import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-stalled.test.ts. trainingStreak takes plain values and
// returns a number, so nothing here touches a DOM node.
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
    APP_SOURCE + "\n;globalThis.trainingStreak = trainingStreak;",
    ctx,
  );
  return ctx;
}

const strength = (date: string) => ({
  date, kind: "strength", exercises: [{ name: "Bench Press", sets: [{ weight: 80, reps: 5 }] }],
});
const cardio = (date: string) => ({ date, kind: "cardio", activity: "Run", minutes: 30 });

describe("trainingStreak", () => {
  it("is zero with nothing logged", () => {
    const app = loadApp();
    expect(app.trainingStreak([], "2026-09-07")).toBe(0);
  });

  it("counts consecutive days ending today", () => {
    const app = loadApp();
    const streak = app.trainingStreak(
      [strength("2026-09-05"), strength("2026-09-06"), strength("2026-09-07")],
      "2026-09-07",
    );
    expect(streak).toBe(3);
  });

  // The bug this function was extracted for. A lift and a run on the same
  // evening are two sessions with one date, and the old counter incremented
  // once per session, so one day of training displayed as two.
  it("counts a lift and a run on the same day as one day", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-07"), cardio("2026-09-07")], "2026-09-07")).toBe(1);
  });

  it("still counts each day once when every day carries two sessions", () => {
    const app = loadApp();
    const sessions = [
      strength("2026-09-06"), cardio("2026-09-06"),
      strength("2026-09-07"), cardio("2026-09-07"),
    ];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  // The second bug. The old counter compared the newest session against the
  // current instant, so a run ending yesterday survived at 09:00 and vanished
  // by 19:00. Both ends are dates now, and the only way to show that is to ask
  // for the same data twice and demand the same answer.
  it("does not depend on the time of day", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-05"), strength("2026-09-06")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  it("survives a day you have not trained yet", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-06")], "2026-09-07")).toBe(1);
  });

  it("is broken by a whole missed day", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-03"), strength("2026-09-04"), strength("2026-09-07")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(1);
  });

  it("is zero when the newest session is two days old", () => {
    const app = loadApp();
    expect(app.trainingStreak([strength("2026-09-05")], "2026-09-07")).toBe(0);
  });

  it("reads the same however the merged store happens to be ordered", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-06"), strength("2026-09-04"), strength("2026-09-05")];
    expect(app.trainingStreak(sessions, "2026-09-06")).toBe(3);
  });

  // The store is merged from two phones, so one of them running ahead is a real
  // shape. A day that has not happened must not extend the run, and it must not
  // end it either -- the assertion is 2, not 3 and not 0.
  it("ignores a session dated after today", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-09"), strength("2026-09-06"), strength("2026-09-07")];
    expect(app.trainingStreak(sessions, "2026-09-07")).toBe(2);
  });

  it("ignores a session whose date is an empty string", () => {
    const app = loadApp();
    // `'' <= '2026-09-07'` is true, so an empty date passes the future check and
    // is dropped by the truthiness half of the filter and nothing else.
    const sessions = [{ date: "", kind: "strength" }, strength("2026-09-07")];
    expect(app.trainingStreak(sessions as any, "2026-09-07")).toBe(1);
  });

  it("ignores a session with no date at all", () => {
    const app = loadApp();
    const sessions = [{ kind: "strength" }, strength("2026-09-07")];
    expect(app.trainingStreak(sessions as any, "2026-09-07")).toBe(1);
  });
});

// 2026-09-07 is a Monday, so 09-01 is Tuesday, 09-02 Wednesday, 09-03 Thursday,
// 09-04 Friday, 09-05 Saturday and 09-06 Sunday. Every date below is picked so
// the weekday it lands on is the point of the test.
const planWithRest = (restDays: string[], trainingDays: string[] = []) => ({
  blockName: "Test Block",
  days: [
    ...restDays.map((day) => ({ day, focus: "Rest", exercises: [] })),
    ...trainingDays.map((day) => ({
      day, focus: "Push", exercises: [{ name: "Bench Press", sets: 3, reps: 8 }],
    })),
  ],
});

describe("trainingStreak and the days the plan calls rest", () => {
  // The bug. Edvard's plan writes Wednesday and Sunday down as rest days, so a
  // streak measured in calendar days resets twice a week no matter how well he
  // follows it -- over his first 36 days the Home tile could never read higher
  // than 2 while he was training five days a week.
  it("steps over a rest day the plan asked for", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-01"), strength("2026-09-03"), strength("2026-09-04")];
    const plan = planWithRest(["Wednesday"], ["Monday", "Tuesday", "Thursday", "Friday"]);
    expect(app.trainingStreak(sessions, "2026-09-04", plan)).toBe(3);
  });

  // The complement, and the reason the test above means anything: the same
  // sessions with no plan still read as the calendar-day answer. Without this,
  // a `trainingStreak` that ignored its third argument entirely would pass the
  // test above whenever the missed day happened to sit at the end of the run.
  it("reads the calendar-day answer on the same sessions with no plan", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-01"), strength("2026-09-03"), strength("2026-09-04")];
    expect(app.trainingStreak(sessions, "2026-09-04")).toBe(2);
  });

  // The whole point of the number: a day the plan told him to train and he did
  // not still ends the run. 2026-09-03 is a Thursday and the plan trains on it.
  it("is still broken by a planned training day with nothing logged", () => {
    const app = loadApp();
    const sessions = [strength("2026-09-01"), strength("2026-09-04")];
    const plan = planWithRest(["Wednesday"], ["Monday", "Tuesday", "Thursday", "Friday"]);
    expect(app.trainingStreak(sessions, "2026-09-04", plan)).toBe(1);
  });

  // Today itself being a rest day must not zero the tile: the run is allowed to
  // start yesterday, and a Sunday is exactly when he opens the app to see how
  // the week went. 2026-09-06 is a Sunday, 09-05 the Saturday before it.
  it("survives today itself being a rest day", () => {
    const app = loadApp();
    const plan = planWithRest(["Sunday"], ["Saturday"]);
    expect(app.trainingStreak([strength("2026-09-05")], "2026-09-06", plan)).toBe(1);
  });

  // A day whose focus says Rest but which carries a cardio session is a
  // training day -- that is how `planCardio` writes a run into a rest slot, and
  // reading the focus string instead of the contents would let a missed run
  // pass as a scheduled day off.
  it("treats a Rest day carrying cardio as a training day", () => {
    const app = loadApp();
    const plan: any = planWithRest([], ["Tuesday", "Thursday"]);
    plan.days.push({ day: "Wednesday", focus: "Rest", exercises: [], cardio: { activity: "Run", minutes: 30 } });
    const sessions = [strength("2026-09-01"), strength("2026-09-03")];
    expect(app.trainingStreak(sessions, "2026-09-03", plan)).toBe(1);
  });

  // A plan of nothing but rest days gives the backward walk no day that can end
  // it, so the only thing stopping it is the floor at the oldest session. This
  // asserts the answer rather than the loop, but a missing floor hangs the test
  // run rather than failing it, which is its own signal.
  it("terminates on a plan that is nothing but rest days", () => {
    const app = loadApp();
    const plan = planWithRest([
      "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    ]);
    expect(app.trainingStreak([strength("2026-09-01")], "2026-09-07", plan)).toBe(1);
  });

  // Edvard's actual week, and the number the Home tile would have shown him on
  // the Sunday: five training days hit, the Wednesday stepped over, and the run
  // ending at the Saturday before it that he did not train. The calendar-day
  // answer on the same data is 3.
  it("reads five on a week of his own plan followed", () => {
    const app = loadApp();
    const plan = planWithRest(
      ["Wednesday", "Sunday"],
      ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"],
    );
    const sessions = [
      strength("2026-08-31"), strength("2026-09-01"), strength("2026-09-03"),
      strength("2026-09-04"), strength("2026-09-05"),
    ];
    expect(app.trainingStreak(sessions, "2026-09-06", plan)).toBe(5);
    expect(app.trainingStreak(sessions, "2026-09-06")).toBe(3);
  });

  // Oslo puts its clocks back on 2026-10-25, and a walk that builds the previous
  // day out of a local-midnight Date lands on 23:00 the day before and skips a
  // date outright. This test has to set the timezone itself: the CI runner and
  // this pod both run in UTC, where a local-time walk and a UTC one are the same
  // function, so without the override the assertion would pass whether or not
  // the code was right. Every date here is a training day in the plan, so
  // nothing but the date arithmetic can break the run.
  it("walks across the autumn clock change without losing a day", () => {
    const wasTZ = process.env.TZ;
    process.env.TZ = "Europe/Oslo";
    try {
      // Guard the precondition: if the override stopped working, the rest of
      // this test proves nothing and should say so rather than pass.
      expect(new Date("2026-07-01T00:00").toISOString()).toBe("2026-06-30T22:00:00.000Z");
      const app = loadApp();
      const plan = planWithRest([], [
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
      ]);
      const sessions = [
        strength("2026-10-23"), strength("2026-10-24"),
        strength("2026-10-25"), strength("2026-10-26"),
      ];
      expect(app.trainingStreak(sessions, "2026-10-26", plan)).toBe(4);
    } finally {
      if (wasTZ === undefined) delete process.env.TZ;
      else process.env.TZ = wasTZ;
    }
  });
});
