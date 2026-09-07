import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-personalbest.test.ts. weeklyMuscleSets takes plain
// values and returns a plain object; muscleBalanceCard returns a string, so no
// DOM node is touched here either.
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
      "\n;globalThis.weeklyMuscleSets = weeklyMuscleSets;" +
      "\n;globalThis.muscleGroupFor = muscleGroupFor;" +
      "\n;globalThis.muscleSetVerdict = muscleSetVerdict;" +
      "\n;globalThis.muscleBalanceCard = muscleBalanceCard;" +
      "\n;globalThis.MUSCLE_GROUPS = MUSCLE_GROUPS;" +
      "\n;globalThis.FORM_GUIDE = FORM_GUIDE;" +
      "\n;globalThis.seededPlan = store.get('plan');",
    ctx,
  );
  return ctx;
}

const session = (date: string, name: string, sets: any[]) => ({
  date, day: "Push", exercises: [{ name, sets }],
});


// A session as the app really stores it: `kind` absent means strength.
const day = (date: string, exercises: any[]) => ({ date, day: "Push", exercises });
const ex = (name: string, count: number, reps = 8) => ({
  name,
  sets: Array.from({ length: count }, () => ({ weight: 60, reps })),
});

describe("muscleGroupFor", () => {
  it("reads the group off the form-guide entry, including its alternate spellings", () => {
    const app = loadApp();
    expect(app.muscleGroupFor("Barbell Bench Press")).toBe("Chest");
    expect(app.muscleGroupFor("bench press")).toBe("Chest");
    expect(app.muscleGroupFor("  FLAT BENCH PRESS ")).toBe("Chest");
  });

  it("counts the conventional deadlift as back and the Romanian as legs", () => {
    const app = loadApp();
    expect(app.muscleGroupFor("Deadlift")).toBe("Back");
    expect(app.muscleGroupFor("RDL")).toBe("Legs");
  });

  it("returns null for a lift no table has heard of, rather than guessing", () => {
    const app = loadApp();
    expect(app.muscleGroupFor("Zercher Carry")).toBeNull();
    expect(app.muscleGroupFor("")).toBeNull();
  });

  // Rowing Erg is in the form guide because it has form cues; it is cardio and
  // trains no one group, so it carries `group: null` explicitly. That is a
  // different thing from a lift somebody forgot to tag, which is what the next
  // test is here to catch.
  it("gives every strength lift in the form guide a group in MUSCLE_GROUPS", () => {
    const app = loadApp();
    const untagged = app.FORM_GUIDE.filter(
      (e: any) => e.group === undefined,
    ).map((e: any) => e.name);
    expect(untagged).toEqual([]);
    const bad = app.FORM_GUIDE.filter(
      (e: any) => e.group !== null && app.MUSCLE_GROUPS.indexOf(e.group) === -1,
    ).map((e: any) => e.name);
    expect(bad).toEqual([]);
    expect(app.FORM_GUIDE.filter((e: any) => e.group === null)).toHaveLength(1);
  });

  // The same coverage assertion app-formguide.test.ts makes, one field along:
  // a nineteenth exercise added to the seeded plan and tagged with no group
  // would sit in "not counted" on the card forever without failing anything.
  it("covers every strength exercise the seeded plan names", () => {
    const app = loadApp();
    const planned: string[] = [];
    for (const d of app.seededPlan.days || []) {
      for (const e of d.exercises || []) planned.push(e.name);
    }
    expect(planned.length).toBeGreaterThan(10);
    const missing = planned.filter(
      (name) => app.muscleGroupFor(name) === null && app.formGuide(name)?.group !== null,
    );
    expect(missing).toEqual([]);
  });
});

describe("muscleSetVerdict", () => {
  it("says none at zero and low below the minimum, which are different sentences", () => {
    const app = loadApp();
    expect(app.muscleSetVerdict(0)).toBe("none");
    expect(app.muscleSetVerdict(1)).toBe("low");
    expect(app.muscleSetVerdict(9)).toBe("low");
  });

  it("puts both ends of the range inside on target", () => {
    const app = loadApp();
    expect(app.muscleSetVerdict(10)).toBe("on target");
    expect(app.muscleSetVerdict(20)).toBe("on target");
    expect(app.muscleSetVerdict(21)).toBe("high");
  });
});

describe("weeklyMuscleSets", () => {
  it("counts hard sets per group, not kilograms", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [day("2026-09-05", [ex("Bench Press", 4), ex("Back Squat", 3)])],
      "2026-09-07",
    );
    const by: Record<string, number> = {};
    out.groups.forEach((g: any) => { by[g.group] = g.sets; });
    expect(by.Chest).toBe(4);
    expect(by.Legs).toBe(3);
    expect(by.Back).toBe(0);
  });

  it("returns every group including the ones at zero — the empty row is the finding", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets([day("2026-09-07", [ex("Bench Press", 4)])], "2026-09-07");
    expect(out.groups.map((g: any) => g.group)).toEqual(app.MUSCLE_GROUPS);
    expect(out.groups.find((g: any) => g.group === "Arms").verdict).toBe("none");
  });

  it("adds up the same group across different lifts and different days", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [
        day("2026-09-02", [ex("Barbell Row", 4)]),
        day("2026-09-05", [ex("Lat Pulldown", 3), ex("Pull-ups", 2)]),
      ],
      "2026-09-07",
    );
    expect(out.groups.find((g: any) => g.group === "Back").sets).toBe(9);
  });

  it("uses a trailing window ending today, inclusive at both ends", () => {
    const app = loadApp();
    const sessions = [
      day("2026-09-01", [ex("Bench Press", 5)]),
      day("2026-09-07", [ex("Bench Press", 2)]),
    ];
    const out = app.weeklyMuscleSets(sessions, "2026-09-07");
    expect(out.from).toBe("2026-09-01");
    expect(out.to).toBe("2026-09-07");
    expect(out.groups.find((g: any) => g.group === "Chest").sets).toBe(7);
  });

  it("drops a session one day outside the window", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [day("2026-08-31", [ex("Bench Press", 5)])],
      "2026-09-07",
    );
    expect(out.groups.find((g: any) => g.group === "Chest").sets).toBe(0);
  });

  it("drops a session dated in the future", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [day("2026-09-09", [ex("Bench Press", 5)])],
      "2026-09-07",
    );
    expect(out.groups.find((g: any) => g.group === "Chest").sets).toBe(0);
  });

  it("honours a window other than seven days", () => {
    const app = loadApp();
    const sessions = [
      day("2026-09-01", [ex("Bench Press", 5)]),
      day("2026-09-07", [ex("Bench Press", 2)]),
    ];
    expect(app.weeklyMuscleSets(sessions, "2026-09-07", 3).groups
      .find((g: any) => g.group === "Chest").sets).toBe(2);
    expect(app.weeklyMuscleSets(sessions, "2026-09-07", 3).days).toBe(3);
  });

  // A pull-up is stored at 0 kg. Requiring a weight would report a back day of
  // pull-ups as no back work at all.
  it("counts a bodyweight set, and skips a set with no rep count", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [day("2026-09-07", [
        { name: "Pull-ups", sets: [{ weight: 0, reps: 8 }, { weight: 0, reps: 6 }] },
        { name: "Lat Pulldown", sets: [{ weight: 50 }, { weight: 50, reps: 0 }] },
      ])],
      "2026-09-07",
    );
    expect(out.groups.find((g: any) => g.group === "Back").sets).toBe(2);
  });

  it("ignores a cardio session even when it carries an exercise row", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [{ ...day("2026-09-07", [ex("Bench Press", 4)]), kind: "cardio" }],
      "2026-09-07",
    );
    expect(out.groups.find((g: any) => g.group === "Chest").sets).toBe(0);
  });

  it("names a lift it cannot place instead of dropping it silently", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [day("2026-09-07", [ex("Zercher Carry", 3), ex("Bench Press", 2)])],
      "2026-09-07",
    );
    expect(out.unmatched).toEqual(["Zercher Carry"]);
    expect(out.groups.find((g: any) => g.group === "Chest").sets).toBe(2);
  });

  it("lists an unplaceable lift once however many times it was logged", () => {
    const app = loadApp();
    const out = app.weeklyMuscleSets(
      [
        day("2026-09-05", [ex("Zercher Carry", 3)]),
        day("2026-09-07", [ex("zercher carry", 3)]),
      ],
      "2026-09-07",
    );
    expect(out.unmatched).toHaveLength(1);
  });

  it("survives a malformed session list", () => {
    const app = loadApp();
    expect(app.weeklyMuscleSets(null, "2026-09-07").groups).toHaveLength(5);
    const out = app.weeklyMuscleSets(
      [null, {}, { date: "2026-09-07" }, day("2026-09-07", [null, { name: "" }])],
      "2026-09-07",
    );
    expect(out.groups.every((g: any) => g.sets === 0)).toBe(true);
    expect(out.unmatched).toEqual([]);
  });
});

describe("muscleBalanceCard", () => {
  it("renders a row per group with its count and verdict", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Bench Press", 12)])], "2026-09-07"),
    );
    expect(html).toContain("Weekly balance");
    expect(html).toContain("12 sets");
    expect(html).toContain("on target");
    expect(html).toContain("none");
    expect(html).toContain("mg-bar");
  });

  it("says one set rather than 1 sets", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Bench Press", 1)])], "2026-09-07"),
    );
    expect(html).toContain("1 set ");
    expect(html).not.toContain("1 sets");
  });

  it("caps the bar at the top of the range rather than overflowing the card", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Bench Press", 40)])], "2026-09-07"),
    );
    // 40 sets against a 20-set top is 200% uncapped, which is the number the
    // Math.min exists to stop.
    expect(html).toContain("width:100%");
    expect(html).not.toContain("width:200%");
  });

  it("shows an empty state when nothing was logged in the window", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(app.weeklyMuscleSets([], "2026-09-07"));
    expect(html).toContain("Log a set in the last 7 days");
    expect(html).not.toContain("mg-bar");
  });

  it("names the unplaceable lifts in the card, and says nothing when there are none", () => {
    const app = loadApp();
    const withOne = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Zercher Carry", 3), ex("Bench Press", 2)])], "2026-09-07"),
    );
    expect(withOne).toContain("Zercher Carry");
    expect(withOne).toContain("Not counted");
    const without = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Bench Press", 2)])], "2026-09-07"),
    );
    expect(without).not.toContain("Not counted");
  });

  // The empty state used to fire here: every group was zero, so `any` was
  // false, and a session made entirely of lifts Marcus cannot place rendered
  // "log a set" at somebody who had just logged three.
  it("shows the unplaceable lifts rather than the empty state when that is all there is", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("Zercher Carry", 3)])], "2026-09-07"),
    );
    expect(html).toContain("Zercher Carry");
    expect(html).not.toContain("Log a set in the last");
  });

  it("escapes a lift name before putting it in the card", () => {
    const app = loadApp();
    const html = app.muscleBalanceCard(
      app.weeklyMuscleSets([day("2026-09-07", [ex("<img src=x onerror=1>", 3)])], "2026-09-07"),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
