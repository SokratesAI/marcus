import { APP_SOURCE, appFile } from "./app-source.js";
import { renderApp } from "./app-dom.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Eight days after Edvard's last session the Log tab still proposed adding 2.5 kg
// to every lift on the row. `nextTarget` is the only thing in this app that
// proposes a number you have not lifted yet, and it had no idea when you last
// lifted at all -- it reads one previous performance and the reps box, and both
// of those look exactly the same the day after a session and a month after one.
//
// The fix is the same shape as the Training load card's `resting` verdict: a
// fact about what was logged, checked before every inference drawn from the last
// set. These tests are pointed at the two halves that can drift apart -- the
// rule, and the wiring that hands it the measurement.

// Same vm shape as app-nexttarget.test.ts -- these three take plain values and
// return plain values, so no DOM node is touched by the first two blocks.
function loadCore(): any {
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
  const stored: Record<string, string> = {};
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
      "\n;globalThis.nextTarget = nextTarget;" +
      "\n;globalThis.nextTargetLabel = nextTargetLabel;" +
      "\n;globalThis.daysSinceSession = daysSinceSession;",
    ctx,
  );
  return ctx;
}

const { nextTarget, nextTargetLabel, daysSinceSession } = loadCore();

// 100 kg x 8 with the rep target met, so the untouched rule says "add 2.5 kg".
// Every layoff test below starts from that, so a test that passes because the
// proposal was a hold anyway cannot exist here.
const EARNED = { date: "2026-08-31", name: "Back Squat", weight: 100, reps: 8, sets: 3, rpe: null };

describe("daysSinceSession", () => {
  it("counts from the newest session on or before the date asked about", () => {
    const sessions = [{ date: "2026-08-31" }, { date: "2026-08-24" }];
    expect(daysSinceSession(sessions, "2026-09-08")).toBe(8);
  });

  // The Log tab's date box can be backdated. Answering with today's gap would
  // tell someone filling in last Tuesday about a layoff that had not started.
  it("ignores sessions after the date asked about", () => {
    const sessions = [{ date: "2026-08-31" }, { date: "2026-09-07" }];
    expect(daysSinceSession(sessions, "2026-09-01")).toBe(1);
  });

  it("is null when nothing has been logged yet", () => {
    expect(daysSinceSession([], "2026-09-08")).toBe(null);
    expect(daysSinceSession([{ date: "2026-09-09" }], "2026-09-08")).toBe(null);
  });

  it("is zero on a day you have already trained", () => {
    expect(daysSinceSession([{ date: "2026-09-08" }], "2026-09-08")).toBe(0);
  });
});

describe("nextTarget after a layoff", () => {
  it("proposes no new number, and says how long it has been", () => {
    // Without the third argument this same row proposes 102.5 kg.
    expect(nextTarget(EARNED, 8)).toEqual({ kind: "add", weight: 102.5, reps: 8, reason: "earned" });
    const next = nextTarget(EARNED, 8, 8);
    expect(next.kind).toBe("hold");
    expect(next.weight).toBe(100);
    expect(next.reason).toBe("layoff");
    expect(nextTargetLabel(next)).toBe("Next: stay at 100 kg × 8, first session back after 8 days");
  });

  // A bodyweight lift progresses in reps, so its untouched answer is also a
  // number you have not done. It holds for the same reason.
  it("holds a bodyweight lift at the rep target instead of adding a rep", () => {
    const pullups = { date: "2026-08-31", name: "Pull-ups", weight: 0, reps: 9, sets: 3, rpe: null };
    expect(nextTarget(pullups, 8)).toEqual({ kind: "reps", weight: 0, reps: 10, reason: "bodyweight" });
    const next = nextTarget(pullups, 8, 8);
    expect(next.reason).toBe("layoff");
    expect(nextTargetLabel(next)).toBe("Next: stay at bodyweight × 8, first session back after 8 days");
  });

  // The ordering is the design decision, and it is the one cycle 1193 made on
  // `loadVerdict`: the layoff is a fact, the other three answers are readings of
  // the last set, so the fact wins. RPE 10 also says hold, so only the label can
  // tell which rule spoke.
  it("outranks the RPE 10 hold, so the reason shown is the layoff", () => {
    const spent = Object.assign({}, EARNED, { rpe: 10 });
    expect(nextTarget(spent, 8).reason).toBe("rpe");
    expect(nextTarget(spent, 8, 8).reason).toBe("layoff");
  });

  it("outranks the short-of-target hold", () => {
    expect(nextTarget(EARNED, 12).reason).toBe("short");
    expect(nextTarget(EARNED, 12, 8).reason).toBe("layoff");
  });

  it("changes nothing when the caller measured no layoff", () => {
    expect(nextTarget(EARNED, 8, null)).toEqual({ kind: "add", weight: 102.5, reps: 8, reason: "earned" });
    expect(nextTarget(EARNED, 8, 0)).toEqual({ kind: "add", weight: 102.5, reps: 8, reason: "earned" });
  });

  it("still proposes nothing at all when there is no history", () => {
    expect(nextTarget(null, 8, 8)).toBe(null);
  });
});

describe("the Log row is actually handed the layoff", () => {
  // The rule above is worth nothing if the row never measures one. This renders
  // the real Log tab against a log whose newest session is eight days old and
  // reads the proposal line off the parsed document.
  const sessions = [
    {
      date: "2026-08-31",
      kind: "strength",
      exercises: [
        { name: "Deadlift", sets: [{ weight: 100, reps: 8 }] },
      ],
    },
  ];
  const plan = {
    blockName: "Test block",
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d) =>
      d === "Tuesday"
        ? { day: d, focus: "Pull", exercises: [{ name: "Deadlift", sets: 3, reps: 8 }] }
        : { day: d, focus: "Rest", exercises: [] },
    ),
  };
  // 2026-09-08 is a Tuesday, eight days after the session above.
  const NOW = new Date("2026-09-08T09:00:00");

  it("says the first session back rather than proposing more weight", () => {
    const app = renderApp("log", { sessions, plan }, { now: NOW });
    const lines = Array.from(app.view.querySelectorAll(".ex-next")).map((n: any) => n.textContent);
    expect(lines).toContain("Next: stay at 100 kg × 8, first session back after 8 days");
    expect(lines.join(" ")).not.toContain("102.5");
    app.close();
  });

  it("goes back to proposing weight once a session is logged again", () => {
    const fresh = sessions.concat([
      { date: "2026-09-07", kind: "strength", exercises: [{ name: "Deadlift", sets: [{ weight: 100, reps: 8 }] }] },
    ]);
    const app = renderApp("log", { sessions: fresh, plan }, { now: NOW });
    const lines = Array.from(app.view.querySelectorAll(".ex-next")).map((n: any) => n.textContent);
    expect(lines).toContain("Next: 102.5 kg × 8");
    app.close();
  });
});

describe("where the threshold lives", () => {
  // One window, not two. app-core.js must not spell a second number, or the Log
  // row and the Training load card can disagree about whether you are resting.
  it("is the fatigue window, read in app.js and not restated in app-core.js", () => {
    expect(appFile("app.js")).toContain("since >= LOAD_FATIGUE_DAYS");
    expect(appFile("app-core.js")).not.toContain("LOAD_FATIGUE_DAYS");
  });
});
