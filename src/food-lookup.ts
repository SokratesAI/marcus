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
    // The barcode door returns brands as one comma-joined string, the search
    // service returns them as an array. Splitting the array's own join gets the
    // right answer for `["Grandiosa", "Orkla"]` by luck and the wrong one for
    // `["Ferrero, Inc.", "Yum yum"]`, so the array case is taken first.
    brand: Array.isArray(p.brands)
      ? String(p.brands[0] ?? "").trim()
      : String(p.brands || "").split(",")[0].trim(),
    unit: "g",
    kcal,
    protein: macro(nutriments["proteins_100g"] ?? nutriments["proteins"]),
    carbs: macro(nutriments["carbohydrates_100g"] ?? nutriments["carbohydrates"]),
    fat: macro(nutriments["fat_100g"] ?? nutriments["fat"]),
    source: "openfoodfacts",
  };
}

// Both caches on this file are the same file-backed map with a different
// payload, and the tolerance below is the part worth having once rather than
// twice: a cache file that does not exist, or that a half-written pod restart
// left unparseable, must never turn a working lookup into a failed one. The
// on-disk shape stays per-cache, so a warm barcode cache written before the
// search cache existed is still read.
async function readCacheFile<T extends { at: number }>(filePath: string): Promise<[string, T][]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, T>;
    return Object.entries(parsed ?? {}).filter(([, entry]) => entry && typeof entry.at === "number");
  } catch {
    return [];
  }
}

async function writeCacheFile<T>(filePath: string, entries: Map<string, T>): Promise<void> {
  const out: Record<string, T> = {};
  for (const [k, v] of entries) out[k] = v;
  try {
    await fs.writeFile(filePath, JSON.stringify(out), "utf8");
  } catch {
    // The in-memory copy still works; a read-only volume must not turn a
    // successful lookup into a failed one.
  }
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
    for (const [code, entry] of await readCacheFile<CacheEntry>(this.filePath)) this.entries.set(code, entry);
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
    await writeCacheFile(this.filePath, this.entries);
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

// --- Searching by name -------------------------------------------------------
// Idea #205 asks for "a whole pizza Grandiosa" to become a priced meal. The
// sentence parser in app.js gets it as far as an unmatched phrase, because the
// 31-food table it matches against has no Grandiosa in it and never will. This
// is the missing half: the same database the barcode route already talks to,
// asked by name instead of by number, through the same proxy for the same two
// reasons (their rate-limit etiquette, and one place where what Edvard eats
// leaves this cluster).
//
// Search does not live on `world.openfoodfacts.org` at all, and that is the
// whole reason this route was unreliable. Measured 2026-09-06 19:12 Oslo, eight
// identical requests each from this cluster: `/cgi/search.pl?...&json=1`
// answered a parseable 200 **two times out of eight** and an HTML 503 the other
// six; `/api/v2/search` managed four out of eight; and Open Food Facts' own
// search service at `search.openfoodfacts.org/search` answered **eight out of
// eight**, in 0.21s against the other two's 0.5-0.8s. So the earlier note here
// -- that the cgi door was the working one -- was true only of the sample it
// was taken on. A user typing a food name got "the food database did not
// answer" three times in four.
//
// The HTML-body tolerance below stays exactly as it was. It is cheap, the new
// endpoint is the same project behind the same edge, and a 503 page is what
// this whole family of hosts serves when it is busy -- so the parse stays
// inside the try and a body that is not JSON reads as "upstream did not answer"
// rather than as an empty result set.
export const SEARCH_BASE = "https://search.openfoodfacts.org";
export const OFF_SEARCH_PATH = "/search";
const SEARCH_FIELDS = "code,product_name,product_name_en,brands,nutriments";

/** Five is what fits on a phone under the box you typed into. */
export const SEARCH_LIMIT = 5;

// A name search is not a barcode: the answer changes as products are added, so
// it is remembered for a week rather than a month, and an empty answer for a
// day -- the same asymmetry and the same reason as the barcode cache.
export const SEARCH_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The cache key, and it is deliberately not the raw string. "Pizza  Grandiosa"
 * and "pizza grandiosa" are one search, and treating them as two sends a second
 * request upstream for an answer we are already holding.
 */
export function searchKey(query: string): string {
  return String(query ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Two characters is the shortest query worth sending: a single letter matches
 * most of their database and the answer is noise. Sixty is where a phrase has
 * stopped being a food name and is a sentence the parser should have split.
 */
export function isSearchQuery(query: unknown): boolean {
  const key = searchKey(String(query ?? ""));
  return key.length >= 2 && key.length <= 60 && /[a-z0-9]/.test(key);
}

interface SearchEntry {
  at: number;
  rows: FoodRow[];
}

export class SearchCache {
  readonly filePath: string;
  private entries = new Map<string, SearchEntry>();
  private loaded = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "food-search-cache.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    for (const [key, entry] of await readCacheFile<SearchEntry>(this.filePath)) {
      if (Array.isArray(entry.rows)) this.entries.set(key, entry);
    }
  }

  async get(key: string, now: number): Promise<SearchEntry | undefined> {
    await this.load();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ttl = entry.rows.length ? SEARCH_HIT_TTL_MS : SEARCH_EMPTY_TTL_MS;
    if (now - entry.at >= ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, rows: FoodRow[], now: number): Promise<void> {
    await this.load();
    this.entries.set(key, { at: now, rows });
    await writeCacheFile(this.filePath, this.entries);
  }
}

export type SearchResult =
  | { status: "invalid" }
  | { status: "found"; rows: FoodRow[]; cached: boolean }
  | { status: "missing"; cached: boolean }
  | { status: "upstream" };

export interface SearchDeps {
  cache: SearchCache;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  limit?: number;
}

/**
 * Their search answer into our rows. A product with no name or no energy is
 * dropped rather than priced, exactly as the barcode path drops it -- a search
 * that returns forty half-entered rows and one real one should hand back the
 * real one, not the count.
 */
export function normalizeSearch(body: unknown, limit: number): FoodRow[] {
  const doc = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  // The search service names its result list `hits`; the old cgi door called it
  // `products`. Same database, same row shape, different key.
  const products = Array.isArray(doc.hits) ? doc.hits : [];
  const rows: FoodRow[] = [];
  for (const product of products) {
    if (rows.length >= limit) break;
    const code = String((product as Record<string, unknown> | null)?.code ?? "");
    const row = normalizeProduct(code, product);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * One phrase in, up to five rows out. `missing` is a real answer and is kept
 * apart from `upstream` for the same reason the barcode route keeps them apart:
 * "nobody has entered a Grandiosa" is worth typing in by hand, and "the
 * database did not answer" is worth trying again in a minute.
 */
export async function searchFoodsByName(query: string, deps: SearchDeps): Promise<SearchResult> {
  if (!isSearchQuery(query)) return { status: "invalid" };
  const key = searchKey(query);
  const limit = deps.limit ?? SEARCH_LIMIT;
  const now = deps.now ? deps.now() : Date.now();
  const hit = await deps.cache.get(key, now);
  if (hit) {
    return hit.rows.length ? { status: "found", rows: hit.rows, cached: true } : { status: "missing", cached: true };
  }

  const url = `${SEARCH_BASE}${OFF_SEARCH_PATH}?q=${encodeURIComponent(key)}`
    + `&page_size=${limit * 4}&fields=${SEARCH_FIELDS}`;
  let rows: FoodRow[];
  try {
    const res = await deps.fetch(url, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
    });
    if (!res.ok) return { status: "upstream" };
    // Inside the try on purpose: their search answers HTML under a 200 often
    // enough that a parse failure outside it would be read as "no products".
    rows = normalizeSearch(await res.json(), limit);
  } catch {
    return { status: "upstream" };
  }

  await deps.cache.set(key, rows, now);
  return rows.length ? { status: "found", rows, cached: false } : { status: "missing", cached: false };
}
