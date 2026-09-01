import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import {
  FoodCache,
  HIT_TTL_MS,
  MISS_TTL_MS,
  OFF_USER_AGENT,
  energyKcal,
  isBarcode,
  lookupBarcode,
  normalizeProduct,
} from "./food-lookup.js";

let dir: string;
let cache: FoodCache;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-food-"));
  cache = new FoodCache(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// A real answer from their API, trimmed to the fields we ask for.
const tineProduct = {
  product_name: "Lettmelk",
  brands: "TINE, Tine Meierier",
  nutriments: {
    "energy-kcal_100g": 41.5,
    proteins_100g: 3.8,
    carbohydrates_100g: 4.7,
    fat_100g: 1,
  },
};

const okResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

function stubFetch(body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return okResponse(body);
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("isBarcode", () => {
  it("takes EAN-8 through GTIN-14 and nothing else", () => {
    expect(isBarcode("12345678")).toBe(true);
    expect(isBarcode("12345678901234")).toBe(true);
    expect(isBarcode("1234567")).toBe(false);
    expect(isBarcode("123456789012345")).toBe(false);
    expect(isBarcode("7038010009 45")).toBe(false);
    expect(isBarcode("../../etc/passwd")).toBe(false);
    expect(isBarcode(undefined)).toBe(false);
  });
});

describe("energyKcal", () => {
  it("prefers the kcal field", () => {
    expect(energyKcal({ "energy-kcal_100g": 82, "energy-kj_100g": 3000 })).toBe(82);
  });

  it("converts kJ when the product only lists energy the European way", () => {
    // 1913 kJ / 4.184 = 457.2 kcal
    expect(energyKcal({ "energy-kj_100g": 1913 })).toBe(457);
  });

  it("is null when the product carries no energy at all", () => {
    expect(energyKcal({ proteins_100g: 12 })).toBe(null);
  });
});

describe("normalizeProduct", () => {
  it("returns one row in the shape the local food table already uses", () => {
    expect(normalizeProduct("7038010009457", tineProduct)).toEqual({
      code: "7038010009457",
      name: "Lettmelk",
      brand: "TINE",
      unit: "g",
      kcal: 42,
      protein: 3.8,
      carbs: 4.7,
      fat: 1,
      source: "openfoodfacts",
    });
  });

  it("reads an absent macro as zero but refuses a product with no energy", () => {
    const noMacros = normalizeProduct("12345678", {
      product_name: "Olive oil",
      nutriments: { "energy-kcal_100g": 884, fat_100g: 100 },
    });
    expect(noMacros?.protein).toBe(0);
    expect(noMacros?.carbs).toBe(0);
    expect(normalizeProduct("12345678", { product_name: "Half-filled row", nutriments: {} })).toBe(null);
  });

  it("refuses a product with no name, because a nameless row cannot be logged", () => {
    expect(normalizeProduct("12345678", { nutriments: { "energy-kcal_100g": 100 } })).toBe(null);
  });
});

describe("lookupBarcode", () => {
  it("identifies itself to Open Food Facts and asks for one product", async () => {
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    const result = await lookupBarcode("7038010009457", { cache, fetch: fn });
    expect(result).toMatchObject({ status: "found", cached: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v2/product/7038010009457.json");
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toBe(OFF_USER_AGENT);
  });

  it("never reaches the network for a barcode that cannot be one", async () => {
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    expect(await lookupBarcode("nope", { cache, fetch: fn })).toEqual({ status: "invalid" });
    expect(calls).toHaveLength(0);
  });

  // Their API answers HTTP 200 with status 0 for a barcode it has never seen,
  // so a check that read the status code alone would report every unknown
  // product as a successful lookup.
  it("reads status 0 as a miss even though the HTTP call succeeded", async () => {
    const { fn } = stubFetch({ status: 0, status_verbose: "product not found" });
    expect(await lookupBarcode("12345678", { cache, fetch: fn })).toEqual({
      status: "missing",
      cached: false,
    });
  });

  // Every not-found response I measured against their live API carries no
  // `product` key at all, so the code would reach the same answer by looking at
  // the shape. This fixture is synthetic on purpose: `status` is the field
  // their documentation says means found, and a lookup that infers found-ness
  // from the shape instead is one payload change away from logging a meal off a
  // product row their API had already disowned.
  it("believes the status field over the presence of a product", async () => {
    const { fn } = stubFetch({ status: 0, status_verbose: "product not found", product: tineProduct });
    expect(await lookupBarcode("12345678", { cache, fetch: fn })).toEqual({
      status: "missing",
      cached: false,
    });
  });

  // Measured against their live API on 2026-09-01: 7038010009999 (a
  // well-formed barcode nobody has entered) answers 404, while 00000000 (a
  // malformed one) answers 200 with status 0. Both are misses and only one of
  // them looks like one.
  it("reads a 404 as a miss, not as the database being down", async () => {
    const calls: string[] = [];
    const notFound = (async (url: string | URL) => {
      calls.push(String(url));
      return { ok: false, status: 404, json: async () => ({ status: 0 }) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    expect(await lookupBarcode("7038010009999", { cache, fetch: notFound })).toEqual({
      status: "missing",
      cached: false,
    });
    // and it is remembered, so a re-scan at the gym does not ask them again
    expect(await lookupBarcode("7038010009999", { cache, fetch: notFound })).toEqual({
      status: "missing",
      cached: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports an upstream failure rather than inventing a miss", async () => {
    const failing = (async () => ({ ok: false, status: 429 }) as unknown as Response) as typeof globalThis.fetch;
    expect(await lookupBarcode("12345678", { cache, fetch: failing })).toEqual({ status: "upstream" });
    const throwing = (async () => {
      throw new Error("timed out");
    }) as unknown as typeof globalThis.fetch;
    expect(await lookupBarcode("12345678", { cache, fetch: throwing })).toEqual({ status: "upstream" });
  });

  it("does not cache an upstream failure — the next scan must try again", async () => {
    const throwing = (async () => {
      throw new Error("timed out");
    }) as unknown as typeof globalThis.fetch;
    await lookupBarcode("12345678", { cache, fetch: throwing });
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    expect(await lookupBarcode("12345678", { cache, fetch: fn })).toMatchObject({ status: "found" });
    expect(calls).toHaveLength(1);
  });

  it("asks once and answers from the cache after that", async () => {
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    await lookupBarcode("7038010009457", { cache, fetch: fn });
    const second = await lookupBarcode("7038010009457", { cache, fetch: fn });
    expect(second).toMatchObject({ status: "found", cached: true });
    expect(calls).toHaveLength(1);
  });

  it("remembers a miss too, so an unknown barcode is not re-asked all evening", async () => {
    const { fn, calls } = stubFetch({ status: 0 });
    await lookupBarcode("12345678", { cache, fetch: fn });
    expect(await lookupBarcode("12345678", { cache, fetch: fn })).toEqual({
      status: "missing",
      cached: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("holds a hit far longer than a miss, because a missing product can be added", async () => {
    const hitStub = stubFetch({ status: 1, product: tineProduct });
    const t0 = 1_000_000;
    await lookupBarcode("7038010009457", { cache, fetch: hitStub.fn, now: () => t0 });
    await lookupBarcode("7038010009457", {
      cache,
      fetch: hitStub.fn,
      now: () => t0 + MISS_TTL_MS + 1,
    });
    expect(hitStub.calls).toHaveLength(1);

    const missStub = stubFetch({ status: 0 });
    await lookupBarcode("12345678", { cache, fetch: missStub.fn, now: () => t0 });
    await lookupBarcode("12345678", {
      cache,
      fetch: missStub.fn,
      now: () => t0 + MISS_TTL_MS + 1,
    });
    expect(missStub.calls).toHaveLength(2);

    const staleStub = stubFetch({ status: 1, product: tineProduct });
    await lookupBarcode("7038010009457", {
      cache,
      fetch: staleStub.fn,
      now: () => t0 + HIT_TTL_MS + 1,
    });
    expect(staleStub.calls).toHaveLength(1);
  });

  it("survives a pod restart, which is the whole reason the cache is on the volume", async () => {
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    await lookupBarcode("7038010009457", { cache, fetch: fn });
    const restarted = new FoodCache(dir);
    const result = await lookupBarcode("7038010009457", { cache: restarted, fetch: fn });
    expect(result).toMatchObject({ status: "found", cached: true });
    expect(calls).toHaveLength(1);
  });

  it("still answers when the cache file cannot be read", async () => {
    await fs.writeFile(path.join(dir, "food-cache.json"), "{not json", "utf8");
    const { fn } = stubFetch({ status: 1, product: tineProduct });
    expect(await lookupBarcode("7038010009457", { cache: new FoodCache(dir), fetch: fn })).toMatchObject({
      status: "found",
      cached: false,
    });
  });
});

describe("GET /api/food/barcode/:code", () => {
  const appWith = (fetchImpl: typeof globalThis.fetch) =>
    createApp(new StateStore(dir), () => "2026-09-01T07:00:00.000Z", { foodCache: cache, fetchImpl });

  it("answers with the food row and whether it came from the cache", async () => {
    const { fn } = stubFetch({ status: 1, product: tineProduct });
    const app = appWith(fn);
    const first = await request(app).get("/api/food/barcode/7038010009457");
    expect(first.status).toBe(200);
    expect(first.body.food.name).toBe("Lettmelk");
    expect(first.body.food.kcal).toBe(42);
    expect(first.body.cached).toBe(false);
    const second = await request(app).get("/api/food/barcode/7038010009457");
    expect(second.body.cached).toBe(true);
  });

  it("is a 400 for something that is not a barcode", async () => {
    const { fn, calls } = stubFetch({ status: 1, product: tineProduct });
    const res = await request(appWith(fn)).get("/api/food/barcode/abc");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is a 404 for a barcode their database does not have", async () => {
    const { fn } = stubFetch({ status: 0 });
    const res = await request(appWith(fn)).get("/api/food/barcode/12345678");
    expect(res.status).toBe(404);
  });

  it("is a 502 when the food database does not answer, not a 500", async () => {
    const throwing = (async () => {
      throw new Error("timed out");
    }) as unknown as typeof globalThis.fetch;
    const res = await request(appWith(throwing)).get("/api/food/barcode/12345678");
    expect(res.status).toBe(502);
  });
});
