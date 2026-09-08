import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-lastweight.test.ts. `dailySeries` and `weeklyVolumes`
// take plain values and return plain values; `weeklyVolumes` reads `sessions`
// out of the store, so localStorage is seeded rather than the function argued.
function loadApp(sessions?: any[]): any {
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
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isFinite,
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
      "\n;globalThis.dailySeries = dailySeries;" +
      "\n;globalThis.weeklyVolumes = weeklyVolumes;" +
      "\n;globalThis.__setSessions = (s) => store.set('sessions', s);",
    ctx,
  );
  if (sessions) ctx.__setSessions(sessions);
  return ctx;
}

function session(date: string, weight: number) {
  return {
    id: date, date, kind: "strength", day: "Monday",
    exercises: [{ name: "Back Squat", sets: [{ reps: 10, weight }] }],
  };
}

describe("dailySeries", () => {
  it("puts a slot on the axis for every day between two readings", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2026-03-01", value: 84 },
      { date: "2026-03-05", value: 82 },
    ]);
    expect(out.labels).toEqual([
      "2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05",
    ]);
    expect(out.values).toEqual([84, null, null, null, 82]);
  });

  it("is null on an unlogged day, not zero", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2026-03-01", value: 2400 },
      { date: "2026-03-03", value: 2100 },
    ]);
    // The precondition this test turns on: the gap day really is in the axis,
    // so "null" is a value that got plotted rather than a day left out.
    expect(out.labels).toContain("2026-03-02");
    expect(out.values[1]).toBeNull();
    expect(out.values[1]).not.toBe(0);
  });

  it("spaces a week-long gap seven times wider than a one-day gap", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2026-03-01", value: 84 },
      { date: "2026-03-02", value: 83.8 },
      { date: "2026-03-09", value: 83 },
    ]);
    const at = (iso: string) => out.labels.indexOf(iso);
    expect(at("2026-03-02") - at("2026-03-01")).toBe(1);
    expect(at("2026-03-09") - at("2026-03-02")).toBe(7);
  });

  it("crosses a month boundary and a leap day by the calendar", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2024-02-27", value: 1 },
      { date: "2024-03-02", value: 2 },
    ]);
    expect(out.labels).toEqual([
      "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02",
    ]);
  });

  it("keeps the later of two readings on one day", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2026-03-01", value: 84 },
      { date: "2026-03-01", value: 83 },
      { date: "2026-03-02", value: 82 },
    ]);
    expect(out.labels).toEqual(["2026-03-01", "2026-03-02"]);
    expect(out.values).toEqual([83, 82]);
  });

  it("returns nothing for no readings, and one slot for one reading", () => {
    const app = loadApp();
    expect(app.dailySeries([])).toEqual({ labels: [], values: [] });
    expect(app.dailySeries(null)).toEqual({ labels: [], values: [] });
    expect(app.dailySeries([{ date: "2026-03-01", value: 84 }]))
      .toEqual({ labels: ["2026-03-01"], values: [84] });
  });

  it("drops a record with no usable date or value instead of walking off it", () => {
    const app = loadApp();
    const out = app.dailySeries([
      { date: "2026-03-01", value: 84 },
      { date: "not a date", value: 5 },
      { date: "2026-03-02", value: null },
      { date: "2026-03-03", value: 83 },
    ]);
    expect(out.labels).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(out.values).toEqual([84, null, 83]);
  });
});

describe("weeklyVolumes", () => {
  it("puts a zero bar on a week with no sessions in it", () => {
    // 2026-03-02, 2026-03-23 are both Mondays: three weeks apart, one week off
    // in between with nothing logged.
    const app = loadApp([session("2026-03-02", 100), session("2026-03-23", 100)]);
    const weeks = app.weeklyVolumes();
    expect(weeks.map(([k]: any) => k)).toEqual([
      "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23",
    ]);
    expect(weeks[1][1]).toBe(0);
    expect(weeks[2][1]).toBe(0);
    expect(weeks[0][1]).toBeGreaterThan(0);
  });

  it("still reports nothing when there are no sessions at all", () => {
    const app = loadApp([]);
    expect(app.weeklyVolumes()).toEqual([]);
  });
});
