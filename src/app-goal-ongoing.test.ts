import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./plan-draft.js";

// Idea #209: "Improve overall health and fitness" is his own example of a goal,
// and it has no race day. Same vm shape as app-plandraft-today.test.ts, except
// the view node is kept so a render can be read back.
function loadApp(sent: string[]): any {
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
    fetch: async (url: string, init: any) => {
      if (String(url).includes("/api/plan-draft")) sent.push(String(init && init.body));
      return { ok: true, json: async () => ({ days: [], note: "" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.requestDraft = requestDraft;globalThis.todayStr = todayStr;", ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);

describe("a goal with no target date", () => {
  it("is accepted as an ongoing goal with no phases", () => {
    const app = loadApp([]);
    const r = run(app, "validateGoal('Improve overall health and fitness', '', '2026-09-11')");
    expect(r.ok).toBe(true);
    expect(r.goal.text).toBe("Improve overall health and fitness");
    expect(r.goal.targetDate).toBe("");
    expect(r.goal.milestones).toEqual([]);
    expect(r.goal.created).toBe("2026-09-11");
    // A date that was typed is still checked -- only an empty one means ongoing.
    expect(run(app, "validateGoal('Run a marathon', 'next july', '2026-08-31')").message).toMatch(/not a real date/);
    expect(run(app, "validateGoal('Run a marathon', '2026-08-30', '2026-08-31')").message).toMatch(/in the future/);
  });

  it("sorts after every dated goal, and a race still leads Home", () => {
    const app = loadApp([]);
    run(app, `(() => {
      const t = todayStr();
      store.set('goals', [
        { id: 'a', text: 'Get fitter', targetDate: '', created: t, milestones: [] },
        { id: 'b', text: 'Half marathon', targetDate: shiftDay(t, 60), created: t, milestones: [] }]);
    })()`);
    expect(run(app, "goalsSorted().map(g => g.text)")).toEqual(["Half marathon", "Get fitter"]);
    expect(run(app, "homeGoal().text")).toBe("Half marathon");
    expect(run(app, "draftGoals().map(g => g.text)")).toEqual(["Half marathon", "Get fitter"]);
  });

  it("never passes, so it is still served once every race is behind him", () => {
    const app = loadApp([]);
    run(app, `(() => {
      const t = todayStr();
      store.set('goals', [
        { id: 'a', text: 'Get fitter', targetDate: '', created: shiftDay(t, -90), milestones: [] },
        { id: 'b', text: '10 km', targetDate: shiftDay(t, -3), created: shiftDay(t, -60), milestones: [] }]);
    })()`);
    expect(run(app, "draftGoals().map(g => g.text)")).toEqual(["Get fitter"]);
    expect(run(app, "homeGoal().text")).toBe("Get fitter");
  });

  it("reaches the coach when he drafts a week", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    run(app, `store.set('goals', [{ id: 'a', text: 'Improve overall health and fitness', targetDate: '', created: todayStr(), milestones: [] }])`);
    await app.requestDraft();
    const body = JSON.parse(sent[0]);
    expect(body.goals.map((g: any) => g.text)).toEqual(["Improve overall health and fitness"]);
    const prompt = buildDraftPrompt(body.goals, { goals: body.goals } as any, body.today);
    expect(prompt).toContain("Edvard is training for: Improve overall health and fitness (an ongoing goal with no target date");
    expect(prompt).not.toContain("has not written a goal yet");
    expect(prompt).not.toContain("target date )");
  });

  it("is not reported as a goal whose phases have all passed", () => {
    const app = loadApp([]);
    run(app, `store.set('goals', [{ id: 'a', text: 'Improve overall health and fitness', targetDate: '', created: '2026-09-01', milestones: [] }])`);
    const week = run(app, "homeWeekTarget('2026-09-11')");
    expect(week.reason).toBe("ongoing goal");
    expect(week.note).toBe("That goal has no target date, so there are no phases to size the week from.");
    expect(week.phase).toBe(null);
    // A dated goal every phase of which is behind him still says that, and a
    // store with no goal at all still says there is no goal.
    run(app, `store.set('goals', [{ id: 'b', text: '10 km', targetDate: '2026-09-05', created: '2026-08-01', milestones: [{ label: 'Peak', note: '', date: '2026-09-05', done: false }] }])`);
    expect(run(app, "homeWeekTarget('2026-09-11')").reason).toBe("phases done");
    run(app, `store.set('goals', [])`);
    expect(run(app, "homeWeekTarget('2026-09-11')").reason).toBe("no goal");
  });

  it("says ongoing on Home, Plan and Progress instead of a countdown", () => {
    const app = loadApp([]);
    run(app, `store.set('goals', [{ id: 'a', text: 'Improve overall health and fitness', targetDate: '', created: '2026-09-11', milestones: [] }])`);
    expect(run(app, "goalCountdown('')")).toBe("ongoing");
    run(app, "renderHome()");
    const home = app.nodes.view.innerHTML as string;
    expect(home).toContain("Improve overall health and fitness");
    expect(home).toContain(">ongoing<");
    expect(home).toContain("No target date, so no phases");
    expect(home).not.toContain("target day is the only thing left");
    expect(home).not.toMatch(/NaN|Invalid Date|undefined/);
    run(app, "renderPlan()");
    const plan = app.nodes.view.innerHTML as string;
    expect(plan).toContain("No target date · an ongoing goal");
    expect(plan).not.toMatch(/NaN|Invalid Date|Target undefined/);
    const progress = run(app, "goalProgressCard(store.get('goals')[0], '2026-09-20')") as string;
    expect(progress).toContain(">ongoing<");
    expect(progress).not.toContain("Time gone");
    expect(progress).not.toMatch(/NaN|Invalid Date|target day is today/);
  });
});
