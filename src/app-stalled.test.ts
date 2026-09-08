import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-personalbest.test.ts. stalledLifts takes plain values and
// returns plain values; stalledLiftsCard returns a string, so no DOM node is
// touched here either.
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
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.stalledLifts = stalledLifts;" +
      "\n;globalThis.stalledLiftsCard = stalledLiftsCard;" +
      "\n;globalThis.STALL_SESSIONS = STALL_SESSIONS;" +
      "\n;globalThis.STALL_DORMANT_GAP_FACTOR = STALL_DORMANT_GAP_FACTOR;",
    ctx,
  );
  return ctx;
}

const set = (weight: number, reps: number) => ({ weight, reps });
const day = (date: string, name: string, sets: any[]) => ({
  date, kind: "strength", exercises: [{ name, sets }],
});

describe("stalledLifts", () => {
  it("says nothing about a lift that has never been logged", () => {
    const app = loadApp();
    const report = app.stalledLifts([]);
    expect(report.watched).toBe(0);
    expect(report.stalled).toEqual([]);
  });

  it("reports a lift that has not improved for three sessions", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Bench Press", [set(80, 5)]),
      day("2026-09-03", "Bench Press", [set(80, 5)]),
      day("2026-09-05", "Bench Press", [set(80, 4)]),
      day("2026-09-07", "Bench Press", [set(80, 5)]),
    ]);
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].name).toBe("Bench Press");
    expect(report.stalled[0].sessions).toBe(3);
    expect(report.stalled[0].best).toMatchObject({ weight: 80, reps: 5, date: "2026-09-01" });
    expect(report.watched).toBe(1);
  });

  it("does not report a lift two sessions past its best -- the boundary is the threshold", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Bench Press", [set(80, 5)]),
      day("2026-09-03", "Bench Press", [set(80, 5)]),
      day("2026-09-05", "Bench Press", [set(80, 5)]),
    ]);
    expect(report.stalled).toEqual([]);
    expect(report.watched).toBe(1);
    expect(report.threshold).toBe(3);
    expect(app.STALL_SESSIONS).toBe(3);
  });

  it("resets the count the session the lift gets heavier again", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Squat", [set(100, 5)]),
      day("2026-09-02", "Squat", [set(100, 5)]),
      day("2026-09-03", "Squat", [set(100, 5)]),
      day("2026-09-04", "Squat", [set(102.5, 5)]),
      day("2026-09-05", "Squat", [set(100, 5)]),
    ]);
    expect(report.stalled).toEqual([]);
  });

  it("counts an extra rep at the same weight as getting better, so a bodyweight lift is judged on reps", () => {
    const app = loadApp();
    const progressing = app.stalledLifts([
      day("2026-09-01", "Pull-Up", [set(0, 6)]),
      day("2026-09-02", "Pull-Up", [set(0, 7)]),
      day("2026-09-03", "Pull-Up", [set(0, 8)]),
      day("2026-09-04", "Pull-Up", [set(0, 9)]),
    ]);
    expect(progressing.stalled).toEqual([]);
    // The same lift with the reps flat IS stuck -- otherwise the test above
    // would pass with the weight-only comparison it exists to rule out.
    const stuck = app.stalledLifts([
      day("2026-09-01", "Pull-Up", [set(0, 6)]),
      day("2026-09-02", "Pull-Up", [set(0, 6)]),
      day("2026-09-03", "Pull-Up", [set(0, 6)]),
      day("2026-09-04", "Pull-Up", [set(0, 6)]),
    ]);
    expect(stuck.stalled).toHaveLength(1);
    expect(stuck.stalled[0].best).toMatchObject({ weight: 0, reps: 6 });
  });

  it("reads the best set in a session, not the last one", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Row", [set(60, 8)]),
      day("2026-09-02", "Row", [set(70, 8), set(60, 8)]),
      day("2026-09-03", "Row", [set(60, 8)]),
      day("2026-09-04", "Row", [set(60, 8)]),
    ]);
    // The 70 kg top set on 09-02 is the last improvement, so only two sessions
    // have passed since. Reading the trailing back-off set instead would make
    // this three and report a stall.
    expect(report.stalled).toEqual([]);
  });

  it("orders sessions by date rather than trusting the array", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-07", "Deadlift", [set(140, 3)]),
      day("2026-09-01", "Deadlift", [set(120, 3)]),
      day("2026-09-05", "Deadlift", [set(130, 3)]),
      day("2026-09-03", "Deadlift", [set(125, 3)]),
    ]);
    // Read in array order the best (140) lands first and the three behind it
    // read as three stuck sessions. In date order every session is a new best.
    expect(report.stalled).toEqual([]);
  });

  it("ignores a cardio session even when it carries an exercise list", () => {
    const app = loadApp();
    // A cardio session as the app really stores it has no `exercises` at all,
    // so deleting the strength guard would change no answer and this test would
    // pass either way. A backup restore can produce a cardio day carrying one --
    // the same fixture app-personalbest.test.ts had to be fixed to use -- and
    // that is the only shape that tells the two apart. Without the guard the
    // 09-02 row is a fourth session and the bench reads as stuck.
    const sessions = [
      day("2026-09-01", "Bench Press", [set(80, 5)]),
      { date: "2026-09-02", kind: "cardio", activity: "Run", minutes: 30,
        exercises: [{ name: "Bench Press", sets: [set(80, 5)] }] },
      day("2026-09-03", "Bench Press", [set(80, 5)]),
      day("2026-09-05", "Bench Press", [set(80, 5)]),
    ];
    expect(app.stalledLifts(sessions).stalled).toEqual([]);
    // ...and the same four sessions with that one marked strength IS stuck, so
    // the assertion above is not passing because the threshold is out of reach.
    const asStrength = sessions.map((s: any) => ({ ...s, kind: "strength" }));
    expect(app.stalledLifts(asStrength).stalled).toHaveLength(1);
  });

  it("does not count an exercise row with no usable set as a session", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Curl", [set(20, 10)]),
      day("2026-09-02", "Curl", [{ weight: 20, reps: 0 }]),
      day("2026-09-03", "Curl", [{ weight: null, reps: 8 }]),
      day("2026-09-04", "Curl", []),
      day("2026-09-05", "Curl", [set(20, 10)]),
    ]);
    // Only two real sessions happened, so nothing is three past its best.
    expect(report.stalled).toEqual([]);
    expect(report.watched).toBe(1);
  });

  it("matches spelling the same way the rest of the app does and shows the newest one", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "bench press", [set(80, 5)]),
      day("2026-09-03", "Bench  Press", [set(80, 5)]),
      day("2026-09-05", "BENCH PRESS", [set(80, 5)]),
      day("2026-09-07", "Bench Press", [set(80, 5)]),
    ]);
    expect(report.watched).toBe(1);
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].name).toBe("Bench Press");
  });

  it("cannot read a lift named constructor off Object.prototype", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "constructor", [set(50, 5)]),
      day("2026-09-02", "constructor", [set(50, 5)]),
      day("2026-09-03", "constructor", [set(50, 5)]),
      day("2026-09-04", "constructor", [set(50, 5)]),
    ]);
    expect(report.watched).toBe(1);
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].name).toBe("constructor");
  });

  it("puts the longest stuck lift first and breaks a tie alphabetically", () => {
    const app = loadApp();
    const flat = (name: string, dates: string[]) =>
      dates.map((d) => day(d, name, [set(50, 5)]));
    const report = app.stalledLifts([
      ...flat("Zercher Squat", ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]),
      ...flat("Abs", ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]),
      ...flat("Dip", ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]),
    ]);
    expect(report.stalled.map((r: any) => r.name)).toEqual(["Dip", "Abs", "Zercher Squat"]);
    expect(report.stalled[0].sessions).toBe(4);
  });

  it("counts every lift it saw as watched, stuck or not", () => {
    const app = loadApp();
    const report = app.stalledLifts([
      day("2026-09-01", "Bench Press", [set(80, 5)]),
      day("2026-09-02", "Bench Press", [set(80, 5)]),
      day("2026-09-03", "Bench Press", [set(80, 5)]),
      day("2026-09-04", "Bench Press", [set(80, 5)]),
      day("2026-09-04", "Squat", [set(100, 5)]),
    ]);
    expect(report.watched).toBe(2);
    expect(report.stalled).toHaveLength(1);
  });
});

describe("stalledLiftsCard", () => {
  it("asks for a lift when nothing has been logged", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({ stalled: [], watched: 0, threshold: 3 });
    expect(html).toContain("Log a lift");
    expect(html).not.toContain("Nothing is stuck");
  });

  it("says nothing is stuck when lifts are logged and all moving", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({ stalled: [], watched: 4, threshold: 3 });
    expect(html).toContain("Nothing is stuck");
    expect(html).toContain("4 lifts have");
    expect(html).not.toContain("Log a lift");
  });

  it("uses the singular for one watched lift", () => {
    const app = loadApp();
    expect(app.stalledLiftsCard({ stalled: [], watched: 1, threshold: 3 })).toContain("1 lift has");
  });

  it("names each stuck lift, its count and the set it is stuck on", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({
      stalled: [{ name: "Bench Press", sessions: 3, best: { weight: 80, reps: 5, date: "2026-09-01" }, sessionsLogged: 4, dormant: false, daysSinceLast: 1 }],
      active: 1,
      watched: 6,
      threshold: 3,
    });
    expect(html).toContain("Bench Press");
    expect(html).toContain("3 sessions");
    expect(html).toContain("80 kg × 5");
    expect(html).toContain("1 of 6");
    expect(html).toContain("chip--alert");
  });

  it("escapes a lift name rather than rendering it as markup", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({
      stalled: [{ name: '<img src=x onerror="boom">', sessions: 3, best: { weight: 50, reps: 5, date: "2026-09-01" }, sessionsLogged: 4, dormant: false, daysSinceLast: 1 }],
      active: 1,
      watched: 1,
      threshold: 3,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("the Progress tab renders the card", () => {
  // Every test above calls stalledLifts and stalledLiftsCard directly, so
  // deleting the call site would leave all of them green and put nothing on the
  // screen. This is the only thing that would fail.
  it("calls stalledLiftsCard(stalledLifts(...)) from the progress view", () => {
    expect(APP_SOURCE).toContain("${stalledLiftsCard(stalledLifts(store.get('sessions', []), todayStr()))}");
  });
});

// A stall is counted in sessions and so never expires on its own. These pin the
// clock half: a lift dropped from the programme stalled once and is not stuck
// now, and the chip that asks Edvard to change something must not count it.
describe("stalledLifts knows a lift was abandoned", () => {
  const weekly = (name: string, weight: number) => [
    day("2026-06-01", name, [set(weight, 5)]),
    day("2026-06-08", name, [set(weight, 5)]),
    day("2026-06-15", name, [set(weight, 5)]),
    day("2026-06-22", name, [set(weight, 5)]),
  ];

  it("marks a lift dormant once the gap is more than twice its own cadence", () => {
    const app = loadApp();
    // Weekly lift, last trained 2026-06-22. 15 days later is more than 2x7.
    const report = app.stalledLifts(weekly("Bench Press", 80), "2026-07-07");
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].dormant).toBe(true);
    expect(report.stalled[0].daysSinceLast).toBe(15);
    expect(report.stalled[0].typicalGap).toBe(7);
    expect(report.active).toBe(0);
    // The stall itself is still reported -- the row is kept, not dropped.
    expect(report.stalled[0].sessions).toBe(3);
  });

  it("leaves a lift still on its normal cadence active", () => {
    const app = loadApp();
    // 13 days is inside 2x7, so this is a late week and not an abandoned lift.
    const report = app.stalledLifts(weekly("Bench Press", 80), "2026-07-05");
    expect(report.stalled[0].dormant).toBe(false);
    expect(report.active).toBe(1);
  });

  it("uses each lift's own cadence rather than the log's", () => {
    const app = loadApp();
    // Squat every 14 days, Press every 2. Same last date, same today: the
    // fortnightly lift is still on schedule and the twice-weekly one is gone.
    const sessions = [
      day("2026-06-01", "Back Squat", [set(100, 5)]),
      day("2026-06-15", "Back Squat", [set(100, 5)]),
      day("2026-06-29", "Back Squat", [set(100, 5)]),
      day("2026-07-13", "Back Squat", [set(100, 5)]),
      day("2026-07-07", "Overhead Press", [set(50, 5)]),
      day("2026-07-09", "Overhead Press", [set(50, 5)]),
      day("2026-07-11", "Overhead Press", [set(50, 5)]),
      day("2026-07-13", "Overhead Press", [set(50, 5)]),
    ];
    const report = app.stalledLifts(sessions, "2026-07-27");
    const by = Object.fromEntries(report.stalled.map((r: any) => [r.name, r]));
    expect(by["Back Squat"].dormant).toBe(false);
    expect(by["Overhead Press"].dormant).toBe(true);
    expect(report.active).toBe(1);
  });

  it("sorts live stalls above dormant ones however long they have been stuck", () => {
    const app = loadApp();
    const sessions = [
      // Dormant, stuck for four sessions.
      day("2026-06-01", "Old Lift", [set(60, 5)]),
      day("2026-06-08", "Old Lift", [set(60, 5)]),
      day("2026-06-15", "Old Lift", [set(60, 5)]),
      day("2026-06-22", "Old Lift", [set(60, 5)]),
      day("2026-06-29", "Old Lift", [set(60, 5)]),
      // Live, stuck for three.
      day("2026-07-06", "New Lift", [set(40, 5)]),
      day("2026-07-13", "New Lift", [set(40, 5)]),
      day("2026-07-20", "New Lift", [set(40, 5)]),
      day("2026-07-27", "New Lift", [set(40, 5)]),
    ];
    const report = app.stalledLifts(sessions, "2026-07-30");
    expect(report.stalled.map((r: any) => r.name)).toEqual(["New Lift", "Old Lift"]);
    expect(report.stalled[1].sessions).toBeGreaterThan(report.stalled[0].sessions);
  });

  it("reports no dormancy at all when the caller has no clock", () => {
    const app = loadApp();
    const report = app.stalledLifts(weekly("Bench Press", 80));
    expect(report.stalled[0].daysSinceLast).toBeNull();
    expect(report.stalled[0].dormant).toBe(false);
    expect(report.active).toBe(1);
  });
});

describe("the Stuck lifts card separates the two", () => {
  it("counts only live stalls in the chip and says none active when there are none", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({
      stalled: [{ name: "Bench Press", sessions: 3, best: { weight: 80, reps: 5, date: "2026-06-22" },
                  sessionsLogged: 4, dormant: true, daysSinceLast: 15 }],
      active: 0,
      watched: 6,
      threshold: 3,
    });
    expect(html).toContain("none active");
    expect(html).toContain("chip--primary");
    expect(html).not.toContain("chip--alert");
    expect(html).toContain("not trained for 15 days");
    expect(html).not.toContain("3 sessions ·");
  });

  it("uses the singular for a lift last trained one day ago", () => {
    const app = loadApp();
    const html = app.stalledLiftsCard({
      stalled: [{ name: "Bench Press", sessions: 3, best: { weight: 80, reps: 5, date: "2026-06-22" },
                  sessionsLogged: 4, dormant: true, daysSinceLast: 1 }],
      active: 0,
      watched: 6,
      threshold: 3,
    });
    expect(html).toContain("not trained for 1 day");
    expect(html).not.toContain("1 days");
  });

  it("explains the mixed list only when there is a dormant row in it", () => {
    const app = loadApp();
    const live = { name: "A", sessions: 3, best: { weight: 80, reps: 5, date: "2026-07-27" },
                   sessionsLogged: 4, dormant: false, daysSinceLast: 1 };
    const dead = { name: "B", sessions: 3, best: { weight: 60, reps: 5, date: "2026-06-22" },
                   sessionsLogged: 4, dormant: true, daysSinceLast: 40 };
    const mixed = app.stalledLiftsCard({ stalled: [live, dead], active: 1, watched: 6, threshold: 3 });
    const clean = app.stalledLiftsCard({ stalled: [live], active: 1, watched: 6, threshold: 3 });
    expect(mixed).toContain("stopped training");
    expect(clean).not.toContain("stopped training");
  });
});
