import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-lastweight.test.ts. personalBests and personalBestLabel
// take plain values and return plain values; personalBestsCard returns a
// string, so no DOM node is touched here either.
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
      "\n;globalThis.personalBests = personalBests;" +
      "\n;globalThis.personalBestLabel = personalBestLabel;" +
      "\n;globalThis.personalBestsCard = personalBestsCard;",
    ctx,
  );
  return ctx;
}

const session = (date: string, name: string, sets: any[]) => ({
  date, day: "Push", exercises: [{ name, sets }],
});

describe("personalBests", () => {
  it("returns the heaviest set ever logged for a lift", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Bench Press", [{ weight: 70, reps: 8 }, { weight: 75, reps: 5 }]),
      session("2026-09-04", "Bench Press", [{ weight: 72.5, reps: 8 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(75);
    expect(rows[0].reps).toBe(5);
    expect(rows[0].date).toBe("2026-09-01");
  });

  it("breaks a tie on weight with the higher rep count", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Bench Press", [{ weight: 80, reps: 5 }]),
      session("2026-09-04", "Bench Press", [{ weight: 80, reps: 8 }]),
    ]);
    expect(rows[0].reps).toBe(8);
    expect(rows[0].date).toBe("2026-09-04");
  });

  it("ranks a bodyweight lift on reps, because every set of it weighs 0", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Pull-Up", [{ weight: 0, reps: 6 }]),
      session("2026-09-04", "Pull-Up", [{ weight: 0, reps: 11 }]),
      session("2026-09-05", "Pull-Up", [{ weight: 0, reps: 9 }]),
    ]);
    expect(rows[0].reps).toBe(11);
    expect(app.personalBestLabel(rows[0])).toBe("bodyweight × 11");
  });

  it("keeps the earliest date when weight and reps both tie", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-04", "Squat", [{ weight: 100, reps: 5 }]),
      session("2026-09-01", "Squat", [{ weight: 100, reps: 5 }]),
    ]);
    expect(rows[0].date).toBe("2026-09-01");
  });

  it("marks a best set on the newest training day as new, and older ones not", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Squat", [{ weight: 100, reps: 5 }]),
      session("2026-09-05", "Bench Press", [{ weight: 80, reps: 6 }]),
    ], "2026-09-05");
    const squat = rows.find((r: any) => r.name === "Squat");
    const bench = rows.find((r: any) => r.name === "Bench Press");
    expect(bench.isNew).toBe(true);
    expect(squat.isNew).toBe(false);
  });

  // Edvard's own log on 2026-09-08: three lifts at their best on 2026-08-31,
  // the newest day he trained, eight days earlier. The card said `new` next to
  // all three. The chip is about how recently the set happened, so a best set
  // on the newest logged day is only new while that day still is.
  it("drops the new chip once the newest training day is no longer recent", () => {
    const app = loadApp();
    const log = [
      session("2026-08-27", "Squat", [{ weight: 100, reps: 5 }]),
      session("2026-08-31", "Bench Press", [{ weight: 80, reps: 6 }]),
    ];
    const bench = (todayISO: string) =>
      app.personalBests(log, todayISO).find((r: any) => r.name === "Bench Press");
    expect(bench("2026-08-31").isNew).toBe(true);
    expect(bench("2026-09-01").isNew).toBe(true);
    expect(bench("2026-09-02").isNew).toBe(false);
    expect(bench("2026-09-08").isNew).toBe(false);
    // The row itself is untouched: it is still his best and still dated.
    expect(bench("2026-09-08").weight).toBe(80);
    expect(bench("2026-09-08").date).toBe("2026-08-31");
  });

  // Without the argument the function reads the clock, which is what the one
  // caller in app.js does. A stale log must not light the chip there either.
  it("reads today off the clock when no date is passed", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2020-01-02", "Squat", [{ weight: 100, reps: 5 }]),
    ]);
    expect(rows[0].isNew).toBe(false);
  });

  it("orders newest best first, then alphabetically inside a date", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Squat", [{ weight: 100, reps: 5 }]),
      { date: "2026-09-05", exercises: [
        { name: "Row", sets: [{ weight: 60, reps: 8 }] },
        { name: "Bench Press", sets: [{ weight: 80, reps: 6 }] },
      ] },
    ]);
    expect(rows.map((r: any) => r.name)).toEqual(["Bench Press", "Row", "Squat"]);
  });

  it("matches a lift across sessions case- and space-insensitively", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Bench Press", [{ weight: 70, reps: 8 }]),
      session("2026-09-04", "bench   press", [{ weight: 85, reps: 3 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(85);
  });

  // The exercises array on the cardio session is the point: without it the
  // loop finds nothing to count either way, so deleting the `kind` guard
  // changes no answer and the test proves nothing. A restore from a backup
  // file is the path that can hand this function a session of any shape.
  it("ignores a cardio session even when it carries lifts", () => {
    const app = loadApp();
    const rows = app.personalBests([
      { kind: "cardio", date: "2026-09-05", activity: "Run", minutes: 40,
        exercises: [{ name: "Squat", sets: [{ weight: 200, reps: 5 }] }] },
      session("2026-09-01", "Squat", [{ weight: 100, reps: 5 }]),
    ], "2026-09-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(100);
    // 2026-09-01 is the newest day that counted, because the cardio day did not.
    expect(rows[0].isNew).toBe(true);
  });

  it("skips a set with no weight recorded rather than reading it as 0 kg", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Squat", [{ reps: 5 }, { weight: 90, reps: 5 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(90);
  });

  it("skips a set with no rep count, because a best has to say how many", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "Squat", [{ weight: 120 }, { weight: 90, reps: 5 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(90);
  });

  it("survives a lift named after something on Object.prototype", () => {
    const app = loadApp();
    const rows = app.personalBests([
      session("2026-09-01", "constructor", [{ weight: 40, reps: 5 }]),
      session("2026-09-02", "constructor", [{ weight: 50, reps: 5 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(50);
  });

  it("returns nothing when no session carries a usable set", () => {
    const app = loadApp();
    expect(app.personalBests([])).toEqual([]);
    expect(app.personalBests(null)).toEqual([]);
    expect(app.personalBests([session("2026-09-01", "Squat", [])])).toEqual([]);
  });
});

describe("personalBestLabel", () => {
  it("says the load and the reps, and calls 0 kg bodyweight", () => {
    const app = loadApp();
    expect(app.personalBestLabel({ weight: 82.5, reps: 6 })).toBe("82.5 kg × 6");
    expect(app.personalBestLabel({ weight: 0, reps: 12 })).toBe("bodyweight × 12");
    expect(app.personalBestLabel(null)).toBe("");
  });
});

describe("personalBestsCard", () => {
  it("names the lift, the set and the date, and chips only the new one", () => {
    const app = loadApp();
    const html = app.personalBestsCard(app.personalBests([
      session("2026-09-01", "Squat", [{ weight: 100, reps: 5 }]),
      session("2026-09-05", "Bench Press", [{ weight: 80, reps: 6 }]),
    ], "2026-09-05"));
    expect(html).toContain("Bench Press");
    expect(html).toContain("80 kg × 6");
    expect(html).toContain("Squat");
    expect(html).toContain("100 kg × 5");
    // One chip, on the row that was set on the newest training day.
    expect(html.match(/chip--primary/g) || []).toHaveLength(1);
    expect(html.indexOf("chip--primary")).toBeLessThan(html.indexOf("Squat"));
  });

  it("escapes a typed exercise name instead of putting it in the page raw", () => {
    const app = loadApp();
    const html = app.personalBestsCard(app.personalBests([
      session("2026-09-01", "<img src=x onerror=1>", [{ weight: 20, reps: 5 }]),
    ]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("says what to do instead of showing an empty list", () => {
    const app = loadApp();
    const html = app.personalBestsCard([]);
    expect(html).toContain("Personal bests");
    expect(html).toContain("your best ever shows up here");
    expect(html).not.toContain("exercise-line");
  });
});
