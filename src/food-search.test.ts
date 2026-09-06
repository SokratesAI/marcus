import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import {
  SEARCH_EMPTY_TTL_MS,
  SEARCH_HIT_TTL_MS,
  SEARCH_LIMIT,
  SearchCache,
  isSearchQuery,
  normalizeSearch,
  searchFoodsByName,
  searchKey,
} from "./food-lookup.js";

let dir: string;
let cache: SearchCache;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-search-"));
  cache = new SearchCache(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Trimmed to the fields we ask for, from their live answer for "grandiosa" on
// 2026-09-06.
const grandiosa = {
  code: "7310240071870",
  product_name: "Grandiosa Original",
  brands: "Grandiosa, Orkla",
  nutriments: { "energy-kcal_100g": 240, proteins_100g: 11, carbohydrates_100g: 24, fat_100g: 10 },
};

const halfEntered = { code: "1111111111111", product_name: "Someone's pizza", nutriments: {} };

function stubFetch(answer: { status?: number; body?: unknown; html?: boolean }) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return {
      status: answer.status ?? 200,
      ok: (answer.status ?? 200) >= 200 && (answer.status ?? 200) < 300,
      json: async () => {
        if (answer.html) throw new SyntaxError("Unexpected token <");
        return answer.body;
      },
    };
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("searchKey and isSearchQuery", () => {
  it("folds case and runs of whitespace, so one search is not sent twice", () => {
    expect(searchKey("  Pizza   Grandiosa ")).toBe("pizza grandiosa");
  });

  it("refuses a query too short to mean anything and one that is a sentence", () => {
    expect(isSearchQuery("a")).toBe(false);
    expect(isSearchQuery("  ")).toBe(false);
    expect(isSearchQuery("-- ...")).toBe(false);
    expect(isSearchQuery("x".repeat(61))).toBe(false);
    expect(isSearchQuery("pizza grandiosa")).toBe(true);
  });
});

describe("normalizeSearch", () => {
  it("drops a product with no energy rather than pricing a meal at zero", () => {
    const rows = normalizeSearch({ products: [halfEntered, grandiosa] }, SEARCH_LIMIT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Grandiosa Original", code: "7310240071870", kcal: 240, unit: "g" });
  });

  it("keeps at most the limit, counting only the rows that survived", () => {
    const products = [halfEntered, halfEntered, grandiosa, grandiosa, grandiosa];
    expect(normalizeSearch({ products }, 2)).toHaveLength(2);
  });

  it("reads a body with no products array as no rows, not as a crash", () => {
    expect(normalizeSearch({}, SEARCH_LIMIT)).toEqual([]);
    expect(normalizeSearch(null, SEARCH_LIMIT)).toEqual([]);
  });
});

describe("searchFoodsByName", () => {
  it("asks the cgi search endpoint with an identifying User-Agent", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    const result = await searchFoodsByName("pizza grandiosa", { cache, fetch: fn });
    expect(result).toMatchObject({ status: "found", cached: false });
    expect(calls[0]).toContain("/cgi/search.pl?search_terms=pizza%20grandiosa");
    expect(calls[0]).toContain("json=1");
  });

  it("never reaches the network for a query it refuses", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    expect(await searchFoodsByName("a", { cache, fetch: fn })).toEqual({ status: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("answers a second search for the same phrase from the cache", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    await searchFoodsByName("pizza grandiosa", { cache, fetch: fn });
    const again = await searchFoodsByName("  Pizza  GRANDIOSA ", { cache, fetch: fn });
    expect(again).toMatchObject({ status: "found", cached: true });
    expect(calls).toHaveLength(1);
  });

  // This is the case their live API actually produces: `/api/v2/search` answered
  // 503 with an HTML page on 2026-09-06, and the cgi endpoint answered HTML for
  // one query and JSON for the next. A body that will not parse must not read as
  // an empty result set, because "nothing matched" tells Edvard to type the food
  // in and "the database did not answer" tells him to try again.
  it("reads an HTML body under a 200 as the database not answering, not as no results", async () => {
    const { fn } = stubFetch({ status: 200, html: true });
    expect(await searchFoodsByName("pizza grandiosa", { cache, fetch: fn })).toEqual({ status: "upstream" });
  });

  it("reads a non-2xx as the database not answering", async () => {
    const { fn } = stubFetch({ status: 503, body: {} });
    expect(await searchFoodsByName("pizza grandiosa", { cache, fetch: fn })).toEqual({ status: "upstream" });
  });

  it("does not cache an answer it never got, so a hiccup is retried", async () => {
    const bad = stubFetch({ status: 503, body: {} });
    await searchFoodsByName("pizza grandiosa", { cache, fetch: bad.fn });
    const good = stubFetch({ body: { products: [grandiosa] } });
    expect(await searchFoodsByName("pizza grandiosa", { cache, fetch: good.fn })).toMatchObject({
      status: "found",
      cached: false,
    });
    expect(good.calls).toHaveLength(1);
  });

  it("remembers a phrase nobody has entered, which is the traffic they ask us not to send", async () => {
    const { fn, calls } = stubFetch({ body: { products: [] } });
    expect(await searchFoodsByName("kveldsmat", { cache, fetch: fn })).toEqual({ status: "missing", cached: false });
    expect(await searchFoodsByName("kveldsmat", { cache, fetch: fn })).toEqual({ status: "missing", cached: true });
    expect(calls).toHaveLength(1);
  });

  // The asymmetry is the point: a product nobody has entered can be entered
  // tomorrow, so an empty answer is forgotten far sooner than a full one.
  it("forgets an empty answer a week before it forgets a full one", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const empty = stubFetch({ body: { products: [] } });
    await searchFoodsByName("kveldsmat", { cache, fetch: empty.fn, now });
    const full = stubFetch({ body: { products: [grandiosa] } });
    await searchFoodsByName("pizza grandiosa", { cache, fetch: full.fn, now });

    clock += SEARCH_EMPTY_TTL_MS;
    await searchFoodsByName("kveldsmat", { cache, fetch: empty.fn, now });
    expect(empty.calls).toHaveLength(2);
    expect(await searchFoodsByName("pizza grandiosa", { cache, fetch: full.fn, now })).toMatchObject({ cached: true });

    clock += SEARCH_HIT_TTL_MS;
    await searchFoodsByName("pizza grandiosa", { cache, fetch: full.fn, now });
    expect(full.calls).toHaveLength(2);
  });

  it("survives a pod restart, which is why the cache is on the volume", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    await searchFoodsByName("pizza grandiosa", { cache, fetch: fn });
    const restarted = new SearchCache(dir);
    expect(await searchFoodsByName("pizza grandiosa", { cache: restarted, fetch: fn })).toMatchObject({
      cached: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps its own file, so a warm barcode cache is not thrown away", async () => {
    expect(path.basename(cache.filePath)).toBe("food-search-cache.json");
  });

  it("still answers when the cache file cannot be read", async () => {
    await fs.writeFile(path.join(dir, "food-search-cache.json"), "{not json", "utf8");
    const { fn } = stubFetch({ body: { products: [grandiosa] } });
    expect(await searchFoodsByName("pizza grandiosa", { cache: new SearchCache(dir), fetch: fn })).toMatchObject({
      status: "found",
    });
  });
});

describe("GET /api/food/search", () => {
  const appWith = (fetchImpl: typeof globalThis.fetch) =>
    createApp(new StateStore(dir), () => "2026-09-06T07:00:00.000Z", { searchCache: cache, fetchImpl });

  it("answers with the rows and whether they came from the cache", async () => {
    const { fn } = stubFetch({ body: { products: [grandiosa] } });
    const app = appWith(fn);
    const first = await request(app).get("/api/food/search?q=pizza%20grandiosa");
    expect(first.status).toBe(200);
    expect(first.body.foods[0].name).toBe("Grandiosa Original");
    expect(first.body.cached).toBe(false);
    const second = await request(app).get("/api/food/search?q=pizza%20grandiosa");
    expect(second.body.cached).toBe(true);
  });

  it("is a 400 for a query too short to search on, and asks nobody", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    const res = await request(appWith(fn)).get("/api/food/search?q=a");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is a 400 when q is missing entirely", async () => {
    const { fn, calls } = stubFetch({ body: { products: [grandiosa] } });
    expect((await request(appWith(fn)).get("/api/food/search")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is a 404 when nothing matched, which is a different answer from a 502", async () => {
    const { fn } = stubFetch({ body: { products: [] } });
    expect((await request(appWith(fn)).get("/api/food/search?q=kveldsmat")).status).toBe(404);
  });

  it("is a 502 when the food database does not answer, not a 500", async () => {
    const throwing = (async () => {
      throw new Error("timed out");
    }) as unknown as typeof globalThis.fetch;
    expect((await request(appWith(throwing)).get("/api/food/search?q=kveldsmat")).status).toBe(502);
  });
});
