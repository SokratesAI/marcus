import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// The plan review reports the period its numbers came from, in the same sentence
// as the numbers: "Over the last 3 weeks you trained on Monday 4 times". Those
// were two different periods. Every count is taken over REVIEW_WINDOW_DAYS (28),
// and the "3" was `reviewWeeks` -- how much history exists, floored to whole
// weeks. A 23-day history inside a 28-day window floors to 3 while the window
// holds four Mondays, so the sentence claimed more Mondays than the weeks it
// named contain, and a count that IS short of the window ("Monday 3 times")
// read as every Monday kept.
//
// These tests are on the sentence rather than on the helper, because the helper
// is right about the question it answers; it was being asked the wrong one.

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
      "\n;globalThis.REVIEW_WINDOW_DAYS = REVIEW_WINDOW_DAYS;",
    ctx,
  );
  return ctx;
}

const DAY = 86400000;
const TODAY = "2026-09-01"; // a Tuesday
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);

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

// Bench only -- so "Dip" is a planned lift with no logged instance, which is what
// makes `drop` speak and print the weekday count.
const benchOn = (date: string) => ({ id: "b" + date, date, exercises: [{ name: "Bench", sets: [{ reps: 8, weight: 60 }] }] });

// Every occurrence of one weekday inside the last `days` days, newest first.
function onWeekday(dow: number, days: number) {
  const out: any[] = [];
  for (let d = 0; d < days; d++) {
    const iso = ago(d);
    if (new Date(iso + "T00:00:00Z").getUTCDay() === dow) out.push(benchOn(iso));
  }
  return out;
}
const mondays = (days: number) => onWeekday(1, days);

describe("the review names the window it counted, not the history it has", () => {
  it("does not claim more Mondays than the number of weeks it names", () => {
    const ctx = loadApp();
    const sessions = mondays(ctx.REVIEW_WINDOW_DAYS);
    // The precondition the whole test rests on: the 28-day window really does
    // hold four Mondays, and the history really does floor to three weeks -- so
    // the two numbers genuinely disagree here rather than by construction.
    expect(sessions.length).toBe(4);
    expect(ctx.reviewWeeks(sessions, TODAY, ctx.REVIEW_WINDOW_DAYS)).toBe(3);

    const drop = ctx.planReview(plan(), sessions, TODAY).proposals.find((p: any) => p.kind === "drop");
    expect(drop).toBeTruthy();
    expect(drop.reason).toContain("Over the last 4 weeks you trained on Monday 4 times");
  });

  it("keeps a short count reading as a miss, not as a full house", () => {
    const ctx = loadApp();
    // Three of the window's four Mondays: the oldest one dropped.
    const sessions = mondays(ctx.REVIEW_WINDOW_DAYS).slice(0, 3);
    expect(sessions.length).toBe(3);

    const drop = ctx.planReview(plan(), sessions, TODAY).proposals.find((p: any) => p.kind === "drop");
    expect(drop.reason).toContain("Over the last 4 weeks you trained on Monday 3 times");
  });

  it("says the same period on the rest-day proposal", () => {
    const ctx = loadApp();
    const rest = ctx.planReview(plan(), mondays(ctx.REVIEW_WINDOW_DAYS), TODAY)
      .proposals.find((p: any) => p.kind === "rest");
    expect(rest.day).toBe("Thursday");
    expect(rest.reason).toContain("Over the last 4 weeks you trained on Thursday 0 times");
  });

  it("says the same period on the trim proposal", () => {
    const ctx = loadApp();
    // Bench logged on every Monday in the window at 3 sets, where the plan asks 4.
    const sessions = mondays(ctx.REVIEW_WINDOW_DAYS).map((s: any) => ({
      ...s,
      exercises: [
        { name: "Bench", sets: [1, 2, 3].map(() => ({ reps: 8, weight: 60 })) },
        { name: "Dip", sets: [1, 2, 3].map(() => ({ reps: 10, weight: 0 })) },
      ],
    }));
    const trim = ctx.planReview(plan(), sessions, TODAY).proposals.find((p: any) => p.kind === "trim");
    expect(trim).toBeTruthy();
    expect(trim.reason).toContain("Over the last 4 weeks you logged Bench on Monday 4 times");
  });

  it("names the window it was actually given, not the default one", () => {
    const ctx = loadApp();
    // A 21-day window over the same log: three Mondays in it, and the sentence
    // has to say three weeks. Without reading the argument this reads 4 either way.
    const drop = ctx.planReview(plan(), mondays(ctx.REVIEW_WINDOW_DAYS), TODAY, 21)
      .proposals.find((p: any) => p.kind === "drop");
    expect(drop.reason).toContain("Over the last 3 weeks you trained on Monday 3 times");
  });

  it("says the same period on the move proposal", () => {
    const ctx = loadApp();
    // Monday kept, Thursday never trained, Saturday used instead -- and Saturday
    // is a rest day in the plan, which is what turns the rest proposal into a move.
    const sessions = [...mondays(ctx.REVIEW_WINDOW_DAYS), ...onWeekday(6, ctx.REVIEW_WINDOW_DAYS)];
    const move = ctx.planReview(plan(), sessions, TODAY).proposals.find((p: any) => p.kind === "move");
    expect(move.toDay).toBe("Saturday");
    expect(move.reason).toContain("Over the last 4 weeks you trained on Thursday 0 times and on Saturday 4 times");
  });

  // There is deliberately no test for the `build` proposal's copy of this
  // sentence, and the reason is that the two numbers cannot differ there:
  // `build` only fires on a `backing off` verdict, and `trainingLoad` answers
  // `too early` under LOAD_MIN_DAYS (28) of covered history -- the same 28 days
  // the review window is. So by the time build can speak, the history has
  // already filled the window and the history figure is 4 as well. A test there
  // would pass against both spellings, which is worse than no test.

  it("still refuses to review under two weeks of history, and counts that in history weeks", () => {
    const ctx = loadApp();
    // 13 days of span: one day short of the two whole weeks the gate wants.
    const shortRun = [benchOn(ago(12)), benchOn(ago(5)), benchOn(ago(0))];
    const r = ctx.planReview(plan(), shortRun, TODAY);
    expect(r.weeks).toBe(1);
    expect(r.proposals).toEqual([]);
    expect(r.note).toContain("1 so far");

    // 14 days of span, the same log with its oldest session one day earlier, and
    // the review opens. Without this the assertion above passes on any code that
    // refuses everything.
    const longRun = [benchOn(ago(13)), benchOn(ago(5)), benchOn(ago(0))];
    expect(ctx.planReview(plan(), longRun, TODAY).weeks).toBe(2);
    expect(ctx.planReview(plan(), longRun, TODAY).proposals.length).toBeGreaterThan(0);
  });
});
