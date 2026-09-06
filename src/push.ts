import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Idea #217, first slice: the half of an evening reminder that has to exist
// before anything can be sent -- an application server identity (VAPID) and a
// list of the browsers that have agreed to hear from it.
//
// Why the keypair lives on Marcus's own volume rather than in a Kubernetes
// Secret. The private key has exactly one reader, the sender that runs beside
// this store, and it must be the same key for the lifetime of every
// subscription: a phone's subscription is bound to the application server key
// it was created with, so a rotated key silently stops delivering to every
// device that already said yes. A file on the volume the state already lives
// on is restored by the same backup and read by the same process. It is also
// the only form this loop can create for itself, which is a reason to prefer
// it here and not a reason that would survive a second reader appearing.

export interface VapidKeys {
  /** Raw uncompressed P-256 point, base64url. This is what a browser wants as
   * `applicationServerKey`, and it is the only half that ever leaves here. */
  publicKey: string;
  /** PKCS#8 PEM. Never served, never logged. */
  privateKeyPem: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

// A cap with a danger behind it, the same one `MAX_BODY` in index.ts names:
// this route takes a body from the open internet and appends to a file on a
// 1Gi volume, so without a ceiling one loop fills the disk that the training
// log is written to. Edvard has one phone; 20 is room for every device he
// might ever install this on and still a bounded file.
export const MAX_SUBSCRIPTIONS = 20;

const b64url = (buf: Buffer): string => buf.toString("base64url");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The uncompressed point a browser expects, built from the JWK coordinates
 * rather than from the DER, so the 0x04 prefix is ours and not assumed. */
export function publicKeyToBase64Url(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error("VAPID public key has no P-256 coordinates");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) throw new Error("VAPID public key is not on P-256");
  return b64url(Buffer.concat([Buffer.from([0x04]), x, y]));
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKeyToBase64Url(publicKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/**
 * The application server's identity, generated once and then never again.
 *
 * `ensure` is deliberately not idempotent in the "regenerate if it looks odd"
 * sense: a stored file that will not parse is an error, not a cue to mint a new
 * key, because minting one un-subscribes every phone without saying so.
 */
export class VapidKeyStore {
  private readonly file: string;
  private cached: VapidKeys | null = null;
  private inflight: Promise<VapidKeys> | null = null;

  constructor(dir: string, filename = "vapid-keys.json") {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  async ensure(): Promise<VapidKeys> {
    if (this.cached) return this.cached;
    // Two requests arriving together must not both generate a keypair and race
    // each other's write -- the loser's public key is the one the browser kept.
    if (!this.inflight) this.inflight = this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<VapidKeys> {
    let text: string | null = null;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text !== null) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`VAPID key file at ${this.file} is not valid JSON`);
      }
      if (!isPlainObject(raw) || typeof raw.publicKey !== "string" || typeof raw.privateKeyPem !== "string") {
        throw new Error(`VAPID key file at ${this.file} is missing a key`);
      }
      this.cached = { publicKey: raw.publicKey, privateKeyPem: raw.privateKeyPem };
      return this.cached;
    }
    const keys = generateVapidKeys();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // 0600 rather than the default: the private half is on a volume that the
    // backup job also reads.
    await fs.writeFile(tmp, JSON.stringify(keys), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.file);
    this.cached = keys;
    return keys;
  }
}

export type SubscribeResult =
  | { ok: true; created: boolean; count: number }
  | { ok: false; reason: "invalid" | "full"; message: string };

/** What the browser hands back from `pushManager.subscribe`, checked rather
 * than trusted: an endpoint that is not an https URL is either a mistake or
 * somebody using this store as a place to park text. */
export function validateSubscription(body: unknown): PushSubscriptionRecord | null {
  if (!isPlainObject(body)) return null;
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const keys = body.keys;
  if (!isPlainObject(keys)) return null;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  // The two halves of RFC 8291's key agreement: a 65-byte point and a 16-byte
  // salt, base64url. Checking the decoded length is what separates a real
  // subscription from a well-shaped string.
  if (Buffer.from(p256dh, "base64url").length !== 65) return null;
  if (Buffer.from(auth, "base64url").length !== 16) return null;
  return { endpoint, keys: { p256dh, auth }, createdAt: "" };
}

/**
 * The devices that have said yes, keyed by endpoint.
 *
 * Keyed rather than appended because a browser re-subscribes on its own
 * schedule and hands back the same endpoint; appending would send Edvard the
 * same 20:00 reminder once per time he opened the app.
 */
export class SubscriptionStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, filename = "push-subscriptions.json") {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`subscription file at ${this.file} is not valid JSON`);
    }
    if (!Array.isArray(raw)) throw new Error(`subscription file at ${this.file} is not a list`);
    return raw.filter((r): r is PushSubscriptionRecord => {
      const ok = validateSubscription(r);
      return ok !== null && typeof (r as PushSubscriptionRecord).createdAt === "string";
    });
  }

  async save(record: PushSubscriptionRecord, nowISO: string): Promise<SubscribeResult> {
    return this.serialise(async () => {
      const current = await this.list();
      const existing = current.findIndex((r) => r.endpoint === record.endpoint);
      if (existing === -1 && current.length >= MAX_SUBSCRIPTIONS) {
        return {
          ok: false as const,
          reason: "full" as const,
          message: `this Marcus already holds ${MAX_SUBSCRIPTIONS} subscriptions.`,
        };
      }
      const next = [...current];
      // Keep the original createdAt on a re-subscribe: it is the answer to
      // "since when has this phone been getting these", and a refreshed
      // endpoint is the same phone.
      if (existing === -1) next.push({ ...record, createdAt: nowISO });
      else next[existing] = { ...record, createdAt: next[existing].createdAt || nowISO };
      await this.writeAtomic(next);
      return { ok: true as const, created: existing === -1, count: next.length };
    });
  }

  async remove(endpoint: string): Promise<{ removed: boolean; count: number }> {
    return this.serialise(async () => {
      const current = await this.list();
      const next = current.filter((r) => r.endpoint !== endpoint);
      if (next.length !== current.length) await this.writeAtomic(next);
      return { removed: next.length !== current.length, count: next.length };
    });
  }

  private async writeAtomic(records: PushSubscriptionRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(records), "utf8");
    await fs.rename(tmp, this.file);
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
