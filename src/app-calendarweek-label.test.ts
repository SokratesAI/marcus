import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-racecalendar-ongoing.test.ts. `weekTargetLabel`,
// `calendarWeekTarget` and `draftCard` are pure over their arguments, so no DOM
// node is read back -- draftCard returns markup as a string on purpose.
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

// A top-level `const` in the page is a lexical binding rather than a property
// of the vm global, so it has to be evaluated in the same context.
const readConst = (app: any, name: string) => vm.runInContext(name, app);

const TODAY = "2026-09-09";            // a Wednesday; its Monday is 09-07

// A dated goal's Home week, exactly as `weekTarget` returns one: a real phase
// WITH an end date.
const HOME_DATED = {
  reason: "ok", phase: "Base", phaseEnds: "2026-10-05", multiplier: 1.1,
  baseline: 2000, baselineWeeks: 4, volumeTarget: 2200,
};

// A later row of that goal's race calendar: it knows its phase and its position
// in it, and it does NOT know when the phase ends.
const LATER_ROW = {
  start: "2026-10-05", phase: "Build", week: 2, weeks: 4, multiplier: 1.0,
  raceWeek: false, then: null,
};

describe("weekTargetLabel on a week drafted ahead", () => {
  it("does not tell him a dated goal has no target date", () => {
    // The defect this file was written for. `calendarWeekTarget` nulls
    // `phaseEnds` -- the row knows its phase but not the phase's end -- and the
    // label used to read that null as "ongoing" and print the wrong sentence
    // about a goal that has a race in it.
    const app = loadApp();
    const week = app.calendarWeekTarget(HOME_DATED, LATER_ROW);
    const label = app.weekTargetLabel(week);
    expect(week.phaseEnds).toBeNull();
    expect(label).not.toContain("no target date");
  });

  it("names the phase and the row's own position in it", () => {
    const app = loadApp();
    const label = app.weekTargetLabel(app.calendarWeekTarget(HOME_DATED, LATER_ROW));
    expect(label).toContain("Build phase, week 2 of 4");
  });

  it("says that week rather than this week", () => {
    const app = loadApp();
    expect(app.weekTargetLabel(app.calendarWeekTarget(HOME_DATED, LATER_ROW)))
      .toContain("so that week aims");
    expect(app.weekTargetLabel(HOME_DATED)).toContain("so this week aims");
  });

  it("sizes the sentence off the row's own multiplier, not the one Home is showing", () => {
    const app = loadApp();
    // Home is in Base at 1.1; the row is Build at 1.0. A label built from the
    // Home multiplier would say "10% above".
    expect(app.weekTargetLabel(app.calendarWeekTarget(HOME_DATED, LATER_ROW)))
      .toContain("level with");
  });

  it("still gives an ongoing goal the open-ended sentence", () => {
    const app = loadApp();
    const ongoingPhase = readConst(app, "ONGOING_PHASE");
    const home = { ...HOME_DATED, phase: ongoingPhase, phaseEnds: null, multiplier: 1.0 };
    const row = { ...LATER_ROW, phase: ongoingPhase, week: null, weeks: null };
    expect(app.weekTargetLabel(app.calendarWeekTarget(home, row)))
      .toContain("no target date");
  });

  it("leaves the Home card's own sentence exactly as it was", () => {
    const app = loadApp();
    const label = app.weekTargetLabel(HOME_DATED);
    expect(label).toContain("Base phase through");
    expect(label).not.toContain("week 2 of");
  });
});

describe("draftCard's sizing sentence", () => {
  const DAYS = [{ day: "Monday", focus: "Full body", exercises: [] }];
  const plan = () => ({ days: [{ day: "Monday", focus: "Full body", exercises: [] }] });

  it("tells him where a week drafted ahead got its kilogram target", () => {
    const app = loadApp();
    const week = app.calendarWeekTarget(HOME_DATED, LATER_ROW);
    const html = app.draftCard(plan(), { days: DAYS, note: "", week, weekOf: LATER_ROW.start },
                               [], TODAY);
    expect(html).toContain("Build phase, week 2 of 4");
  });

  it("stays quiet for this week, because the Home card is already saying it", () => {
    const app = loadApp();
    const html = app.draftCard(plan(), { days: DAYS, note: "", week: HOME_DATED }, [], TODAY);
    expect(html).not.toContain("Base phase through");
  });
});
