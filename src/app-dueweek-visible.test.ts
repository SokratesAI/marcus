import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// The racecalendar-draft harness, except the document keeps the listeners the
// boot block adds, so a test can bring the app back to the foreground and see
// what the real wiring does rather than calling the helper by hand.
function loadApp(): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const listeners: Record<string, Array<() => void>> = {};
  const document: any = {
    body: makeNode(),
    visibilityState: "visible",
    getElementById: () => makeNode(),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener(name: string, fn: () => void) { (listeners[name] ??= []).push(fn); },
  };
  const stored: Record<string, string> = {};
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
  ctx.fire = (name: string) => (listeners[name] || []).forEach(fn => fn());
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const run = (app: any, expr: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, app));

// A week whose Monday is this one, saved after the app booted -- what the store
// holds when a week drafted ahead begins while the app sits in a pocket.
const saveDueWeek = (app: any) => vm.runInContext(`(() => {
  const mon = weekStartOf(todayStr());
  store.set('plannedWeeks', [{ id: mon + '@1', start: mon, days: [{ day: 'Tuesday', focus: 'Swim day', exercises: [] }] }]);
})()`, app);

describe("a week that begins while the app is open", () => {
  it("becomes the plan when the app comes back to the foreground, with no tab tapped", () => {
    const app = loadApp();
    saveDueWeek(app);
    app.document.visibilityState = "visible";
    app.fire("visibilitychange");
    expect(run(app, "store.get('plan').days.find(d => d.day === 'Tuesday').focus")).toBe("Swim day");
    expect(run(app, "store.get('plannedWeeks')")).toEqual([]);
  });

  it("is left waiting while the app is going into the background", () => {
    const app = loadApp();
    const before = run(app, "store.get('plan')");
    saveDueWeek(app);
    app.document.visibilityState = "hidden";
    app.fire("visibilitychange");
    expect(run(app, "store.get('plan')")).toEqual(before);
    expect(run(app, "store.get('plannedWeeks')")).toHaveLength(1);
  });

  it("redraws the screen only when a week was actually applied", () => {
    const app = loadApp();
    vm.runInContext("globalThis.drawn = []; switchTab = (t) => { globalThis.drawn.push(t); };", app);
    app.fire("visibilitychange");
    expect(run(app, "drawn")).toEqual([]);
    saveDueWeek(app);
    app.fire("visibilitychange");
    expect(run(app, "drawn")).toEqual(["home"]);
  });

  it("redraws Home and Plan, and leaves Log and Food alone so a half-typed entry survives", () => {
    const app = loadApp();
    vm.runInContext(`globalThis.drawn = []; globalThis.badged = [];
      switchTab = (t) => { globalThis.drawn.push(t); };
      refreshBadge = () => { globalThis.badged.push(currentTab); };`, app);
    for (const tab of ["home", "plan", "log", "nutrition", "progress"]) {
      vm.runInContext(`currentTab = ${JSON.stringify(tab)}; redrawPlanTab();`, app);
    }
    expect(run(app, "drawn")).toEqual(["home", "plan"]);
    // The tabs left alone still get the badge switchTab would have refreshed.
    expect(run(app, "badged")).toEqual(["log", "nutrition", "progress"]);
  });

  it("survives a document with no addEventListener", () => {
    const app = loadApp();
    expect(() => vm.runInContext("applyDueWeekOnVisible({}, () => true, () => {})", app)).not.toThrow();
    expect(() => vm.runInContext("applyDueWeekOnVisible(null, () => true, () => {})", app)).not.toThrow();
  });
});
