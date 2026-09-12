import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-progressaxis.test.ts. `volumeThisWeek` is pure -- it
// takes the rows `weeklyVolumes` returns and a date -- but `weeklyVolumes`
// itself reads `sessions` out of the store, so the store is seeded rather than
// the function argued, and both are exposed so the pair can be tested together.
function loadApp(sessions?: any[]): any {
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
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isFinite,
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
      "\n;globalThis.volumeThisWeek = volumeThisWeek;" +
      "\n;globalThis.weeklyVolumes = weeklyVolumes;" +
      "\n;globalThis.__setSessions = (s) => store.set('sessions', s);" +
      "\n;globalThis.__setPlan = (p) => store.set('plan', p);" +
      "\n;globalThis.__setWeights = (w) => store.set('weights', w);" +
      "\n;globalThis.marcusReply = marcusReply;",
    ctx,
  );
  if (sessions) ctx.__setSessions(sessions);
  return ctx;
}

// 2026-03-02, 03-09, 03-16 and 03-23 are Mondays.
function session(date: string, weight: number) {
  return {
    id: date, date, kind: "strength", day: "Monday",
    exercises: [{ name: "Back Squat", sets: [{ reps: 10, weight }] }],
  };
}

describe("volumeThisWeek", () => {
  it("reports the current week when he has trained in it", () => {
    const app = loadApp([session("2026-03-09", 100), session("2026-03-18", 50)]);
    // 03-18 is the Wednesday of the 03-16 week, and today is the Friday of it.
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-20");
    expect(out).toEqual({ kg: 500, weekStart: "2026-03-16", current: true, weeksAgo: 0 });
  });

  it("does not call the last trained week 'this week' once it is over", () => {
    // The bug: his last session is eight days old, so `weeklyVolumes`'s last
    // element is the 03-09 week and the old reply printed it as "this week".
    const app = loadApp([session("2026-03-09", 100)]);
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-17");
    expect(out.current).toBe(false);
    expect(out.weekStart).toBe("2026-03-09");
    expect(out.kg).toBe(1000);
  });

  it("counts the gap in whole weeks, not in days", () => {
    const app = loadApp([session("2026-03-02", 100)]);
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-25");
    // 03-02 to 03-23 is 21 days: three weeks, not 21 and not 22.
    expect(out.weeksAgo).toBe(3);
  });

  it("counts a session earlier in the current week as current", () => {
    // Monday's session, read on Sunday: still this week, six days later.
    const app = loadApp([session("2026-03-16", 80)]);
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-22");
    expect(out.current).toBe(true);
    expect(out.weeksAgo).toBe(0);
  });

  it("is null when nothing is logged", () => {
    const app = loadApp([]);
    expect(app.volumeThisWeek(app.weeklyVolumes(), "2026-03-20")).toBe(null);
  });

  it("answers the same way whether or not a later session exists", () => {
    // A future-dated session makes `weeklyVolumes` fill a zero row for the
    // current week, so a blind read of the last row on or before today would
    // say "0kg this week" here and name the 03-09 week in the test above --
    // the same past data, two different answers.
    const app = loadApp([session("2026-03-09", 100), session("2026-03-30", 60)]);
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-18");
    expect(out.weekStart).toBe("2026-03-09");
    expect(out.kg).toBe(1000);
    expect(out.current).toBe(false);
  });

  it("does not count a week whose only session lifted nothing", () => {
    // A cardio session carries no sets, so the week is logged and its volume is
    // zero. Calling that "0kg this week" is arithmetically true and useless:
    // the number he wants compared is the last week he actually lifted in.
    const cardio = { id: "c", date: "2026-03-18", kind: "cardio", day: "Wednesday", exercises: [] };
    const app = loadApp([session("2026-03-09", 100), cardio]);
    const out = app.volumeThisWeek(app.weeklyVolumes(), "2026-03-20");
    expect(out).toEqual({ kg: 1000, weekStart: "2026-03-09", current: false, weeksAgo: 1 });
  });

  it("is null when every logged session is still ahead of him", () => {
    const app = loadApp([session("2026-03-30", 60)]);
    expect(app.volumeThisWeek(app.weeklyVolumes(), "2026-03-18")).toBe(null);
  });
});

// The figure can be right and the sentence still wrong: `marcusReply` is the
// only caller and nothing has ever tested it. These two pin the claim he reads.
describe("marcusReply on progress", () => {
  function withStore(sessions: any[], today: string): any {
    const app = loadApp(sessions);
    app.__setPlan({ days: [{ day: "Monday", focus: "Push", exercises: [] }] });
    // `marcusReply` reads `todayStr()`, so the clock is moved rather than argued.
    const real = app.Date;
    app.Date = class extends real {
      constructor(...a: any[]) { super(...(a.length ? a : [today + "T12:00:00"])); }
      static now() { return real.parse(today + "T12:00:00"); }
    };
    return app;
  }

  it("does not say 'this week' when the last session is eight days old", () => {
    const app = withStore([session("2026-03-09", 100)], "2026-03-17");
    const out = app.marcusReply("how am I doing");
    // The bug was this exact phrase carrying an eight-day-old number.
    expect(out).not.toContain("of volume this week");
    expect(out).toContain("1 week ago");
    expect(out).toContain("1,000kg");
    // "Trending well" is a verdict on this week and there is no this week yet.
    expect(out).not.toContain("trending well");
  });

  it("says 'this week' when he has trained in it", () => {
    const app = withStore([session("2026-03-16", 100)], "2026-03-17");
    const out = app.marcusReply("how am I doing");
    expect(out).toContain("1,000kg of volume this week");
    expect(out).toContain("trending well");
  });

  it("does not start a clause with 'and' when he has never weighed in", () => {
    const app = withStore([session("2026-03-16", 100)], "2026-03-17");
    app.__setWeights([]);
    const out = app.marcusReply("how am I doing");
    expect(out).not.toContain("and you put up");
    expect(out).toContain("well \u2014 you put up");
  });
});
