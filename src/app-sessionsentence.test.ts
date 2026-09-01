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
      "\n;Object.defineProperty(globalThis, 'mealParse', { get: () => mealParse, set: (v) => { mealParse = v; } });" +
      "\n;Object.defineProperty(globalThis, 'logSentence', { get: () => logSentence, set: (v) => { logSentence = v; } });" +
      "\n;Object.defineProperty(globalThis, 'logKind', { get: () => logKind, set: (v) => { logKind = v; } });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

const PLAN = {
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench Press", sets: 4, reps: 8 }, { name: "Overhead Press", sets: 3, reps: 10 }] },
    { day: "Tuesday", focus: "Pull", exercises: [{ name: "Deadlift", sets: 3, reps: 5 }] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 4, reps: 6 }] },
    { day: "Friday", focus: "Upper", exercises: [{ name: "Lat Pulldown", sets: 3, reps: 10 }] },
    { day: "Saturday", focus: "Conditioning", exercises: [{ name: "Kettlebell Swing", sets: 4, reps: 20 }] },
  ],
};
// 2026-09-01 is a Tuesday, which is the Pull day above.
const TUE = "2026-09-01";

describe("parseSessionSentence — cardio", () => {
  it("reads Edvard's run sentence into an activity, a distance and an injury flag", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence(
      "I ran 7km today, got a small injury in my leg so I want to take it easy next run.",
      PLAN, TUE);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("cardio");
    expect(r.cardio.activity).toBe("Run");
    expect(r.cardio.distance).toBe(7);
    expect(r.date).toBe(TUE);
    expect(r.injury).toBe(true);
  });

  it("leaves the duration null and names it as missing rather than deriving it from the distance", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("I ran 7km today", PLAN, TUE);
    expect(r.cardio.minutes).toBe(null);
    expect(r.missing).toContain("minutes");
  });

  it("reads a duration when it is there, and then nothing is missing", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("swam for 45 minutes yesterday", PLAN, TUE);
    expect(r.cardio.activity).toBe("Swim");
    expect(r.cardio.minutes).toBe(45);
    expect(r.cardio.distance).toBe(null);
    expect(r.missing).toEqual([]);
    expect(r.date).toBe("2026-08-31");
  });

  it("reads hours, including half an hour", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("biked 1.5 hours", PLAN, TUE).cardio.minutes).toBe(90);
    expect(ctx.parseSessionSentence("walked for half an hour", PLAN, TUE).cardio.minutes).toBe(30);
    expect(ctx.parseSessionSentence("rowed for an hour", PLAN, TUE).cardio.minutes).toBe(60);
  });

  it("does not read a bare m as metres, because that is how people write minutes", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 45 m", PLAN, TUE);
    expect(r.cardio.distance).toBe(null);
  });

  it("reads metres spelled out, as kilometres", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("swam 1500 metres", PLAN, TUE).cardio.distance).toBe(1.5);
  });

  it("prefers the named activity over a plan reference in the same sentence", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan's easy run today, 5 km", PLAN, TUE);
    expect(r.kind).toBe("cardio");
    expect(r.cardio.activity).toBe("Run");
  });
});

describe("parseSessionSentence — the plan", () => {
  it("reads Edvard's plan sentence into that day's exercises and a feel", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence(
      "I followed the training plan today, felt easy. Drank a lot of water", PLAN, TUE);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("strength");
    expect(r.day).toBe("Tuesday");
    expect(r.exercises).toEqual([{ name: "Deadlift", sets: 3, reps: 5 }]);
    expect(r.feel).toBe("easy");
    expect(r.injury).toBe(false);
    expect(r.note).toBe("I followed the training plan today, felt easy. Drank a lot of water");
  });

  it("names the weight as missing, because a plan carries sets and reps and no kilos", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("followed the plan", PLAN, TUE);
    expect(r.missing).toEqual(["weight"]);
  });

  it("resolves a weekday backwards to the session you already did", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan on Thursday", PLAN, TUE);
    expect(r.day).toBe("Thursday");
    expect(r.date).toBe("2026-08-27");
  });

  it("refuses a plan day with nothing on it instead of saving an empty session", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("followed the plan yesterday", PLAN, "2026-09-03");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Wednesday");
  });
});

describe("parseSessionSentence — refusing to guess", () => {
  it("refuses a sentence that names neither an activity nor the plan", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("felt pretty good about things today", PLAN, TUE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not tell");
  });

  it("refuses an empty sentence", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("  ", PLAN, TUE).ok).toBe(false);
  });
});

describe("sessionSentenceSummary", () => {
  it("says the duration is missing rather than leaving the blank silent", () => {
    const { ctx } = loadApp();
    const s = ctx.sessionSentenceSummary(ctx.parseSessionSentence("ran 7 km today", PLAN, TUE));
    expect(s).toContain("Run");
    expect(s).toContain("7 km");
    expect(s).toContain("duration");
  });

  it("says the plan carries no weights", () => {
    const { ctx } = loadApp();
    const s = ctx.sessionSentenceSummary(ctx.parseSessionSentence("followed the plan today", PLAN, TUE));
    expect(s).toContain("Tuesday");
    expect(s).toContain("weights");
  });

  it("is empty for a refusal", () => {
    const { ctx } = loadApp();
    expect(ctx.sessionSentenceSummary({ ok: false, reason: "no" })).toBe("");
  });
});

describe("sessionNote", () => {
  it("carries the feel and the injury flag when the note is still the sentence", () => {
    const { ctx, byId } = loadApp();
    const parsed = ctx.parseSessionSentence("ran 7 km today, sore knee, felt hard", PLAN, TUE);
    ctx.logSentence = parsed;
    byId["logNote"] = { value: parsed.note };
    expect(ctx.sessionNote()).toEqual({ note: parsed.note, feel: "hard", injury: true });
  });

  it("drops the flags when the note was edited, because the words no longer say it", () => {
    const { ctx, byId } = loadApp();
    const parsed = ctx.parseSessionSentence("ran 7 km today, sore knee", PLAN, TUE);
    ctx.logSentence = parsed;
    byId["logNote"] = { value: "ran 7 km today" };
    expect(ctx.sessionNote()).toEqual({ note: "ran 7 km today" });
  });

  it("writes nothing at all when the note box is empty", () => {
    const { ctx, byId } = loadApp();
    ctx.logSentence = null;
    byId["logNote"] = { value: "  " };
    expect(ctx.sessionNote()).toEqual({});
  });
});

describe("renderLog with a sentence in hand", () => {
  // The shared stub cannot clone a <template>, so the exercise rows get a
  // minimal one here. Everything else is the real render path.
  function stubTemplate(byId: Record<string, any>) {
    byId["tpl-log-exercise-row"] = {
      content: {
        cloneNode: () => ({
          querySelector: () => ({ value: "", addEventListener() {}, closest: () => ({ remove() {} }) }),
        }),
      },
    };
  }

  it("renders the cardio form from a run sentence without throwing", () => {
    const { ctx } = loadApp();
    ctx.store.set("plan", PLAN);
    const cardio = ctx.parseSessionSentence("ran 7 km today", PLAN, TUE);
    ctx.logSentence = { ...cardio, summary: ctx.sessionSentenceSummary(cardio) };
    ctx.logKind = "cardio";
    expect(() => ctx.renderLog()).not.toThrow();
  });

  it("renders the strength form from a plan sentence without throwing", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    stubTemplate(byId);
    const strength = ctx.parseSessionSentence("followed the plan today", PLAN, TUE);
    ctx.logSentence = { ...strength, summary: ctx.sessionSentenceSummary(strength) };
    ctx.logKind = "strength";
    expect(() => ctx.renderLog()).not.toThrow();
  });

  it("still renders with no sentence read at all", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    stubTemplate(byId);
    ctx.logSentence = null;
    ctx.logKind = "strength";
    expect(() => ctx.renderLog()).not.toThrow();
  });
});
