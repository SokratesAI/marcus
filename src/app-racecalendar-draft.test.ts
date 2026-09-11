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
    // A later week waits for its Monday, and the card says so.
    expect(html).toContain("Save for that week");
    expect(html).toContain("the week you are on now stays as it is");
    expect(html).not.toContain("Use this week");
  });

  it("keeps the tapped goal's list open through the re-render, and only that one", async () => {
    const app = loadApp([]);
    const closed: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(closed).toContain('<details class="race-calendar" style="margin:8px 0">');
    await app.requestDraft("g1", rows(app)[1].start);
    expect(vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app))
      .toContain('<details class="race-calendar" style="margin:8px 0" open>');
    expect(vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'other')", app))
      .not.toContain(" open>");
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
    expect(html).toContain("Use this week");
    expect(html).not.toContain("Save for that week");
  });

  it("treats a click event handed in as Draft my week, not as a goal id", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await app.requestDraft({ type: "click", target: {} });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).calendarWeek).toBeUndefined();
  });
});

const run = (app: any, src: string) => JSON.parse(vm.runInContext(`JSON.stringify(${src})`, app) ?? "null");

describe("a week drafted ahead waits for its Monday", () => {
  it("is saved under that Monday and leaves the plan he is on untouched", async () => {
    const app = loadApp([]);
    const before = run(app, "store.get('plan')");
    const later = rows(app)[2];
    await app.requestDraft("g1", later.start);
    vm.runInContext("acceptDraft()", app);
    expect(run(app, "store.get('plan')")).toEqual(before);
    const saved = run(app, "store.get('plannedWeeks')");
    expect(saved).toHaveLength(1);
    expect(saved[0].start).toBe(later.start);
    expect(saved[0].days[0].focus).toBe("Push");
    expect(run(app, "planDraft")).toBeNull();
  });

  it("replaces an earlier draft for the same week rather than keeping two", async () => {
    const app = loadApp([]);
    const later = rows(app)[2];
    for (let i = 0; i < 2; i++) {
      await app.requestDraft("g1", later.start);
      vm.runInContext("acceptDraft()", app);
    }
    expect(run(app, "store.get('plannedWeeks')")).toHaveLength(1);
  });

  it("Draft my week still writes the plan at once and saves nothing ahead", async () => {
    const app = loadApp([]);
    await app.requestDraft();
    vm.runInContext("acceptDraft()", app);
    expect(run(app, "store.get('plan').days.find(d => d.day === 'Monday').focus")).toBe("Push");
    expect(run(app, "store.get('plannedWeeks', [])")).toEqual([]);
  });

  it("becomes the plan once its week has begun, and a later one keeps waiting", () => {
    const app = loadApp([]);
    vm.runInContext(`(() => {
      const mon = weekStartOf(todayStr());
      store.set('plannedWeeks', [
        { id: mon, start: mon, days: [{ day: 'Tuesday', focus: 'Swim day', exercises: [] }] },
        { id: shiftDay(mon, 7), start: shiftDay(mon, 7), days: [{ day: 'Monday', focus: 'Later', exercises: [] }] },
      ]);
    })()`, app);
    const expected = run(app, "applyDraft(store.get('plan'), store.get('plannedWeeks')[0].days).days");
    expect(vm.runInContext("applyDueWeek()", app)).toBe(true);
    expect(run(app, "store.get('plan').days")).toEqual(expected);
    expect(run(app, "store.get('plan').days.find(d => d.day === 'Tuesday').focus")).toBe("Swim day");
    expect(run(app, "store.get('plannedWeeks').map(w => w.start)")).toEqual([run(app, "shiftDay(weekStartOf(todayStr()), 7)")]);
    // Nothing else has begun, so a second call writes nothing.
    expect(vm.runInContext("applyDueWeek()", app)).toBe(false);
  });

  it("applies the newest week that has begun when several have, and drops the older", () => {
    const app = loadApp([]);
    const out = run(app, `takeDueWeek([
      { start: '2026-09-07', days: [] }, { start: '2026-09-21', days: [] },
      { start: '2026-09-14', days: [] }, { start: '2026-09-28', days: [] }], '2026-09-21')`);
    expect(out.due.start).toBe("2026-09-21");
    expect(out.waiting.map((w: any) => w.start)).toEqual(["2026-09-28"]);
    expect(run(app, "takeDueWeek([], '2026-09-21')")).toEqual({ due: null, waiting: [] });
  });

  it("is checked before every tab renders", () => {
    const app = loadApp([]);
    const src = String(vm.runInContext("switchTab", app));
    expect(src.indexOf("applyDueWeek()")).toBeGreaterThan(-1);
    expect(src.indexOf("applyDueWeek()")).toBeLessThan(src.indexOf("renderers[tab]()"));
  });

  it("shows as Planned on its calendar row, and can be dropped", async () => {
    const app = loadApp([]);
    const later = rows(app)[2];
    await app.requestDraft("g1", later.start);
    vm.runInContext("acceptDraft()", app);
    const html: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(html.match(/>Planned</g)).toHaveLength(1);
    expect(html).toContain(`dropWeekAhead('${later.start}')`);
    vm.runInContext(`dropWeekAhead('${later.start}')`, app);
    expect(run(app, "store.get('plannedWeeks')")).toEqual([]);
    expect(vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app)).not.toContain(">Planned<");
  });

  it("merges with the other phone's saved weeks on a conflicting push", () => {
    const app = loadApp([]);
    const out = run(app, `mergeBackupData(
      { plannedWeeks: [{ id: '2026-10-12@2', start: '2026-10-12', days: [] }] },
      { plannedWeeks: [{ id: '2026-10-05@1', start: '2026-10-05', days: [] }] }).plannedWeeks.map(w => w.start).sort()`);
    expect(out).toEqual(["2026-10-05", "2026-10-12"]);
  });

  it("does not come back from the other phone once applied or dropped", () => {
    const app = loadApp([]);
    vm.runInContext(`(() => {
      const mon = weekStartOf(todayStr());
      store.set('plannedWeeks', [
        { id: mon + '@1', start: mon, days: [{ day: 'Tuesday', focus: 'Swim day', exercises: [] }] },
        { id: shiftDay(mon, 7) + '@1', start: shiftDay(mon, 7), days: [] },
      ]);
    })()`, app);
    const stale = run(app, "store.get('plannedWeeks')");
    expect(vm.runInContext("applyDueWeek()", app)).toBe(true);
    vm.runInContext(`dropWeekAhead(shiftDay(weekStartOf(todayStr()), 7))`, app);
    // The other phone still holds both weeks and pushes them back.
    const merged = run(app, `mergeBackupData({ plannedWeeks: store.get('plannedWeeks'), deletions: store.get('deletions') },
      { plannedWeeks: ${JSON.stringify(stale)} }).plannedWeeks`);
    expect(merged).toEqual([]);
  });

  it("a week saved again after one was dropped is not swallowed by the old tombstone", async () => {
    const app = loadApp([]);
    const later = rows(app)[2];
    await app.requestDraft("g1", later.start);
    vm.runInContext("acceptDraft()", app);
    vm.runInContext(`dropWeekAhead('${later.start}')`, app);
    await new Promise(r => setTimeout(r, 2));
    await app.requestDraft("g1", later.start);
    vm.runInContext("acceptDraft()", app);
    const merged = run(app, `mergeBackupData({ plannedWeeks: store.get('plannedWeeks'), deletions: store.get('deletions') }, {}).plannedWeeks`);
    expect(merged.map((w: any) => w.start)).toEqual([later.start]);
  });

  it("survives a backup and a restore", async () => {
    const app = loadApp([]);
    await app.requestDraft("g1", rows(app)[2].start);
    vm.runInContext("acceptDraft()", app);
    const text = vm.runInContext("JSON.stringify(buildBackup('2026-09-11T00:00:00.000Z'))", app);
    const parsed = run(app, `parseBackup(${JSON.stringify(text)})`);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.plannedWeeks).toEqual(run(app, "store.get('plannedWeeks')"));
  });
});
