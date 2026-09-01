import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same vm shape as app-load.test.ts. Everything under test here is pure --
// a plan and a list of sessions in, proposals or a new plan out -- so no DOM
// node is ever touched.
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
      "\n;globalThis.REVIEW_MIN_WEEKS = REVIEW_MIN_WEEKS;" +
      "\n;globalThis.REVIEW_WINDOW_DAYS = REVIEW_WINDOW_DAYS;" +
      "\n;globalThis.DELOAD_SET_FLOOR = DELOAD_SET_FLOOR;",
    ctx,
  );
  return ctx;
}

const DAY = 86400000;
const TODAY = "2026-09-01"; // a Tuesday
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);

// One exercise, one set: reps x weight is the whole volume of a session.
const sess = (date: string, kg: number) => ({ id: date + "-" + kg, date, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }] });

const plan = () => ({
  blockName: "Block",
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 }] },
    { day: "Tuesday", focus: "Rest", exercises: [] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Legs", exercises: [{ name: "Squat", sets: 4, reps: 6 }] },
    { day: "Friday", focus: "Rest", exercises: [] },
    { day: "Saturday", focus: "Rest", exercises: [] },
  ],
});

// Sessions on a named weekday, once a week, for `weeks` weeks back from today.
function weekly(weekday: string, weeks: number, kg: number) {
  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const target = DAY_NAMES.indexOf(weekday);
  const out: any[] = [];
  for (let d = 0; d < weeks * 7; d++) {
    const iso = ago(d);
    if (new Date(iso + "T00:00:00Z").getUTCDay() === target) out.push(sess(iso, kg));
  }
  return out;
}

describe("plan review — when it refuses to have an opinion", () => {
  it("says nothing with less than two weeks logged", () => {
    const ctx = loadApp();
    const r = ctx.planReview(plan(), [sess(ago(1), 1000), sess(ago(3), 1000)], TODAY);
    expect(r.proposals).toEqual([]);
    expect(r.weeks).toBeLessThan(ctx.REVIEW_MIN_WEEKS);
    expect(r.note).toContain("2 weeks");
  });

  it("says nothing with no sessions at all", () => {
    const ctx = loadApp();
    expect(ctx.planReview(plan(), [], TODAY).proposals).toEqual([]);
  });

  it("proposes nothing when every planned day is kept and load is in the building range", () => {
    const ctx = loadApp();
    // Both planned weekdays trained every week for four weeks, steady volume.
    const sessions = [...weekly("Monday", 4, 3000), ...weekly("Thursday", 4, 3000)];
    const r = ctx.planReview(plan(), sessions, TODAY);
    expect(r.proposals).toEqual([]);
    expect(r.note).toContain("Nothing to change");
  });
});

describe("plan review — adherence", () => {
  it("moves a never-trained planned day onto the rest day actually used", () => {
    const ctx = loadApp();
    // Monday kept; Thursday never trained; Saturday (a plan rest day) trained instead.
    const sessions = [...weekly("Monday", 4, 3000), ...weekly("Saturday", 4, 3000)];
    const r = ctx.planReview(plan(), sessions, TODAY);
    const move = r.proposals.find((p: any) => p.kind === "move");
    expect(move).toBeTruthy();
    expect(move.day).toBe("Thursday");
    expect(move.toDay).toBe("Saturday");
    expect(move.reason).toContain("Thursday 0 times");
  });

  it("proposes a rest day when nothing else is being used instead", () => {
    const ctx = loadApp();
    const sessions = weekly("Monday", 4, 3000); // Thursday simply skipped
    const r = ctx.planReview(plan(), sessions, TODAY);
    const rest = r.proposals.find((p: any) => p.kind === "rest");
    expect(rest).toBeTruthy();
    expect(rest.day).toBe("Thursday");
  });

  it("counts only sessions inside the window", () => {
    const ctx = loadApp();
    const rows = ctx.adherenceByWeekday(plan(), [sess(ago(2), 100), sess(ago(60), 100)], TODAY, ctx.REVIEW_WINDOW_DAYS);
    const total = rows.reduce((n: number, r: any) => n + r.logged, 0);
    expect(total).toBe(1);
  });
});

describe("plan review — load", () => {
  it("proposes a deload on a load spike and quotes the ratio", () => {
    const ctx = loadApp();
    // Four weeks of steady work, then a very heavy final week.
    const base = [...weekly("Monday", 6, 2000), ...weekly("Thursday", 6, 2000)];
    const spike = [sess(ago(0), 60000), sess(ago(1), 60000), sess(ago(2), 60000), sess(ago(3), 60000)];
    const sessions = [...base, ...spike];
    const load = ctx.trainingLoad(sessions, TODAY);
    expect(load.verdict).toBe("load spike");
    const r = ctx.planReview(plan(), sessions, TODAY);
    const deload = r.proposals.find((p: any) => p.kind === "deload");
    expect(deload).toBeTruthy();
    expect(deload.reason).toContain(load.ratio.toFixed(2));
  });

  it("does not propose building while a planned day is being skipped", () => {
    const ctx = loadApp();
    // Falling volume, so the ratio really is under 0.8 -- but Thursday is
    // never trained. Adherence has to be fixed before volume is added, and
    // this fixture only says that if the load half is genuinely 'backing off'.
    const sessions = weekly("Monday", 10, 0)
      .map((x: any) => ({ ...x, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: x.date < ago(21) ? 8000 : 200 }] }] }));
    expect(ctx.trainingLoad(sessions, TODAY).verdict).toBe("backing off");
    const r = ctx.planReview(plan(), sessions, TODAY);
    expect(r.proposals.some((p: any) => p.kind === "build")).toBe(false);
    expect(r.proposals.some((p: any) => p.kind === "rest")).toBe(true);
  });
});

describe("applyProposal is pure and does what the reason says", () => {
  it("deload takes one set off every exercise and never goes below the floor", () => {
    const ctx = loadApp();
    const before = plan();
    before.days[1].exercises[1].sets = ctx.DELOAD_SET_FLOOR; // already at the floor
    const after = ctx.applyProposal(before, { kind: "deload" });
    expect(after.days[1].exercises[0].sets).toBe(3);
    expect(after.days[1].exercises[1].sets).toBe(ctx.DELOAD_SET_FLOOR);
    expect(after.days[4].exercises[0].sets).toBe(3);
    expect(before.days[1].exercises[0].sets).toBe(4); // untouched
  });

  it("move empties the source day and fills the target", () => {
    const ctx = loadApp();
    const before = plan();
    const after = ctx.applyProposal(before, { kind: "move", day: "Thursday", toDay: "Saturday" });
    const thu = after.days.find((d: any) => d.day === "Thursday");
    const sat = after.days.find((d: any) => d.day === "Saturday");
    expect(thu.exercises).toEqual([]);
    expect(thu.focus).toBe("Rest");
    expect(sat.focus).toBe("Legs");
    expect(sat.exercises).toHaveLength(1);
    expect(before.days.find((d) => d.day === "Saturday")!.exercises).toEqual([]);
  });

  it("rest clears the day", () => {
    const ctx = loadApp();
    const after = ctx.applyProposal(plan(), { kind: "rest", day: "Monday" });
    const mon = after.days.find((d: any) => d.day === "Monday");
    expect(mon.exercises).toEqual([]);
    expect(mon.focus).toBe("Rest");
  });

  it("build adds a set to the named day only", () => {
    const ctx = loadApp();
    const after = ctx.applyProposal(plan(), { kind: "build", day: "Thursday" });
    expect(after.days.find((d: any) => d.day === "Thursday").exercises[0].sets).toBe(5);
    expect(after.days.find((d: any) => d.day === "Monday").exercises[0].sets).toBe(4);
  });

  it("an unknown proposal changes nothing", () => {
    const ctx = loadApp();
    expect(ctx.applyProposal(plan(), { kind: "nonsense", day: "Monday" })).toEqual(plan());
    expect(ctx.applyProposal(plan(), null)).toEqual(plan());
  });
});

describe("plan review — the build proposal picks the lightest day", () => {
  it("names the planned day with the fewest sets", () => {
    const ctx = loadApp();
    // Both planned days kept every week, but very little volume: ratio under 0.8.
    // Ten weeks of both planned days kept, but the last three weeks are light:
    // adherence is perfect and the acute:chronic ratio falls under 0.8.
    const sessions = [...weekly("Monday", 10, 0), ...weekly("Thursday", 10, 0)]
      .map((x: any) => ({ ...x, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: x.date < ago(21) ? 8000 : 200 }] }] }));
    const p = plan();
    p.days[1].exercises[0].sets = 9; // Monday now much heavier than Thursday's 4
    const r = ctx.planReview(p, sessions, TODAY);
    const build = r.proposals.find((x: any) => x.kind === "build");
    expect(build).toBeTruthy();
    expect(build.day).toBe("Thursday");
    expect(build.reason).toContain("4 sets");
  });
});
