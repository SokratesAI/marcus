import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import {
  MAX_SUBSCRIPTIONS,
  SubscriptionStore,
  VapidKeyStore,
  generateVapidKeys,
  publicKeyToBase64Url,
  validateSubscription,
} from "./push.js";

let dir: string;
let app: ReturnType<typeof createApp>;
let keyStore: VapidKeyStore;
let subs: SubscriptionStore;
const clock = "2026-09-06T17:00:00.000Z";

/** A subscription of the shape a browser actually hands back: a 65-byte
 * P-256 point and a 16-byte auth secret, both base64url. */
const subscription = (endpoint: string) => ({
  endpoint,
  keys: {
    p256dh: publicKeyToBase64Url(crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey),
    auth: crypto.randomBytes(16).toString("base64url"),
  },
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-push-"));
  keyStore = new VapidKeyStore(dir);
  subs = new SubscriptionStore(dir);
  app = createApp(new StateStore(dir), () => clock, { vapidKeys: keyStore, subscriptions: subs });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the VAPID keypair", () => {
  it("is a P-256 public key in the uncompressed form a browser wants", () => {
    const keys = generateVapidKeys();
    const raw = Buffer.from(keys.publicKey, "base64url");
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("round-trips: the served key is the public half of the stored private half", async () => {
    const keys = await keyStore.ensure();
    const derived = publicKeyToBase64Url(
      crypto.createPublicKey(crypto.createPrivateKey(keys.privateKeyPem)),
    );
    expect(derived).toBe(keys.publicKey);
  });

  it("is minted once and then never again, because a new key un-subscribes every phone", async () => {
    const first = await keyStore.ensure();
    // A second store over the same directory is a restarted process.
    const second = await new VapidKeyStore(dir).ensure();
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });

  it("does not race itself when two requests arrive before the file exists", async () => {
    const [a, b] = await Promise.all([keyStore.ensure(), keyStore.ensure()]);
    expect(a.publicKey).toBe(b.publicKey);
    const onDisk = JSON.parse(await fs.readFile(keyStore.filePath, "utf8"));
    expect(onDisk.publicKey).toBe(a.publicKey);
  });

  it("refuses a damaged key file rather than minting a replacement", async () => {
    await fs.writeFile(keyStore.filePath, "{ not json", "utf8");
    await expect(new VapidKeyStore(dir).ensure()).rejects.toThrow(/not valid JSON/);
  });

  it("writes the private half readable only by its owner", async () => {
    await keyStore.ensure();
    const mode = (await fs.stat(keyStore.filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("GET /api/push/key", () => {
  it("serves the public key and mints it on first ask", async () => {
    await expect(fs.stat(keyStore.filePath)).rejects.toThrow();
    const res = await request(app).get("/api/push/key");
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.key, "base64url").length).toBe(65);
    await expect(fs.stat(keyStore.filePath)).resolves.toBeTruthy();
  });

  it("never serves the private half", async () => {
    const res = await request(app).get("/api/push/key");
    const stored = await keyStore.ensure();
    // The whole body, not just the keys I thought to name: a private key that
    // leaks under some other field name is the failure this guards.
    expect(res.text).not.toContain("PRIVATE KEY");
    expect(res.text).not.toContain(stored.privateKeyPem.trim().split("\n")[1]);
    expect(Object.keys(res.body)).toEqual(["key"]);
  });
});

describe("validateSubscription", () => {
  it("accepts what a browser hands back", () => {
    expect(validateSubscription(subscription("https://web.push.apple.com/abc"))).not.toBeNull();
  });

  it.each([
    ["nothing at all", undefined],
    ["a bare string", "https://web.push.apple.com/abc"],
    ["no endpoint", { keys: subscription("https://x.example/a").keys }],
    ["a non-https endpoint", { ...subscription("https://x.example/a"), endpoint: "http://x.example/a" }],
    ["an unparseable endpoint", { ...subscription("https://x.example/a"), endpoint: "not a url" }],
    ["no keys", { endpoint: "https://web.push.apple.com/abc" }],
  ])("refuses %s", (_name, body) => {
    expect(validateSubscription(body)).toBeNull();
  });

  it("refuses a well-shaped string that is not a P-256 point", () => {
    const s = subscription("https://web.push.apple.com/abc");
    s.keys.p256dh = Buffer.alloc(64).toString("base64url");
    expect(validateSubscription(s)).toBeNull();
  });

  it("refuses an auth secret of the wrong length", () => {
    const s = subscription("https://web.push.apple.com/abc");
    s.keys.auth = Buffer.alloc(12).toString("base64url");
    expect(validateSubscription(s)).toBeNull();
  });
});

describe("POST /api/push/subscribe", () => {
  it("stores a subscription and answers 201 the first time", async () => {
    const res = await request(app).post("/api/push/subscribe").send(subscription("https://web.push.apple.com/one"));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ subscribed: true, count: 1 });
    const stored = await subs.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].createdAt).toBe(clock);
  });

  it("does not add the same phone twice, so the 20:00 reminder arrives once", async () => {
    const one = subscription("https://web.push.apple.com/one");
    expect((await request(app).post("/api/push/subscribe").send(one)).status).toBe(201);
    const again = await request(app).post("/api/push/subscribe").send(one);
    expect(again.status).toBe(200);
    expect(again.body.count).toBe(1);
    expect(await subs.list()).toHaveLength(1);
  });

  it("keeps the original createdAt when a phone re-subscribes with fresh keys", async () => {
    const endpoint = "https://web.push.apple.com/one";
    await subs.save(validateSubscription(subscription(endpoint))!, "2026-01-01T00:00:00.000Z");
    await request(app).post("/api/push/subscribe").send(subscription(endpoint));
    const stored = await subs.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses a body that is not a subscription", async () => {
    const res = await request(app).post("/api/push/subscribe").send({ endpoint: "http://x.example/a" });
    expect(res.status).toBe(400);
    expect(await subs.list()).toHaveLength(0);
  });

  it("stops filling the volume at the cap and says so", async () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      const res = await request(app).post("/api/push/subscribe").send(subscription(`https://web.push.apple.com/${i}`));
      expect(res.status).toBe(201);
    }
    const over = await request(app).post("/api/push/subscribe").send(subscription("https://web.push.apple.com/over"));
    expect(over.status).toBe(507);
    expect(await subs.list()).toHaveLength(MAX_SUBSCRIPTIONS);
  });

  it("still lets a device already stored re-subscribe once the list is full", async () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      await request(app).post("/api/push/subscribe").send(subscription(`https://web.push.apple.com/${i}`));
    }
    const res = await request(app).post("/api/push/subscribe").send(subscription("https://web.push.apple.com/0"));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/push/subscribe", () => {
  it("removes a stored subscription", async () => {
    const one = subscription("https://web.push.apple.com/one");
    await request(app).post("/api/push/subscribe").send(one);
    const res = await request(app).delete("/api/push/subscribe").send({ endpoint: one.endpoint });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscribed: false, removed: true, count: 0 });
    expect(await subs.list()).toHaveLength(0);
  });

  it("answers 200 for an endpoint it never held", async () => {
    const res = await request(app).delete("/api/push/subscribe").send({ endpoint: "https://web.push.apple.com/nope" });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(false);
  });

  it("refuses a call with no endpoint", async () => {
    const res = await request(app).delete("/api/push/subscribe").send({});
    expect(res.status).toBe(400);
  });
});

describe("the subscription file", () => {
  it("survives a restart", async () => {
    await request(app).post("/api/push/subscribe").send(subscription("https://web.push.apple.com/one"));
    expect(await new SubscriptionStore(dir).list()).toHaveLength(1);
  });

  it("does not serve a row that is no longer a valid subscription", async () => {
    await fs.writeFile(subs.filePath, JSON.stringify([{ endpoint: "http://x.example/a", keys: {}, createdAt: clock }]), "utf8");
    expect(await subs.list()).toHaveLength(0);
  });

  it("reports a damaged file rather than reading it as nobody subscribed", async () => {
    await fs.writeFile(subs.filePath, "{ not json", "utf8");
    await expect(subs.list()).rejects.toThrow(/not valid JSON/);
  });
});
