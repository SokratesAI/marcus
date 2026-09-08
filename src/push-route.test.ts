import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { SubscriptionStore, VapidKeyStore } from "./push.js";

let dir: string;
let app: ReturnType<typeof createApp>;
let subscriptions: SubscriptionStore;
let posted: string[];
let statusFor: (url: string) => number;

const ua = () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-pushroute-"));
  subscriptions = new SubscriptionStore(dir);
  posted = [];
  statusFor = () => 201;
  const fetchImpl = (async (url: string) => {
    posted.push(url);
    return new Response(null, { status: statusFor(url) });
  }) as unknown as typeof globalThis.fetch;
  app = createApp(new StateStore(dir), undefined, {
    subscriptions,
    vapidKeys: new VapidKeyStore(dir),
    fetchImpl,
    coach: null,
  });
  process.env.MARCUS_PUSH_TOKEN = "a-token-nobody-guesses";
});

afterEach(async () => {
  delete process.env.MARCUS_PUSH_TOKEN;
  await fs.rm(dir, { recursive: true, force: true });
});

const subscribe = async (endpoint: string) => {
  const res = await request(app).post("/api/push/subscribe").send({ endpoint, keys: ua() });
  expect(res.status).toBe(201);
};

const send = (body: Record<string, unknown>, token: string | null = "a-token-nobody-guesses") => {
  const req = request(app).post("/api/push/send");
  return (token === null ? req : req.set("Authorization", `Bearer ${token}`)).send(body);
};

describe("POST /api/push/send", () => {
  it("sends to every subscribed device", async () => {
    await subscribe("https://web.push.apple.com/one");
    await subscribe("https://web.push.apple.com/two");
    const res = await send({ title: "Tomorrow: legs", body: "Squats, 5x5", navigate: "/plan" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, failed: 0, pruned: 0 });
    expect(posted.sort()).toEqual(["https://web.push.apple.com/one", "https://web.push.apple.com/two"]);
  });

  it("refuses a caller with no credential, and sends nothing", async () => {
    await subscribe("https://web.push.apple.com/one");
    const res = await send({ title: "t", body: "b" }, null);
    expect(res.status).toBe(401);
    expect(posted).toEqual([]);
  });

  it("refuses a caller with the wrong credential", async () => {
    await subscribe("https://web.push.apple.com/one");
    expect((await send({ title: "t", body: "b" }, "a-token-nobody-guessez")).status).toBe(401);
    // A token of a different length must be refused too, not throw: an
    // unequal-length timingSafeEqual raises rather than returning false.
    expect((await send({ title: "t", body: "b" }, "short")).status).toBe(401);
    expect(posted).toEqual([]);
  });

  it("is closed, not open, when no token is configured", async () => {
    delete process.env.MARCUS_PUSH_TOKEN;
    await subscribe("https://web.push.apple.com/one");
    const res = await send({ title: "t", body: "b" }, null);
    expect(res.status).toBe(503);
    expect(posted).toEqual([]);
  });

  it("requires a title and a body", async () => {
    await subscribe("https://web.push.apple.com/one");
    expect((await send({ body: "b" })).status).toBe(400);
    expect((await send({ title: "  ", body: "b" })).status).toBe(400);
    expect((await send({ title: "t" })).status).toBe(400);
    expect(posted).toEqual([]);
  });

  it("forgets a device the push service says is gone", async () => {
    await subscribe("https://web.push.apple.com/one");
    await subscribe("https://web.push.apple.com/two");
    statusFor = (url) => (url.endsWith("/one") ? 410 : 201);
    const res = await send({ title: "t", body: "b" });
    expect(res.body).toEqual({ sent: 1, failed: 1, pruned: 1 });
    expect((await subscriptions.list()).map((s) => s.endpoint)).toEqual(["https://web.push.apple.com/two"]);
  });

  it("refuses a second send while the first is still in flight", async () => {
    await subscribe("https://web.push.apple.com/one");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => {};
    // Resolved from inside the hanging fetch, so the second request provably
    // arrives while the first is mid-send rather than after a guessed delay.
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    const slow = createApp(new StateStore(dir), undefined, {
      subscriptions,
      vapidKeys: new VapidKeyStore(dir),
      coach: null,
      fetchImpl: (async (url: string) => {
        posted.push(url);
        entered();
        await held;
        return new Response(null, { status: 201 });
      }) as unknown as typeof globalThis.fetch,
    });
    const send1 = request(slow)
      .post("/api/push/send")
      .set("Authorization", "Bearer a-token-nobody-guesses")
      // `.then` and not a bare assignment: supertest does not dispatch until
      // the request is awaited, so without this the "first" send never starts.
      .send({ title: "t", body: "b" })
      .then((r) => r);
    await inFlight;
    const res2 = await request(slow)
      .post("/api/push/send")
      .set("Authorization", "Bearer a-token-nobody-guesses")
      .send({ title: "t", body: "b" });
    expect(res2.status).toBe(409);
    release();
    expect((await send1).status).toBe(200);
    // One device, one notification -- not two.
    expect(posted).toEqual(["https://web.push.apple.com/one"]);
  });

  it("lets a later send through once the first has finished", async () => {
    await subscribe("https://web.push.apple.com/one");
    expect((await send({ title: "t", body: "b" })).status).toBe(200);
    expect((await send({ title: "t", body: "b" })).status).toBe(200);
    expect(posted.length).toBe(2);
  });

  it("answers with zeroes rather than an error when nobody has subscribed", async () => {
    const res = await send({ title: "t", body: "b" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, failed: 0, pruned: 0 });
  });
});

describe("POST /api/push/status", () => {
  it("says known for a device the store holds", async () => {
    await subscribe("https://web.push.apple.com/known-one");
    const res = await request(app).post("/api/push/status").send({ endpoint: "https://web.push.apple.com/known-one" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ known: true });
  });

  it("says not known for a device the store has never seen, even with others stored", async () => {
    // The failing half of Edvard's report: the browser is subscribed and the
    // server's list does not contain it. With another row present, a matcher
    // that answers "is the list non-empty" passes and this one does not.
    await subscribe("https://web.push.apple.com/some-other-phone");
    const res = await request(app).post("/api/push/status").send({ endpoint: "https://web.push.apple.com/his-phone" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ known: false });
  });

  it("answers not known against an empty store rather than failing", async () => {
    const res = await request(app).post("/api/push/status").send({ endpoint: "https://web.push.apple.com/anything" });
    expect(res.status).toBe(200);
    expect(res.body.known).toBe(false);
  });

  it("refuses a body with no endpoint", async () => {
    expect((await request(app).post("/api/push/status").send({})).status).toBe(400);
    expect((await request(app).post("/api/push/status").send({ endpoint: "" })).status).toBe(400);
    expect((await request(app).post("/api/push/status").send({ endpoint: 7 })).status).toBe(400);
  });

  it("never returns another device's endpoint or the size of the list", async () => {
    await subscribe("https://web.push.apple.com/phone-a");
    await subscribe("https://web.push.apple.com/phone-b");
    const res = await request(app).post("/api/push/status").send({ endpoint: "https://web.push.apple.com/phone-a" });
    expect(Object.keys(res.body)).toEqual(["known"]);
    expect(JSON.stringify(res.body)).not.toContain("phone-b");
  });

  it("is a 500, not a false negative, when the store cannot be read", async () => {
    // A phone told "not known" re-registers itself. Over a disk error that is a
    // write on top of a broken store, so the honest answer is that nobody knows.
    const broken = createApp(new StateStore(dir), undefined, {
      subscriptions: { async list() { throw new Error("volume gone"); } } as unknown as SubscriptionStore,
      vapidKeys: new VapidKeyStore(dir),
      coach: null,
    });
    const res = await request(broken).post("/api/push/status").send({ endpoint: "https://web.push.apple.com/x" });
    expect(res.status).toBe(500);
    expect(res.body.known).toBeUndefined();
  });
});
