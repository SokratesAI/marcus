import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-rpe.test.ts: openNudges and applyBadge take plain
// arguments and return values, so no DOM node is touched.
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

// 2026-09-07 is a Monday and 2026-09-10 a Thursday, so a week that starts on
// Monday runs 09-07..09-13. Every date below is checked against that.
const MONDAY = "2026-09-07";
const THURSDAY = "2026-09-10";

const plan = (over: Record<string, unknown> = {}) => ({
  days: [
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }] },
    { day: "Tuesday", focus: "Pull", exercises: [{ name: "Row", sets: 3, reps: 10 }] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Legs", exercises: [{ name: "Squat", sets: 4, reps: 6 }] },
    { day: "Friday", focus: "Conditioning", exercises: [], cardio: { activity: "Run", minutes: 40 } },
    { day: "Saturday", focus: "Rest", exercises: [] },
    { day: "Sunday", focus: "Rest", exercises: [] },
  ],
  ...over,
});

const session = (date: string) => ({ id: date, date, day: "x", exercises: [] });

describe("openNudges", () => {
  it("says nothing when every planned day this week is logged", () => {
    const app = loadApp();
    const done = [session(MONDAY), session("2026-09-08"), session(THURSDAY)];
    expect(app.openNudges(plan(), done, THURSDAY)).toEqual([]);
  });

  it("names today when today is a planned training day with nothing logged", () => {
    const app = loadApp();
    const done = [session(MONDAY), session("2026-09-08")];
    const out = app.openNudges(plan(), done, THURSDAY);
    expect(out.map((n: any) => n.kind)).toEqual(["today"]);
    expect(out[0].text).toContain("Legs");
  });

  it("stays quiet on a rest day even with nothing logged that day", () => {
    const app = loadApp();
    const done = [session(MONDAY), session("2026-09-08")];
    // Wednesday is Rest in the plan, and Monday and Tuesday are both logged.
    expect(app.openNudges(plan(), done, "2026-09-09")).toEqual([]);
  });

  it("counts a cardio-only plan day as a training day", () => {
    const app = loadApp();
    // Friday carries no exercises, only a cardio block.
    const out = app.openNudges(plan(), [], "2026-09-11");
    expect(out.map((n: any) => n.kind)).toContain("today");
  });

  it("clears today's nudge from any session dated today, cardio included", () => {
    const app = loadApp();
    const swim = { id: "s", date: THURSDAY, kind: "cardio", activity: "Swim", minutes: 30 };
    const done = [session(MONDAY), session("2026-09-08"), swim];
    expect(app.openNudges(plan(), done, THURSDAY)).toEqual([]);
  });

  it("never counts today twice — a skipped today is the today nudge only", () => {
    const app = loadApp();
    const done = [session(MONDAY), session("2026-09-08")];
    const out = app.openNudges(plan(), done, THURSDAY);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("today");
  });

  it("reports the earlier days of this week as one nudge, however many there are", () => {
    const app = loadApp();
    // Monday, Tuesday and Thursday all planned; nothing logged at all.
    const out = app.openNudges(plan(), [], THURSDAY);
    expect(out.map((n: any) => n.kind)).toEqual(["today", "week"]);
    expect(out[1].text).toContain("2 sessions");
  });

  it("says 'One session' rather than '1 sessions' for a single missed day", () => {
    const app = loadApp();
    const done = [session(MONDAY), session(THURSDAY)];
    const out = app.openNudges(plan(), done, THURSDAY);
    expect(out.map((n: any) => n.kind)).toEqual(["week"]);
    expect(out[0].text).toBe("One session earlier this week is still unlogged.");
  });

  it("does not look back past the start of this week", () => {
    const app = loadApp();
    // Last Thursday is a planned day and unlogged; this week is clean so far.
    const done = [session(MONDAY), session("2026-09-08")];
    expect(app.openNudges(plan(), done, "2026-09-09")).toEqual([]);
  });

  it("has nothing to say without a plan", () => {
    const app = loadApp();
    expect(app.openNudges(null, [], THURSDAY)).toEqual([]);
    expect(app.openNudges({ days: [] }, [], THURSDAY)).toEqual([]);
  });

  it("caps at two, so the badge is a nudge count and not a backlog", () => {
    const app = loadApp();
    expect(app.openNudges(plan(), [], "2026-09-13").length).toBeLessThanOrEqual(2);
  });
});

describe("applyBadge", () => {
  it("sets the count when there is something to nudge about", () => {
    const app = loadApp();
    const calls: number[] = [];
    const nav: any = { setAppBadge: (n: number) => { calls.push(n); }, clearAppBadge: () => { calls.push(-1); } };
    expect(app.applyBadge(nav, 2)).toBe(true);
    expect(calls).toEqual([2]);
  });

  it("clears rather than setting zero, because a browser may implement only clear", () => {
    const app = loadApp();
    let cleared = false; let set = false;
    const nav: any = { setAppBadge: () => { set = true; }, clearAppBadge: () => { cleared = true; } };
    expect(app.applyBadge(nav, 0)).toBe(true);
    expect(cleared).toBe(true);
    expect(set).toBe(false);
  });

  it("reports false rather than throwing where the API does not exist", () => {
    const app = loadApp();
    expect(app.applyBadge({}, 1)).toBe(false);
    expect(app.applyBadge({}, 0)).toBe(false);
    expect(app.applyBadge(null, 1)).toBe(false);
  });

  it("swallows the rejection Safari gives an uninstalled page", async () => {
    const app = loadApp();
    const nav: any = { setAppBadge: () => Promise.reject(new Error("not installed")) };
    expect(app.applyBadge(nav, 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("survives a setAppBadge that throws synchronously", () => {
    const app = loadApp();
    const nav: any = { setAppBadge: () => { throw new Error("nope"); } };
    expect(app.applyBadge(nav, 1)).toBe(false);
  });
});

describe("refreshBadge", () => {
  // `store` is a top-level const, which lives in the context's global lexical
  // scope rather than on the context object, so it is reachable from a second
  // script run in the same context and not as a property of it.
  function withStore(plan: unknown, sessions: unknown[]) {
    const app = loadApp();
    vm.runInContext(`store.set('plan', ${JSON.stringify(plan)});`
                  + `store.set('sessions', ${JSON.stringify(sessions)});`, app);
    const calls: number[] = [];
    app.navigator.setAppBadge = (n: number) => { calls.push(n); };
    app.navigator.clearAppBadge = () => { calls.push(0); };
    return { app, calls };
  }

  it("passes the real count through, not just whether there is one", () => {
    const { app, calls } = withStore(plan(), []);
    // Monday, Tuesday and Thursday planned, nothing logged: today plus the week.
    expect(app.refreshBadge(THURSDAY)).toBe(true);
    expect(calls).toEqual([2]);
  });

  it("clears the icon when the week is up to date", () => {
    const { app, calls } = withStore(plan(), [session(MONDAY), session("2026-09-08"), session(THURSDAY)]);
    expect(app.refreshBadge(THURSDAY)).toBe(true);
    expect(calls).toEqual([0]);
  });

  it("reads the stored plan and sessions rather than being handed them", () => {
    const { app, calls } = withStore(plan(), [session(MONDAY), session("2026-09-08")]);
    app.refreshBadge(THURSDAY);
    expect(calls).toEqual([1]);
  });
});

describe("the badge is wired to every render", () => {
  it("switchTab refreshes it, so a saved session updates the icon", () => {
    const src = APP_SOURCE;
    const body = src.slice(src.indexOf("function switchTab("));
    expect(body.slice(0, body.indexOf("\n}"))).toContain("refreshBadge()");
  });
});
