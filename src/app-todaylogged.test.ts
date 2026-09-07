import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-musclebalance.test.ts. `todayLogged` takes plain values
// and returns a plain object, so no DOM node is touched here.
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
  vm.runInContext(APP_SOURCE + "\n;globalThis.todayLogged = todayLogged;", ctx);
  return ctx;
}

const TODAY = "2026-09-07";
const lift = (name: string, count: number, reps = 8) => ({
  name,
  sets: Array.from({ length: count }, () => ({ weight: 60, reps })),
});
const strength = (date: string, exercises: any[]) => ({ date, day: "Push", exercises });
const cardio = (date: string, activity: string, minutes: number | null) =>
  ({ date, kind: "cardio", activity, minutes, distance: null });

describe("todayLogged", () => {
  it("is null when nothing was logged today, even with sessions on other days", () => {
    const app = loadApp();
    expect(app.todayLogged([], TODAY)).toBe(null);
    expect(app.todayLogged([strength("2026-09-06", [lift("Bench Press", 3)])], TODAY)).toBe(null);
    // Tomorrow is not today either -- a store merged from two phones can hold a
    // date ahead of this one.
    expect(app.todayLogged([strength("2026-09-08", [lift("Bench Press", 3)])], TODAY)).toBe(null);
  });

  it("survives a missing list and a hole in it rather than throwing on the home screen", () => {
    const app = loadApp();
    expect(app.todayLogged(undefined, TODAY)).toBe(null);
    expect(app.todayLogged(null, TODAY)).toBe(null);
    expect(app.todayLogged([null, undefined, {}], TODAY)).toBe(null);
  });

  it("counts lifts and sets across every strength session logged today", () => {
    const app = loadApp();
    const out = app.todayLogged([
      strength("2026-09-06", [lift("Squat", 5)]),
      strength(TODAY, [lift("Bench Press", 3), lift("Barbell Row", 4)]),
      strength(TODAY, [lift("Overhead Press", 2)]),
    ], TODAY);
    expect(out.count).toBe(2);
    expect(out.lifts).toBe(3);
    expect(out.sets).toBe(9);
    expect(out.label).toBe("3 lifts · 9 sets");
  });

  it("counts a set only when it has a positive rep count, the same rule Progress uses", () => {
    const app = loadApp();
    const out = app.todayLogged([{
      date: TODAY, day: "Push",
      exercises: [{ name: "Bench Press", sets: [
        { weight: 60, reps: 8 },
        { weight: 60, reps: 0 },
        { weight: 60, reps: null },
        { weight: 60 },
      ] }],
    }], TODAY);
    expect(out.sets).toBe(1);
    expect(out.lifts).toBe(1);
    expect(out.label).toBe("1 lift · 1 set");
  });

  it("says a strength session was logged in words when no set was completed, never as a zero", () => {
    const app = loadApp();
    const out = app.todayLogged([strength(TODAY, [lift("Bench Press", 0)])], TODAY);
    // The session is real and must be reported; "0 lifts / 0 sets" would read as
    // nothing logged, which is the state this card exists to tell apart.
    expect(out).not.toBe(null);
    expect(out.count).toBe(1);
    expect(out.sets).toBe(0);
    expect(out.lifts).toBe(0);
    expect(out.label).toBe("strength session logged");
  });

  it("does not count a lift whose sets were all left empty", () => {
    const app = loadApp();
    const out = app.todayLogged([strength(TODAY, [lift("Squat", 4), lift("Leg Press", 0)])], TODAY);
    expect(out.lifts).toBe(1);
    expect(out.sets).toBe(4);
    expect(out.label).toBe("1 lift \u00b7 4 sets");
  });

  it("names the cardio activity and totals the minutes", () => {
    const app = loadApp();
    const one = app.todayLogged([cardio(TODAY, "Rowing Erg", 45)], TODAY);
    expect(one.cardioMinutes).toBe(45);
    expect(one.label).toBe("45 min Rowing Erg");
    // Two of the same activity keep the name; two different ones must not be
    // labelled with whichever came first.
    const same = app.todayLogged([cardio(TODAY, "Run", 20), cardio(TODAY, "Run", 25)], TODAY);
    expect(same.label).toBe("45 min Run");
    const mixed = app.todayLogged([cardio(TODAY, "Run", 20), cardio(TODAY, "Swim", 25)], TODAY);
    expect(mixed.label).toBe("45 min cardio");
  });

  it("reports a cardio session with no usable duration without printing a zero", () => {
    const app = loadApp();
    expect(app.todayLogged([cardio(TODAY, "Swim", null)], TODAY).label).toBe("Swim logged");
    expect(app.todayLogged([cardio(TODAY, "", 30)], TODAY).label).toBe("30 min cardio");
    // A number that is not a duration must add nothing rather than poison the
    // total: NaN would make every later minute read as NaN, and a negative one
    // would subtract from a real session logged beside it.
    expect(app.todayLogged([cardio(TODAY, "Swim", NaN)], TODAY).cardioMinutes).toBe(0);
    expect(app.todayLogged([cardio(TODAY, "Swim", NaN), cardio(TODAY, "Swim", 30)], TODAY).label).toBe("30 min Swim");
    expect(app.todayLogged([cardio(TODAY, "Swim", -20), cardio(TODAY, "Swim", 30)], TODAY).label).toBe("30 min Swim");
  });

  it("joins both halves when today holds a lift and a run", () => {
    const app = loadApp();
    const out = app.todayLogged([
      strength(TODAY, [lift("Deadlift", 3)]),
      cardio(TODAY, "Rowing Erg", 20),
    ], TODAY);
    expect(out.count).toBe(2);
    expect(out.label).toBe("1 lift · 3 sets · 20 min Rowing Erg");
  });

  it("ignores an exercise with no name, so a blank log row cannot inflate the count", () => {
    const app = loadApp();
    const out = app.todayLogged([strength(TODAY, [
      lift("Bench Press", 2),
      { name: "   ", sets: [{ weight: 40, reps: 10 }] },
      { sets: [{ weight: 40, reps: 10 }] },
    ])], TODAY);
    expect(out.lifts).toBe(1);
    expect(out.sets).toBe(2);
  });
});

describe("the home Today card", () => {
  const source = APP_SOURCE;

  it("draws the logged line and swaps the button label off todayLogged", () => {
    // renderHome writes a template string into the DOM, so what is checkable
    // without a browser is that the card reads the helper rather than the
    // session count -- `sessions.length` was the bug in the day streak.
    expect(source).toContain("const doneToday = todayLogged(store.get('sessions', []), todayStr());");
    expect(source).toContain("exercise-line--done");
    expect(source).toContain("doneToday ? 'Log another session' : 'Log this session'");
  });
});
