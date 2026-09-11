import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-plandraft-today.test.ts: a fetch that records what a
// Draft button sends, so the test reads the request body rather than the DOM.
function loadApp(sent: string[]): any {
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
      return { ok: true, json: async () => ({ days: [{ day: "Monday", focus: "Push", exercises: [] }], note: "" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.requestDraft = requestDraft;", ctx);
  // A goal in Base for forty more days, Build after it, and three completed
  // weeks of lifting, so the Home card has a real kilogram target to resize.
  vm.runInContext(`(() => {
    const t = todayStr();
    store.set('goals', [{ id: 'g1', text: 'Olympic triathlon', targetDate: shiftDay(t, 120), created: shiftDay(t, -30),
      milestones: [{ label: 'Base', note: '', date: shiftDay(t, 40), done: false },
                   { label: 'Build', note: '', date: shiftDay(t, 90), done: false },
                   { label: 'Taper', note: '', date: shiftDay(t, 120), done: false }] }]);
    store.set('sessions', [8, 15, 22].map(n => ({ date: shiftDay(t, -n),
      exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] }] })));
  })()`, ctx);
  return ctx;
}

const rows = (app: any) => JSON.parse(vm.runInContext("JSON.stringify(raceCalendar(store.get('goals')[0]))", app));

describe("a calendar row's Draft button", () => {
  it("is on every row after this week and names the goal and that row's Monday", () => {
    const app = loadApp([]);
    const weeks = rows(app);
    const html: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(html).not.toContain(`requestDraft('g1','${weeks[0].start}')`);
    for (const w of weeks.slice(1)) expect(html).toContain(`requestDraft('g1','${w.start}')`);
    expect(html.match(/requestDraft\(/g)).toHaveLength(weeks.length - 1);
    // No goal id, no buttons: the block is still drawn by callers without one.
    expect(vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]))", app)).not.toContain("requestDraft(");
    expect(String(vm.runInContext("renderPlan", app))).toContain("raceCalendarBlock(raceCalendar(g), g.id)");
  });

  it("sends that row's own label, not today's", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    const build = rows(app).find((w: any) => w.phase === "Build" && w.week === 2);
    expect(build).toBeTruthy();
    await app.requestDraft("g1", build.start);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).calendarWeek).toEqual({
      goal: "Olympic triathlon", start: build.start, phase: "Build",
      week: build.week, weeks: build.weeks, raceWeek: false,
    });
  });

  it("sizes the week by that row's phase, from the same baseline Home uses", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    const build = rows(app).find((w: any) => w.phase === "Build");
    await app.requestDraft("g1", build.start);
    const body = JSON.parse(sent[0]);
    const home = vm.runInContext("homeWeekTarget()", app);
    expect(home.reason).toBe("ok");
    expect(home.phase).toBe("Base");
    expect(body.week.phase).toBe("Build");
    expect(body.week.multiplier).toBe(1.0);
    expect(body.week.baseline).toBe(home.baseline);
    expect(body.week.volumeTarget).toBe(Math.round(home.baseline * 1.0));
    expect(body.week.volumeTarget).not.toBe(home.volumeTarget);
  });

  it("labels the draft card with the week it was drafted for", async () => {
    const app = loadApp([]);
    const build = rows(app).find((w: any) => w.phase === "Build" && w.week === 2);
    await app.requestDraft("g1", build.start);
    const html: string = vm.runInContext("draftCard(store.get('plan'), planDraft)", app);
    expect(html).toContain(`Marcus's week of ${vm.runInContext(`niceDate('${build.start}')`, app)}`);
    expect(html).toContain(`Drafted for Build week 2 of ${build.weeks}`);
  });

  it("refuses this week's row and a week that is not on the calendar, sending nothing", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await app.requestDraft("g1", rows(app)[0].start);
    await app.requestDraft("g1", "1999-01-04");
    await app.requestDraft("nope", rows(app)[1].start);
    expect(sent).toHaveLength(0);
  });

  it("leaves Draft my week as it was: no calendarWeek, Home's own target", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await app.requestDraft();
    const body = JSON.parse(sent[0]);
    expect(body.calendarWeek).toBeUndefined();
    expect(body.week).toEqual(JSON.parse(JSON.stringify(vm.runInContext("homeWeekTarget()", app))));
    const html: string = vm.runInContext("draftCard(store.get('plan'), planDraft)", app);
    expect(html).toContain("<h2>Marcus's week</h2>");
    expect(html).not.toContain("Drafted for");
  });

  it("treats a click event handed in as Draft my week, not as a goal id", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await app.requestDraft({ type: "click", target: {} });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).calendarWeek).toBeUndefined();
  });
});
