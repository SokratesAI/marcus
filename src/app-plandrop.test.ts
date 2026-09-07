import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-planreview.test.ts. Everything under test is pure -- a
// plan and a list of sessions in, proposals or a new plan out -- so no DOM node
// is ever touched.
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

const TODAY = "2026-09-01"; // a Tuesday
const MONDAYS = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"];
const THURSDAYS = ["2026-08-13", "2026-08-20", "2026-08-27"];

// A logged strength session naming the lifts it contained. The weights are
// arbitrary and identical everywhere -- nothing here is about load.
const sess = (date: string, names: string[]) => ({
  id: date + "-" + names.join("+"),
  date,
  kind: "strength",
  exercises: names.map((n) => ({ name: n, sets: [{ reps: 8, weight: 50 }] })),
});

// Monday asks for two lifts, Thursday for two, and nothing else is a training
// day. Friday is added by the one test that needs a day he never trains on.
const plan = (extra: any[] = []) => ({
  blockName: "Block",
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 }] },
    { day: "Tuesday", focus: "Rest", exercises: [] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Legs", exercises: [{ name: "Squat", sets: 4, reps: 6 }, { name: "Row", sets: 3, reps: 8 }] },
    { day: "Friday", focus: "Rest", exercises: [] },
    { day: "Saturday", focus: "Rest", exercises: [] },
  ].map((d) => {
    const over = extra.filter((e) => e.day === d.day)[0];
    return over ? over : d;
  }),
});

// He keeps both days. On Monday he only ever does Bench; Thursday is complete.
function kept(mondayLifts: string[] = ["Bench"]) {
  return MONDAYS.map((d) => sess(d, mondayLifts))
    .concat(THURSDAYS.map((d) => sess(d, ["Squat", "Row"])));
}

const drops = (app: any, sessions: any[], p: any = plan()) =>
  app.planReview(p, sessions, TODAY, 28, null).proposals.filter((x: any) => x.kind === "drop");

describe("dropping a lift the plan names and you never do", () => {
  it("proposes taking the unlogged lift off a day he keeps training on", () => {
    const app = loadApp();
    const found = drops(app, kept());
    expect(found.length).toBe(1);
    expect(found[0].id).toBe("drop-Monday");
    expect(found[0].day).toBe("Monday");
    expect(found[0].names).toEqual(["Dip"]);
    expect(found[0].title).toBe("Take Dip off Monday");
  });

  it("puts both numbers in the reason -- how often he trained the day, and how much of it stays", () => {
    const app = loadApp();
    const found = drops(app, kept());
    expect(found[0].reason).toContain("you trained on Monday 4 times");
    expect(found[0].reason).toContain("never logged Dip on any day");
    expect(found[0].reason).toContain("1 of the 2 on that day stay");
  });

  it("is one proposal per day naming every unlogged lift, not one per lift", () => {
    const app = loadApp();
    const p = plan([{ day: "Monday", focus: "Push", exercises: [
      { name: "Bench", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 }, { name: "Fly", sets: 3, reps: 12 },
    ] }]);
    const found = drops(app, kept(), p);
    expect(found.length).toBe(1);
    expect(found[0].names).toEqual(["Dip", "Fly"]);
    expect(found[0].title).toBe("Take Dip and Fly off Monday");
    expect(found[0].reason).toContain("lifts you are not doing");
  });

  it("says nothing when every lift on the day is unlogged -- that is a wrong day, not a wrong lift", () => {
    const app = loadApp();
    // He trains on Monday, but does deadlifts the plan never asked for.
    const found = drops(app, kept(["Deadlift"]));
    expect(found.length).toBe(0);
  });

  it("says nothing about a day he never trains on -- 'move' and 'rest' own that day", () => {
    const app = loadApp();
    const p = plan([{ day: "Friday", focus: "Arms", exercises: [
      { name: "Curl", sets: 3, reps: 12 }, { name: "Pushdown", sets: 3, reps: 12 },
    ] }]);
    const all = app.planReview(p, kept(), TODAY, 28, null).proposals;
    expect(all.filter((x: any) => x.kind === "drop").map((x: any) => x.day)).toEqual(["Monday"]);
    expect(all.some((x: any) => x.day === "Friday" && (x.kind === "rest" || x.kind === "move"))).toBe(true);
  });

  it("keeps a lift he does on another weekday -- that is the day being wrong, not the lift", () => {
    const app = loadApp();
    const sessions = kept().concat([sess("2026-08-26", ["Dip"])]); // a Wednesday
    expect(drops(app, sessions).length).toBe(0);
  });

  it("drops a lift whose only logging is older than the review window", () => {
    const app = loadApp();
    const sessions = kept().concat([sess("2026-07-20", ["Dip"])]);
    const found = drops(app, sessions);
    expect(found.length).toBe(1);
    expect(found[0].names).toEqual(["Dip"]);
  });

  it("matches names case- and space-insensitively, the same as the kg prefill", () => {
    const app = loadApp();
    const sessions = MONDAYS.map((d) => sess(d, ["  bench   press ", "dip"]))
      .concat(THURSDAYS.map((d) => sess(d, ["Squat", "Row"])));
    const p = plan([{ day: "Monday", focus: "Push", exercises: [
      { name: "Bench Press", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 },
    ] }]);
    expect(drops(app, sessions, p).length).toBe(0);
  });

  it("holds its opinion until there are enough weeks of history, like the rest of the review", () => {
    const app = loadApp();
    const oneWeek = [sess("2026-08-31", ["Bench"])];
    const review = app.planReview(plan(), oneWeek, TODAY, 28, null);
    expect(review.weeks).toBeLessThan(app.REVIEW_MIN_WEEKS);
    expect(review.proposals.some((x: any) => x.kind === "drop")).toBe(false);
  });

  it("has a chip that reads on its own", () => {
    const app = loadApp();
    expect(app.proposalChip("drop")).toBe("drop a lift");
    expect(app.proposalChip("rest")).toBe("drop a day");
  });
});

describe("applying it", () => {
  it("removes exactly the named lifts from exactly that day", () => {
    const app = loadApp();
    const before = plan();
    const next = app.applyProposal(before, drops(app, kept())[0]);
    const monday = next.days.filter((d: any) => d.day === "Monday")[0];
    expect(monday.exercises.map((e: any) => e.name)).toEqual(["Bench"]);
    expect(monday.focus).toBe("Push");
    const thursday = next.days.filter((d: any) => d.day === "Thursday")[0];
    expect(thursday.exercises.map((e: any) => e.name)).toEqual(["Squat", "Row"]);
  });

  it("does not touch the plan it was handed", () => {
    const app = loadApp();
    const before = plan();
    app.applyProposal(before, drops(app, kept())[0]);
    expect(before.days.filter((d: any) => d.day === "Monday")[0].exercises.length).toBe(2);
  });

  it("matches the lift to remove the same way it matched it to propose", () => {
    const app = loadApp();
    const before = plan([{ day: "Monday", focus: "Push", exercises: [
      { name: "Bench", sets: 4, reps: 8 }, { name: "  Dip  ", sets: 3, reps: 10 },
    ] }]);
    const next = app.applyProposal(before, { kind: "drop", day: "Monday", names: ["dip"] });
    expect(next.days.filter((d: any) => d.day === "Monday")[0].exercises.map((e: any) => e.name)).toEqual(["Bench"]);
  });
});
