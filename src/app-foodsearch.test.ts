import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

type Answer = { status: number; body?: unknown; throws?: boolean; badJson?: boolean };

// Same vm harness as app-barcode.test.ts, plus a fetch this test controls.
// The context deliberately has no real `fetch`: every call the app makes here
// has to come back from `answer`, so a test that passed by reaching the network
// is not possible.
function loadApp(answer?: Answer): { ctx: any; toasts: string[]; byId: Record<string, any>; asked: string[] } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};
  const asked: string[] = [];

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      disabled: false,
      hidden: false,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      content: { firstElementChild: { cloneNode: () => makeNode() } },
      appendChild() {},
      remove() {},
      addEventListener(name: string, fn: any) {
        (node.handlers ??= {})[name] = fn;
      },
      querySelector: () => makeNode(),
      querySelectorAll: () => [],
      getContext: () => ({}),
      handlers: {} as Record<string, any>,
    };
    return node;
  };

  const byId: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (byId[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console, setTimeout, clearTimeout, Promise,
    Math, JSON, Number, String, Array, Object, Date, RegExp,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async (url: string) => {
      asked.push(url);
      if (!answer) throw new Error("no answer configured");
      if (answer.throws) throw new TypeError("Failed to fetch");
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        json: async () => {
          if (answer.badJson) throw new SyntaxError("Unexpected token <");
          return answer.body;
        },
      };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.FOODS = FOODS;" +
      "\n;Object.defineProperty(globalThis, 'foodPick', { get: () => foodPick });" +
      "\n;Object.defineProperty(globalThis, 'mealParse', { get: () => mealParse, set: (v) => { mealParse = v; } });",
    ctx,
  );
  // Boot asks the server for the state copy (issue #153). That request is real
  // and is asserted in app-servercopy.test.ts; here it is noise in front of the
  // one call each test below is about, so the log starts after boot.
  asked.length = 0;
  return { ctx, toasts, byId, asked };
}


const GRANDIOSA = {
  name: "Grandiosa Original", code: "7310240071870", brand: "Grandiosa",
  unit: "g", kcal: 240, protein: 11, carbs: 24, fat: 10, source: "openfoodfacts",
};

describe("lookUpFoodByName", () => {
  it("asks the server's proxy route, never Open Food Facts directly", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: { foods: [GRANDIOSA], cached: false } });
    const result = await ctx.lookUpFoodByName("pizza  Grandiosa ");
    expect(result).toMatchObject({ ok: true, cached: false });
    expect(result.foods[0].name).toBe("Grandiosa Original");
    expect(asked).toEqual(["/api/food/search?q=pizza%20Grandiosa"]);
    expect(asked[0]).not.toContain("openfoodfacts");
  });

  it("does not ask at all for a phrase too short to search on", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: { foods: [GRANDIOSA] } });
    expect(await ctx.lookUpFoodByName("a")).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });

  // The four failures say different things to somebody holding a plate, and
  // collapsing them into "it did not work" is what makes an app feel broken.
  it("says nothing matched for a 404, and try again for a 502", async () => {
    const missing = loadApp({ status: 404, body: { error: "nothing matched that" } });
    expect((await missing.ctx.lookUpFoodByName("kveldsmat")).message).toContain("Nothing matched");
    const down = loadApp({ status: 502, body: { error: "the food database did not answer" } });
    expect((await down.ctx.lookUpFoodByName("kveldsmat")).message).toContain("did not answer");
  });

  it("says no connection when the request throws rather than answering", async () => {
    const { ctx } = loadApp({ status: 0, throws: true });
    expect((await ctx.lookUpFoodByName("pizza grandiosa")).message).toContain("No connection");
  });

  it("reads a 200 whose body will not parse as the database not answering", async () => {
    const { ctx } = loadApp({ status: 200, badJson: true });
    expect((await ctx.lookUpFoodByName("pizza grandiosa")).message).toContain("did not answer");
  });

  // However well the request went, a row with no calorie number would write a
  // 0 kcal meal into the day's total.
  it("refuses a row with no name or no calorie number", async () => {
    const { ctx } = loadApp({ status: 200, body: { foods: [{ name: "Mystery", unit: "g" }] } });
    expect(await ctx.lookUpFoodByName("mystery")).toMatchObject({ ok: false });
    const nameless = loadApp({ status: 200, body: { foods: [{ kcal: 100, unit: "g" }] } });
    expect(await nameless.ctx.lookUpFoodByName("mystery")).toMatchObject({ ok: false });
  });

  it("reads a 200 carrying no foods as nothing matched", async () => {
    const { ctx } = loadApp({ status: 200, body: { foods: [] } });
    expect((await ctx.lookUpFoodByName("kveldsmat")).message).toContain("Nothing matched");
  });
});

describe("lookUpParsedPhrase", () => {
  const withParse = (answer: any) => {
    const app = loadApp(answer);
    app.ctx.mealParse = { label: "dinner", items: [], unmatched: ["pizza grandiosa", "kveldsmat"] };
    return app;
  };

  it("puts the top match in the picker and takes the phrase off the unmatched list", async () => {
    const { ctx, asked } = withParse({ status: 200, body: { foods: [GRANDIOSA], cached: false } });
    await ctx.lookUpParsedPhrase(0);
    expect(asked).toEqual(["/api/food/search?q=pizza%20grandiosa"]);
    expect(ctx.foodPick.name).toBe("Grandiosa Original");
    expect(ctx.mealParse.unmatched).toEqual(["kveldsmat"]);
  });

  // A lookup that found nothing must leave the phrase there: it is the only
  // record of what he typed, and dropping it would silently lose part of the
  // meal he described.
  it("leaves the phrase and picks nothing when the lookup fails", async () => {
    const { ctx, toasts } = withParse({ status: 404, body: {} });
    await ctx.lookUpParsedPhrase(0);
    expect(ctx.foodPick).toBe(null);
    expect(ctx.mealParse.unmatched).toEqual(["pizza grandiosa", "kveldsmat"]);
    expect(toasts.join(" ")).toContain("Nothing matched");
  });

  it("disables the button while the call is in flight, so a second tap sends no second request", async () => {
    const { ctx, asked } = withParse({ status: 200, body: { foods: [GRANDIOSA] } });
    const seen: boolean[] = [];
    Object.defineProperty(ctx.document.getElementById("lookUpPhrase0"), "disabled", {
      get: () => seen[seen.length - 1] ?? false,
      set: (v: boolean) => seen.push(v),
    });
    await ctx.lookUpParsedPhrase(0);
    expect(seen).toEqual([true, false]);
    expect(asked).toHaveLength(1);
  });

  it("does nothing at all when there is no parse or no such phrase", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: { foods: [GRANDIOSA] } });
    await ctx.lookUpParsedPhrase(0);
    const withOne = withParse({ status: 200, body: { foods: [GRANDIOSA] } });
    await withOne.ctx.lookUpParsedPhrase(7);
    expect(asked).toEqual([]);
    expect(withOne.asked).toEqual([]);
  });

  it("clears the parse box once the last unmatched phrase is looked up and no items are left", async () => {
    const { ctx } = loadApp({ status: 200, body: { foods: [GRANDIOSA] } });
    ctx.mealParse = { label: null, items: [], unmatched: ["pizza grandiosa"] };
    await ctx.lookUpParsedPhrase(0);
    expect(ctx.mealParse).toBe(null);
  });
});

// The upstream call is seconds long and the parse box is live underneath it:
// tapping Add clears the parse, and dropping a row shifts every index after it.
// An index captured before the await is a stale one by the time it is used.
describe("lookUpParsedPhrase while the parse box moves under it", () => {
  const slowApp = () => {
    const app = loadApp({ status: 200, body: { foods: [GRANDIOSA] } });
    app.ctx.mealParse = { label: null, items: [], unmatched: ["kveldsmat", "pizza grandiosa"] };
    return app;
  };

  it("still puts the food in the picker when the parse is cleared mid-flight", async () => {
    const { ctx } = slowApp();
    const inFlight = ctx.lookUpParsedPhrase(1);
    ctx.mealParse = null;
    await inFlight;
    expect(ctx.foodPick.name).toBe("Grandiosa Original");
    expect(ctx.mealParse).toBe(null);
  });

  it("drops the phrase it looked up, not whatever moved into that index", async () => {
    const { ctx } = slowApp();
    const inFlight = ctx.lookUpParsedPhrase(1);
    ctx.mealParse.unmatched.splice(0, 1);
    await inFlight;
    expect(ctx.mealParse).toBe(null);
  });
});
