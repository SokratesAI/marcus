import { renderApp, settle } from "./app-dom.js";
import { describe, it, expect } from "vitest";

// The notice is rendered markup rather than wired listeners, so this uses the
// jsdom harness and reads `#view` back. The app's `const` declarations do not
// land on `window` -- the source is run through an indirect eval, so only `var`
// and function declarations become properties -- so `store` is unreachable by
// name from here and the store is read through the localStorage it writes to,
// under the same `marcus.` prefix `store.get` uses. The functions under test
// are declarations, so those come off `window` directly.
async function load(seed: Record<string, unknown> = {}) {
  const app = renderApp("home", seed);
  await settle();
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
  it("records which stores seed() actually filled", async () => {
    const app = await load();
    expect(app.get("demoSeeded")).toEqual(SEEDED);
    app.close();
  });

  it("claims nothing in a browser that already held its own log", async () => {
    // A returning browser takes none of seed()'s branches. The separating input
    // is `plan`: seed() keys every branch on its own store, so all four have to
    // be present for nothing to be written.
    const app = await load({
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

  it("counts only the seeded stores that still hold records", async () => {
    const app = await load();
    app.set("weights", []);
    const summary = app.win.demoSeededSummary();
    expect(summary.map((s: any) => s.key)).toEqual(["sessions", "meals"]);
    expect(summary.every((s: any) => s.count > 0)).toBe(true);
    app.close();
  });

  it("stops claiming anything once every seeded store is empty", async () => {
    const app = await load();
    app.win.clearTrainingLog();
    expect(app.win.demoSeededSummary()).toEqual([]);
    app.close();
  });

  it("says so on Home, with the counts, above the plan", async () => {
    const app = await load();
    const html = app.html();
    expect(html).toContain("This is demo data");
    // The counts are the point: he confirms against what is there, never
    // against the word "demo".
    // The training week is on the list too. It is demo data as much as the rows
    // are and it is the largest thing on the screen -- Home's Today card is
    // nothing but this week -- and until now the card named everything except it.
    expect(html).toMatch(/filled this browser with \d+ sessions, \d+ bodyweights, \d+ meals and a training week/);
    // Above the plan card, or the first thing he reads is a plan he never chose.
    expect(html.indexOf("This is demo data")).toBeLessThan(html.indexOf("Today"));
    app.close();
  });

  it("still stands on the made-up week once every seeded row is gone", async () => {
    // Exactly where Edvard was at 08:03 on 2026-09-13: he had deleted all sixteen
    // demo sessions by hand and Home still drew a bench-press day for a man who
    // had told Marcus he runs and rides. The row counts were empty; the week was
    // not, and nothing on the screen said so.
    const app = await load();
    app.win.clearTrainingLog();
    app.win.renderHome();
    expect(app.win.demoSeededSummary()).toEqual([]);
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).toContain("a training week");
    app.close();
  });

  it("is gone from Home once the week is not the made-up one either", async () => {
    const app = await load();
    app.win.clearTrainingLog();
    // One exercise changed is enough: the claim is a comparison against the
    // template, not a stored flag some writer has to remember to clear.
    const plan = app.get("plan");
    plan.days[0].exercises[0].name = "Threshold intervals";
    app.set("plan", plan);
    app.win.renderHome();
    expect(app.win.planIsDemo()).toBe(false);
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("asks before it deletes, and names the total", async () => {
    const app = await load();
    expect(app.html()).not.toContain("Are you sure?");
    const total = app.count("sessions") + app.count("weights") + app.count("meals");

    app.win.armClearDemo();
    expect(app.html()).toContain("Are you sure? This deletes " + total + " record(s)");
    expect(app.html()).toContain("Delete all of it");
    // Arming must not delete anything on its own.
    expect(app.count("sessions")).toBeGreaterThan(0);
    app.close();
  });

  it("leaving Home disarms the confirm", async () => {
    // An armed card left live across a tab switch is a Delete-all-of-it under
    // his thumb on a screen he did not arm.
    const app = await load();
    app.win.armClearDemo();
    expect(app.html()).toContain("Are you sure?");
    app.win.switchTab("plan");
    app.win.switchTab("home");
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).not.toContain("Are you sure?");
    app.close();
  });

  it("cancelling leaves the records and the notice both standing", async () => {
    const app = await load();
    app.win.armClearDemo();
    app.win.cancelClearDemo();
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).not.toContain("Are you sure?");
    expect(app.count("sessions")).toBeGreaterThan(0);
    expect(app.get("demoSeeded")).toEqual(SEEDED);
    app.close();
  });

  it("clearing empties exactly the seeded stores and writes tombstones", async () => {
    const app = await load();
    const sessions = app.count("sessions");
    const plan = app.get("plan");
    app.win.armClearDemo();
    app.win.clearDemoData();

    expect(app.get("sessions")).toEqual([]);
    expect(app.get("weights")).toEqual([]);
    expect(app.get("meals")).toEqual([]);
    // The made-up week goes with the log. Emptied rather than deleted, because
    // Home reads `plan.days` and because seedShell rewrites a falsy plan on the
    // next boot, which would put the bodybuilding block straight back.
    expect(app.get("plan")).not.toEqual(plan);
    expect(app.get("plan").blockName).toBe("No plan yet");
    expect(app.get("plan").days.map((d: any) => d.day)).toEqual(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(app.get("plan").days.every((d: any) => d.exercises.length === 0)).toBe(true);
    // Without tombstones the other phone merges every cleared session back.
    expect((app.get("deletions") || []).filter((d: any) => d.store === "sessions").length).toBe(sessions);
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("says today is unplanned after the clear, not that it is a rest day", async () => {
    // Every day of the empty week is `Open`, and the Today card's only empty
    // state used to read "Rest day -- recovery is training too." for any day
    // with no exercises, which would call a plan he no longer has a recovery day.
    const app = await load();
    app.win.clearDemoData();
    expect(app.html()).toContain("Nothing planned for today yet.");
    expect(app.html()).not.toContain("recovery is training too");
    app.close();
  });

  it("clears only what was seeded, so a real goal logged since survives", async () => {
    // The separating input: a goal the user actually set, in a store that is in
    // LOGGED_STORES but was never seeded. Clearing the whole logged set would
    // take it, and a fresh browser has no goals, so nothing else notices.
    const app = await load();
    app.set("goals", [{ id: "g1", text: "Olympic triathlon next August", targetDate: "2027-08-14", milestones: [] }]);
    app.win.clearDemoData();
    expect(app.get("goals")).toEqual([{ id: "g1", text: "Olympic triathlon next August", targetDate: "2027-08-14", milestones: [] }]);
    expect(app.get("sessions")).toEqual([]);
    app.close();
  });

  it("keeping it answers the question for good, without deleting anything", async () => {
    const app = await load();
    const sessions = app.count("sessions");
    app.win.keepDemoData();

    expect(app.count("sessions")).toBe(sessions);
    expect(app.get("demoSeeded")).toEqual([]);
    expect(app.win.demoSeededSummary()).toEqual([]);
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("restoring a backup file drops the claim -- those records are his", async () => {
    const app = await load();
    app.win.restoreBackup({ data: { sessions: [{ id: "real-1", date: "2026-09-12", day: "Friday", exercises: [] }] } });
    expect(app.get("demoSeeded")).toEqual([]);
    app.win.renderHome();
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("adopting the server copy drops the claim, so real history is not called demo", async () => {
    const app = await load();
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
