import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-planreview.test.ts: `applyDraft` is pure -- a plan and
// the coach's days in, a new plan out -- so no DOM node is touched here.
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
  vm.runInContext(APP_SOURCE + "\n;globalThis.applyDraft = applyDraft;globalThis.draftPreview = draftPreview;globalThis.draftCard = draftCard;", ctx);
  return ctx;
}

const PLAN = {
  blockName: "Hypertrophy Block — Week 5",
  phase: "Build",
  days: [
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench Press", sets: 4, reps: 8 }] },
    { day: "Tuesday", focus: "Pull", exercises: [{ name: "Deadlift", sets: 3, reps: 5 }], cardio: { activity: "Run", minutes: 30 } },
    { day: "Wednesday", focus: "Rest", exercises: [] },
  ],
};

describe("applyDraft", () => {
  it("puts the drafted focus and exercises on the day it names", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [
      { day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] },
    ]);
    const monday = next.days.find((d: any) => d.day === "Monday");
    expect(monday.focus).toBe("Legs");
    expect(monday.exercises).toEqual([{ name: "Back Squat", sets: 5, reps: 5 }]);
  });

  it("makes a day the draft left out into a rest day, so the week means the whole week", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    const tuesday = next.days.find((d: any) => d.day === "Tuesday");
    expect(tuesday.focus).toBe("Rest");
    expect(tuesday.exercises).toEqual([]);
  });

  it("keeps cardio Edvard put there himself, on a drafted day and on a cleared one", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [
      { day: "Tuesday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] },
    ]);
    expect(next.days.find((d: any) => d.day === "Tuesday").cardio).toEqual({ activity: "Run", minutes: 30 });

    const cleared = app.applyDraft(PLAN, [{ day: "Monday", focus: "Push", exercises: [] }]);
    expect(cleared.days.find((d: any) => d.day === "Tuesday").cardio).toEqual({ activity: "Run", minutes: 30 });
  });

  it("ignores a drafted day the plan does not have, rather than growing the week", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [{ day: "Sunday", focus: "Legs", exercises: [] }]);
    expect(next.days.map((d: any) => d.day)).toEqual(["Monday", "Tuesday", "Wednesday"]);
  });

  it("does not mutate the plan it was given", () => {
    const app = loadApp();
    const before = JSON.stringify(PLAN);
    app.applyDraft(PLAN, [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] }]);
    expect(JSON.stringify(PLAN)).toBe(before);
  });

  it("keeps the block name and the phase, which the coach was not asked about", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    expect(next.blockName).toBe(PLAN.blockName);
    expect(next.phase).toBe("Build");
  });

  it("copies only the three fields an exercise has, so nothing the coach invented lands in the plan", () => {
    const app = loadApp();
    const next = app.applyDraft(PLAN, [
      { day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 100, note: "hi" }] },
    ]);
    expect(Object.keys(next.days[0].exercises[0]).sort()).toEqual(["name", "reps", "sets"]);
  });
});


// The preview is what Edvard agrees to, so it has to be the week that accepting
// produces -- not the subset of days the coach happened to name.
describe("draftPreview", () => {
  it("returns a row for every day of the plan, not only the days the coach named", () => {
    const app = loadApp();
    const rows = app.draftPreview(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    expect(rows.map((r: any) => r.day)).toEqual(["Monday", "Tuesday", "Wednesday"]);
  });

  it("marks a day with exercises that the coach left out as cleared", () => {
    const app = loadApp();
    const rows = app.draftPreview(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    const tuesday = rows.find((r: any) => r.day === "Tuesday");
    expect(tuesday.change).toBe("cleared");
    expect(tuesday.focus).toBe("Rest");
    expect(tuesday.exercises).toEqual([]);
  });

  it("does not call a day cleared when it had nothing on it to clear", () => {
    const app = loadApp();
    const rows = app.draftPreview(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    expect(rows.find((r: any) => r.day === "Wednesday").change).toBe("rest");
  });

  it("marks a day the coach named as drafted, and shows what he wrote on it", () => {
    const app = loadApp();
    const rows = app.draftPreview(PLAN, [
      { day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] },
    ]);
    const monday = rows.find((r: any) => r.day === "Monday");
    expect(monday.change).toBe("drafted");
    expect(monday.focus).toBe("Legs");
    expect(monday.exercises).toEqual([{ name: "Back Squat", sets: 5, reps: 5 }]);
  });

  it("shows the cardio that survives, on a drafted day and on a cleared one", () => {
    const app = loadApp();
    const rows = app.draftPreview(PLAN, [{ day: "Monday", focus: "Legs", exercises: [] }]);
    expect(rows.find((r: any) => r.day === "Tuesday").cardio).toEqual({ activity: "Run", minutes: 30 });
    const drafted = app.draftPreview(PLAN, [{ day: "Tuesday", focus: "Legs", exercises: [] }]);
    expect(drafted.find((r: any) => r.day === "Tuesday").cardio).toEqual({ activity: "Run", minutes: 30 });
  });

  it("agrees with applyDraft on every field it shows, because it is built from it", () => {
    const app = loadApp();
    const days = [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] }];
    const applied = app.applyDraft(PLAN, days).days;
    const rows = app.draftPreview(PLAN, days);
    rows.forEach((r: any, i: number) => {
      const { change, ...rest } = r;
      expect(rest).toEqual(applied[i]);
    });
  });

  it("does not mutate the plan it was given", () => {
    const app = loadApp();
    const before = JSON.stringify(PLAN);
    app.draftPreview(PLAN, [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] }]);
    expect(JSON.stringify(PLAN)).toBe(before);
  });
});

// The card is the only thing Edvard actually sees, and the defect this replaces
// was in the markup rather than in the arithmetic, so it is asserted directly.
describe("draftCard", () => {
  const DRAFT = { note: "easier week", days: [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 5 }] }] };

  it("is empty when there is no draft to show", () => {
    const app = loadApp();
    expect(app.draftCard(PLAN, null)).toBe("");
  });

  it("names every day of the plan, including the ones the coach left out", () => {
    const app = loadApp();
    const html = app.draftCard(PLAN, DRAFT);
    expect(html).toContain("Monday");
    expect(html).toContain("Tuesday");
    expect(html).toContain("Wednesday");
  });

  it("says on a cleared day that what is on it now goes", () => {
    const app = loadApp();
    const html = app.draftCard(PLAN, DRAFT);
    expect(html).toContain("Marcus left this day out, so what is on it now goes");
    expect(html).not.toContain("Deadlift");
  });

  it("does not label a day that was already a rest day as cleared", () => {
    const app = loadApp();
    const restOnly = { note: "", days: [{ day: "Monday", focus: "Legs", exercises: [] }, { day: "Tuesday", focus: "Pull", exercises: [{ name: "Deadlift", sets: 3, reps: 5 }] }] };
    const html = app.draftCard(PLAN, restOnly);
    expect(html).not.toContain("Marcus left this day out");
  });

  it("shows the cardio that survives the draft", () => {
    const app = loadApp();
    expect(app.draftCard(PLAN, DRAFT)).toContain("Run");
  });

  it("escapes what the coach wrote rather than rendering it", () => {
    const app = loadApp();
    const nasty = { note: "<img src=x>", days: [{ day: "Monday", focus: "<b>Legs</b>", exercises: [] }] };
    const html = app.draftCard(PLAN, nasty);
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>Legs</b>");
    expect(html).toContain("&lt;b&gt;Legs&lt;/b&gt;");
  });
});
