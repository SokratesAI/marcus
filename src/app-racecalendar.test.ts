import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-weektarget.test.ts: raceCalendar takes a goal and a day
// and returns rows -- no DOM node is touched.
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

const TODAY = "2026-09-09";            // a Wednesday; its Monday is 09-07
// Base 09-01 (a Tuesday)..09-20, so it owns the Mondays 09-07 and 09-14;
// Build 09-21..09-27; Taper 09-28..10-04, the race week.
const goal = () => ({
  text: "Sprint triathlon", targetDate: "2026-10-04", created: "2026-09-01",
  milestones: [
    { label: "Base", note: "", date: "2026-09-20", done: false },
    { label: "Build", note: "", date: "2026-09-27", done: false },
    { label: "Taper", note: "", date: "2026-10-04", done: false },
  ],
});

describe("raceCalendar", () => {
  it("lists every Monday from this week to the race week", () => {
    const rows = loadApp().raceCalendar(goal(), TODAY);
    expect(rows.map((r: any) => r.start)).toEqual(
      ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(rows.map((r: any) => r.raceWeek)).toEqual([false, false, false, true]);
  });

  it("names the phase and counts the Mondays it owns", () => {
    const rows = loadApp().raceCalendar(goal(), TODAY);
    // This week is judged on today (09-09, day 9 of Base), not on Monday.
    expect(rows.map((r: any) => [r.phase, r.week, r.weeks])).toEqual([
      ["Base", 1, 2], ["Base", 2, 2], ["Build", 1, 1], ["Taper", 1, 1]]);
  });

  it("starts every phase of a real goal at week 1 and counts without a gap", () => {
    // A goal built the way the app builds one: buildMilestones cuts the phases
    // on arbitrary weekdays, which is what a hand-written fixture hid -- a phase
    // starting mid-week used to open on "week 2" here.
    const app = loadApp();
    const made = app.validateGoal("Olympic triathlon", "2026-11-23", TODAY);
    expect(made.ok).toBe(true);
    const rows = app.raceCalendar(made.goal, TODAY);
    const byPhase: Record<string, any[]> = {};
    rows.forEach((r: any) => { (byPhase[r.phase] ||= []).push(r); });
    expect(Object.keys(byPhase)).toEqual(["Base", "Build", "Peak", "Taper"]);
    for (const list of Object.values(byPhase)) {
      expect(list.map((r: any) => r.week)).toEqual(list.map((_: any, i: number) => i + 1));
      expect(list.every((r: any) => r.weeks === list.length)).toBe(true);
    }
  });

  it("carries the Home card's multiplier for each phase", () => {
    const app = loadApp();
    const rows = app.raceCalendar(goal(), TODAY);
    expect(rows.map((r: any) => r.multiplier)).toEqual([1.1, 1.1, 1.0, 0.6]);
    expect(rows.map((r: any) => app.volumeChangeLabel(r.multiplier)))
      .toEqual(["volume +10%", "volume +10%", "volume level", "volume −40%"]);
  });

  it("agrees with currentPhase on this week", () => {
    const app = loadApp();
    expect(app.raceCalendar(goal(), TODAY)[0].phase).toBe(app.currentPhase(goal(), TODAY).label);
  });

  it("returns nothing for a goal whose day has passed, or no goal", () => {
    const app = loadApp();
    expect(app.raceCalendar(goal(), "2026-10-05")).toEqual([]);
    // Race on Wednesday, today Thursday of the same week: the loop alone would
    // still list that week, so only the date guard keeps it off the card.
    expect(app.raceCalendar(Object.assign(goal(), { targetDate: "2026-09-09" }), "2026-09-10")).toEqual([]);
    expect(app.raceCalendar(null, TODAY)).toEqual([]);
  });

  it("reads the phases by date even when they are stored out of order", () => {
    const app = loadApp();
    const shuffled = Object.assign(goal(), { milestones: goal().milestones.slice().reverse() });
    expect(app.raceCalendar(shuffled, TODAY)).toEqual(app.raceCalendar(goal(), TODAY));
    expect(app.raceCalendar(shuffled, TODAY)[0].phase).toBe("Base");
  });

  it("still lists the weeks for an old goal with no phases", () => {
    const rows = loadApp().raceCalendar(Object.assign(goal(), { milestones: [] }), TODAY);
    expect(rows).toHaveLength(4);
    expect(rows.every((r: any) => r.phase === null && r.week === null)).toBe(true);
  });

  it("renders under each goal card, folded", () => {
    const app = loadApp();
    const html = app.raceCalendarBlock(app.raceCalendar(goal(), TODAY));
    expect(html).toContain("<details");
    expect(html).toContain("Every week to the race (4)");
    expect(html).toContain("Base week 1 of 2");
    expect(html).toContain("race week");
    expect(String(vm.runInContext("renderPlan", app))).toContain("raceCalendarBlock(raceCalendar(g))");
  });
});

describe("the Plan tab's suggestions follow the goal Home is about", () => {
  it("reviews the plan against homeGoal, not the oldest goal", () => {
    const app = loadApp();
    const renderPlan = String(vm.runInContext("renderPlan", app));
    const acceptProposal = String(vm.runInContext("acceptProposal", app));
    // renderPlan and acceptProposal must judge the same goal, or a button
    // offered on screen is refused as "no longer current" when tapped.
    for (const src of [renderPlan, acceptProposal]) {
      expect(src).toContain("planReview(");
      expect(src).toContain("homeGoal()");
      expect(src).not.toContain("goalsSorted()[0]");
      expect(src).not.toContain("goals[0])");
    }
  });

  it("offers the phase change for the goal ahead once an older race has passed", () => {
    const app = loadApp();
    vm.runInContext(`(() => {
      const t = todayStr();
      store.set('goals', [
        { text: 'Olympic triathlon', targetDate: shiftDay(t, 120), created: shiftDay(t, -30),
          milestones: [{ label: 'Base', note: '', date: shiftDay(t, 40), done: false },
                       { label: 'Taper', note: '', date: shiftDay(t, 120), done: false }] },
        { text: 'Sprint triathlon', targetDate: shiftDay(t, -3), created: shiftDay(t, -90),
          milestones: [{ label: 'Peak', note: '', date: shiftDay(t, -10), done: false }] }]);
      store.set('plan', Object.assign({}, store.get('plan'), { phase: 'Taper' }));
    })()`, app);
    const kinds = (g: string) => vm.runInContext(
      `planReview(store.get('plan'), [], todayStr(), undefined, ${g}).proposals.map(p => p.kind)`, app);
    // The oldest goal has every phase behind it, so it proposes nothing; the
    // goal Home shows is in Base and the plan is sized for Taper.
    expect(kinds("goalsSorted()[0]")).not.toContain("phase");
    expect(kinds("homeGoal()")).toContain("phase");
  });
});
