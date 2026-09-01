import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same shape as app-validation.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// `byId` is returned as well because the food picker renders into #foodPicked
// and then reads #foodAmount back, and this stub does not parse HTML — a test
// that drives the picker has to set that input's value itself.
function loadApp(opts: { now?: Date } = {}): { ctx: any; toasts: string[]; byId: Record<string, any>; stored: Record<string, string> } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
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
    console, setTimeout, clearTimeout,
    Math, JSON, Number, String, Array, Object,
    // `new Date()` with no argument is the app's only clock. Left real, a test
    // of the timestamp is judged against whatever time the suite happens to run
    // at -- which is why a two-digit hour cannot fail one. Every other call
    // shape passes straight through.
    Date: opts.now
      ? new Proxy(Date, {
          construct(target, args: any[]) {
            return args.length ? new (target as any)(...args) : new (target as any)(opts.now!.getTime());
          },
        })
      : Date,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  // `const`/`let` at the top level of a script are lexical, so unlike a
  // `function` declaration they never land on the context's global object.
  // FOODS is read by every test here and recentMealCache is reassigned on each
  // render, so it is exposed as a getter rather than a snapshot.
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.FOODS = FOODS;" +
      "\n;Object.defineProperty(globalThis, 'recentMealCache', { get: () => recentMealCache });" +
      // `mealParse` is lexical too, and these tests drive the add/drop handlers
      // that read and write it, so it needs a setter as well as a getter.
      "\n;Object.defineProperty(globalThis, 'mealParse', { get: () => mealParse, set: (v) => { mealParse = v; } });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

describe("parseMealPhrase", () => {
  it("reads a word quantity for a food priced per item", () => {
    const { ctx } = loadApp();
    const item = ctx.parseMealPhrase("two eggs");
    expect(item.food.name).toBe("Egg");
    expect(item.unit).toBe("each");
    expect(item.amount).toBe(2);
    expect(item.assumed).toBe(false);
  });

  it("reads a digit quantity with a gram unit for a weighed food", () => {
    const { ctx } = loadApp();
    const item = ctx.parseMealPhrase("150 g chicken breast");
    expect(item.food.name).toBe("Chicken breast, cooked");
    expect(item.unit).toBe("g");
    expect(item.amount).toBe(150);
  });

  it("converts kilograms to grams", () => {
    const { ctx } = loadApp();
    expect(ctx.parseMealPhrase("1.5 kg rice").amount).toBe(1500);
  });

  it("leaves the amount unknown for a weighed food with no unit rather than inventing one", () => {
    const { ctx } = loadApp();
    const bare = ctx.parseMealPhrase("rice");
    expect(bare.food.name).toBe("Rice, cooked");
    expect(bare.amount).toBe(null);
    const numbered = ctx.parseMealPhrase("2 rice");
    expect(numbered.amount).toBe(null);
  });

  it("assumes one of a countable food and says that it assumed", () => {
    const { ctx } = loadApp();
    const item = ctx.parseMealPhrase("banana");
    expect(item.amount).toBe(1);
    expect(item.assumed).toBe(true);
  });

  it("consumes a counting word and keeps its number", () => {
    const { ctx } = loadApp();
    const item = ctx.parseMealPhrase("2 slices of wholemeal bread");
    expect(item.food.name).toBe("Bread, wholemeal slice");
    expect(item.amount).toBe(2);
  });

  it("reads half as a fraction", () => {
    const { ctx } = loadApp();
    const item = ctx.parseMealPhrase("half an avocado");
    expect(item.food.name).toBe("Avocado");
    expect(item.amount).toBe(0.5);
  });

  it("does not turn a one- or two-letter fragment into a food", () => {
    const { ctx } = loadApp();
    // A prefix that short matches half the table, so it is required to be exact.
    expect(ctx.parseMealPhrase("ap")).toBe(null);
    expect(ctx.parseMealPhrase("100 g ri")).toBe(null);
  });

  it("refuses a phrase whose words are not all in one food name", () => {
    const { ctx } = loadApp();
    expect(ctx.parseMealPhrase("a whole pizza grandiosa")).toBe(null);
    expect(ctx.parseMealPhrase("kale")).toBe(null);
    expect(ctx.parseMealPhrase("")).toBe(null);
  });

  it("prefers the shorter food name when several contain the word", () => {
    const { ctx } = loadApp();
    const names = ctx.FOODS.filter((f: any) => f.name.toLowerCase().includes("cheese")).map((f: any) => f.name);
    expect(names.length).toBeGreaterThan(1);
    expect(ctx.parseMealPhrase("cheese").food.name).toBe("Cottage cheese");
  });

  it("matches a plural the table spells singular, and the other way round", () => {
    const { ctx } = loadApp();
    expect(ctx.parseMealPhrase("almonds").food.name).toBe("Almonds");
    expect(ctx.parseMealPhrase("100 g oat").food.name).toBe("Oats, dry");
  });
});

describe("parseMealSentence", () => {
  it("splits on commas and the word and, and cuts a leading label", () => {
    const { ctx } = loadApp();
    const out = ctx.parseMealSentence("dinner: 200 g salmon, 150 g rice and broccoli");
    expect(out.label).toBe("dinner");
    expect(out.items.map((i: any) => i.food.name)).toEqual([
      "Salmon, cooked", "Rice, cooked", "Broccoli, cooked",
    ]);
    expect(out.unmatched).toEqual([]);
  });

  it("names back the phrases it could not place instead of dropping them", () => {
    const { ctx } = loadApp();
    const out = ctx.parseMealSentence("lunch: a whole pizza Grandiosa and two eggs");
    expect(out.items.map((i: any) => i.food.name)).toEqual(["Egg"]);
    expect(out.unmatched).toEqual(["a whole pizza Grandiosa"]);
  });

  it("treats a long prefix before a colon as food, not as a label", () => {
    const { ctx } = loadApp();
    const out = ctx.parseMealSentence("two eggs and a banana: nice one");
    expect(out.label).toBe("");
    expect(out.items.map((i: any) => i.food.name)).toContain("Egg");
  });

  it("returns nothing at all for empty input", () => {
    const { ctx } = loadApp();
    const out = ctx.parseMealSentence("   ");
    expect(out.items).toEqual([]);
    expect(out.unmatched).toEqual([]);
  });

  it("hands each item to portionFrom to give real macros", () => {
    const { ctx } = loadApp();
    const out = ctx.parseMealSentence("two eggs");
    const r = ctx.portionFrom(out.items[0].food, out.items[0].amount);
    expect(r.ok).toBe(true);
    expect(r.meal.calories).toBe(156);
    expect(r.meal.name).toBe("Egg (2x)");
  });
});

describe("adding what the sentence read", () => {
  // The store ships with seed meals so an empty app has something to show, so a
  // test that counts what was written has to start from a cleared log.
  const parsed = (ctx: any, text: string) => {
    ctx.store.set("meals", []);
    ctx.mealParse = ctx.parseMealSentence(text);
    return ctx.mealParse;
  };

  it("writes only the rows that carry an amount and leaves the rest on screen", () => {
    const { ctx, toasts } = loadApp();
    const out = parsed(ctx, "two eggs and rice");
    expect(out.items.map((i: any) => i.amount)).toEqual([2, null]);
    ctx.addParsedMeals();
    const meals = ctx.store.get("meals", []);
    expect(meals.map((m: any) => m.name)).toEqual(["Egg (2x)"]);
    expect(toasts).toContain("Added 1 meal");
    expect(ctx.mealParse.items.map((i: any) => i.food.name)).toEqual(["Rice, cooked"]);
  });

  it("refuses to write anything when no row has an amount", () => {
    const { ctx, toasts } = loadApp();
    parsed(ctx, "rice and broccoli");
    ctx.addParsedMeals();
    expect(ctx.store.get("meals", [])).toEqual([]);
    expect(toasts).toContain("Fill in an amount first");
  });

  it("clears the parse once every row is written and nothing was unmatched", () => {
    const { ctx } = loadApp();
    parsed(ctx, "two eggs and a banana");
    ctx.addParsedMeals();
    expect(ctx.store.get("meals", []).length).toBe(2);
    expect(ctx.mealParse).toBe(null);
  });

  it("keeps the parse alive while an unmatched phrase is still on it", () => {
    const { ctx } = loadApp();
    parsed(ctx, "two eggs and a whole pizza Grandiosa");
    ctx.addParsedMeals();
    expect(ctx.mealParse.items).toEqual([]);
    expect(ctx.mealParse.unmatched).toEqual(["a whole pizza Grandiosa"]);
  });

  it("setParsedAmount fills an unknown amount and stops calling it assumed", () => {
    const { ctx } = loadApp();
    parsed(ctx, "rice and banana");
    ctx.setParsedAmount(0, "180");
    expect(ctx.mealParse.items[0].amount).toBe(180);
    expect(ctx.mealParse.items[1].assumed).toBe(true);
    ctx.setParsedAmount(1, "2");
    expect(ctx.mealParse.items[1].assumed).toBe(false);
    ctx.addParsedMeals();
    const names = ctx.store.get("meals", []).map((m: any) => m.name);
    expect(names).toContain("Rice, cooked (180 g)");
    expect(names).toContain("Banana (2x)");
  });

  it("setParsedAmount takes an emptied box back to unknown rather than to zero", () => {
    const { ctx } = loadApp();
    parsed(ctx, "two eggs");
    ctx.setParsedAmount(0, "  ");
    expect(ctx.mealParse.items[0].amount).toBe(null);
    ctx.addParsedMeals();
    expect(ctx.store.get("meals", [])).toEqual([]);
  });

  it("dropParsedItem removes one row and clears the parse when it was the last", () => {
    const { ctx } = loadApp();
    parsed(ctx, "two eggs and a banana");
    ctx.dropParsedItem(0);
    expect(ctx.mealParse.items.map((i: any) => i.food.name)).toEqual(["Banana"]);
    ctx.dropParsedItem(0);
    expect(ctx.mealParse).toBe(null);
  });
});
