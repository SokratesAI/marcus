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
      "\n;Object.defineProperty(globalThis, 'recentMealCache', { get: () => recentMealCache });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

const foodNamed = (ctx: any, name: string) => ctx.FOODS.find((f: any) => f.name === name);

describe("searchFoods", () => {
  it("puts name-start matches above mid-name ones", () => {
    const { ctx } = loadApp();
    const hits = ctx.searchFoods("ch").map((h: any) => h.food.name);
    expect(hits.length).toBeGreaterThan(1);
    const firstMid = hits.findIndex((n: string) => !n.toLowerCase().startsWith("ch"));
    const lastStart = hits.map((n: string) => n.toLowerCase().startsWith("ch")).lastIndexOf(true);
    expect(firstMid === -1 || firstMid > lastStart).toBe(true);
    expect(hits).toContain("Cottage cheese");
  });

  it("matches case-insensitively and carries the index back", () => {
    const { ctx } = loadApp();
    const [hit] = ctx.searchFoods("BANANA");
    expect(hit.food.name).toBe("Banana");
    expect(ctx.FOODS[hit.index]).toBe(hit.food);
  });

  it("returns nothing for an empty or whitespace query", () => {
    const { ctx } = loadApp();
    expect(ctx.searchFoods("")).toEqual([]);
    expect(ctx.searchFoods("   ")).toEqual([]);
    expect(ctx.searchFoods(null)).toEqual([]);
  });

  it("caps the list at the limit", () => {
    const { ctx } = loadApp();
    expect(ctx.searchFoods("e", 3).length).toBe(3);
    expect(ctx.searchFoods("e").length).toBeLessThanOrEqual(6);
  });
});

describe("portionFrom", () => {
  it("scales a weighed food off its per-100-g values", () => {
    const { ctx } = loadApp();
    const r = ctx.portionFrom(foodNamed(ctx, "Chicken breast, cooked"), "200");
    expect(r.ok).toBe(true);
    expect(r.meal).toEqual({ name: "Chicken breast, cooked (200 g)", calories: 330, protein: 62, carbs: 0, fat: 7.2 });
  });

  it("scales a counted food per item, not per 100", () => {
    const { ctx } = loadApp();
    const r = ctx.portionFrom(foodNamed(ctx, "Egg"), "3");
    expect(r.ok).toBe(true);
    expect(r.meal).toEqual({ name: "Egg (3x)", calories: 234, protein: 18.9, carbs: 1.8, fat: 15.9 });
  });

  it("allows a half portion of a counted food", () => {
    const { ctx } = loadApp();
    const r = ctx.portionFrom(foodNamed(ctx, "Avocado"), "0.5");
    expect(r.ok).toBe(true);
    expect(r.meal.calories).toBe(120);
  });

  it("refuses an amount outside the bound, naming it", () => {
    const { ctx } = loadApp();
    expect(ctx.portionFrom(foodNamed(ctx, "Rice, cooked"), "0")).toMatchObject({ ok: false });
    expect(ctx.portionFrom(foodNamed(ctx, "Rice, cooked"), "0").message).toMatch(/between 1 and 5000 g/);
    expect(ctx.portionFrom(foodNamed(ctx, "Egg"), "80").message).toMatch(/between 0.25 and 50/);
  });

  it("refuses a blank or non-numeric amount rather than saving a zero", () => {
    const { ctx } = loadApp();
    expect(ctx.portionFrom(foodNamed(ctx, "Oats, dry"), "")).toMatchObject({ ok: false });
    expect(ctx.portionFrom(foodNamed(ctx, "Oats, dry"), "a lot")).toMatchObject({ ok: false });
  });
});

describe("recentMeals", () => {
  const meals = [
    { name: "Oats", date: "2026-08-30", time: "07:00", calories: 300, protein: 10, carbs: 50, fat: 5 },
    { name: "Oats", date: "2026-08-31", time: "07:30", calories: 350, protein: 12, carbs: 55, fat: 6 },
    { name: "Chicken breast, cooked (200 g)", date: "2026-08-31", time: "12:00", calories: 330, protein: 62, carbs: 0, fat: 7.2 },
  ];

  it("is newest first, one row per name, with the macros kept", () => {
    const { ctx } = loadApp();
    const r = ctx.recentMeals(meals);
    expect(r.map((m: any) => m.name)).toEqual(["Chicken breast, cooked (200 g)", "Oats"]);
    expect(r[1].calories).toBe(350);
    expect(r[0].protein).toBe(62);
  });

  it("caps the list and copes with an empty log", () => {
    const { ctx } = loadApp();
    expect(ctx.recentMeals(meals, 1).map((m: any) => m.name)).toEqual(["Chicken breast, cooked (200 g)"]);
    expect(ctx.recentMeals([])).toEqual([]);
    expect(ctx.recentMeals(null)).toEqual([]);
  });
});

describe("macroTotals", () => {
  it("adds up the macros and does not accumulate float noise", () => {
    const { ctx } = loadApp();
    const t = ctx.macroTotals([
      { calories: 100, protein: 0.1, carbs: 0.2, fat: 0.3 },
      { calories: 200, protein: 0.2, carbs: 0.1, fat: 0.3 },
    ]);
    expect(t).toEqual({ calories: 300, protein: 0.3, carbs: 0.3, fat: 0.6 });
  });

  it("treats a meal logged before macros existed as zeroes", () => {
    const { ctx } = loadApp();
    expect(ctx.macroTotals([{ calories: 500 }])).toEqual({ calories: 500, protein: 0, carbs: 0, fat: 0 });
  });
});

describe("the food picker end to end", () => {
  it("saves the picked food with its macros", () => {
    const { ctx, byId } = loadApp();
    ctx.switchTab("nutrition");
    const chicken = ctx.FOODS.findIndex((f: any) => f.name === "Chicken breast, cooked");
    ctx.pickFood(chicken);
    byId.foodAmount.value = "150";
    byId.addPicked.handlers.click();

    const saved = ctx.store.get("meals", []).filter((m: any) => m.name.startsWith("Chicken breast"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ calories: 248, protein: 46.5, name: "Chicken breast, cooked (150 g)" });
    expect(saved[0].time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("refuses to save a picked food with no amount, and says why", () => {
    const { ctx, toasts, byId } = loadApp();
    ctx.switchTab("nutrition");
    ctx.pickFood(ctx.FOODS.findIndex((f: any) => f.name === "Banana"));
    const before = ctx.store.get("meals", []).length;
    byId.foodAmount.value = "";
    byId.addPicked.handlers.click();
    expect(ctx.store.get("meals", []).length).toBe(before);
    expect(toasts.join(" ")).toMatch(/How many/);
  });

  it("still saves a meal typed in by hand", () => {
    const { ctx, byId } = loadApp();
    ctx.switchTab("nutrition");
    ctx.document.getElementById("mealName").value = "Pizza at Olivia";
    ctx.document.getElementById("mealCal").value = "900";
    byId.addMeal.handlers.click();
    expect(ctx.store.get("meals", []).some((m: any) => m.name === "Pizza at Olivia" && m.calories === 900)).toBe(true);
  });

  it("re-logs a recent meal in one call, macros and all", () => {
    const { ctx, byId } = loadApp();
    ctx.switchTab("nutrition");
    ctx.pickFood(ctx.FOODS.findIndex((f: any) => f.name === "Egg"));
    byId.foodAmount.value = "2";
    byId.addPicked.handlers.click();

    ctx.switchTab("nutrition");
    const index = ctx.recentMealCache.findIndex((m: any) => m.name === "Egg (2x)");
    expect(index).toBeGreaterThanOrEqual(0);
    ctx.addRecentMeal(index);

    const eggs = ctx.store.get("meals", []).filter((m: any) => m.name === "Egg (2x)");
    expect(eggs).toHaveLength(2);
    expect(eggs[1].protein).toBe(12.6);
  });

  it("stamps a single-digit hour with a leading zero, so the day sorts", () => {
    // 09:05 local, which is the case a two-digit clock hour can never expose.
    const { ctx, byId } = loadApp({ now: new Date("2026-08-31T09:05:00Z") });
    ctx.switchTab("nutrition");
    ctx.pickFood(ctx.FOODS.findIndex((f: any) => f.name === "Banana"));
    byId.foodAmount.value = "1";
    byId.addPicked.handlers.click();
    const saved = ctx.store.get("meals", []).find((m: any) => m.name.startsWith("Banana"));
    expect(saved.time).toBe("09:05");
  });

  it("does nothing when asked for a recent meal that is not there", () => {
    const { ctx } = loadApp();
    ctx.switchTab("nutrition");
    const before = ctx.store.get("meals", []).length;
    ctx.addRecentMeal(99);
    expect(ctx.store.get("meals", []).length).toBe(before);
  });
});

describe("seeded meals", () => {
  it("carry a zero-padded time, so the Food tab sorts them by hour", () => {
    const { ctx } = loadApp();
    const times = ctx.store.get("meals", []).map((m: any) => m.time);
    expect(times.length).toBeGreaterThan(0);
    times.forEach((t: string) => expect(t).toMatch(/^\d{2}:\d{2}$/));
  });
});
