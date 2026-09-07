import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-planreview.test.ts. Everything under test is pure: a
// plan and a list of sessions in, proposals out.
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
      "\n;globalThis.INJURY_WINDOW_DAYS = INJURY_WINDOW_DAYS;" +
      "\n;globalThis.DELOAD_SET_FLOOR = DELOAD_SET_FLOOR;",
    ctx,
  );
  return ctx;
}

const DAY = 86400000;
const TODAY = "2026-09-01"; // a Tuesday
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);

const sess = (date: string, kg: number, extra: any = {}) =>
  Object.assign({ id: date + "-" + kg, date, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }] }, extra);

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

// The plan the deload has no lever on: every day is cardio, so there is not a
// set anywhere to take off.
const cardioOnlyPlan = () => ({
  blockName: "Block",
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Swim", exercises: [], cardio: { activity: "Swim", minutes: 40 } },
    { day: "Tuesday", focus: "Rest", exercises: [] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Rest", exercises: [] },
    { day: "Friday", focus: "Rest", exercises: [] },
    { day: "Saturday", focus: "Rest", exercises: [] },
  ],
});

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

describe("recentInjuries — which flags count", () => {
  it("keeps a flag inside the window and drops one outside it", () => {
    const ctx = loadApp();
    const hits = ctx.recentInjuries(
      [sess(ago(2), 100, { injury: true }), sess(ago(30), 100, { injury: true })],
      TODAY, ctx.INJURY_WINDOW_DAYS,
    );
    expect(hits.map((s: any) => s.date)).toEqual([ago(2)]);
  });

  it("counts the oldest day still inside the window and not the one after it", () => {
    const ctx = loadApp();
    const inside = ctx.recentInjuries([sess(ago(6), 100, { injury: true })], TODAY, ctx.INJURY_WINDOW_DAYS);
    const outside = ctx.recentInjuries([sess(ago(7), 100, { injury: true })], TODAY, ctx.INJURY_WINDOW_DAYS);
    expect(inside).toHaveLength(1);
    expect(outside).toHaveLength(0);
  });

  it("ignores a session with no flag on it", () => {
    const ctx = loadApp();
    expect(ctx.recentInjuries([sess(ago(1), 100)], TODAY, ctx.INJURY_WINDOW_DAYS)).toHaveLength(0);
  });

  it("returns the newest flagged session first", () => {
    const ctx = loadApp();
    const hits = ctx.recentInjuries(
      [sess(ago(5), 100, { injury: true }), sess(ago(1), 100, { injury: true }), sess(ago(3), 100, { injury: true })],
      TODAY, ctx.INJURY_WINDOW_DAYS,
    );
    expect(hits.map((s: any) => s.date)).toEqual([ago(1), ago(3), ago(5)]);
  });

  it("does not throw on a missing session list", () => {
    const ctx = loadApp();
    expect(ctx.recentInjuries(undefined, TODAY, ctx.INJURY_WINDOW_DAYS)).toEqual([]);
  });
});

describe("plan review — an injury eases the week off", () => {
  it("proposes the deload on a flagged session with nothing else wrong", () => {
    const ctx = loadApp();
    // Both planned days kept for four weeks at steady volume: without the flag
    // this exact history proposes nothing at all.
    const sessions = [...weekly("Monday", 4, 3000), ...weekly("Thursday", 4, 3000)];
    expect(ctx.planReview(plan(), sessions, TODAY).proposals).toEqual([]);

    sessions[0].injury = true;
    sessions[0].note = "knee is sore";
    const r = ctx.planReview(plan(), sessions, TODAY);
    const deload = r.proposals.find((p: any) => p.kind === "deload");
    expect(deload).toBeTruthy();
    expect(deload.reason).toContain("You flagged an injury on " + sessions[0].date);
    expect(deload.reason).toContain("knee is sore");
  });

  it("fires before two weeks of history, where the rest of the review will not", () => {
    const ctx = loadApp();
    const sessions = [sess(ago(1), 1000, { injury: true, note: "tweaked my back" })];
    const r = ctx.planReview(plan(), sessions, TODAY);
    expect(r.weeks).toBeLessThan(ctx.REVIEW_MIN_WEEKS);
    expect(r.proposals.map((p: any) => p.kind)).toEqual(["deload"]);
    expect(r.proposals[0].reason).toContain("tweaked my back");
  });

  it("says nothing about a flag older than the window", () => {
    const ctx = loadApp();
    const sessions = [...weekly("Monday", 4, 3000), ...weekly("Thursday", 4, 3000)];
    const old = sessions.find((s: any) => s.date <= ago(14))!;
    old.injury = true;
    expect(ctx.planReview(plan(), sessions, TODAY).proposals).toEqual([]);
  });

  it("quotes nothing when the flagged session carries no note", () => {
    const ctx = loadApp();
    const sessions = [sess(ago(1), 1000, { injury: true })];
    const deload = ctx.planReview(plan(), sessions, TODAY).proposals[0];
    expect(deload.reason).toContain("You flagged an injury on " + ago(1) + ".");
    expect(deload.reason).not.toContain("“");
  });

  it("counts them when more than one session in the window mentions an injury", () => {
    const ctx = loadApp();
    const sessions = [sess(ago(1), 1000, { injury: true }), sess(ago(3), 1000, { injury: true })];
    const deload = ctx.planReview(plan(), sessions, TODAY).proposals[0];
    expect(deload.reason).toContain("2 of your sessions in the last " + ctx.INJURY_WINDOW_DAYS + " days");
  });

  it("does not say 'of your sessions' when only one mentions an injury", () => {
    const ctx = loadApp();
    const sessions = [sess(ago(1), 1000, { injury: true })];
    const deload = ctx.planReview(plan(), sessions, TODAY).proposals[0];
    expect(deload.reason).not.toContain("of your sessions");
  });

  it("proposes nothing when the plan has no set to take off", () => {
    const ctx = loadApp();
    const sessions = [sess(ago(1), 1000, { injury: true, note: "sore" })];
    expect(ctx.planReview(cardioOnlyPlan(), sessions, TODAY).proposals).toEqual([]);
  });
});

describe("plan review — an injury and a load spike are one proposal", () => {
  // A ramp steep enough to put the acute:chronic ratio over 1.5, with the
  // newest session also carrying the flag.
  function spiking(flagged: boolean) {
    const out: any[] = [];
    for (let d = 27; d >= 0; d--) out.push(sess(ago(d), d <= 3 ? 20000 : 1000));
    if (flagged) { out[out.length - 1].injury = true; out[out.length - 1].note = "shoulder hurts"; }
    return out;
  }

  it("gives one deload, not two, when both reasons fire", () => {
    const ctx = loadApp();
    const r = ctx.planReview(plan(), spiking(true), TODAY);
    const deloads = r.proposals.filter((p: any) => p.kind === "deload");
    expect(deloads).toHaveLength(1);
    expect(deloads[0].reason).toContain("shoulder hurts");
    expect(deloads[0].reason).toContain("times your fitness");
  });

  it("still gives the load reason on its own when nothing is flagged", () => {
    const ctx = loadApp();
    const deload = ctx.planReview(plan(), spiking(false), TODAY).proposals.find((p: any) => p.kind === "deload");
    expect(deload).toBeTruthy();
    expect(deload.reason).toContain("times your fitness");
    expect(deload.reason).not.toContain("You flagged an injury");
  });

  it("keeps the id stable so accepting it applies the one deload edit", () => {
    const ctx = loadApp();
    const r = ctx.planReview(plan(), spiking(true), TODAY);
    const deload = r.proposals.find((p: any) => p.kind === "deload");
    expect(deload.id).toBe("deload");
    const after = ctx.applyProposal(plan(), deload);
    const monday = after.days.find((d: any) => d.day === "Monday");
    expect(monday.exercises.map((e: any) => e.sets)).toEqual([3, 2]);
  });
});
