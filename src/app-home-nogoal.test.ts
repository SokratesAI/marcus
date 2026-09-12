import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209. Every feature built onto a goal so far -- the phase sentence, the
// race calendar, the volume trend, the Progress card -- draws nothing until a
// goal exists, and Home said nothing at all when there was none. His live synced
// state has held no goals key since 2026-09-07, so this is the gate the whole
// chain sits behind, not a cosmetic empty state.
//
// Same vm harness as app-goal-ongoing.test.ts: app.js is a classic script, so
// its top-level declarations land on the context and the tests read them back.
function loadApp(): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const nodes: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (nodes[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
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
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);
const home = (app: any) => {
  run(app, "renderHome()");
  return run(app, "view.innerHTML") as string;
};

describe("Home when Marcus has no goal", () => {
  it("asks the question instead of rendering nothing", () => {
    const app = loadApp();
    run(app, `store.set('goals', [])`);
    // The precondition the whole test rests on: there really is no goal, and
    // homeGoal() -- which falls back to the last goal once every date has
    // passed -- agrees there is none.
    expect(run(app, "goalsSorted()")).toEqual([]);
    expect(run(app, "homeGoal()")).toBeUndefined();

    const html = home(app);
    expect(html).toContain("Next goal");
    expect(html).toContain("What are you training for?");
    expect(html).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it("offers the chat first, because stating it out loud is the flow that listens", () => {
    const app = loadApp();
    run(app, `store.set('goals', [])`);
    const html = home(app);
    // openChat() is the chat sheet; switchTab('plan') is the typed form. Both
    // are reachable, and the chat is the filled button because a form he has to
    // find is not a flow that listens.
    expect(html).toContain('onclick="openChat()"');
    expect(html).toContain(`onclick="switchTab('plan')"`);
    expect(html.indexOf('onclick="openChat()"')).toBeLessThan(html.indexOf(`onclick="switchTab('plan')"`));
    // Both are real globals in the page, not names that only look like calls.
    expect(run(app, "typeof openChat")).toBe("function");
    expect(run(app, "typeof switchTab")).toBe("function");
  });

  it("says nothing of the sort once a goal exists", () => {
    const app = loadApp();
    run(app, `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '2027-08-14', created: '2026-09-12', milestones: [{ id: 'm1', label: 'Base', note: 'aerobic base', date: '2027-02-01', done: false }] }])`);
    const html = home(app);
    expect(html).toContain("Oslo Triathlon");
    expect(html).not.toContain("What are you training for?");
    expect(html).not.toContain('onclick="openChat()"');
  });

  it("still says nothing of the sort when the goal's target date has passed", () => {
    // homeGoal() deliberately keeps the last goal after its date, so the card
    // reads "target date passed" rather than going blank. Asking "what are you
    // training for?" there would be telling him he never told Marcus anything.
    const app = loadApp();
    run(app, `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '2020-08-14', created: '2020-01-01', milestones: [] }])`);
    const html = home(app);
    expect(html).toContain("Oslo Triathlon");
    expect(html).not.toContain("What are you training for?");
  });
});
