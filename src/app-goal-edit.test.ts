import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209: a goal could only be removed and set again, which threw away the
// milestone ticks and, across two phones, left a second goal beside the new
// one. Same vm shape as app-goal-ongoing.test.ts; the view node is kept so the
// rendered form can be read back, and focus() is recorded so the "the tap did
// nothing" case is a real assertion rather than a hope.
function loadApp(): any {
  const focused: string[] = [];
  const handlers: Record<string, any[]> = {};
  const makeNode = (id?: string): any => {
    const node: any = {
      value: "", textContent: "", hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, remove() {},
      addEventListener(ev: string, fn: any) { (handlers[String(id) + ":" + ev] ??= []).push(fn); },
      focus() { focused.push(String(id)); },
      querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
    };
    let html = "";
    Object.defineProperty(node, "innerHTML", {
      get: () => html,
      // Writing a view's innerHTML destroys its children in a real DOM and
      // their listeners with them. getElementById here hands back the same
      // cached node every time, so without this every render stacks another
      // click handler on it and one tap saves the goal twice.
      set: (v: string) => { html = v; if (id === "view") Object.keys(handlers).forEach(k => delete handlers[k]); },
    });
    return node;
  };
  const nodes: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (nodes[id] ??= makeNode(id)),
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
    fetch: async () => ({ ok: true, json: async () => ({ days: [], note: "" }) }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  ctx.focused = focused;
  // Firing the page's OWN click handler, rather than a test re-spelling of what
  // it does, is the only way a save test can fail when the handler is wrong.
  ctx.click = (id: string) => (handlers[id + ":click"] || []).forEach((fn) => fn());
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.startGoalEdit = startGoalEdit;globalThis.renderPlan = renderPlan;globalThis.deleteGoal = deleteGoal;", ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);

const DATED = `{ id: 'g1', text: 'Olympic triathlon', targetDate: '2027-06-05', created: '2026-09-01',
  milestones: [
    { id: 'm1', label: 'Base', note: 'n', date: '2026-12-01', done: true },
    { id: 'm2', label: 'Build', note: 'n', date: '2027-03-01', done: true },
    { id: 'm3', label: 'Peak', note: 'n', date: '2027-05-10', done: false },
    { id: 'm4', label: 'Taper', note: 'n', date: '2027-06-05', done: false }] }`;

describe("editing a goal", () => {
  it("keeps the id, the created date and the ticks when only the text changes", () => {
    const app = loadApp();
    const r = run(app, `validateGoalEdit(${DATED}, 'Olympic triathlon in Bergen', '2027-06-05', '2026-09-12')`);
    expect(r.ok).toBe(true);
    // The id is what a two-phone merge identifies the goal by, so a changed id
    // is a second goal on the other phone rather than an edit of this one.
    expect(r.goal.id).toBe("g1");
    expect(r.goal.text).toBe("Olympic triathlon in Bergen");
    expect(r.goal.created).toBe("2026-09-01");
    expect(r.goal.milestones.map((m: any) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.goal.milestones.filter((m: any) => m.done).length).toBe(2);
  });

  it("re-cuts the phases from the day the goal was set, not from today", () => {
    const app = loadApp();
    const r = run(app, `validateGoalEdit(${DATED}, 'Olympic triathlon', '2027-07-05', '2026-09-12')`);
    expect(r.ok).toBe(true);
    expect(r.goal.milestones.map((m: any) => m.label)).toEqual(["Base", "Build", "Peak", "Taper"]);
    // Cut from 2026-09-01, so Base ends 40% of the way through a 307-day span.
    // Cut from today instead and Base would end later than this, because the
    // window would start eleven days further on.
    const fromCreated = run(app, "buildMilestones('2026-09-01', '2027-07-05')");
    const fromToday = run(app, "buildMilestones('2026-09-12', '2027-07-05')");
    expect(r.goal.milestones.map((m: any) => m.date)).toEqual(fromCreated.map((m: any) => m.date));
    expect(r.goal.milestones[0].date).not.toBe(fromToday[0].date);
    // The ticks survive the re-cut, matched by phase label.
    expect(r.goal.milestones.filter((m: any) => m.done).map((m: any) => m.label)).toEqual(["Base", "Build"]);
  });

  it("drops the phases when the goal becomes ongoing, and rebuilds them when a date comes back", () => {
    const app = loadApp();
    const ongoing = run(app, `validateGoalEdit(${DATED}, 'Get fitter', '', '2026-09-12')`);
    expect(ongoing.goal.targetDate).toBe("");
    expect(ongoing.goal.milestones).toEqual([]);
    const redated = run(app, `validateGoalEdit(${JSON.stringify({ id: "g1", text: "Get fitter", targetDate: "", created: "2026-09-01", milestones: [] })}, 'Half marathon', '2027-02-01', '2026-09-12')`);
    expect(redated.goal.id).toBe("g1");
    expect(redated.goal.milestones.length).toBe(4);
    expect(redated.goal.milestones.every((m: any) => m.done === false)).toBe(true);
  });

  it("refuses what setting a goal refuses, and refuses a goal that is gone", () => {
    const app = loadApp();
    expect(run(app, `validateGoalEdit(${DATED}, '', '2027-06-05', '2026-09-12')`).message).toMatch(/what you are training for/);
    expect(run(app, `validateGoalEdit(${DATED}, 'x', '2026-09-01', '2026-09-12')`).message).toMatch(/in the future/);
    expect(run(app, `validateGoalEdit(null, 'x', '', '2026-09-12')`).ok).toBe(false);
    // A refusal never returns a goal to write over the good one.
    expect(run(app, `validateGoalEdit(${DATED}, '', '', '2026-09-12')`).goal).toBe(undefined);
  });

  it("puts the form into edit mode with the goal in it, and focuses it", () => {
    const app = loadApp();
    run(app, `store.set('goals', [${DATED}])`);
    run(app, "renderPlan()");
    expect(app.nodes.view.innerHTML).toContain("Add a goal");
    expect(app.nodes.view.innerHTML).not.toContain("Save changes");
    run(app, "startGoalEdit('g1')");
    expect(app.nodes.view.innerHTML).toContain("Edit goal");
    expect(app.nodes.view.innerHTML).toContain("Save changes");
    expect(app.nodes.view.innerHTML).toContain(`value="Olympic triathlon"`);
    expect(app.nodes.view.innerHTML).toContain(`value="2027-06-05"`);
    expect(app.nodes.view.innerHTML).toContain("cancelGoalEdit");
    // Without this the tap looks like it did nothing when the form is below
    // the fold.
    expect(app.focused).toContain("goalText");
  });

  it("falls back to the Add form when the goal being edited is deleted", () => {
    const app = loadApp();
    run(app, `store.set('goals', [${DATED}])`);
    run(app, "startGoalEdit('g1')");
    run(app, "deleteGoal('g1')");
    expect(app.nodes.view.innerHTML).toContain("Add a goal");
    expect(app.nodes.view.innerHTML).not.toContain("Save changes");
    // And the form is genuinely an Add form again, not one still pointed at a
    // goal that is gone -- that state looks identical on the page and refuses
    // the next goal you set with "That goal is gone."
    run(app, `document.getElementById('goalText').value = 'Half marathon'; document.getElementById('goalDate').value = '2027-03-01';`);
    app.click("addGoal");
    expect(run(app, "store.get('goals', [])").map((g: any) => g.text)).toEqual(["Half marathon"]);
  });

  it("saves through the page's own button and leaves the list one goal long", () => {
    const app = loadApp();
    run(app, `store.set('goals', [${DATED}])`);
    run(app, "startGoalEdit('g1')");
    run(app, `document.getElementById('goalText').value = 'Olympic triathlon in Bergen'; document.getElementById('goalDate').value = '2027-06-05';`);
    app.click("addGoal");
    const goals = run(app, "store.get('goals', [])");
    // Not two: an edit that appended would read as a second goal here, which is
    // exactly what remove-and-set-again did across two phones.
    expect(goals.length).toBe(1);
    expect(goals[0].text).toBe("Olympic triathlon in Bergen");
    expect(goals[0].id).toBe("g1");
    expect(goals[0].milestones.filter((m: any) => m.done).length).toBe(2);
    // The form goes back to Add once the edit is saved.
    expect(app.nodes.view.innerHTML).toContain("Add a goal");
  });

  it("cancels back to the Add form without writing anything", () => {
    const app = loadApp();
    run(app, `store.set('goals', [${DATED}])`);
    run(app, "startGoalEdit('g1')");
    run(app, `document.getElementById('goalText').value = 'typed but abandoned';`);
    app.click("cancelGoalEdit");
    expect(app.nodes.view.innerHTML).toContain("Add a goal");
    expect(run(app, "store.get('goals', [])")[0].text).toBe("Olympic triathlon");
  });

  it("does not add a new goal when the edit is refused", () => {
    const app = loadApp();
    run(app, `store.set('goals', [${DATED}])`);
    run(app, "startGoalEdit('g1')");
    run(app, `document.getElementById('goalText').value = ''; document.getElementById('goalDate').value = '2027-06-05';`);
    app.click("addGoal");
    const goals = run(app, "store.get('goals', [])");
    expect(goals.length).toBe(1);
    expect(goals[0].text).toBe("Olympic triathlon");
  });
});
