import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209: "Weeks trained" says he showed up for an open-ended goal; nothing
// said whether the training was going anywhere. `volumeTrend` is that number --
// the last four completed weeks of kilograms against the four before them.
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
      "\n;globalThis.volumeTrend = volumeTrend;globalThis.volumeTrendLabel = volumeTrendLabel;globalThis.goalProgressCard = goalProgressCard;",
    ctx,
  );
  return ctx;
}

const ongoing = (created: string) => ({ id: "g1", text: "Improve overall health and fitness", targetDate: "", created, milestones: [] });
// One session of `kg` kilograms on `date`.
const lift = (date: string, kg: number) => ({ id: date + kg, date, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }] });
const ride = (date: string) => ({ id: "c" + date, date, kind: "cardio", activity: "ride", minutes: 40 });

// 2026-09-12 is a Saturday; its Monday is 2026-09-07.
// Recent window: the four weeks beginning 2026-08-10, 08-17, 08-24, 08-31.
// Older window:  the four weeks beginning 2026-07-13, 07-20, 07-27, 08-03.
const TODAY = "2026-09-12";

describe("volumeTrend", () => {
  it("compares the last four completed weeks against the four before them", () => {
    const ctx = load();
    const sessions = [
      lift("2026-07-13", 100), lift("2026-07-20", 100), lift("2026-07-27", 100), lift("2026-08-03", 100),
      lift("2026-08-10", 150), lift("2026-08-17", 150), lift("2026-08-24", 150), lift("2026-08-31", 150),
    ];
    expect(ctx.volumeTrend(sessions, TODAY)).toMatchObject({ recent: 600, older: 400, pct: 50, weeks: 4 });
  });

  it("leaves the week in progress out of both halves", () => {
    const ctx = load();
    // A huge session dated this Monday must not land in the recent window --
    // read on a Tuesday that would compare two days against four whole weeks.
    const base = [
      lift("2026-07-13", 100), lift("2026-08-03", 100),
      lift("2026-08-10", 100),
    ];
    const withThisWeek = base.concat([lift("2026-09-07", 9999), lift("2026-09-12", 9999)]);
    expect(ctx.volumeTrend(withThisWeek, TODAY).recent).toBe(ctx.volumeTrend(base, TODAY).recent);
  });

  it("returns null when the log does not reach back eight completed weeks", () => {
    const ctx = load();
    // His first session is inside the older window, so the weeks before it are
    // zeros he had no chance to lift in -- that is a shorter log, not a doubling.
    const sessions = [lift("2026-07-20", 100), lift("2026-08-31", 400)];
    expect(ctx.volumeTrend(sessions, TODAY)).toBe(null);
  });

  it("counts a week he trained nothing in as a real zero once the log is long enough", () => {
    const ctx = load();
    const sessions = [lift("2026-07-13", 400), lift("2026-08-10", 100)];
    expect(ctx.volumeTrend(sessions, TODAY)).toMatchObject({ recent: 100, older: 400, pct: -75 });
  });

  it("reports no percentage when the older window holds no kilograms", () => {
    const ctx = load();
    // The log reaches back far enough -- his first session is the week BEFORE
    // the older window -- so this is a real empty month, not a short log.
    // Dividing by it is undefined, and the card says so in words.
    const sessions = [lift("2026-07-06", 100), lift("2026-08-10", 300)];
    expect(ctx.volumeTrend(sessions, TODAY)).toMatchObject({ recent: 300, older: 0, pct: null });
  });

  it("ignores a session dated after this week", () => {
    const ctx = load();
    const sessions = [lift("2026-07-13", 100), lift("2026-08-10", 100), lift("2026-09-21", 9999)];
    expect(ctx.volumeTrend(sessions, TODAY).recent).toBe(100);
  });

  it("reads a cardio-only recent block as no kilograms, not as missing data", () => {
    const ctx = load();
    const sessions = [lift("2026-07-13", 100), ride("2026-08-10"), ride("2026-08-24")];
    expect(ctx.volumeTrend(sessions, TODAY)).toMatchObject({ recent: 0, older: 100, pct: -100 });
  });

  it("skips a row with no date rather than throwing", () => {
    const ctx = load();
    const sessions = [null, {}, lift("2026-07-13", 100), lift("2026-08-10", 200)];
    expect(ctx.volumeTrend(sessions as any, TODAY)).toMatchObject({ recent: 200, older: 100 });
  });

  it("returns null when there is no session list to read", () => {
    const ctx = load();
    expect(ctx.volumeTrend(undefined, TODAY)).toBe(null);
    expect(ctx.volumeTrend([], TODAY)).toBe(null);
  });
});

describe("volumeTrendLabel", () => {
  it("signs a rise and leaves a fall to the minus sign", () => {
    const ctx = load();
    expect(ctx.volumeTrendLabel({ recent: 600, older: 400, pct: 50, weeks: 4 })).toBe("+50%");
    expect(ctx.volumeTrendLabel({ recent: 100, older: 400, pct: -75, weeks: 4 })).toBe("-75%");
  });

  it("says a rise from nothing in words rather than as a percentage", () => {
    const ctx = load();
    // Dividing by an older window of zero is undefined, not infinite.
    expect(ctx.volumeTrendLabel({ recent: 600, older: 0, pct: null, weeks: 4 })).toBe("up from nothing");
    expect(ctx.volumeTrendLabel({ recent: 0, older: 0, pct: null, weeks: 4 })).toBe("no lifting either month");
  });
});

describe("goalProgressCard for an ongoing goal", () => {
  it("draws the volume trend beside the weeks-trained meter", () => {
    const ctx = load();
    const sessions = [
      lift("2026-07-13", 100), lift("2026-08-03", 100),
      lift("2026-08-10", 150), lift("2026-08-31", 150),
    ];
    const html = ctx.goalProgressCard(ongoing("2026-07-01"), TODAY, sessions);
    expect(html).toContain("Volume, last 4 weeks");
    expect(html).toContain("+50%");
    expect(html).toContain("300 kg");
    expect(html).toContain("against 200 kg the 4 weeks before");
    // The meter that was already there is added to, not swapped out.
    expect(html).toContain("Weeks trained");
    expect(html).toContain("No target date");
  });

  it("draws no volume row on a log too short to compare", () => {
    const ctx = load();
    const html = ctx.goalProgressCard(ongoing("2026-08-31"), TODAY, [lift("2026-09-01", 100)]);
    expect(html).not.toContain("Volume, last");
    expect(html).toContain("Weeks trained");
  });
});
