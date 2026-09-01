import fs from "node:fs/promises";
import path from "node:path";

// Open Food Facts is the food database idea #205 names by title, and idea #215
// is the decision about *where* it gets called from. Two reasons it is not
// called from public/app.js, and they are the whole design of this file.
//
// Their documentation asks for rate-limit etiquette and points bulk consumers
// at the downloadable dataset rather than the live API, so a browser that calls
// it per keystroke is one enthusiastic evening away from being blocked at the
// gym. And a barcode is a fact about what Edvard is eating leaving this cluster
// to a third party -- that decision belongs in one place, taken once, not
// implicitly on every request from a phone.
//
// So: one route, one upstream call per barcode ever (the cache survives a pod
// restart on the same volume the state file lives on), one User-Agent that says
// who we are, and one shape out -- the same `{ name, unit, kcal, protein,
// carbs, fat }` row the local FOODS table in app.js already returns, so the UI
// does not learn a second format.

export const OFF_BASE = "https://world.openfoodfacts.org";
// Their guidance is an identifying User-Agent with contact details; an app that
// does not say who it is is the first one rate-limited.
export const OFF_USER_AGENT = "Marcus/1.0 (SokratesAI; https://github.com/SokratesAI/marcus)";
const OFF_FIELDS = "product_name,product_name_en,brands,nutriments";

export interface FoodRow {
  code: string;
  name: string;
  brand: string;
  /** Values below are per 100 g, which is the unit the local table uses too. */
  unit: "g";
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  source: "openfoodfacts";
}

// EAN-8 through GTIN-14. Anything else never reaches the network: a bad scan is
// our own 400, not a request someone else has to rate-limit.
const BARCODE = /^[0-9]{8,14}$/;

export const isBarcode = (code: unknown): boolean => BARCODE.test(String(code ?? ""));

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// A macro that is absent is 0 on a real product far more often than it is
// unknown -- olive oil really does carry no protein -- but energy is different:
// a product with no energy at all is a row someone started and never finished,
// and logging it would write a 0 kcal meal into the day's total.
const macro = (v: unknown): number => {
  const n = num(v);
  return n == null || n < 0 ? 0 : Math.round(n * 10) / 10;
};

/**
 * Their `nutriments` object carries kcal for most products and only kJ for
 * some, so the kJ fallback is not a nicety -- without it a European product
 * that lists energy the European way looks like a product with no energy.
 */
export function energyKcal(nutriments: Record<string, unknown>): number | null {
  const kcal = num(nutriments["energy-kcal_100g"]) ?? num(nutriments["energy-kcal"]);
  if (kcal != null && kcal >= 0) return Math.round(kcal);
  const kj = num(nutriments["energy-kj_100g"]) ?? num(nutriments["energy-kj"]);
  if (kj != null && kj >= 0) return Math.round(kj / 4.184);
  return null;
}

/**
 * Their product JSON into one of our rows, or null when the row is too thin to
 * log honestly. Null is a real answer here and the caller reports it as a miss.
 */
export function normalizeProduct(code: string, product: unknown): FoodRow | null {
  if (typeof product !== "object" || product === null) return null;
  const p = product as Record<string, unknown>;
  const name = String(p.product_name || p.product_name_en || "").trim();
  if (!name) return null;
  const nutriments = (typeof p.nutriments === "object" && p.nutriments !== null
    ? p.nutriments
    : {}) as Record<string, unknown>;
  const kcal = energyKcal(nutriments);
  if (kcal == null) return null;
  return {
    code,
    name,
    brand: String(p.brands || "").split(",")[0].trim(),
    unit: "g",
    kcal,
    protein: macro(nutriments["proteins_100g"] ?? nutriments["proteins"]),
    carbs: macro(nutriments["carbohydrates_100g"] ?? nutriments["carbohydrates"]),
    fat: macro(nutriments["fat_100g"] ?? nutriments["fat"]),
    source: "openfoodfacts",
  };
}

interface CacheEntry {
  at: number;
  row: FoodRow | null;
}

/**
 * A barcode's nutrition does not change, so the cache is about not asking
 * again rather than about freshness -- but a product that was missing today can
 * be added by someone tomorrow, so a miss is remembered for far less time than
 * a hit. Both are remembered: re-asking for a barcode that is not in their
 * database is exactly the traffic their documentation asks us not to send.
 */
export const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MISS_TTL_MS = 24 * 60 * 60 * 1000;

export class FoodCache {
  readonly filePath: string;
  private entries = new Map<string, CacheEntry>();
  private loaded = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "food-cache.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Record<string, CacheEntry>;
      for (const [code, entry] of Object.entries(parsed ?? {})) {
        if (entry && typeof entry.at === "number") this.entries.set(code, entry);
      }
    } catch {
      // No cache file yet, or one we cannot parse. Either way the upstream is
      // the source of truth and a warm cache is not worth failing a lookup for.
    }
  }

  async get(code: string, now: number): Promise<CacheEntry | undefined> {
    await this.load();
    const entry = this.entries.get(code);
    if (!entry) return undefined;
    const ttl = entry.row ? HIT_TTL_MS : MISS_TTL_MS;
    if (now - entry.at >= ttl) {
      this.entries.delete(code);
      return undefined;
    }
    return entry;
  }

  async set(code: string, row: FoodRow | null, now: number): Promise<void> {
    await this.load();
    this.entries.set(code, { at: now, row });
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of this.entries) out[k] = v;
    try {
      await fs.writeFile(this.filePath, JSON.stringify(out), "utf8");
    } catch {
      // The in-memory copy still works; a read-only volume must not turn a
      // successful lookup into a failed one.
    }
  }
}

export type LookupResult =
  | { status: "invalid" }
  | { status: "found"; row: FoodRow; cached: boolean }
  | { status: "missing"; cached: boolean }
  | { status: "upstream" };

export interface LookupDeps {
  cache: FoodCache;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * One barcode in, one row out. Note what is deliberately *not* trusted: their
 * API answers HTTP 200 with `status: 0` for a barcode it has never seen, so a
 * check that reads the status code alone would report every unknown product as
 * a successful lookup of an empty product.
 */
export async function lookupBarcode(code: string, deps: LookupDeps): Promise<LookupResult> {
  if (!isBarcode(code)) return { status: "invalid" };
  const now = deps.now ? deps.now() : Date.now();
  const hit = await deps.cache.get(code, now);
  if (hit) return hit.row ? { status: "found", row: hit.row, cached: true } : { status: "missing", cached: true };

  const url = `${OFF_BASE}/api/v2/product/${code}.json?fields=${OFF_FIELDS}`;
  let body: unknown;
  try {
    const res = await deps.fetch(url, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    // Both shapes are real and I measured both against their live API: an
    // unknown-but-well-formed barcode is a 404, and a malformed one is a 200
    // carrying `status: 0`. Reading only the second maps a genuine miss onto a
    // 502, which tells the client the database is down when it is answering
    // perfectly.
    if (res.status === 404) {
      await deps.cache.set(code, null, now);
      return { status: "missing", cached: false };
    }
    if (!res.ok) return { status: "upstream" };
    body = await res.json();
  } catch {
    return { status: "upstream" };
  }

  const doc = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const row = doc.status === 1 || doc.status === "1" ? normalizeProduct(code, doc.product) : null;
  await deps.cache.set(code, row, now);
  return row ? { status: "found", row, cached: false } : { status: "missing", cached: false };
}
