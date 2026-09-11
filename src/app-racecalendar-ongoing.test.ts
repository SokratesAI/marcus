import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-racecalendar.test.ts: raceCalendar and raceCalendarBlock
// are pure over a goal and a day, so no DOM node is read back.
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

// A top-level `const` in the page is a lexical binding, not a property of the
// vm's global object, so `ctx.WEEK_BASELINE_WEEKS` is undefined. Evaluating the
// name in the same context reads the page's own value -- which is the point: a
// test that re-spells 4 and 1.00 agrees with itself rather than with the app.
const readConst = (app: any, name: string) => vm.runInContext(name, app);

const TODAY = "2026-09-09";            // a Wednesday; its Monday is 09-07
const ongoing = () => ({
  id: "g-ongoing", text: "Improve overall health and fitness",
  targetDate: "", created: "2026-08-01", milestones: [],
});
const dated = () => ({
  id: "g-race", text: "Sprint triathlon", targetDate: "2026-10-04", created: "2026-09-01",
  milestones: [
    { label: "Base", note: "", date: "2026-09-20", done: false },
    { label: "Build", note: "", date: "2026-09-27", done: false },
    { label: "Taper", note: "", date: "2026-10-04", done: false },
  ],
});

describe("raceCalendar for an ongoing goal", () => {
  it("lists this week and the next four Mondays instead of nothing", () => {
    const rows = loadApp().raceCalendar(ongoing(), TODAY);
    expect(rows.map((r: any) => r.start)).toEqual(
      ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  it("stops at the baseline window, so no row is sized off an average that has turned over", () => {
    const app = loadApp();
    expect(app.raceCalendar(ongoing(), TODAY).length).toBe(readConst(app, "WEEK_BASELINE_WEEKS") + 1);
  });

  it("gives every row the Ongoing phase, no week number and ONGOING_VOLUME", () => {
    const app = loadApp();
    const rows = app.raceCalendar(ongoing(), TODAY);
    expect(rows.every((r: any) => r.phase === "Ongoing")).toBe(true);
    expect(rows.every((r: any) => r.week === null && r.weeks === null)).toBe(true);
    const ongoingVolume = readConst(app, "ONGOING_VOLUME");
    expect(ongoingVolume).toBeTypeOf("number");
    expect(rows.every((r: any) => r.multiplier === ongoingVolume)).toBe(true);
    expect(rows.every((r: any) => r.raceWeek === false)).toBe(true);
    expect(rows.every((r: any) => r.ongoing === true)).toBe(true);
  });

  it("sizes an ongoing row the same way the Home card sizes this week", () => {
    const app = loadApp();
    const rows = app.raceCalendar(ongoing(), TODAY);
    const home = { reason: "ok", phase: "Ongoing", phaseEnds: null, multiplier: readConst(app, "ONGOING_VOLUME"),
                   baseline: 4200, baselineWeeks: 4, volumeTarget: 4200 };
    const week = app.calendarWeekTarget(home, rows[2]);
    expect(week.phase).toBe("Ongoing");
    expect(week.phaseEnds).toBeNull();
    expect(week.volumeTarget).toBe(4200);
  });

  it("still returns nothing when there is no goal at all", () => {
    expect(loadApp().raceCalendar(null, TODAY)).toEqual([]);
  });

  it("leaves a dated goal's calendar alone", () => {
    const rows = loadApp().raceCalendar(dated(), TODAY);
    expect(rows.map((r: any) => r.start)).toEqual(
      ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(rows.some((r: any) => r.ongoing)).toBe(false);
  });
});

describe("raceCalendarBlock for an ongoing goal", () => {
  it("names the horizon rather than a race that does not exist", () => {
    const app = loadApp();
    const html = app.raceCalendarBlock(app.raceCalendar(ongoing(), TODAY), "g-ongoing");
    expect(html).toContain("<summary>The next 5 weeks</summary>");
    expect(html).not.toContain("to the race");
  });

  it("still says 'Every week to the race' for a dated goal", () => {
    const app = loadApp();
    const html = app.raceCalendarBlock(app.raceCalendar(dated(), TODAY), "g-race");
    expect(html).toContain("Every week to the race (4)");
  });

  it("puts a Draft button on every row but this week's", () => {
    const app = loadApp();
    const rows = app.raceCalendar(ongoing(), TODAY);
    const html = app.raceCalendarBlock(rows, "g-ongoing");
    // Draft my week is this week's button, so the first row carries none.
    expect(html).not.toContain("requestDraft('g-ongoing','2026-09-07')");
    for (const start of ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]) {
      expect(html).toContain(`requestDraft('g-ongoing','${start}')`);
    }
  });
});
