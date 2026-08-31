import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect, beforeEach, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

interface Harness {
  ctx: any;
  toasts: string[];
  stored: Record<string, string>;
}

// app.js is a classic script, not a module: top-level `function` declarations
// land on the context's global object, which is how the tests reach them.
// It boots itself on load (switchTab('home')), so the DOM stub has to be real
// enough to render every tab, the same way sw.test.ts stubs a ServiceWorker.
function loadApp(opts: { storageThrows?: Error } = {}): Harness {
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
    getElementById(id: string) {
      return (byId[id] ??= makeNode());
    },
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => {
        if (opts.storageThrows) throw opts.storageThrows;
        stored[k] = v;
      },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () {
      return { destroy() {} };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  // The real toast writes into #toast; read what it wrote rather than stubbing
  // the function, so the message under test is the one a user would see. This
  // has to be wired before the script runs, because boot itself can toast.
  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;", ctx);

  return { ctx, toasts, stored };
}

describe("planDayName", () => {
  it("is the single source of truth every tab now calls", () => {
    const { ctx } = loadApp();
    // 2026-08-31 is a Monday; 2026-09-06 is a Sunday.
    expect(ctx.planDayName(new Date("2026-08-31T12:00:00Z"))).toBe("Monday");
    expect(ctx.planDayName(new Date("2026-09-06T12:00:00Z"))).toBe("Sunday");
    expect(APP_SOURCE).not.toMatch(/DAY_NAMES\[new Date\(\)\.getDay\(\)\]/);
    expect(APP_SOURCE.match(/planDayName\(\)/g)?.length).toBe(4);
  });
});

describe("validateExerciseRow", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    name: "Back Squat",
    sets: "3",
    reps: "10",
    weight: "100",
    ...over,
  });

  it("accepts a fully filled row and expands it into sets", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row());
    expect(r.ok).toBe(true);
    expect(r.exercise.sets).toEqual([
      { reps: 10, weight: 100 },
      { reps: 10, weight: 100 },
      { reps: 10, weight: 100 },
    ]);
  });

  it("skips a row the user left entirely blank", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow({ name: "", sets: "", reps: "", weight: "" });
    expect(r).toEqual({ ok: true, skip: true });
  });

  it("skips a prefilled row whose name was cleared, which is how you skip an exercise", () => {
    const { ctx } = loadApp();
    // The Log tab prefills name/sets/reps from the plan and leaves weight blank.
    const r = ctx.validateExerciseRow({ name: "", sets: "3", reps: "10", weight: "" });
    expect(r).toEqual({ ok: true, skip: true });
  });

  it("rejects blank reps instead of silently saving 1", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ reps: "" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Reps is required");
  });

  it("rejects zero reps", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ reps: "0" })).ok).toBe(false);
  });

  it("rejects blank weight instead of silently saving 0kg", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ weight: "" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Weight is required");
  });

  it("allows a genuine bodyweight exercise at 0kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ name: "Pull-ups", weight: "0" })).ok).toBe(true);
  });

  it("rejects a named row whose numbers are all blank rather than skipping it", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow({ name: "Back Squat", sets: "", reps: "", weight: "" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Back Squat");
  });

  it("rejects an absurd weight", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ weight: "5000" })).ok).toBe(false);
  });

  it("rejects text where a number belongs", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ reps: "ten" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("must be a number");
  });
});

describe("validateSession", () => {
  it("keeps the filled rows and drops the blank ones", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([
      { name: "Bench", sets: "3", reps: "8", weight: "80" },
      { name: "", sets: "", reps: "", weight: "" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.exercises).toHaveLength(1);
  });

  it("refuses a session where every row is blank", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([{ name: "", sets: "", reps: "", weight: "" }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("at least one exercise");
  });

  it("fails the whole session on one bad row rather than saving the rest", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([
      { name: "Bench", sets: "3", reps: "8", weight: "80" },
      { name: "Row", sets: "3", reps: "", weight: "60" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Row:");
  });
});

describe("validateMeal", () => {
  it("accepts a normal meal", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("Grandiosa", "1200")).toEqual({
      ok: true,
      meal: { name: "Grandiosa", calories: 1200 },
    });
  });

  it("rejects a fat-fingered 50000 instead of saving it", () => {
    const { ctx } = loadApp();
    const r = ctx.validateMeal("Pizza", "50000");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("between 1 and 10000 kcal");
  });

  it("rejects 0 kcal with a message rather than returning in silence", () => {
    const { ctx } = loadApp();
    const r = ctx.validateMeal("Water", "0");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("between 1 and 10000");
  });

  it("rejects a missing calorie count", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("Lunch", "").ok).toBe(false);
  });

  it("rejects a missing name", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("  ", "500").message).toBe("Give the meal a name.");
  });
});

describe("validateBodyweight", () => {
  it("accepts a plausible bodyweight", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("83.4")).toEqual({ ok: true, kg: 83.4 });
  });

  it("rejects a typo of 8 kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("8").ok).toBe(false);
  });

  it("rejects a typo of 834 kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("834").ok).toBe(false);
  });
});

describe("store.set under a failing localStorage", () => {
  it("tells the user when storage is full instead of failing silently", () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.set("meals", [])).toBe(false);
    expect(toasts.at(-1)).toContain("Storage is full");
    // and the value is still readable for the rest of the session
    expect(ctx.store.get("meals", null)).toEqual([]);
  });

  it("tells the user when the browser blocks storage entirely", () => {
    const err = new Error("denied");
    err.name = "SecurityError";
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.set("meals", [])).toBe(false);
    expect(toasts.at(-1)).toContain("blocking storage");
  });

  it("stops shadowing localStorage once a write succeeds again", () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    const { ctx, stored } = loadApp({ storageThrows: err });
    // storage was full: the value lives only in memory
    expect(ctx.store.set("meals", [{ id: "held" }])).toBe(false);
    expect(ctx.store.get("meals", null)).toEqual([{ id: "held" }]);
    // storage recovers; the persisted value must win, not the stale copy
    stored["marcus.meals"] = JSON.stringify([{ id: "persisted" }]);
    ctx.localStorage.setItem = (k: string, v: string) => {
      stored[k] = v;
    };
    expect(ctx.store.set("meals", [{ id: "persisted" }])).toBe(true);
    stored["marcus.meals"] = JSON.stringify([{ id: "from-disk" }]);
    expect(ctx.store.get("meals", null)).toEqual([{ id: "from-disk" }]);
  });

  it("still boots and renders when localStorage is blocked outright", () => {
    const err = new Error("denied");
    err.name = "SecurityError";
    // loadApp() runs the whole script, including switchTab('home'). Before the
    // in-memory fallback existed this threw: seed() could not write the plan,
    // so renderHome read undefined and the app died with a blank screen.
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.get("plan", null)).not.toBeNull();
    expect(toasts.at(-1)).toContain("blocking storage");
  });

  it("returns true and stores the value when storage works", () => {
    const { ctx, stored, toasts } = loadApp();
    expect(toasts).toHaveLength(0); // a healthy boot says nothing
    expect(ctx.store.set("meals", [{ id: "a" }])).toBe(true);
    expect(JSON.parse(stored["marcus.meals"])).toEqual([{ id: "a" }]);
    expect(toasts).toHaveLength(0);
  });
});
