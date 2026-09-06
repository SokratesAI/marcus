import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same vm shape as app-planphase.test.ts. Everything under test here is pure: a
// plan in, a plan or a verdict out. No DOM node is touched.
function loadApp(): any {
  const stored: Record<string, string> = {};
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const document: any = {
    body: makeNode(),
    getElementById: () => makeNode(),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.CARDIO_ACTIVITIES = CARDIO_ACTIVITIES;" +
      "\n;globalThis.BOUNDS = BOUNDS;" +
      "\n;globalThis.REVIEW_WINDOW_DAYS = REVIEW_WINDOW_DAYS;",
    ctx,
  );
  return ctx;
}

// Monday lifts, Wednesday rest. 4 + 3 = 7 sets on one training day.
const plan = (): any => ({
  blockName: "Block",
  days: [
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 }] },
    { day: "Tuesday", focus: "Rest", exercises: [] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
  ],
});

describe("validatePlanCardio", () => {
  it("refuses an activity that is not one of the offered ones", () => {
    const app = loadApp();
    const result = app.validatePlanCardio("Yoga", "45");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/list/i);
  });

  it("accepts every activity the log tab already offers", () => {
    const app = loadApp();
    expect(app.CARDIO_ACTIVITIES.length).toBeGreaterThan(0);
    for (const activity of app.CARDIO_ACTIVITIES) {
      expect(app.validatePlanCardio(activity, "45")).toEqual({ ok: true, cardio: { activity, minutes: 45 } });
    }
  });

  it("refuses a duration outside the shared minutes bound", () => {
    const app = loadApp();
    expect(app.validatePlanCardio("Swim", "0").ok).toBe(false);
    expect(app.validatePlanCardio("Swim", String(app.BOUNDS.minutes.max + 1)).ok).toBe(false);
    expect(app.validatePlanCardio("Swim", String(app.BOUNDS.minutes.max)).ok).toBe(true);
  });

  it("refuses a fractional duration rather than rounding it", () => {
    const app = loadApp();
    const result = app.validatePlanCardio("Swim", "45.5");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/whole number/i);
  });

  it("refuses a blank duration", () => {
    const app = loadApp();
    expect(app.validatePlanCardio("Swim", "").ok).toBe(false);
  });
});

describe("withPlanCardio", () => {
  it("puts a session on the named day and leaves the others alone", () => {
    const app = loadApp();
    const before = plan();
    const after = app.withPlanCardio(before, "Wednesday", { activity: "Swim", minutes: 45 });
    expect(after.days[2].cardio).toEqual({ activity: "Swim", minutes: 45 });
    expect(after.days[0].cardio).toBeUndefined();
    expect(after.days[1].cardio).toBeUndefined();
    // Pure: the plan it was handed is unchanged.
    expect(before.days[2].cardio).toBeUndefined();
  });

  it("renames a rest day to the activity, and a lifting day keeps its focus", () => {
    const app = loadApp();
    const after = app.withPlanCardio(plan(), "Wednesday", { activity: "Swim", minutes: 45 });
    expect(after.days[2].focus).toBe("Swim");
    const onLifting = app.withPlanCardio(plan(), "Monday", { activity: "Run", minutes: 30 });
    expect(onLifting.days[0].focus).toBe("Push");
  });

  it("clearing puts a cardio-only day back to Rest and leaves a lifting day's focus", () => {
    const app = loadApp();
    const withSwim = app.withPlanCardio(plan(), "Wednesday", { activity: "Swim", minutes: 45 });
    const cleared = app.withPlanCardio(withSwim, "Wednesday", null);
    expect(cleared.days[2].cardio).toBeUndefined();
    expect(cleared.days[2].focus).toBe("Rest");

    const withRun = app.withPlanCardio(plan(), "Monday", { activity: "Run", minutes: 30 });
    const clearedLifting = app.withPlanCardio(withRun, "Monday", null);
    expect(clearedLifting.days[0].cardio).toBeUndefined();
    expect(clearedLifting.days[0].focus).toBe("Push");
    expect(clearedLifting.days[0].exercises).toHaveLength(2);
  });

  it("does nothing to a day name the plan does not have", () => {
    const app = loadApp();
    const after = app.withPlanCardio(plan(), "Caturday", { activity: "Swim", minutes: 45 });
    expect(after.days.every((d: any) => !d.cardio)).toBe(true);
  });
});

describe("a cardio session counts as training", () => {
  it("a cardio-only day is a training day, and was not one before", () => {
    const app = loadApp();
    const before = plan();
    expect(app.planTrainingDays(before).map((d: any) => d.day)).toEqual(["Monday"]);
    const after = app.withPlanCardio(before, "Wednesday", { activity: "Swim", minutes: 45 });
    expect(app.planTrainingDays(after).map((d: any) => d.day)).toEqual(["Monday", "Wednesday"]);
  });

  it("contributes no sets, so the phase arithmetic is untouched by it", () => {
    const app = loadApp();
    const after = app.withPlanCardio(plan(), "Wednesday", { activity: "Swim", minutes: 45 });
    expect(app.planTotalSets(plan())).toBe(7);
    expect(app.planTotalSets(after)).toBe(7);
  });

  it("is a planned day in the adherence table", () => {
    const app = loadApp();
    const after = app.withPlanCardio(plan(), "Wednesday", { activity: "Swim", minutes: 45 });
    const rows = app.adherenceByWeekday(after, [], "2026-09-01", app.REVIEW_WINDOW_DAYS);
    const wednesday = rows.find((r: any) => r.day === "Wednesday");
    expect(wednesday.planned).toBe(true);
    const before = app.adherenceByWeekday(plan(), [], "2026-09-01", app.REVIEW_WINDOW_DAYS);
    expect(before.find((r: any) => r.day === "Wednesday").planned).toBe(false);
  });
});

describe("proposals keep the cardio session honest", () => {
  it("moving a day's work carries its cardio session with it", () => {
    const app = loadApp();
    const withSwim = app.withPlanCardio(plan(), "Monday", { activity: "Swim", minutes: 45 });
    const moved = app.applyProposal(withSwim, { kind: "move", day: "Monday", toDay: "Tuesday" });
    expect(moved.days[1].cardio).toEqual({ activity: "Swim", minutes: 45 });
    expect(moved.days[0].cardio).toBeUndefined();
  });

  it("making a day a rest day takes the cardio off it too", () => {
    const app = loadApp();
    const withSwim = app.withPlanCardio(plan(), "Monday", { activity: "Swim", minutes: 45 });
    const rested = app.applyProposal(withSwim, { kind: "rest", day: "Monday" });
    expect(rested.days[0].cardio).toBeUndefined();
    expect(rested.days[0].exercises).toEqual([]);
  });
});
