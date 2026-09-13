import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209, the goal-to-plan half. Clearing the demo data leaves him with seven
// Open days and nothing in them, and the only button that fills them again --
// Draft my week -- is on the Plan tab, below the suggestions and the research
// block. That is the same shape as the full clear he never found on Progress, so
// Home now carries the draft whenever the week it is drawing is empty.
//
// Same vm harness as app-home-nogoal.test.ts: app.js is a classic script, so its
// top-level declarations land on the context and the tests read them back.
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

const GOAL = `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '2027-08-14', created: '2026-09-12', milestones: [] }])`;

describe("planIsEmpty", () => {
  it("is true for the week clearing the demo data leaves behind", () => {
    const app = loadApp();
    // Not a week this test wrote: the literal `clearDemoData` actually stores.
    run(app, `store.set('plan', emptyPlanTemplate())`);
    expect(run(app, "planIsEmpty()")).toBe(true);
  });

  it("is false for the demo week, which is full", () => {
    const app = loadApp();
    run(app, `store.set('plan', demoPlanTemplate())`);
    expect(run(app, "planIsEmpty()")).toBe(false);
  });

  it("is false the moment one day carries one exercise", () => {
    const app = loadApp();
    run(app, `const p = emptyPlanTemplate(); p.days[2].exercises.push({ name: 'Back Squat', sets: 3, reps: 5 }); store.set('plan', p)`);
    expect(run(app, "planIsEmpty()")).toBe(false);
  });

  it("is false for a week whose only work is cardio", () => {
    // An endurance week is mostly cardio and carries no exercises at all, so a
    // check that only counted exercises would call his running week empty and
    // offer to write over it.
    const app = loadApp();
    run(app, `const p = emptyPlanTemplate(); p.days[1].cardio = { activity: 'Run', minutes: 45 }; store.set('plan', p)`);
    expect(run(app, "planIsEmpty()")).toBe(false);
  });

  it("is false when there is no plan at all, because seedShell writes one back", () => {
    const app = loadApp();
    run(app, `store.set('plan', null)`);
    expect(run(app, "planIsEmpty()")).toBe(false);
  });
});

describe("Home when the week is empty", () => {
  it("offers the draft where the emptiness is, not one tab away", () => {
    const app = loadApp();
    run(app, GOAL);
    run(app, `store.set('plan', emptyPlanTemplate())`);
    const html = home(app);
    expect(html).toContain("Your week is empty");
    expect(html).toContain("Draft my week");
    expect(html).toContain(`onclick="draftFromHome()"`);
    // The goal is named in the card, so the offer says what it will draft from.
    expect(html).toContain("Oslo Triathlon");
    expect(html).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it("names a real global, not a string that only looks like a call", () => {
    const app = loadApp();
    expect(run(app, "typeof draftFromHome")).toBe("function");
    expect(run(app, "typeof requestDraft")).toBe("function");
  });

  it("changes tab before asking, because requestDraft paints the Plan tab", () => {
    // requestDraft calls renderPlan directly. Called from Home without the tab
    // change, the draft card and the busy state land on a screen that is about
    // to be replaced.
    const app = loadApp();
    run(app, GOAL);
    run(app, `store.set('plan', emptyPlanTemplate())`);
    run(app, `switchTab('home')`);
    run(app, `planDraftSeen = []; const realRequest = requestDraft; requestDraft = function () { planDraftSeen.push(currentTab); }`);
    run(app, `draftFromHome()`);
    expect(run(app, "planDraftSeen")).toEqual(["plan"]);
  });

  it("says nothing of the sort while the demo week is still on screen", () => {
    // The demo week is full, and the card above it already offers to clear it.
    // Two answers to one screen is the second asker this idea keeps growing.
    const app = loadApp();
    run(app, GOAL);
    run(app, `store.set('plan', demoPlanTemplate())`);
    const html = home(app);
    expect(html).not.toContain("Your week is empty");
    expect(html).not.toContain(`onclick="draftFromHome()"`);
  });

  it("does not offer a draft from a goal whose day has gone", () => {
    // homeGoal() keeps handing back the last goal after its date so Home can ask
    // what is next; draftGoals() drops it, so the coach would get an empty goal
    // list and draft the generic week he just cleared.
    const app = loadApp();
    run(app, `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '2020-08-14', created: '2020-01-01', milestones: [] }])`);
    run(app, `store.set('plan', emptyPlanTemplate())`);
    expect(run(app, "draftGoals()")).toEqual([]);
    expect(run(app, "homeGoal().text")).toBe("Oslo Triathlon");
    const html = home(app);
    expect(html).not.toContain("Your week is empty");
    expect(html).not.toContain(`onclick="draftFromHome()"`);
  });

  it("does not offer a draft when there is no goal to draft from", () => {
    // Home already asks what he is training for in that case. A draft button
    // beside it would be a second answer to the same screen, and a week drafted
    // from nothing is the generic week he just cleared.
    const app = loadApp();
    run(app, `store.set('goals', [])`);
    run(app, `store.set('plan', emptyPlanTemplate())`);
    const html = home(app);
    expect(html).not.toContain(`onclick="draftFromHome()"`);
    expect(html).toContain("What are you training for?");
    // And the question tells the truth about the week it is standing on.
    expect(html).toContain("your week is empty");
    expect(html).not.toContain("so this week is a generic one");
  });

  it("still calls the week generic when there is no goal and a week is planned", () => {
    const app = loadApp();
    run(app, `store.set('goals', [])`);
    run(app, `store.set('plan', demoPlanTemplate())`);
    const html = home(app);
    expect(html).toContain("so this week is a generic one");
    expect(html).not.toContain("your week is empty");
  });
});
