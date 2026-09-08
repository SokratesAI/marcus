import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { renderApp } from "./app-dom.js";

// Same vm shape as app-streak.test.ts. bodyweightChange takes a plain array and
// returns a plain object, so nothing here touches a DOM node.
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
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const app = loadApp();

describe("bodyweightChange", () => {
  it("measures first to last weigh-in and reports the span in days", () => {
    const c = app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-30", kg: 82.2 },
    ]);
    expect(c.delta).toBeCloseTo(-2.1, 5);
    expect(c.days).toBe(26);
    expect(c.fromISO).toBe("2026-08-04");
    expect(c.toISO).toBe("2026-08-30");
  });

  it("picks the ends by date, not by array position", () => {
    // A weigh-in is pushed in the order it was typed, so a reading entered late
    // for an earlier day sits at the end of the array while being the earliest.
    const typedInOrder = [
      { date: "2026-08-10", kg: 83.8 },
      { date: "2026-08-30", kg: 82.2 },
    ];
    const backdatedLast = [
      { date: "2026-08-30", kg: 82.2 },
      { date: "2026-08-10", kg: 83.8 },
    ];
    expect(app.bodyweightChange(backdatedLast)).toEqual(app.bodyweightChange(typedInOrder));
    // And that shared answer is the by-date one, not the by-position one: read
    // positionally the second array gives +1.6kg over -20 days.
    expect(app.bodyweightChange(backdatedLast).delta).toBeCloseTo(-1.6, 5);
    expect(app.bodyweightChange(backdatedLast).days).toBe(20);
  });

  it("is null with one reading, and with two on the same day", () => {
    expect(app.bodyweightChange([{ date: "2026-08-04", kg: 84.3 }])).toBe(null);
    expect(app.bodyweightChange([])).toBe(null);
    expect(app.bodyweightChange(undefined)).toBe(null);
    expect(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-04", kg: 84.0 },
    ])).toBe(null);
  });

  it("labels the window, and says only 'weight change' when there is none", () => {
    expect(app.bodyweightChangeLabel(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-30", kg: 82.2 },
    ]))).toBe("weight change over 26 days");
    expect(app.bodyweightChangeLabel(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-05", kg: 84.0 },
    ]))).toBe("weight change over 1 day");
    expect(app.bodyweightChangeLabel(null)).toBe("weight change");
  });
});

describe("the Home tile", () => {
  const weights = [
    { date: "2026-08-04", kg: 84.3 },
    { date: "2026-08-30", kg: 82.2 },
  ];

  it("prints the span beside the number", () => {
    const a = renderApp("home", { weights });
    const text = a.text();
    expect(text).toContain("-2.1kg");
    expect(text).toContain("weight change over 26 days");
    // The precondition this test rests on: the old code printed a bare label.
    expect(text).not.toContain("weight changesessions");
    a.close();
  });

  it("shows a dash rather than 0.0kg when there is only one reading", () => {
    const a = renderApp("home", { weights: [{ date: "2026-08-04", kg: 84.3 }] });
    const text = a.text();
    expect(text).toContain("—");
    expect(text).not.toContain("0.0kg");
    a.close();
  });

  it("signs a gain so it cannot read as a loss", () => {
    const a = renderApp("home", { weights: [
      { date: "2026-08-04", kg: 82.2 },
      { date: "2026-08-30", kg: 84.3 },
    ] });
    expect(a.text()).toContain("+2.1kg");
    a.close();
  });
});
