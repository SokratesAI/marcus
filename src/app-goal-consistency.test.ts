import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209: "Improve overall health and fitness" is his own example goal and it
// has no race day, so the Progress tab drew it a card with no measurement on it
// at all. `trainingConsistency` is the honest one: weeks since he set it, and how
// many of those have a session in them.
function load(): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const nodes: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (nodes[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };
  const stored: Record<string, string> = {};
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, Set,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.trainingConsistency = trainingConsistency;globalThis.goalProgressCard = goalProgressCard;",
    ctx,
  );
  return ctx;
}

const ongoing = (created: string) => ({ id: "g1", text: "Improve overall health and fitness", targetDate: "", created, milestones: [] });
const lift = (date: string) => ({ id: date, date, exercises: [{ name: "Squat", sets: [{ reps: 5, weight: 100 }] }] });
const ride = (date: string) => ({ id: "c" + date, date, kind: "cardio", activity: "ride", minutes: 40 });

describe("trainingConsistency", () => {
  it("counts the week the goal was set as week one", () => {
    const ctx = load();
    // 2026-09-07 is a Monday; 2026-09-12 is the Saturday of the same week.
    expect(ctx.trainingConsistency(ongoing("2026-09-07"), [], "2026-09-12")).toMatchObject({ weeks: 1, trained: 0, pct: 0 });
  });

  it("counts calendar weeks, not days, from a goal set mid-week", () => {
    const ctx = load();
    // Set on a Wednesday; three Mondays have begun by 2026-09-12.
    expect(ctx.trainingConsistency(ongoing("2026-08-26"), [], "2026-09-12").weeks).toBe(3);
  });

  it("counts a week once however many sessions it holds", () => {
    const ctx = load();
    const p = ctx.trainingConsistency(ongoing("2026-08-31"), [lift("2026-09-01"), lift("2026-09-03"), lift("2026-09-05")], "2026-09-12");
    expect(p).toMatchObject({ weeks: 2, trained: 1, pct: 50 });
  });

  it("counts a cardio-only week as trained", () => {
    const ctx = load();
    // The deliberate split from volumeThisWeek, which needs kilograms: a ride is
    // training toward "improve overall health and fitness" and lifts nothing.
    const p = ctx.trainingConsistency(ongoing("2026-09-07"), [ride("2026-09-09")], "2026-09-12");
    expect(p).toMatchObject({ weeks: 1, trained: 1, pct: 100 });
  });

  it("ignores a session from before the goal was set", () => {
    const ctx = load();
    const p = ctx.trainingConsistency(ongoing("2026-09-07"), [lift("2026-08-31"), lift("2026-09-08")], "2026-09-12");
    expect(p.trained).toBe(1);
  });

  it("ignores a session dated after this week", () => {
    const ctx = load();
    const p = ctx.trainingConsistency(ongoing("2026-09-07"), [lift("2026-09-15")], "2026-09-12");
    expect(p).toMatchObject({ weeks: 1, trained: 0 });
  });

  it("skips a row with no date rather than throwing", () => {
    const ctx = load();
    const p = ctx.trainingConsistency(ongoing("2026-09-07"), [null, {}, lift("2026-09-08")], "2026-09-12");
    expect(p.trained).toBe(1);
  });

  it("returns null when there is no session list to read", () => {
    const ctx = load();
    // A caller that forgot the argument gets no meter, not "0 of 8 weeks".
    expect(ctx.trainingConsistency(ongoing("2026-08-01"), undefined, "2026-09-12")).toBe(null);
  });

  it("returns null for a goal created in a week that has not arrived", () => {
    const ctx = load();
    expect(ctx.trainingConsistency(ongoing("2026-09-21"), [], "2026-09-12")).toBe(null);
  });
});

describe("goalProgressCard for an ongoing goal", () => {
  it("draws the weeks-trained meter with the count spelled out", () => {
    const ctx = load();
    const html = ctx.goalProgressCard(ongoing("2026-08-31"), "2026-09-12", [lift("2026-09-01")]);
    expect(html).toContain("Weeks trained");
    expect(html).toContain("1 of 2");
    expect(html).toContain("width:50%");
    // The card still says what it is; the meter is added, not swapped in.
    expect(html).toContain("No target date");
  });

  it("draws no meter when the caller passes no sessions", () => {
    const ctx = load();
    const html = ctx.goalProgressCard(ongoing("2026-08-31"), "2026-09-12");
    expect(html).not.toContain("Weeks trained");
    expect(html).toContain("No target date");
  });

  it("keeps a dated goal's own two meters and adds the third", () => {
    const ctx = load();
    const dated = { id: "g2", text: "Olympic triathlon", targetDate: "2026-12-31", created: "2026-08-31", milestones: [] };
    const html = ctx.goalProgressCard(dated, "2026-09-12", [lift("2026-09-01")]);
    expect(html).toContain("Time gone");
    expect(html).toContain("Phases ticked");
    expect(html).toContain("Weeks trained");
    expect(html).toContain("1 of 2");
  });
});

// The dated half, which is what cycle 1442 added. A race goal's two old meters
// both move without him: the clock runs on its own and the phase ticks are his
// own checkboxes, so the card could read healthy on a block he barely trained in.
describe("trainingConsistency for a dated goal", () => {
  const dated = (created: string, targetDate: string) =>
    ({ id: "g2", text: "Olympic triathlon", targetDate, created, milestones: [] });

  it("measures up to today while the target is still ahead", () => {
    const ctx = load();
    // Created Monday 2026-08-31, race 2026-12-31, today Saturday 2026-09-12:
    // two calendar weeks have begun, not the eighteen to the race.
    const p = ctx.trainingConsistency(dated("2026-08-31", "2026-12-31"), [lift("2026-09-01")], "2026-09-12");
    expect(p).toMatchObject({ weeks: 2, trained: 1, pct: 50, until: "2026-09-07" });
  });

  it("stops the window on the target day once the race is behind him", () => {
    const ctx = load();
    // Race 2026-09-04 (a Friday), today three weeks later. The block is the two
    // weeks he trained in, not five weeks of which he trained two.
    const p = ctx.trainingConsistency(dated("2026-08-31", "2026-09-04"),
      [lift("2026-09-01"), lift("2026-09-03")], "2026-09-26");
    expect(p).toMatchObject({ weeks: 1, trained: 1, pct: 100, until: "2026-08-31" });
  });

  it("does not count training done after the race toward the block", () => {
    const ctx = load();
    const p = ctx.trainingConsistency(dated("2026-08-31", "2026-09-04"),
      [lift("2026-09-10"), lift("2026-09-17")], "2026-09-26");
    expect(p).toMatchObject({ weeks: 1, trained: 0 });
  });

  it("returns null for a goal whose target day precedes the week it was set in", () => {
    const ctx = load();
    expect(ctx.trainingConsistency(dated("2026-09-07", "2026-09-05"), [], "2026-09-12")).toBe(null);
  });

  it("counts the race week itself while the race is still ahead", () => {
    const ctx = load();
    // Race Thursday 2026-09-10, today Tuesday 2026-09-08 of the same week.
    const p = ctx.trainingConsistency(dated("2026-09-07", "2026-09-10"), [lift("2026-09-08")], "2026-09-08");
    expect(p).toMatchObject({ weeks: 1, trained: 1, until: "2026-09-07" });
  });
});
