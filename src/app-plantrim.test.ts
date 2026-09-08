import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-planreview.test.ts. Everything under test is pure: a
// plan and a list of sessions in, proposals or a new plan out.
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
      "\n;globalThis.TRIM_MIN_SESSIONS = TRIM_MIN_SESSIONS;" +
      "\n;globalThis.REVIEW_MIN_WEEKS = REVIEW_MIN_WEEKS;" +
      "\n;globalThis.DELOAD_SET_FLOOR = DELOAD_SET_FLOOR;",
    ctx,
  );
  return ctx;
}

const DAY = 86400000;
const TODAY = "2026-09-01"; // a Tuesday
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

// One session per week on `weekday`, `weeks` back, logging each named lift with
// however many sets `done` says. `done` is read per index so one lift on a day
// can be short while another is not.
function weekly(weekday: string, weeks: number, lifts: Array<{ name: string; sets: number[] }>) {
  const target = DAY_NAMES.indexOf(weekday);
  const out: any[] = [];
  let n = 0;
  for (let d = 0; d < weeks * 7 && n < weeks; d++) {
    const iso = ago(d);
    if (new Date(iso + "T00:00:00Z").getUTCDay() !== target) continue;
    out.push({
      id: weekday + "-" + n,
      date: iso,
      exercises: lifts.map(l => ({
        name: l.name,
        sets: Array.from({ length: l.sets[Math.min(n, l.sets.length - 1)] }, () => ({ reps: 5, weight: 40 })),
      })),
    });
    n++;
  }
  return out;
}

const trims = (r: any) => r.proposals.filter((p: any) => p.kind === "trim");

describe("plan review — the sets you never do", () => {
  it("names the lift when every logged session is short by the same amount", () => {
    const ctx = loadApp();
    // Bench is written as 4 sets and done as 3, four Mondays running. Dip is
    // written as 3 and done as 3, so it is not a finding.
    const sessions = weekly("Monday", 4, [{ name: "Bench", sets: [3] }, { name: "Dip", sets: [3] }]);
    const r = ctx.planReview(plan(), sessions, TODAY);
    const t = trims(r);
    expect(t).toHaveLength(1);
    expect(t[0].day).toBe("Monday");
    expect(t[0].lifts).toEqual([{ name: "Bench", sets: 3, was: 4, times: 4 }]);
    expect(t[0].title).toBe("Write Bench as 3 sets on Monday");
    expect(t[0].reason).toContain("did 3 sets every time, where the plan asks for 4");
    // The lift he actually completes is not named anywhere in the proposal.
    expect(t[0].title).not.toContain("Dip");
    expect(t[0].reason).not.toContain("Dip");
  });

  it("says nothing when the set count varies", () => {
    const ctx = loadApp();
    // 3, 4, 3, 4 -- a week that went badly rather than a plan that is wrong.
    const sessions = weekly("Monday", 4, [{ name: "Bench", sets: [3, 4, 3, 4] }, { name: "Dip", sets: [3] }]);
    expect(trims(ctx.planReview(plan(), sessions, TODAY))).toEqual([]);
  });

  it("says nothing on a single short session", () => {
    const ctx = loadApp();
    // Four Mondays, so the review is well past its two-week minimum and does
    // have opinions -- it proposes dropping Bench, which is the point: only one
    // of those Mondays logged Bench at all, so its set count is one data point.
    const sessions = weekly("Monday", 4, [{ name: "Dip", sets: [3] }]);
    sessions[0].exercises.push({ name: "Bench", sets: [{ reps: 5, weight: 40 }, { reps: 5, weight: 40 }, { reps: 5, weight: 40 }] });
    expect(ctx.TRIM_MIN_SESSIONS).toBe(2);
    const r = ctx.planReview(plan(), sessions, TODAY);
    expect(r.weeks).toBeGreaterThanOrEqual(ctx.REVIEW_MIN_WEEKS ?? 2);
    expect(trims(r)).toEqual([]);
    // The precondition: Bench really was logged once and really was short.
    expect(sessions.filter((s: any) => s.exercises.some((e: any) => e.name === "Bench"))).toHaveLength(1);
  });

  it("never trims below the deload floor", () => {
    const ctx = loadApp();
    // One set every time, four weeks running. The pattern is real; the edit is
    // not one Marcus will write, because a one-set day is not a session.
    const sessions = weekly("Monday", 4, [{ name: "Bench", sets: [1] }, { name: "Dip", sets: [3] }]);
    expect(ctx.DELOAD_SET_FLOOR).toBe(2);
    expect(trims(ctx.planReview(plan(), sessions, TODAY))).toEqual([]);
  });

  it("counts only the weekday the prescription is written on", () => {
    const ctx = loadApp();
    // Squat is written on Thursday at 4 sets. He does it at 3 sets on four
    // Mondays and never on a Thursday, so Thursday's number is unmeasured --
    // and he does train on Thursday, so the day itself is kept.
    const sessions = [
      ...weekly("Monday", 4, [{ name: "Bench", sets: [4] }, { name: "Dip", sets: [3] }, { name: "Squat", sets: [3] }]),
      ...weekly("Thursday", 4, [{ name: "Squat", sets: [4] }]),
    ];
    // Only Mondays are short on Squat, and only Thursdays are not.
    expect(sessions.filter((s: any) => new Date(s.date + "T00:00:00Z").getUTCDay() === 1)).toHaveLength(4);
    expect(sessions.filter((s: any) => new Date(s.date + "T00:00:00Z").getUTCDay() === 4)).toHaveLength(4);
    const r = ctx.planReview(plan(), sessions, TODAY);
    expect(trims(r)).toEqual([]);
    // And the lift is not proposed for dropping either -- it is in his training.
    expect(r.proposals.some((p: any) => p.kind === "drop" && (p.names || []).includes("Squat"))).toBe(false);
  });

  it("counts the lift only on the day it is written, when it is logged on two", () => {
    const ctx = loadApp();
    // Bench is written on Monday and done at 3 sets there, four times. He also
    // benches on Thursday, at 3 sets, four times -- and Thursday's plan says
    // nothing about Bench. The Monday finding must be four sessions, not eight:
    // a count pooled across weekdays measures a prescription nobody wrote.
    const sessions = [
      ...weekly("Monday", 4, [{ name: "Bench", sets: [3] }, { name: "Dip", sets: [3] }]),
      ...weekly("Thursday", 4, [{ name: "Squat", sets: [4] }, { name: "Bench", sets: [3] }]),
    ];
    const t = trims(ctx.planReview(plan(), sessions, TODAY));
    expect(t).toHaveLength(1);
    expect(t[0].day).toBe("Monday");
    expect(t[0].lifts).toEqual([{ name: "Bench", sets: 3, was: 4, times: 4 }]);
    expect(t[0].reason).toContain("Bench on Monday 4 times");
  });

  it("writes one proposal per day naming every short lift on it", () => {
    const ctx = loadApp();
    const p = plan();
    p.days[1].exercises[1].sets = 4; // Dip written as 4 too
    const sessions = weekly("Monday", 4, [{ name: "Bench", sets: [3] }, { name: "Dip", sets: [2] }]);
    const t = trims(ctx.planReview(p, sessions, TODAY));
    expect(t).toHaveLength(1);
    expect(t[0].title).toBe("Write Bench as 3 sets and Dip as 2 sets on Monday");
    expect(t[0].reason).toContain("sets you are not doing");
  });

  it("does not collide with the drop proposal", () => {
    const ctx = loadApp();
    // Dip is never logged at all, Bench is logged short. Dip belongs to `drop`
    // and Bench to `trim`, and neither names the other's lift.
    const sessions = weekly("Monday", 4, [{ name: "Bench", sets: [3] }]);
    const r = ctx.planReview(plan(), sessions, TODAY);
    const drop = r.proposals.find((x: any) => x.kind === "drop" && x.day === "Monday");
    const trim = trims(r).find((x: any) => x.day === "Monday");
    expect(drop.names).toEqual(["Dip"]);
    expect(trim.lifts.map((l: any) => l.name)).toEqual(["Bench"]);
  });
});

describe("applying a trim", () => {
  it("writes the number he actually does and leaves the rest of the week alone", () => {
    const ctx = loadApp();
    const p = plan();
    const next = ctx.applyProposal(p, { kind: "trim", day: "Monday", lifts: [{ name: "Bench", sets: 3 }] });
    expect(next.days[1].exercises[0].sets).toBe(3);
    expect(next.days[1].exercises[1].sets).toBe(3); // Dip untouched
    expect(next.days[4].exercises[0].sets).toBe(4); // Thursday untouched
    expect(p.days[1].exercises[0].sets).toBe(4);    // the original is not mutated
  });

  it("never raises a set count", () => {
    const ctx = loadApp();
    // The plan was edited down to 2 after the review ran. Applying a proposal
    // measured against 4 must not push it back up to 3.
    const p = plan();
    p.days[1].exercises[0].sets = 2;
    const next = ctx.applyProposal(p, { kind: "trim", day: "Monday", lifts: [{ name: "Bench", sets: 3 }] });
    expect(next.days[1].exercises[0].sets).toBe(2);
  });

  it("carries a chip a reader can understand and no invented citation", () => {
    const ctx = loadApp();
    expect(ctx.proposalChip("trim")).toBe("trim a lift");
    expect(ctx.referencesFor("trim")).toEqual([]);
  });
});
