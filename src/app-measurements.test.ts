import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-rpe.test.ts: every function under test takes plain values
// and returns plain values, so no DOM node is touched.
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
      "\n;globalThis.MEASUREMENT_SITES = MEASUREMENT_SITES;" +
      "\n;globalThis.BACKUP_KEYS = BACKUP_KEYS;" +
      "\n;globalThis.MERGE_KEYS = MERGE_KEYS;",
    ctx
  );
  return ctx;
}

describe("validateMeasurement", () => {
  const ctx = loadApp();

  it("accepts a waist reading and rounds it to the millimetre", () => {
    expect(ctx.validateMeasurement("waist", "86.47")).toEqual({ ok: true, site: "waist", value: 86.5 });
  });

  it("refuses a site the app does not know, so two spellings cannot become two series", () => {
    const r = ctx.validateMeasurement("tummy", "86");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Pick what you measured/);
  });

  it("refuses a blank site the same way", () => {
    expect(ctx.validateMeasurement("", "86").ok).toBe(false);
    expect(ctx.validateMeasurement(null, "86").ok).toBe(false);
  });

  it("refuses text in the value box", () => {
    const r = ctx.validateMeasurement("waist", "about ninety");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must be a number/);
  });

  it("refuses an empty value box -- a measurement with no number is not a record", () => {
    expect(ctx.validateMeasurement("waist", "").ok).toBe(false);
  });

  it("bounds a circumference at 10 and 300 cm", () => {
    expect(ctx.validateMeasurement("waist", "10").ok).toBe(true);
    expect(ctx.validateMeasurement("waist", "300").ok).toBe(true);
    expect(ctx.validateMeasurement("waist", "9.9").ok).toBe(false);
    expect(ctx.validateMeasurement("waist", "301").ok).toBe(false);
  });

  it("bounds body fat separately, because a percentage is not a circumference", () => {
    // 86 is a perfectly ordinary waist and an impossible body-fat percentage;
    // one shared bound could not have refused it.
    expect(ctx.validateMeasurement("waist", "86").ok).toBe(true);
    expect(ctx.validateMeasurement("bodyfat", "86").ok).toBe(false);
    expect(ctx.validateMeasurement("bodyfat", "18.5")).toEqual({ ok: true, site: "bodyfat", value: 18.5 });
  });

  it("names the unit in the message it refuses with", () => {
    expect(ctx.validateMeasurement("waist", "400").message).toMatch(/cm/);
    expect(ctx.validateMeasurement("bodyfat", "90").message).toMatch(/%/);
  });

  it("knows seven sites and gives each one a label and a unit", () => {
    expect(ctx.MEASUREMENT_SITES.map((s: any) => s.key)).toEqual(
      ["waist", "chest", "hips", "thigh", "arm", "neck", "bodyfat"]
    );
    for (const s of ctx.MEASUREMENT_SITES) {
      expect(typeof s.label).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
      expect(["cm", "%"]).toContain(s.unit);
      expect(ctx.measurementSite(s.key)).toBe(s);
    }
    expect(ctx.measurementSite("tummy")).toBe(null);
  });
});

describe("upsertMeasurement", () => {
  const ctx = loadApp();

  it("appends a reading for a site that has none today", () => {
    const out = ctx.upsertMeasurement([{ date: "2026-09-01", site: "waist", value: 88 }],
      { date: "2026-09-07", site: "waist", value: 86.5 });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ date: "2026-09-07", site: "waist", value: 86.5 });
  });

  it("replaces a second reading of the same site on the same day", () => {
    // (date, site) is the merge identity, so two records sharing both would
    // collide when two phones sync and one would vanish silently.
    const out = ctx.upsertMeasurement([{ date: "2026-09-07", site: "waist", value: 88 }],
      { date: "2026-09-07", site: "waist", value: 86.5 });
    expect(out).toEqual([{ date: "2026-09-07", site: "waist", value: 86.5 }]);
  });

  it("leaves the same day's other sites alone", () => {
    const out = ctx.upsertMeasurement(
      [{ date: "2026-09-07", site: "waist", value: 88 }, { date: "2026-09-07", site: "chest", value: 104 }],
      { date: "2026-09-07", site: "waist", value: 86.5 });
    expect(out).toHaveLength(2);
    expect(out.find((r: any) => r.site === "chest").value).toBe(104);
  });

  it("takes a missing list as an empty one rather than throwing", () => {
    expect(ctx.upsertMeasurement(undefined, { date: "2026-09-07", site: "waist", value: 86.5 }))
      .toEqual([{ date: "2026-09-07", site: "waist", value: 86.5 }]);
  });
});

describe("measurementSeries", () => {
  const ctx = loadApp();
  const records = [
    { date: "2026-09-05", site: "waist", value: 87 },
    { date: "2026-09-01", site: "waist", value: 88 },
    { date: "2026-09-03", site: "chest", value: 104 },
    { date: "2026-09-07", site: "waist", value: 86.5 },
  ];

  it("returns one site oldest first, whatever order the store held", () => {
    expect(ctx.measurementSeries(records, "waist").map((r: any) => r.date))
      .toEqual(["2026-09-01", "2026-09-05", "2026-09-07"]);
  });

  it("does not mutate the array it was given", () => {
    const copy = records.slice();
    ctx.measurementSeries(records, "waist");
    expect(records).toEqual(copy);
  });

  it("skips a record with no number in it, so a chart cannot plot a gap as zero", () => {
    const out = ctx.measurementSeries(
      [{ date: "2026-09-01", site: "waist", value: 88 }, { date: "2026-09-02", site: "waist" }], "waist");
    expect(out).toHaveLength(1);
  });

  it("is empty for a site nothing was logged under", () => {
    expect(ctx.measurementSeries(records, "neck")).toEqual([]);
    expect(ctx.measurementSeries(undefined, "waist")).toEqual([]);
  });
});

describe("measurementTrend", () => {
  const ctx = loadApp();

  it("reports the newest reading and the change since the first", () => {
    const t = ctx.measurementTrend([
      { date: "2026-09-01", site: "waist", value: 88 },
      { date: "2026-09-07", site: "waist", value: 86.5 },
    ], "waist");
    expect(t).toEqual({ latest: 86.5, date: "2026-09-07", count: 2, change: -1.5, since: "2026-09-01" });
  });

  it("reports a single reading as a starting point with no change, not a change of zero", () => {
    // A 0 would read as "the tape has not moved", which is a claim one reading
    // cannot support.
    const t = ctx.measurementTrend([{ date: "2026-09-07", site: "waist", value: 86.5 }], "waist");
    expect(t.change).toBe(null);
    expect(t.since).toBe(null);
    expect(t.count).toBe(1);
  });

  it("rounds the change to the millimetre rather than carrying float noise", () => {
    const t = ctx.measurementTrend([
      { date: "2026-09-01", site: "waist", value: 88.3 },
      { date: "2026-09-07", site: "waist", value: 86.1 },
    ], "waist");
    expect(t.change).toBe(-2.2);
  });

  it("measures from the oldest reading even when the store is out of order", () => {
    const t = ctx.measurementTrend([
      { date: "2026-09-07", site: "waist", value: 86.5 },
      { date: "2026-09-01", site: "waist", value: 88 },
    ], "waist");
    expect(t.change).toBe(-1.5);
  });

  it("is null when the site has nothing logged", () => {
    expect(ctx.measurementTrend([], "waist")).toBe(null);
    expect(ctx.measurementTrend([{ date: "2026-09-01", site: "chest", value: 104 }], "waist")).toBe(null);
  });
});

describe("measurements are carried by backup and by merge", () => {
  const ctx = loadApp();

  it("is a backup key, so a restored file keeps the tape readings", () => {
    expect(ctx.BACKUP_KEYS).toContain("measurements");
  });

  it("merges by date and site together, which is what makes one per day per site correct", () => {
    expect(ctx.MERGE_KEYS.measurements).toEqual({ by: ["date", "site"] });
  });
});
