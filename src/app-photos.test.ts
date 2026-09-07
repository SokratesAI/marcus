import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-measurements.test.ts: every function under test takes
// plain values and returns plain values, so no DOM node is touched.
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
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isFinite, RegExp,
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
      "\n;globalThis.PHOTO_POSES = PHOTO_POSES;" +
      "\n;globalThis.PHOTO_BUDGET_BYTES = PHOTO_BUDGET_BYTES;" +
      "\n;globalThis.PHOTO_MAX_BYTES = PHOTO_MAX_BYTES;" +
      "\n;globalThis.PHOTO_MAX_EDGE = PHOTO_MAX_EDGE;",
    ctx
  );
  return ctx;
}

// A data URL whose decoded payload is exactly `bytes` long. Built rather than
// pasted so a test that says "one byte over the limit" really is one byte over.
function jpegOf(bytes: number, mime = "image/jpeg"): string {
  return `data:${mime};base64,` + Buffer.alloc(bytes, 0x41).toString("base64");
}

describe("photoBytes", () => {
  const ctx = loadApp();

  it("reports the decoded size, not the length of the data URL", () => {
    // 300 bytes of base64 is 400 characters plus the prefix; measuring the
    // string would overstate every photo by a third and refuse a set that fits.
    const url = jpegOf(300);
    expect(url.length).toBeGreaterThan(400);
    expect(ctx.photoBytes(url)).toBe(300);
  });

  it("gets the padded lengths right", () => {
    expect(ctx.photoBytes(jpegOf(1))).toBe(1);
    expect(ctx.photoBytes(jpegOf(2))).toBe(2);
    expect(ctx.photoBytes(jpegOf(3))).toBe(3);
  });

  it("is 0 for anything that is not a data URL", () => {
    expect(ctx.photoBytes("")).toBe(0);
    expect(ctx.photoBytes(null)).toBe(0);
    expect(ctx.photoBytes("https://example.com/a.jpg")).toBe(0);
  });
});

describe("photoTotalBytes", () => {
  const ctx = loadApp();

  it("adds up the stored byte counts", () => {
    expect(ctx.photoTotalBytes([{ bytes: 10 }, { bytes: 32 }])).toBe(42);
  });

  it("falls back to measuring a record written without a byte count", () => {
    expect(ctx.photoTotalBytes([{ dataUrl: jpegOf(90) }])).toBe(90);
  });

  it("is 0 for a missing list", () => {
    expect(ctx.photoTotalBytes(null)).toBe(0);
    expect(ctx.photoTotalBytes([])).toBe(0);
  });
});

describe("validatePhoto", () => {
  const ctx = loadApp();

  it("accepts a front photo and reports what it costs", () => {
    const r = ctx.validatePhoto("front", jpegOf(1000), [], "2026-09-07");
    expect(r.ok).toBe(true);
    expect(r.pose).toBe("front");
    expect(r.bytes).toBe(1000);
    expect(r.date).toBe("2026-09-07");
  });

  it("refuses a pose the app does not know, so two spellings cannot become two series", () => {
    expect(ctx.validatePhoto("torso", jpegOf(10), [], "2026-09-07").ok).toBe(false);
    expect(ctx.validatePhoto("", jpegOf(10), [], "2026-09-07").ok).toBe(false);
    expect(ctx.validatePhoto(null, jpegOf(10), [], "2026-09-07").ok).toBe(false);
  });

  it("refuses anything that is not an image data URL", () => {
    for (const bad of ["", "https://example.com/a.jpg", "data:text/html;base64,QQ==", "data:image/svg+xml;base64,QQ=="]) {
      const r = ctx.validatePhoto("front", bad, [], "2026-09-07");
      expect(r.ok, bad).toBe(false);
      expect(r.message).toMatch(/not an image/);
    }
  });

  it("takes a png and a webp as well as a jpeg", () => {
    expect(ctx.validatePhoto("front", jpegOf(50, "image/png"), [], "2026-09-07").ok).toBe(true);
    expect(ctx.validatePhoto("front", jpegOf(50, "image/webp"), [], "2026-09-07").ok).toBe(true);
  });

  it("holds one photo to its own limit, exactly", () => {
    const max = ctx.PHOTO_MAX_BYTES;
    expect(ctx.validatePhoto("front", jpegOf(max), [], "2026-09-07").ok).toBe(true);
    const over = ctx.validatePhoto("front", jpegOf(max + 1), [], "2026-09-07");
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/over the .* limit for one photo/);
  });

  it("refuses a photo that would push the set past the budget", () => {
    const budget = ctx.PHOTO_BUDGET_BYTES;
    const existing = [{ date: "2026-01-01", pose: "front", bytes: budget - 100, dataUrl: jpegOf(4) }];
    expect(ctx.validatePhoto("side", jpegOf(100), existing, "2026-09-07").ok).toBe(true);
    const over = ctx.validatePhoto("side", jpegOf(101), existing, "2026-09-07");
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/No room/);
  });

  it("does not count the photo it is about to replace against the budget", () => {
    // The failure this exists to stop: a retake near the ceiling refused while
    // the room it needs is sitting in the record being overwritten.
    const budget = ctx.PHOTO_BUDGET_BYTES;
    const incoming = 300 * 1024;
    // Deliberately under PHOTO_MAX_BYTES, or the per-photo limit would refuse
    // this before the budget arithmetic ever ran and the test would pass on the
    // wrong rule.
    expect(incoming).toBeLessThan(ctx.PHOTO_MAX_BYTES);
    const existing = [{ date: "2026-09-07", pose: "front", bytes: budget - incoming + 1, dataUrl: jpegOf(4) }];
    expect(ctx.validatePhoto("front", jpegOf(incoming), existing, "2026-09-07").ok).toBe(true);
    // ...but a different pose on the same day is a second record and does count.
    expect(ctx.validatePhoto("side", jpegOf(incoming), existing, "2026-09-07").ok).toBe(false);
    // ...and so does the same pose on a different day.
    expect(ctx.validatePhoto("front", jpegOf(incoming), existing, "2026-09-08").ok).toBe(false);
  });
});

describe("upsertPhoto", () => {
  const ctx = loadApp();

  it("replaces the same pose on the same day rather than appending", () => {
    const first = ctx.upsertPhoto([], { date: "2026-09-07", pose: "front", bytes: 10 });
    const second = ctx.upsertPhoto(first, { date: "2026-09-07", pose: "front", bytes: 20 });
    expect(second).toHaveLength(1);
    expect(second[0].bytes).toBe(20);
  });

  it("keeps a different pose on the same day", () => {
    const rows = ctx.upsertPhoto([{ date: "2026-09-07", pose: "front", bytes: 10 }], { date: "2026-09-07", pose: "side", bytes: 20 });
    expect(rows).toHaveLength(2);
  });

  it("keeps the same pose on a different day", () => {
    const rows = ctx.upsertPhoto([{ date: "2026-09-06", pose: "front", bytes: 10 }], { date: "2026-09-07", pose: "front", bytes: 20 });
    expect(rows).toHaveLength(2);
  });
});

describe("photoSeries", () => {
  const ctx = loadApp();
  const rows = [
    { date: "2026-09-07", pose: "front", dataUrl: "data:image/jpeg;base64,QQ==" },
    { date: "2026-01-01", pose: "front", dataUrl: "data:image/jpeg;base64,QQ==" },
    { date: "2026-05-01", pose: "side", dataUrl: "data:image/jpeg;base64,QQ==" },
  ];

  it("returns one pose, oldest first", () => {
    expect(ctx.photoSeries(rows, "front").map((r: any) => r.date)).toEqual(["2026-01-01", "2026-09-07"]);
  });

  it("drops a record with no image on it", () => {
    expect(ctx.photoSeries([{ date: "2026-09-07", pose: "front" }], "front")).toEqual([]);
    expect(ctx.photoSeries([{ pose: "front", dataUrl: "data:image/jpeg;base64,QQ==" }], "front")).toEqual([]);
  });

  it("is empty for a pose with nothing in it", () => {
    expect(ctx.photoSeries(rows, "back")).toEqual([]);
    expect(ctx.photoSeries(null, "front")).toEqual([]);
  });
});

describe("photoSpan", () => {
  const ctx = loadApp();
  const img = "data:image/jpeg;base64,QQ==";

  it("reports the days between the first and last photo of a pose", () => {
    const rows = [
      { date: "2026-09-07", pose: "front", dataUrl: img },
      { date: "2026-07-10", pose: "front", dataUrl: img },
    ];
    expect(ctx.photoSpan(rows, "front")).toEqual({ count: 2, days: 59, first: "2026-07-10", last: "2026-09-07" });
  });

  it("gives one photo a null span rather than 0 days", () => {
    // 0 would read as "no time has passed", which is a claim one photo cannot
    // make -- the same call measurementTrend makes about a single reading.
    const span = ctx.photoSpan([{ date: "2026-09-07", pose: "front", dataUrl: img }], "front");
    expect(span.count).toBe(1);
    expect(span.days).toBeNull();
  });

  it("is null when the pose has no photos", () => {
    expect(ctx.photoSpan([], "front")).toBeNull();
  });
});

describe("photoSizeLabel", () => {
  const ctx = loadApp();

  it("switches units where a reader would", () => {
    expect(ctx.photoSizeLabel(512)).toBe("512 B");
    expect(ctx.photoSizeLabel(1024)).toBe("1 KB");
    expect(ctx.photoSizeLabel(320 * 1024)).toBe("320 KB");
    expect(ctx.photoSizeLabel(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("never reports a negative or a non-number", () => {
    expect(ctx.photoSizeLabel(-5)).toBe("0 B");
    expect(ctx.photoSizeLabel(null)).toBe("0 B");
    expect(ctx.photoSizeLabel(NaN)).toBe("0 B");
  });
});

describe("the photo store is wired into sync and backup", () => {
  const ui = appFile("app.js");

  it("merges a photo by (date, pose), the pair upsertPhoto keys on", () => {
    // If these two disagree, a same-day retake on two phones collides in the
    // merge and one photo disappears with nothing saying so.
    expect(ui).toMatch(/photos:\s*\{\s*by:\s*\['date',\s*'pose'\]\s*\}/);
  });

  it("is in BACKUP_KEYS, so an export and a server copy carry the photos", () => {
    const m = ui.match(/const BACKUP_KEYS = \[[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("'photos'");
  });

  it("is deletable, so a full budget is not a dead end", () => {
    const m = ui.match(/const DELETABLE_STORES = \[[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("'photos'");
  });
});
