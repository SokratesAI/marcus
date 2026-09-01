import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

type Answer = { status: number; body?: unknown; throws?: boolean; badJson?: boolean };

// Same vm harness as app-nutrition.test.ts, plus a fetch this test controls.
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
      "\n;Object.defineProperty(globalThis, 'foodPick', { get: () => foodPick });",
    ctx,
  );
  return { ctx, toasts, byId, asked };
}

const GRANDIOSA = {
  food: { name: "Grandiosa Original", unit: "g", kcal: 235, protein: 9.5, carbs: 27, fat: 9.8 },
  cached: false,
};

describe("lookupBarcodeFood", () => {
  it("asks the server's proxy route, never Open Food Facts directly", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: GRANDIOSA });
    const out = await ctx.lookupBarcodeFood("7038010009457");
    expect(out.ok).toBe(true);
    expect(out.food.name).toBe("Grandiosa Original");
    expect(asked).toEqual(["/api/food/barcode/7038010009457"]);
  });

  it("strips the spaces and dashes a barcode is printed with", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: GRANDIOSA });
    const out = await ctx.lookupBarcodeFood(" 7038 010-009457 ");
    expect(out.ok).toBe(true);
    expect(asked).toEqual(["/api/food/barcode/7038010009457"]);
  });

  it("refuses a code that is not 8 to 14 digits without asking anyone", async () => {
    const { ctx, asked } = loadApp({ status: 200, body: GRANDIOSA });
    for (const bad of ["", "1234567", "123456789012345", "70380100094a7"]) {
      const out = await ctx.lookupBarcodeFood(bad);
      expect(out.ok).toBe(false);
      expect(out.message).toBe("A barcode is 8 to 14 digits.");
    }
    expect(asked).toEqual([]);
  });

  // The whole point of the separate messages: these two both mean "no food",
  // and one of them is worth waiting out while the other never will be.
  it("says something different for an unknown barcode and for a dead database", async () => {
    const missing = await loadApp({ status: 404, body: {} }).ctx.lookupBarcodeFood("7038010009457");
    const upstream = await loadApp({ status: 502, body: {} }).ctx.lookupBarcodeFood("7038010009457");
    expect(missing.ok).toBe(false);
    expect(upstream.ok).toBe(false);
    expect(missing.message).not.toBe(upstream.message);
    expect(missing.message).toContain("Nobody has entered");
    expect(upstream.message).toContain("try again");
  });

  it("treats a connection that never opens as no connection, not as a missing food", async () => {
    const { ctx } = loadApp({ status: 200, throws: true });
    const out = await ctx.lookupBarcodeFood("7038010009457");
    expect(out.ok).toBe(false);
    expect(out.message).toContain("No connection");
  });

  it("does not accept a 200 whose body is not a food", async () => {
    for (const body of [{}, { food: null }, { food: { name: "Nameless" } }, { food: { kcal: 200 } }]) {
      const { ctx } = loadApp({ status: 200, body });
      const out = await ctx.lookupBarcodeFood("7038010009457");
      expect(out.ok).toBe(false);
      expect(out.message).toContain("no nutrition");
    }
  });

  it("does not accept a 200 whose body is not JSON at all", async () => {
    const { ctx } = loadApp({ status: 200, badJson: true });
    const out = await ctx.lookupBarcodeFood("7038010009457");
    expect(out.ok).toBe(false);
  });
});

describe("the barcode field on the nutrition tab", () => {
  it("puts a looked-up food into the picker, priced like a table food", async () => {
    const { ctx, byId } = loadApp({ status: 200, body: GRANDIOSA });
    ctx.renderNutrition();
    byId.foodBarcode.value = "7038010009457";
    await byId.lookUpBarcode.handlers.click();
    expect(ctx.foodPick).toBeTruthy();
    expect(ctx.foodPick.name).toBe("Grandiosa Original");
    // Not in FOODS -- the picker used to index into that table, so this is the
    // assertion that fails if the pick ever goes back to being an index.
    expect(ctx.FOODS.some((f: any) => f.name === "Grandiosa Original")).toBe(false);
    const portion = ctx.portionFrom(ctx.foodPick, 200);
    expect(portion.ok).toBe(true);
    expect(portion.meal.calories).toBe(470);
    expect(byId.foodPicked.innerHTML).toContain("Grandiosa Original");
  });

  it("re-enables the button and says why when the lookup fails", async () => {
    const { ctx, byId, toasts } = loadApp({ status: 404, body: {} });
    ctx.renderNutrition();
    byId.foodBarcode.value = "7038010009457";
    await byId.lookUpBarcode.handlers.click();
    expect(ctx.foodPick).toBe(null);
    expect(byId.lookUpBarcode.disabled).toBe(false);
    expect(toasts.at(-1)).toContain("Nobody has entered");
  });

  it("still picks a table food by index", async () => {
    const { ctx } = loadApp({ status: 200, body: GRANDIOSA });
    ctx.renderNutrition();
    ctx.pickFood(0);
    expect(ctx.foodPick).toBe(ctx.FOODS[0]);
  });
});
