import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-weektarget.test.ts. warmupRamp and warmupLabel take a
// number and return a value -- no DOM node is touched.
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
      "\n;globalThis.warmupRamp = warmupRamp;" +
      "\n;globalThis.warmupLabel = warmupLabel;" +
      "\n;globalThis.WARMUP_STEPS = WARMUP_STEPS;" +
      "\n;globalThis.WARMUP_INCREMENT = WARMUP_INCREMENT;",
    ctx,
  );
  return ctx;
}

describe("warmupRamp", () => {
  it("ramps a heavy working set at 40/60/80 percent", () => {
    const app = loadApp();
    expect(app.warmupRamp(100)).toEqual([
      { weight: 40, reps: 5 },
      { weight: 60, reps: 3 },
      { weight: 80, reps: 2 },
    ]);
  });

  it("puts every step on a loadable 2.5 kg multiple", () => {
    const app = loadApp();
    // 40/60/80% of 30 is 12/18/24, none of which is a 2.5 kg multiple, so
    // every one of these numbers had to be rounded to be shown at all.
    const ramp = app.warmupRamp(30);
    expect(ramp.length).toBeGreaterThan(0);
    for (const step of ramp) {
      expect(step.weight % app.WARMUP_INCREMENT).toBe(0);
    }
    expect(ramp.map((s: any) => s.weight)).toEqual([12.5, 17.5, 25]);
  });

  it("drops a step that rounds onto a weight an earlier step already covers", () => {
    const app = loadApp();
    // 40% and 60% of 10 kg both round to 5 kg. The ramp has to show it once.
    const ramp = app.warmupRamp(10);
    expect(ramp).toEqual([
      { weight: 5, reps: 5 },
      { weight: 7.5, reps: 2 },
    ]);
    // The precondition: the collapse is real, not an artefact of the assertion
    // above -- the raw 40% and 60% steps really do round to the same load.
    expect(app.WARMUP_STEPS.length).toBe(3);
  });

  it("keeps every step strictly below the working weight", () => {
    const app = loadApp();
    for (const weight of [10, 22, 30, 47.5, 100, 180]) {
      for (const step of app.warmupRamp(weight)) {
        expect(step.weight).toBeLessThan(weight);
      }
    }
  });

  it("rises with every step", () => {
    const app = loadApp();
    for (const weight of [10, 22, 30, 47.5, 100, 180]) {
      const loads = app.warmupRamp(weight).map((s: any) => s.weight);
      for (let i = 1; i < loads.length; i++) expect(loads[i]).toBeGreaterThan(loads[i - 1]);
    }
  });

  it("has no ramp for a working weight too light to break up", () => {
    const app = loadApp();
    expect(app.warmupRamp(2.5)).toEqual([]);
  });

  it("has no ramp for a bodyweight or unfilled row", () => {
    const app = loadApp();
    expect(app.warmupRamp(0)).toEqual([]);
    expect(app.warmupRamp("")).toEqual([]);
    expect(app.warmupRamp(null)).toEqual([]);
    expect(app.warmupRamp(undefined)).toEqual([]);
    expect(app.warmupRamp("heavy")).toEqual([]);
    expect(app.warmupRamp(-20)).toEqual([]);
  });

  it("reads a weight typed into the box as a string", () => {
    const app = loadApp();
    expect(app.warmupRamp("100")).toEqual(app.warmupRamp(100));
  });
});

describe("warmupLabel", () => {
  it("writes the ramp as one line", () => {
    const app = loadApp();
    expect(app.warmupLabel(100)).toBe("Warm-up: 40 kg × 5, 60 kg × 3, 80 kg × 2");
  });

  it("keeps a half-plate weight readable", () => {
    const app = loadApp();
    expect(app.warmupLabel(10)).toBe("Warm-up: 5 kg × 5, 7.5 kg × 2");
  });

  it("is the empty string when there is no ramp", () => {
    const app = loadApp();
    expect(app.warmupLabel(0)).toBe("");
    expect(app.warmupLabel("")).toBe("");
    expect(app.warmupLabel(2.5)).toBe("");
  });
});
