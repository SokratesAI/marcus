import { renderApp } from "./app-dom.js";
import { describe, it, expect } from "vitest";

// The notice is rendered markup rather than wired listeners, so this uses the
// jsdom harness and reads `#view` back. The app's `const` declarations do not
// land on `window` -- the source is run through an indirect eval, so only `var`
// and function declarations become properties -- so `store` is unreachable by
// name from here and the store is read through the localStorage it writes to,
// under the same `marcus.` prefix `store.get` uses. The functions under test
// are declarations, so those come off `window` directly.
function load(seed: Record<string, unknown> = {}) {
  const app = renderApp("home", seed);
  const win: any = app.window;
  return {
    ...app,
    win,
    html: () => app.view.innerHTML as string,
    get: (key: string) => {
      const raw = win.localStorage.getItem("marcus." + key);
      return raw === null ? null : JSON.parse(raw);
    },
    set: (key: string, value: unknown) =>
      win.localStorage.setItem("marcus." + key, JSON.stringify(value)),
    count(key: string) {
      const rows = this.get(key);
      return Array.isArray(rows) ? rows.length : 0;
    },
  };
}

const SEEDED = ["sessions", "weights", "meals"];

describe("the demo data a new browser is seeded with", () => {
  it("records which stores seed() actually filled", () => {
    const app = load();
    expect(app.get("demoSeeded")).toEqual(SEEDED);
    app.close();
  });

  it("claims nothing in a browser that already held its own log", () => {
    // A returning browser takes none of seed()'s branches. The separating input
    // is `plan`: seed() keys every branch on its own store, so all four have to
    // be present for nothing to be written.
    const app = load({
      plan: {
        blockName: "mine",
        // Every weekday, because Home looks up today by name and this test has
        // to pass on whichever day it runs.
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
          .map(day => ({ day, focus: "Rest", exercises: [] })),
      },
      sessions: [],
      weights: [],
      meals: [],
      chat: [{ role: "marcus", text: "hi", ts: 1 }],
    });
    expect(app.get("demoSeeded")).toBe(null);
    expect(app.win.demoSeededSummary()).toEqual([]);
    app.close();
  });

  it("counts only the seeded stores that still hold records", () => {
    const app = load();
    app.set("weights", []);
    const summary = app.win.demoSeededSummary();
    expect(summary.map((s: any) => s.key)).toEqual(["sessions", "meals"]);
    expect(summary.every((s: any) => s.count > 0)).toBe(true);
    app.close();
  });

  it("stops claiming anything once every seeded store is empty", () => {
    const app = load();
    app.win.clearTrainingLog();
    expect(app.win.demoSeededSummary()).toEqual([]);
    app.close();
  });

  it("says so on Home, with the counts, above the plan", () => {
    const app = load();
    const html = app.html();
    expect(html).toContain("This is demo data");
    // The counts are the point: he confirms against what is there, never
    // against the word "demo".
    expect(html).toMatch(/filled this browser with \d+ sessions, \d+ bodyweights and \d+ meals/);
    // Above the plan card, or the first thing he reads is a plan he never chose.
    expect(html.indexOf("This is demo data")).toBeLessThan(html.indexOf("Today"));
    app.close();
  });

  it("is gone from Home once there is nothing seeded left", () => {
    const app = load();
    app.win.clearTrainingLog();
    app.win.renderHome();
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("asks before it deletes, and names the total", () => {
    const app = load();
    expect(app.html()).not.toContain("Are you sure?");
    const total = app.count("sessions") + app.count("weights") + app.count("meals");

    app.win.armClearDemo();
    expect(app.html()).toContain("Are you sure? This deletes " + total + " record(s)");
    expect(app.html()).toContain("Delete all of it");
    // Arming must not delete anything on its own.
    expect(app.count("sessions")).toBeGreaterThan(0);
    app.close();
  });

  it("leaving Home disarms the confirm", () => {
    // An armed card left live across a tab switch is a Delete-all-of-it under
    // his thumb on a screen he did not arm.
    const app = load();
    app.win.armClearDemo();
    expect(app.html()).toContain("Are you sure?");
    app.win.switchTab("plan");
    app.win.switchTab("home");
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).not.toContain("Are you sure?");
    app.close();
  });

  it("cancelling leaves the records and the notice both standing", () => {
    const app = load();
    app.win.armClearDemo();
    app.win.cancelClearDemo();
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).not.toContain("Are you sure?");
    expect(app.count("sessions")).toBeGreaterThan(0);
    expect(app.get("demoSeeded")).toEqual(SEEDED);
    app.close();
  });

  it("clearing empties exactly the seeded stores and writes tombstones", () => {
    const app = load();
    const sessions = app.count("sessions");
    const plan = app.get("plan");
    app.win.armClearDemo();
    app.win.clearDemoData();

    expect(app.get("sessions")).toEqual([]);
    expect(app.get("weights")).toEqual([]);
    expect(app.get("meals")).toEqual([]);
    // The plan is a template, not a record of a workout, and seed() rewrites it
    // the moment it is falsy -- clearing it would put the demo block straight back.
    expect(app.get("plan")).toEqual(plan);
    // Without tombstones the other phone merges every cleared session back.
    expect((app.get("deletions") || []).filter((d: any) => d.store === "sessions").length).toBe(sessions);
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("clears only what was seeded, so a real goal logged since survives", () => {
    // The separating input: a goal the user actually set, in a store that is in
    // LOGGED_STORES but was never seeded. Clearing the whole logged set would
    // take it, and a fresh browser has no goals, so nothing else notices.
    const app = load();
    app.set("goals", [{ id: "g1", text: "Olympic triathlon next August", targetDate: "2027-08-14", milestones: [] }]);
    app.win.clearDemoData();
    expect(app.get("goals")).toEqual([{ id: "g1", text: "Olympic triathlon next August", targetDate: "2027-08-14", milestones: [] }]);
    expect(app.get("sessions")).toEqual([]);
    app.close();
  });

  it("keeping it answers the question for good, without deleting anything", () => {
    const app = load();
    const sessions = app.count("sessions");
    app.win.keepDemoData();

    expect(app.count("sessions")).toBe(sessions);
    expect(app.get("demoSeeded")).toEqual([]);
    expect(app.win.demoSeededSummary()).toEqual([]);
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("restoring a backup file drops the claim -- those records are his", () => {
    const app = load();
    app.win.restoreBackup({ data: { sessions: [{ id: "real-1", date: "2026-09-12", day: "Friday", exercises: [] }] } });
    expect(app.get("demoSeeded")).toEqual([]);
    app.win.renderHome();
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("adopting the server copy drops the claim, so real history is not called demo", () => {
    const app = load();
    expect(app.get("demoSeeded")).toEqual(SEEDED);

    const adopted = app.win.adoptServerCopy({
      rev: 7,
      updatedAt: "2026-09-13T06:03:00.000Z",
      data: {
        plan: app.get("plan"),
        sessions: [{ id: "real-1", date: "2026-09-12", day: "Friday", exercises: [] }],
        weights: [],
        meals: [],
      },
    });

    expect(adopted && adopted.ok).toBe(true);
    expect(app.get("demoSeeded")).toEqual([]);
    app.win.renderHome();
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });
});
