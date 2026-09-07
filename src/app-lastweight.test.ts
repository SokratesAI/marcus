import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-warmup.test.ts. exerciseKey, lastPerformance and
// lastPerformanceLabel take plain values and return plain values -- no DOM node
// is touched.
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
      "\n;globalThis.exerciseKey = exerciseKey;" +
      "\n;globalThis.lastPerformance = lastPerformance;" +
      "\n;globalThis.lastPerformanceLabel = lastPerformanceLabel;",
    ctx,
  );
  return ctx;
}

function strength(date: string, name: string, sets: any[], rpe?: number) {
  const ex: any = { name, sets };
  if (rpe != null) ex.rpe = rpe;
  return { id: date + name, date, kind: "strength", day: "Monday", exercises: [ex] };
}

describe("exerciseKey", () => {
  it("treats case and inner spacing as the same lift", () => {
    const app = loadApp();
    expect(app.exerciseKey("  Back   Squat ")).toBe("back squat");
    expect(app.exerciseKey("back squat")).toBe(app.exerciseKey("Back Squat"));
  });

  it("keeps two different lifts apart", () => {
    const app = loadApp();
    expect(app.exerciseKey("Front Squat")).not.toBe(app.exerciseKey("Back Squat"));
  });
});

describe("lastPerformance", () => {
  it("finds the most recent session that has the exercise in it", () => {
    const app = loadApp();
    const sessions = [
      strength("2026-09-01", "Back Squat", [{ reps: 10, weight: 80 }, { reps: 10, weight: 80 }]),
      strength("2026-09-04", "Back Squat", [{ reps: 8, weight: 85 }], 8),
      strength("2026-09-05", "Bench Press", [{ reps: 5, weight: 60 }]),
    ];
    expect(app.lastPerformance(sessions, "back squat", "2026-09-06")).toEqual({
      date: "2026-09-04", name: "Back Squat", weight: 85, reps: 8, sets: 1, rpe: 8,
    });
    // The precondition: an older session with the same lift really is in the
    // list, so "most recent" is doing work rather than "the only one".
    expect(sessions.filter((s) => s.exercises[0].name === "Back Squat")).toHaveLength(2);
  });

  it("reports the heaviest set of that session, not the first", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-04", "Deadlift", [
      { reps: 5, weight: 100 }, { reps: 3, weight: 120 }, { reps: 3, weight: 110 },
    ])];
    const last = app.lastPerformance(sessions, "Deadlift", "2026-09-06");
    expect(last.weight).toBe(120);
    expect(last.reps).toBe(3);
    expect(last.sets).toBe(3);
  });

  it("ignores a session dated after the day being logged", () => {
    const app = loadApp();
    const sessions = [
      strength("2026-09-01", "Row", [{ reps: 10, weight: 40 }]),
      strength("2026-09-05", "Row", [{ reps: 10, weight: 50 }]),
    ];
    // Backfilling the 2nd must not be told about the 5th, which had not
    // happened yet.
    expect(app.lastPerformance(sessions, "Row", "2026-09-02").weight).toBe(40);
    // Same list, no cutoff moved anywhere else: with the later date it does
    // find the 5th, so the filter above is the reason and not an empty list.
    expect(app.lastPerformance(sessions, "Row", "2026-09-05").weight).toBe(50);
  });

  it("prefers the later of two sessions logged on the same date", () => {
    const app = loadApp();
    const sessions = [
      strength("2026-09-04", "Press", [{ reps: 8, weight: 40 }]),
      strength("2026-09-04", "Press", [{ reps: 8, weight: 45 }]),
    ];
    expect(app.lastPerformance(sessions, "Press", "2026-09-04").weight).toBe(45);
  });

  it("keeps 0 kg, because 0 kg is bodyweight and not a missing number", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-04", "Pull-up", [{ reps: 8, weight: 0 }])];
    expect(app.lastPerformance(sessions, "Pull-up", "2026-09-06").weight).toBe(0);
  });

  it("skips an exercise whose sets carry no usable weight at all", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-04", "Plank", [{ reps: 1, weight: null }] as any)];
    expect(app.lastPerformance(sessions, "Plank", "2026-09-06")).toBe(null);
  });

  it("never answers from a cardio session", () => {
    const app = loadApp();
    const sessions = [
      { id: "c", date: "2026-09-05", kind: "cardio", activity: "Run", minutes: 40, distance: 7 },
      strength("2026-09-01", "Run", [{ reps: 1, weight: 0 }]),
    ];
    expect(app.lastPerformance(sessions, "Run", "2026-09-06").date).toBe("2026-09-01");
  });

  it("answers null for an exercise never done, an empty name and no sessions", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-04", "Back Squat", [{ reps: 5, weight: 100 }])];
    expect(app.lastPerformance(sessions, "Hip Thrust", "2026-09-06")).toBe(null);
    expect(app.lastPerformance(sessions, "   ", "2026-09-06")).toBe(null);
    expect(app.lastPerformance([], "Back Squat", "2026-09-06")).toBe(null);
    expect(app.lastPerformance(undefined, "Back Squat", "2026-09-06")).toBe(null);
  });
});

describe("lastPerformanceLabel", () => {
  it("writes the load, the reps, the set count and the day", () => {
    const app = loadApp();
    const label = app.lastPerformanceLabel({ date: "2026-09-04", name: "Back Squat", weight: 85, reps: 8, sets: 3, rpe: 8 });
    expect(label).toContain("Last time 85 kg × 8 × 3");
    expect(label).toContain("RPE 8");
    expect(label).toContain("Sep");
  });

  it("leaves the set count off a single set and RPE off when it was not recorded", () => {
    const app = loadApp();
    const label = app.lastPerformanceLabel({ date: "2026-09-04", name: "Press", weight: 40, reps: 8, sets: 1, rpe: null });
    expect(label).toContain("Last time 40 kg × 8 ·");
    expect(label).not.toContain("RPE");
    expect(label).not.toContain("× 1 ");
  });

  it("says bodyweight rather than 0 kg", () => {
    const app = loadApp();
    const label = app.lastPerformanceLabel({ date: "2026-09-04", name: "Pull-up", weight: 0, reps: 8, sets: 3, rpe: null });
    expect(label).toContain("Last time bodyweight × 8 × 3");
    expect(label).not.toContain("0 kg");
  });

  it("is empty for nothing found, so the line can be hidden on it", () => {
    const app = loadApp();
    expect(app.lastPerformanceLabel(null)).toBe("");
  });
});
