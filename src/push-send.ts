import crypto from "node:crypto";
import type { PushSubscriptionRecord, VapidKeys } from "./push.js";
import type { SubscriptionStore } from "./push.js";

// Idea #217, second slice: the half that actually sends. The first slice
// (marcus#42) gave Marcus an application server identity and a list of phones
// that said yes; nothing turned that into a notification.
//
// Everything below is RFC 8291 (Message Encryption for Web Push) over RFC 8188
// (aes128gcm content encoding), with an RFC 8292 (VAPID) Authorization header.
// It is written against node:crypto rather than pulled from npm on purpose:
// the whole schedule is about sixty lines, and the alternative is a dependency
// in the request path of a notification that carries what Edvard is training.

/** What Safari renders with no service-worker push handler at all: a payload
 * carrying `web_push: 8030` is built into a notification by the browser
 * itself (Declarative Web Push). `sw.js` may still intercept it; nothing
 * breaks if it does not, which is the whole point of the row. */
export interface DeclarativeNotification {
  title: string;
  body: string;
  /** Required by the declarative format -- where a tap lands. */
  navigate: string;
  tag?: string;
}

export function declarativePayload(n: DeclarativeNotification): Buffer {
  const notification: Record<string, unknown> = {
    title: n.title,
    body: n.body,
    navigate: n.navigate,
  };
  if (n.tag !== undefined) notification.tag = n.tag;
  return Buffer.from(JSON.stringify({ web_push: 8030, notification }), "utf8");
}

/** RFC 8188 names a record size and this is the one every push service
 * accepts; a payload larger than one record is refused rather than split,
 * because a reminder that needs two records is not a reminder. */
export const RECORD_SIZE = 4096;
/** RFC 8291 §4: 3993 bytes of plaintext fit in one 4096-byte record once the
 * 16-byte auth tag, the padding delimiter and the header are taken out. */
export const MAX_PLAINTEXT = 3993;

const KEY_INFO_PREFIX = Buffer.from("WebPush: info\0", "utf8");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));

/** A raw uncompressed P-256 point as a KeyObject, which is the only form the
 * browser gives us for the user agent's key. */
export function publicKeyFromRawPoint(point: Buffer): crypto.KeyObject {
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("user agent public key is not an uncompressed P-256 point");
  }
  return crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

export interface EncryptOverrides {
  /** Both injected only by a test that needs a fixed record to assert on.
   * Production passes neither and every message gets fresh randomness. */
  salt?: Buffer;
  localKeys?: crypto.ECDH;
}

/**
 * One aes128gcm record: header || AES-128-GCM(plaintext || 0x02).
 *
 * The 0x02 delimiter is what marks this as the last record, and it is inside
 * the ciphertext rather than beside it -- a receiver that trusts a plaintext
 * length instead would accept a truncated message.
 */
export function encryptPayload(
  plaintext: Buffer,
  p256dhBase64Url: string,
  authBase64Url: string,
  overrides: EncryptOverrides = {},
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(`push payload is ${plaintext.length} bytes, over the ${MAX_PLAINTEXT}-byte record`);
  }
  const uaPublic = Buffer.from(p256dhBase64Url, "base64url");
  const authSecret = Buffer.from(authBase64Url, "base64url");
  if (uaPublic.length !== 65) throw new Error("user agent public key is not 65 bytes");
  if (authSecret.length !== 16) throw new Error("auth secret is not 16 bytes");

  const salt = overrides.salt ?? crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error("salt is not 16 bytes");
  const ecdh = overrides.localKeys ?? crypto.createECDH("prime256v1");
  if (!overrides.localKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4. The context that binds the key to *these two* keys is the
  // info string, not the salt: swap either public key and the CEK changes.
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, CEK_INFO, 16);
  const nonce = hkdf(ikm, salt, NONCE_INFO, 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 §2: an ES256 JWT over the push service's origin, signed by the
 * same key the phone subscribed with. `sub` is a contact for the push service
 * operator, not a user identity. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
  ttlSeconds = 12 * 60 * 60,
): string {
  const audience = new URL(endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8").toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + ttlSeconds, sub: subject }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${header}.${claims}`;
  // ieee-p1363, not the DER default: a push service reads r||s and rejects a
  // DER signature outright.
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: crypto.createPrivateKey(keys.privateKeyPem),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  return `vapid t=${signingInput}.${signature},k=${keys.publicKey}`;
}

export interface SendOutcome {
  endpoint: string;
  status: number;
  /** The push service says this subscription is dead and will never be
   * anything else -- 404 or 410, and nothing else. A 429 or a 500 is the
   * service having a bad minute and the phone is still there. */
  gone: boolean;
}

export async function sendPush(
  subscription: PushSubscriptionRecord,
  payload: Buffer,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
  fetchImpl: typeof globalThis.fetch,
  ttlSeconds = 24 * 60 * 60,
): Promise<SendOutcome> {
  const body = encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, keys, subject, nowMs),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "normal",
    },
    body: new Uint8Array(body),
  });
  return { endpoint: subscription.endpoint, status: res.status, gone: res.status === 404 || res.status === 410 };
}

export interface FanOutResult {
  sent: number;
  failed: number;
  pruned: number;
  outcomes: SendOutcome[];
}

/**
 * Send to every subscribed device, and forget the ones the push service says
 * are gone.
 *
 * Pruning here rather than in a sweep somewhere else, because a 410 is the
 * only moment anything ever learns a phone is gone -- there is no other
 * signal, and an unpruned endpoint is a failed send in every report forever.
 */
export async function sendToAll(
  store: SubscriptionStore,
  payload: Buffer,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<FanOutResult> {
  const subs = await store.list();
  const outcomes: SendOutcome[] = [];
  for (const sub of subs) {
    try {
      outcomes.push(await sendPush(sub, payload, keys, subject, nowMs, fetchImpl));
    } catch {
      // A throw is this side failing -- a refused connection, a malformed
      // stored key. Status 0 says "never reached the push service", which is
      // not the same as a service that answered badly, and it never prunes.
      outcomes.push({ endpoint: sub.endpoint, status: 0, gone: false });
    }
  }
  let pruned = 0;
  for (const outcome of outcomes) {
    if (!outcome.gone) continue;
    await store.remove(outcome.endpoint);
    pruned += 1;
  }
  const sent = outcomes.filter((o) => o.status >= 200 && o.status < 300).length;
  return { sent, failed: outcomes.length - sent, pruned, outcomes };
}
