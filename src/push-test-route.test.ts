import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { SubscriptionStore, VapidKeyStore } from "./push.js";

// POST /api/push/test — issue #154. The route exists so that tapping "Turn on
// reminders" produces an answer within seconds instead of at 20:00 tomorrow.
// Its whole authorisation model is "you named an endpoint that is already in
// the store", so most of what is worth testing is what happens when you did
// not.

let dir: string;
let app: ReturnType<typeof createApp>;
let subscriptions: SubscriptionStore;
let posted: string[];
let statusFor: (url: string) => number;
let bodyFor: (body: Buffer) => void;

const ua = () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-pushtest-"));
  subscriptions = new SubscriptionStore(dir);
  posted = [];
  statusFor = () => 201;
  bodyFor = () => {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posted.push(url);
    bodyFor(Buffer.from(init.body as Uint8Array));
    return new Response(null, { status: statusFor(url) });
  }) as unknown as typeof globalThis.fetch;
  app = createApp(new StateStore(dir), undefined, {
    subscriptions,
    vapidKeys: new VapidKeyStore(dir),
    fetchImpl,
    coach: null,
  });
});

afterEach(async () => {
  delete process.env.MARCUS_PUSH_TOKEN;
  await fs.rm(dir, { recursive: true, force: true });
});

const PHONE = "https://web.push.apple.com/his-phone";

const subscribe = async (endpoint: string) => {
  const res = await request(app).post("/api/push/subscribe").send({ endpoint, keys: ua() });
  expect(res.status).toBe(201);
};


// A subscriber that keeps its own ECDH private key, so a test can read back
// what was actually put on the wire. The RFC 8291 walk is the same one
// push-send.test.ts does against `encryptPayload` directly; this file needs it
// to assert what the ROUTE chose to say, which is a different question.
function userAgent() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    decrypt(record: Buffer): Buffer {
      const salt = record.subarray(0, 16);
      const idlen = record.readUInt8(20);
      const asPublic = record.subarray(21, 21 + idlen);
      const body = record.subarray(21 + idlen);
      const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh.computeSecret(asPublic), auth, keyInfo, 32));
      const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
      const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
      const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(body.subarray(body.length - 16));
      const padded = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
      return padded.subarray(0, padded.length - 1);
    },
  };
}

const subscribeAs = async (endpoint: string, ua: ReturnType<typeof userAgent>) => {
  const res = await request(app).post("/api/push/subscribe").send({ endpoint, keys: ua.keys });
  expect(res.status).toBe(201);
};

const test = (body: Record<string, unknown>) => request(app).post("/api/push/test").send(body);

// supertest's Test only starts on `.end()`/`.then()`. Two "concurrent"
// requests built and awaited in order run strictly one after the other, which
// would make an in-flight test pass whether the flags were shared or not --
// the positive result guaranteed in advance. `fire` starts the request now.
const fire = (req: request.Test): Promise<request.Response> =>
  new Promise((resolve, reject) => req.end((err, res) => (err ? reject(err) : resolve(res))));

/** A fetch that parks the FIRST push-service call until it is released, and
 * says when it got there. Only the first: the second request in these tests is
 * the one under examination and has to be able to finish while the first is
 * still holding its flag. */
function held() {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const arrived = new Promise<void>((r) => { entered = r; });
  let first = true;
  const fetchImpl = (async (url: string) => {
    posted.push(url);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return new Response(null, { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, entered: arrived, release: () => release() };
}

const appWith = (fetchImpl: typeof globalThis.fetch) =>
  createApp(new StateStore(dir), undefined, {
    subscriptions,
    vapidKeys: new VapidKeyStore(dir),
    fetchImpl,
    coach: null,
  });

describe("POST /api/push/test", () => {
  it("sends one notification to the named device and says so", async () => {
    await subscribe(PHONE);
    await subscribe("https://web.push.apple.com/some-other-device");
    const res = await test({ endpoint: PHONE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    // One device, and the right one. A test that fanned out would buzz every
    // phone Edvard has ever installed this on.
    expect(posted).toEqual([PHONE]);
  });

  it("needs no bearer token, unlike /api/push/send", async () => {
    // /api/push/send is 503 with no MARCUS_PUSH_TOKEN set, by design. This
    // route must not inherit that: the phone tapping the button has no token
    // and never will.
    expect(process.env.MARCUS_PUSH_TOKEN).toBeUndefined();
    await subscribe(PHONE);
    expect((await test({ endpoint: PHONE })).status).toBe(200);
    expect((await request(app).post("/api/push/send").send({ title: "t", body: "b" })).status).toBe(503);
  });

  it("refuses an endpoint nobody has subscribed, and sends nothing", async () => {
    await subscribe(PHONE);
    const res = await test({ endpoint: "https://web.push.apple.com/never-seen" });
    expect(res.status).toBe(404);
    expect(posted).toEqual([]);
  });

  it("refuses a body with no endpoint", async () => {
    await subscribe(PHONE);
    expect((await test({})).status).toBe(400);
    expect((await test({ endpoint: "" })).status).toBe(400);
    expect((await test({ endpoint: 7 })).status).toBe(400);
    expect(posted).toEqual([]);
  });

  it("takes no notification text from the caller", async () => {
    // The point of the fixed payload: this route is unauthenticated, so a
    // caller who could choose the words could write anything onto Edvard's
    // lock screen. Asserting the 200 alone would pass either way -- the
    // plaintext never reaches the fake fetch unencrypted -- so this reads the
    // bytes actually sent and decrypts them as the phone would.
    const ua = userAgent();
    await subscribeAs(PHONE, ua);
    let body: Buffer | null = null;
    bodyFor = (b) => { body = b; };
    const res = await test({ endpoint: PHONE, title: "Injected", body: "Injected", tag: "Injected" });
    expect(res.status).toBe(200);
    const sent = JSON.parse(ua.decrypt(body!).toString("utf8"));
    expect(JSON.stringify(sent)).not.toMatch(/Injected/);
    expect(sent.notification.title).toBe("Marcus");
    expect(sent.notification.body).toMatch(/Reminders are working/);
  });

  it("drops a subscription the push service says is gone, and tells the phone", async () => {
    await subscribe(PHONE);
    statusFor = () => 410;
    const res = await test({ endpoint: PHONE });
    expect(res.status).toBe(410);
    expect(res.body.pruned).toBe(true);
    expect(await subscriptions.list()).toEqual([]);
  });

  it("keeps a subscription the push service merely refused today", async () => {
    // 429 is Apple having a bad minute. Pruning on it would silently
    // unsubscribe a phone that is still perfectly there.
    await subscribe(PHONE);
    statusFor = () => 429;
    const res = await test({ endpoint: PHONE });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe(429);
    expect((await subscriptions.list()).map((s) => s.endpoint)).toEqual([PHONE]);
  });

  it("does not block the scheduled reminder, and is not blocked by it", async () => {
    // The two routes hold separate in-flight flags on purpose. A test tap at
    // 20:00:00 sharing one would make the CronJob report a failed reminder.
    process.env.MARCUS_PUSH_TOKEN = "a-token-nobody-guesses";
    await subscribe(PHONE);
    const gate = held();
    const slowApp = appWith(gate.fetchImpl);
    const scheduled = fire(
      request(slowApp)
        .post("/api/push/send")
        .set("Authorization", "Bearer a-token-nobody-guesses")
        .send({ title: "Tomorrow", body: "Legs" }),
    );
    // Not a sleep: this resolves when the scheduled send is actually parked
    // inside its fetch, which is the only moment its in-flight flag is set. A
    // timer here would let the send finish first and the test would pass on a
    // shared flag as happily as on separate ones.
    await gate.entered;
    const tapped = await fire(request(slowApp).post("/api/push/test").send({ endpoint: PHONE }));
    expect(tapped.status).toBe(200);
    gate.release();
    expect((await scheduled).status).toBe(200);
  });

  it("refuses a second test while one is still in flight", async () => {
    await subscribe(PHONE);
    const gate = held();
    const slowApp = appWith(gate.fetchImpl);
    const first = fire(request(slowApp).post("/api/push/test").send({ endpoint: PHONE }));
    await gate.entered;
    const second = await fire(request(slowApp).post("/api/push/test").send({ endpoint: PHONE }));
    expect(second.status).toBe(409);
    gate.release();
    expect((await first).status).toBe(200);
    // The flag is released either way, so the next tap works.
    const third = await fire(request(slowApp).post("/api/push/test").send({ endpoint: PHONE }));
    expect(third.status).toBe(200);
  });
});
