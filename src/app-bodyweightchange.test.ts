import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { renderApp } from "./app-dom.js";

// Same vm shape as app-streak.test.ts. bodyweightChange takes a plain array and
// returns a plain object, so nothing here touches a DOM node.
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
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const app = loadApp();

describe("bodyweightChange", () => {
  it("measures first to last weigh-in and reports the span in days", () => {
    const c = app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-30", kg: 82.2 },
    ]);
    expect(c.delta).toBeCloseTo(-2.1, 5);
    expect(c.days).toBe(26);
    expect(c.fromISO).toBe("2026-08-04");
    expect(c.toISO).toBe("2026-08-30");
  });

  it("picks the ends by date, not by array position", () => {
    // A weigh-in is pushed in the order it was typed, so a reading entered late
    // for an earlier day sits at the end of the array while being the earliest.
    const typedInOrder = [
      { date: "2026-08-10", kg: 83.8 },
      { date: "2026-08-30", kg: 82.2 },
    ];
    const backdatedLast = [
      { date: "2026-08-30", kg: 82.2 },
      { date: "2026-08-10", kg: 83.8 },
    ];
    expect(app.bodyweightChange(backdatedLast)).toEqual(app.bodyweightChange(typedInOrder));
    // And that shared answer is the by-date one, not the by-position one: read
    // positionally the second array gives +1.6kg over -20 days.
    expect(app.bodyweightChange(backdatedLast).delta).toBeCloseTo(-1.6, 5);
    expect(app.bodyweightChange(backdatedLast).days).toBe(20);
  });

  it("is null with one reading, and with two on the same day", () => {
    expect(app.bodyweightChange([{ date: "2026-08-04", kg: 84.3 }])).toBe(null);
    expect(app.bodyweightChange([])).toBe(null);
    expect(app.bodyweightChange(undefined)).toBe(null);
    expect(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-04", kg: 84.0 },
    ])).toBe(null);
  });

  it("labels the window, and says only 'weight change' when there is none", () => {
    expect(app.bodyweightChangeLabel(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-30", kg: 82.2 },
    ]))).toBe("weight change over 26 days");
    expect(app.bodyweightChangeLabel(app.bodyweightChange([
      { date: "2026-08-04", kg: 84.3 },
      { date: "2026-08-05", kg: 84.0 },
    ]))).toBe("weight change over 1 day");
    expect(app.bodyweightChangeLabel(null)).toBe("weight change");
  });
});

describe("the Home tile", () => {
  const weights = [
    { date: "2026-08-04", kg: 84.3 },
    { date: "2026-08-30", kg: 82.2 },
  ];
  // The label is a function of today now, so every render below pins one.
  // Without this these three would change their answer as the wall clock moved.
  const AUG31 = { now: new Date("2026-08-31T09:00:00") };

  it("prints the span beside the number", () => {
    const a = renderApp("home", { weights }, AUG31);
    const text = a.text();
    expect(text).toContain("-2.1kg");
    expect(text).toContain("weight change over 26 days");
    // The precondition this test rests on: the old code printed a bare label.
    expect(text).not.toContain("weight changesessions");
    a.close();
  });

  it("shows a dash rather than 0.0kg when there is only one reading", () => {
    const a = renderApp("home", { weights: [{ date: "2026-08-04", kg: 84.3 }] }, AUG31);
    const text = a.text();
    expect(text).toContain("—");
    expect(text).not.toContain("0.0kg");
    a.close();
  });

  it("signs a gain so it cannot read as a loss", () => {
    const a = renderApp("home", { weights: [
      { date: "2026-08-04", kg: 82.2 },
      { date: "2026-08-30", kg: 84.3 },
    ] }, AUG31);
    expect(a.text()).toContain("+2.1kg");
    a.close();
  });
});

// Edvard's own log on 2026-09-08: fourteen readings, one every two days, the
// last of them nine days before the day the tile was rendered. The tile read
// "-2.1kg / weight change over 26 days" and nothing on it said the scale had
// stopped, so a number that had not moved in nine days read as this week's.
const EVERY_TWO_DAYS = [
  "2026-08-04", "2026-08-06", "2026-08-08", "2026-08-10", "2026-08-12", "2026-08-14",
  "2026-08-16", "2026-08-18", "2026-08-20", "2026-08-22", "2026-08-24", "2026-08-26",
  "2026-08-28", "2026-08-30",
].map((date, i) => ({ date, kg: 84.3 - i * 0.16153846 }));

describe("a weight reading that stopped", () => {
  it("is stale when the silence is longer than twice this log's own cadence", () => {
    const c = app.bodyweightChange(EVERY_TWO_DAYS, "2026-09-08");
    expect(c.typicalGap).toBe(2);
    expect(c.daysSinceLast).toBe(9);
    expect(c.stale).toBe(true);
  });

  it("is not stale at exactly twice the cadence, so an ordinary skipped day is not an alarm", () => {
    // The precondition: four days really is silence, it is just not enough of it.
    expect(app.bodyweightChange(EVERY_TWO_DAYS, "2026-09-03").daysSinceLast).toBe(4);
    expect(app.bodyweightChange(EVERY_TWO_DAYS, "2026-09-03").stale).toBe(false);
    expect(app.bodyweightChange(EVERY_TWO_DAYS, "2026-09-04").stale).toBe(true);
  });

  it("scales to the logger, so three days is a stop for someone who weighs daily", () => {
    const daily = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]
      .map((date, i) => ({ date, kg: 84 - i * 0.1 }));
    const c = app.bodyweightChange(daily, "2026-09-07");
    expect(c.typicalGap).toBe(1);
    expect(c.daysSinceLast).toBe(3);
    expect(c.stale).toBe(true);
    // ... and the same three days is nothing at all for a weekly weigher.
    const weekly = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]
      .map((date, i) => ({ date, kg: 84 - i * 0.4 }));
    const w = app.bodyweightChange(weekly, "2026-08-27");
    expect(w.typicalGap).toBe(7);
    expect(w.daysSinceLast).toBe(3);
    expect(w.stale).toBe(false);
  });

  it("takes the middle of an even number of gaps rather than the later one", () => {
    // Gaps of 1 and 5 days: the cadence is 3, so eight days of silence is stale.
    // Reading the upper of the two instead would put the line at ten and call
    // this current, and every other log in this file has an odd gap count.
    const uneven = [
      { date: "2026-09-01", kg: 84.0 },
      { date: "2026-09-02", kg: 83.9 },
      { date: "2026-09-07", kg: 83.6 },
    ];
    const c = app.bodyweightChange(uneven, "2026-09-15");
    expect(c.typicalGap).toBe(3);
    expect(c.daysSinceLast).toBe(8);
    expect(c.stale).toBe(true);
  });

  it("does not read two readings on one day as a cadence of zero", () => {
    // Without a floor the median gap here is 0, and every reading after it is
    // stale the next morning -- the tile would say "last weighed 1 day ago" on
    // a log that is bang up to date.
    const sameDay = [
      { date: "2026-09-01", kg: 84.0 },
      { date: "2026-09-01", kg: 84.2 },
      { date: "2026-09-02", kg: 83.9 },
    ];
    const c = app.bodyweightChange(sameDay, "2026-09-03");
    expect(c.typicalGap).toBe(1);
    expect(c.daysSinceLast).toBe(1);
    expect(c.stale).toBe(false);
  });

  it("says it does not know rather than guessing fresh when no clock is passed", () => {
    const c = app.bodyweightChange(EVERY_TWO_DAYS);
    expect(c.daysSinceLast).toBeNull();
    expect(c.stale).toBe(false);
    expect(c.delta).toBeCloseTo(-2.1, 5);
  });

  it("names when the scale stopped instead of the span it covers", () => {
    const stale = app.bodyweightChange(EVERY_TWO_DAYS, "2026-09-08");
    expect(app.bodyweightChangeLabel(stale)).toBe("weight change, last weighed 9 days ago");
    // The span is still the label while the readings are current, so this is a
    // second sentence for a second state rather than a replacement.
    const fresh = app.bodyweightChange(EVERY_TWO_DAYS, "2026-08-31");
    expect(app.bodyweightChangeLabel(fresh)).toBe("weight change over 26 days");
  });

  it("singularises the day it stopped on", () => {
    const daily = ["2026-09-01", "2026-09-02", "2026-09-03"].map((date, i) => ({ date, kg: 84 - i * 0.1 }));
    const c = app.bodyweightChange(daily, "2026-09-04");
    expect(c.stale).toBe(false);
    expect(app.bodyweightChangeLabel({ ...c, stale: true, daysSinceLast: 1 }))
      .toBe("weight change, last weighed 1 day ago");
  });
});

describe("the Home tile after the scale stopped", () => {
  it("says how long ago he last weighed instead of quoting the span", () => {
    const a = renderApp("home", { weights: EVERY_TWO_DAYS }, { now: new Date("2026-09-08T05:58:00") });
    const text = a.text();
    expect(text).toContain("-2.1kg");
    expect(text).toContain("weight change, last weighed 9 days ago");
    expect(text).not.toContain("weight change over 26 days");
    a.close();
  });
});

describe("the coach reply", () => {
  // Rendered rather than run in the vm, because `marcusReply` reads the store
  // and the clock itself -- the render harness is the only place both can be
  // pinned, and a test that cannot pin the clock would change its answer daily.
  function ask(question: string, weights: unknown[], nowISO: string): string {
    const a = renderApp("home", { weights, sessions: [] }, { now: new Date(nowISO) });
    const reply = a.window.marcusReply(question);
    a.close();
    return reply;
  }

  it("stops calling a reading nine days old a trend", () => {
    const reply = ask("how is my progress going", EVERY_TWO_DAYS, "2026-09-08T05:58:00");
    expect(reply).toContain("you have not weighed in for 9 days");
    expect(reply).not.toContain("over 26 days");
  });

  it("still quotes the span while the readings are current", () => {
    const reply = ask("how is my progress going", EVERY_TWO_DAYS, "2026-08-31T09:00:00");
    expect(reply).toContain("bodyweight moved -2.1kg over 26 days");
  });
});
