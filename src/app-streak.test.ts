import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-stalled.test.ts. trainingStreak takes plain values and
// returns a number, so nothing here touches a DOM node.
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
    APP_SOURCE + "\n;globalThis.trainingStreak = trainingStreak;",
    ctx,
  );
  return ctx;
}

const strength = (date: string) => ({
  date, kind: "strength", exercises: [{ name: "Bench Press", sets: [{ weight: 80, reps: 5 }] }],
});
const cardio = (date: string) => ({ date, kind: "cardio", activity: "Run", minutes: 30 });

describe("trainingStreak", () => {
  it("is zero with nothing logged", () => {
    const app = loadApp();
    expect(app.trainingStreak([], "2026-09-07")).toBe(0);
  });

  it("counts consecutive days ending today", () => {
    const app = loadApp();
    const streak = app.trainingStreak(
      [strength("2026-09-05"), strength("2026-09-06"), strength("2026-09-07")],
      "2026-09-07",
    );
    expect(streak).toBe(3);
  });

  // The bug this function was extracted for. A lift and a run on the same
  // evening are two sessions with one date, and the old counter incremented
  // once per session, so one day of training displayed as two.
  it("counts a lift and a run on the same day as one day", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-07"), cardio("2026-09-07")], "2026-09-07")).toBe(1);
  });

  it("still counts each day once when every day carries two sessions", () => {
    const app = loadApp();
    const sessions = [
      strength("2026-09-06"), cardio("2026-09-06"),
      strength("2026-09-07"), cardio("2026-09-07"),
    ];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  // The second bug. The old counter compared the newest session against the
  // current instant, so a run ending yesterday survived at 09:00 and vanished
  // by 19:00. Both ends are dates now, and the only way to show that is to ask
  // for the same data twice and demand the same answer.
  it("does not depend on the time of day", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-05"), strength("2026-09-06")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  it("survives a day you have not trained yet", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-06")], "2026-09-07")).toBe(1);
  });

  it("is broken by a whole missed day", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-03"), strength("2026-09-04"), strength("2026-09-07")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(1);
  });

  it("is zero when the newest session is two days old", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-05")], "2026-09-07")).toBe(0);
  });

  it("reads the same however the merged store happens to be ordered", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-06"), strength("2026-09-04"), strength("2026-09-05")];
    expect(app.trainingStreak(sessions, "2026-09-06")).toBe(3);
  });

  // The store is merged from two phones, so one of them running ahead is a real
  // shape. A day that has not happened must not extend the run, and it must not
  // end it either -- the assertion is 2, not 3 and not 0.
  it("ignores a session dated after today", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-09"), strength("2026-09-06"), strength("2026-09-07")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  it("ignores a session whose date is an empty string", () => {
    const app = loadApp();
    // `'' <= '2026-09-07'` is true, so an empty date passes the future check and
    // is dropped by the truthiness half of the filter and nothing else.
    const sessions = [{ date: "", kind: "strength" }, strength("2026-09-07")];
    expect(app.trainingStreak(sessions as any, "2026-09-07")).toBe(1);
  });

  it("ignores a session with no date at all", () => {
    const app = loadApp();
    const sessions = [{ kind: "strength" }, strength("2026-09-07")];
    expect(app.trainingStreak(sessions as any, "2026-09-07")).toBe(1);
  });
});
