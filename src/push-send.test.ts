import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionStore, generateVapidKeys, type PushSubscriptionRecord } from "./push.js";
import {
  MAX_PLAINTEXT,
  RECORD_SIZE,
  declarativePayload,
  encryptPayload,
  publicKeyFromRawPoint,
  sendPush,
  sendToAll,
  vapidAuthorization,
} from "./push-send.js";

/**
 * A user agent, written from the receiving side of RFC 8291 rather than by
 * calling the sender's own helpers.
 *
 * This is the point of the file: a round trip through `encryptPayload` and an
 * inverse built out of the same functions would agree with each other however
 * wrong the key schedule was. Everything below re-derives the schedule from
 * the RFC text -- the info strings are spelled out here as literals, the
 * header is parsed by offset, and the delimiter is checked.
 */
function makeUserAgent() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(record: Buffer): Buffer {
      const salt = record.subarray(0, 16);
      const rs = record.readUInt32BE(16);
      const idlen = record.readUInt8(20);
      expect(rs).toBe(RECORD_SIZE);
      expect(idlen).toBe(65);
      const asPublic = record.subarray(21, 21 + idlen);
      const body = record.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        ecdh.getPublicKey(),
        asPublic,
      ]);
      const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
      const cek = Buffer.from(
        crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
      );
      const nonce = Buffer.from(
        crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
      );
      const tag = body.subarray(body.length - 16);
      const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(tag);
      const padded = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
      expect(padded[padded.length - 1]).toBe(0x02);
      return padded.subarray(0, padded.length - 1);
    },
  };
}

const subscriptionFor = (ua: ReturnType<typeof makeUserAgent>, endpoint: string): PushSubscriptionRecord => ({
  endpoint,
  keys: { p256dh: ua.p256dh, auth: ua.auth },
  createdAt: "2026-09-06T20:00:00.000Z",
});

describe("declarativePayload", () => {
  it("carries the 8030 key that makes Safari render it with no push handler", () => {
    const parsed = JSON.parse(
      declarativePayload({ title: "Tomorrow", body: "Legs", navigate: "https://marcus/plan" }).toString("utf8"),
    );
    expect(parsed.web_push).toBe(8030);
    expect(parsed.notification).toEqual({ title: "Tomorrow", body: "Legs", navigate: "https://marcus/plan" });
  });

  it("omits tag when there is none rather than sending null", () => {
    const parsed = JSON.parse(declarativePayload({ title: "t", body: "b", navigate: "n" }).toString("utf8"));
    expect("tag" in parsed.notification).toBe(false);
  });
});

describe("encryptPayload", () => {
  it("produces a record a user agent following RFC 8291 can decrypt", () => {
    const ua = makeUserAgent();
    const plaintext = declarativePayload({ title: "Tomorrow: legs", body: "5 exercises", navigate: "/plan" });
    const record = encryptPayload(plaintext, ua.p256dh, ua.auth);
    expect(ua.decrypt(record).toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("binds the key to both public keys -- another device cannot read it", () => {
    const mine = makeUserAgent();
    const other = makeUserAgent();
    const record = encryptPayload(Buffer.from("secret"), mine.p256dh, mine.auth);
    expect(() => other.decrypt(record)).toThrow();
  });

  it("binds the key to the auth secret as well as the keypair", () => {
    const ua = makeUserAgent();
    const wrongAuth = crypto.randomBytes(16).toString("base64url");
    const record = encryptPayload(Buffer.from("secret"), ua.p256dh, wrongAuth);
    expect(() => ua.decrypt(record)).toThrow();
  });

  it("never sends the same record twice for the same message", () => {
    const ua = makeUserAgent();
    const a = encryptPayload(Buffer.from("same"), ua.p256dh, ua.auth);
    const b = encryptPayload(Buffer.from("same"), ua.p256dh, ua.auth);
    expect(a.equals(b)).toBe(false);
    expect(ua.decrypt(a).toString()).toBe("same");
    expect(ua.decrypt(b).toString()).toBe("same");
  });

  it("refuses a payload that does not fit in one record", () => {
    const ua = makeUserAgent();
    expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT + 1), ua.p256dh, ua.auth)).toThrow(/over the/);
    expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT), ua.p256dh, ua.auth)).not.toThrow();
  });

  it("refuses keys of the wrong length rather than sending an unreadable record", () => {
    const ua = makeUserAgent();
    expect(() => encryptPayload(Buffer.from("x"), Buffer.alloc(64).toString("base64url"), ua.auth)).toThrow(
      /65 bytes/,
    );
    expect(() => encryptPayload(Buffer.from("x"), ua.p256dh, Buffer.alloc(12).toString("base64url"))).toThrow(
      /16 bytes/,
    );
  });
});

describe("publicKeyFromRawPoint", () => {
  it("round-trips a real P-256 point", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const key = publicKeyFromRawPoint(ecdh.getPublicKey());
    const jwk = key.export({ format: "jwk" }) as { x: string; y: string };
    expect(Buffer.from(jwk.x, "base64url").equals(ecdh.getPublicKey().subarray(1, 33))).toBe(true);
  });

  it("refuses a compressed point", () => {
    const point = Buffer.alloc(65);
    point[0] = 0x02;
    expect(() => publicKeyFromRawPoint(point)).toThrow(/uncompressed/);
  });
});

describe("vapidAuthorization", () => {
  const keys = generateVapidKeys();

  it("signs claims a push service can verify with the key the phone subscribed to", () => {
    const header = vapidAuthorization(
      "https://web.push.apple.com/abc/def",
      keys,
      "mailto:nova@sokrates.ai",
      Date.UTC(2026, 8, 6, 20, 0, 0),
    );
    const [, token] = /^vapid t=([^,]+),k=(.+)$/.exec(header) ?? [];
    const k = /k=(.+)$/.exec(header)?.[1];
    expect(k).toBe(keys.publicKey);
    const [h, c, sig] = token.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    // The audience is the origin only: a service given the full endpoint as
    // `aud` rejects the token.
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe("mailto:nova@sokrates.ai");
    expect(claims.exp).toBe(Math.floor(Date.UTC(2026, 8, 6, 20, 0, 0) / 1000) + 12 * 60 * 60);
    const point = Buffer.from(keys.publicKey, "base64url");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${c}`, "utf8"),
      { key: publicKeyFromRawPoint(point), dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);
    // 64 bytes is r||s. A DER signature is 70-72 bytes and every push service
    // refuses it, which is a failure with no symptom until a real send.
    expect(Buffer.from(sig, "base64url").length).toBe(64);
  });

  it("re-derives the audience per endpoint", () => {
    const a = vapidAuthorization("https://fcm.googleapis.com/x", keys, "mailto:a@b", 0);
    const claims = (h: string) => JSON.parse(Buffer.from(h.split(".")[1], "base64url").toString());
    expect(claims(a.slice("vapid t=".length)).aud).toBe("https://fcm.googleapis.com");
  });
});

describe("sendPush", () => {
  const keys = generateVapidKeys();

  it("posts an encrypted body with the headers a push service requires", async () => {
    const ua = makeUserAgent();
    const seen: { url: string; init: RequestInit } = { url: "", init: {} };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(null, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const payload = declarativePayload({ title: "T", body: "B", navigate: "/" });
    const out = await sendPush(
      subscriptionFor(ua, "https://web.push.apple.com/one"),
      payload,
      keys,
      "mailto:nova@sokrates.ai",
      0,
      fetchImpl,
    );
    expect(out).toEqual({ endpoint: "https://web.push.apple.com/one", status: 201, gone: false });
    const headers = seen.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe(String(24 * 60 * 60));
    expect(headers.Authorization.startsWith("vapid t=")).toBe(true);
    expect(ua.decrypt(Buffer.from(seen.init.body as Uint8Array)).toString()).toBe(payload.toString());
  });

  it("calls 404 and 410 gone, and nothing else", async () => {
    const ua = makeUserAgent();
    const at = (status: number) =>
      sendPush(
        subscriptionFor(ua, "https://push/x"),
        Buffer.from("x"),
        keys,
        "mailto:a@b",
        0,
        (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch,
      );
    expect((await at(404)).gone).toBe(true);
    expect((await at(410)).gone).toBe(true);
    for (const status of [201, 429, 500, 502]) expect((await at(status)).gone).toBe(false);
  });
});

describe("sendToAll", () => {
  const keys = generateVapidKeys();
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  const storeWith = async (uas: ReturnType<typeof makeUserAgent>[]) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-push-"));
    dirs.push(dir);
    const store = new SubscriptionStore(dir);
    for (const [i, ua] of uas.entries()) {
      await store.save(subscriptionFor(ua, `https://push/${i}`), "2026-09-06T20:00:00.000Z");
    }
    return store;
  };

  it("sends to every device and counts what landed", async () => {
    const store = await storeWith([makeUserAgent(), makeUserAgent()]);
    const hit: string[] = [];
    const fetchImpl = (async (url: string) => {
      hit.push(url);
      return new Response(null, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const result = await sendToAll(store, Buffer.from("x"), keys, "mailto:a@b", 0, fetchImpl);
    expect(hit.sort()).toEqual(["https://push/0", "https://push/1"]);
    expect(result).toMatchObject({ sent: 2, failed: 0, pruned: 0 });
    expect((await store.list()).length).toBe(2);
  });

  it("forgets a subscription the push service says is gone, and keeps the rest", async () => {
    const store = await storeWith([makeUserAgent(), makeUserAgent()]);
    const fetchImpl = (async (url: string) =>
      new Response(null, { status: url.endsWith("/0") ? 410 : 201 })) as unknown as typeof globalThis.fetch;
    const result = await sendToAll(store, Buffer.from("x"), keys, "mailto:a@b", 0, fetchImpl);
    expect(result).toMatchObject({ sent: 1, failed: 1, pruned: 1 });
    expect((await store.list()).map((s) => s.endpoint)).toEqual(["https://push/1"]);
  });

  it("keeps a subscription that merely failed -- a 500 is the service, not the phone", async () => {
    const store = await storeWith([makeUserAgent()]);
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch;
    const result = await sendToAll(store, Buffer.from("x"), keys, "mailto:a@b", 0, fetchImpl);
    expect(result).toMatchObject({ sent: 0, failed: 1, pruned: 0 });
    expect((await store.list()).length).toBe(1);
  });

  it("survives a throw on one device and still sends to the next", async () => {
    const store = await storeWith([makeUserAgent(), makeUserAgent()]);
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/0")) throw new Error("connection refused");
      return new Response(null, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const result = await sendToAll(store, Buffer.from("x"), keys, "mailto:a@b", 0, fetchImpl);
    expect(result).toMatchObject({ sent: 1, failed: 1, pruned: 0 });
    expect(result.outcomes.find((o) => o.endpoint.endsWith("/0"))?.status).toBe(0);
    expect((await store.list()).length).toBe(2);
  });

  it("does nothing at all when no device has subscribed", async () => {
    const store = await storeWith([]);
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response(null, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    expect(await sendToAll(store, Buffer.from("x"), keys, "mailto:a@b", 0, fetchImpl)).toMatchObject({
      sent: 0,
      failed: 0,
      pruned: 0,
    });
    expect(called).toBe(0);
  });
});
