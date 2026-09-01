import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same vm shape as app-planreview.test.ts. weekTarget takes a goal, a plan and
// a list of sessions and returns an object -- no DOM node is touched.
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
      "\n;globalThis.PHASE_VOLUME = PHASE_VOLUME;" +
      "\n;globalThis.WEEK_MIN_BASELINE_WEEKS = WEEK_MIN_BASELINE_WEEKS;" +
      "\n;globalThis.WEEK_BASELINE_WEEKS = WEEK_BASELINE_WEEKS;",
    ctx,
  );
  return ctx;
}

const DAY = 86400000;
const TODAY = "2026-09-01";                        // a Tuesday
const MONDAY = "2026-08-31";                       // the Monday of TODAY's week
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);

const sess = (date: string, kg: number) => ({ id: date + "-" + kg, date, exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }] });
const cardio = (date: string) => ({ id: "c" + date, date, kind: "cardio", activity: "Run", minutes: 45 });

const plan = () => ({
  blockName: "Block",
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }] },
    { day: "Tuesday", focus: "Rest", exercises: [] },
    { day: "Wednesday", focus: "Pull", exercises: [{ name: "Row", sets: 4, reps: 8 }] },
    { day: "Thursday", focus: "Rest", exercises: [] },
    { day: "Friday", focus: "Legs", exercises: [{ name: "Squat", sets: 4, reps: 6 }] },
    { day: "Saturday", focus: "Rest", exercises: [] },
  ],
});

// A goal whose current phase is whatever label the test asks for: one milestone
// already past, and the named one ending a fortnight out.
const goalIn = (label: string) => ({
  id: "g1", text: "Meet", targetDate: ago(-90), created: ago(60),
  milestones: [
    { id: "m0", label: "Base", note: "", date: ago(1), done: false },
    { id: "m1", label, note: "", date: ago(-14), done: false },
  ],
});

// Four full weeks before this one, 1000 kg in each.
const fourWeeks = () => [8, 15, 22, 29].map((n) => sess(ago(n), 1000));

describe("weekTarget", () => {
  it("sizes the week from the phase multiplier and the user's own average", () => {
    const app = loadApp();
    const w = app.weekTarget(goalIn("Base"), plan(), fourWeeks(), TODAY);
    expect(w.phase).toBe("Base");
    expect(w.baselineWeeks).toBe(4);
    expect(w.baseline).toBe(1000);
    expect(w.volumeTarget).toBe(1100);          // Base grows by 10%
    expect(w.reason).toBe("ok");
  });

  it("cuts the target in a Taper and holds it in a Build", () => {
    const app = loadApp();
    expect(app.weekTarget(goalIn("Taper"), plan(), fourWeeks(), TODAY).volumeTarget).toBe(600);
    expect(app.weekTarget(goalIn("Build"), plan(), fourWeeks(), TODAY).volumeTarget).toBe(1000);
    expect(app.weekTarget(goalIn("Peak"), plan(), fourWeeks(), TODAY).volumeTarget).toBe(900);
  });

  it("counts a week with nothing logged in it as a real zero", () => {
    const app = loadApp();
    // Same four weeks, but the two most recent are empty. Dropping them would
    // leave the average at 1000; including them halves it.
    const w = app.weekTarget(goalIn("Build"), plan(), [sess(ago(22), 1000), sess(ago(29), 1000)], TODAY);
    expect(w.baselineWeeks).toBe(4);
    expect(w.baseline).toBe(500);
    expect(w.volumeTarget).toBe(500);
  });

  it("does not count weeks before the first session ever logged", () => {
    const app = loadApp();
    const w = app.weekTarget(goalIn("Build"), plan(), [sess(ago(8), 900), sess(ago(15), 700)], TODAY);
    expect(w.baselineWeeks).toBe(2);
    expect(w.baseline).toBe(800);
  });

  it("refuses a kilogram target under two full weeks of history", () => {
    const app = loadApp();
    const w = app.weekTarget(goalIn("Base"), plan(), [sess(ago(8), 1000)], TODAY);
    expect(w.reason).toBe("too early");
    expect(w.baselineWeeks).toBe(1);
    expect(w.volumeTarget).toBeNull();
    expect(w.baseline).toBeNull();
    expect(w.note).toContain("2 full weeks");
    // The session count does not depend on history, so it is still there.
    expect(w.sessionsPlanned).toBe(3);
  });

  it("says there is no phase rather than showing a card when there is no goal", () => {
    const app = loadApp();
    const w = app.weekTarget(null, plan(), fourWeeks(), TODAY);
    expect(w.phase).toBeNull();
    expect(w.reason).toBe("no goal");
    expect(w.volumeTarget).toBeNull();
  });

  it("says the phases are done when every phase date has passed", () => {
    const app = loadApp();
    const goal = { id: "g", text: "Meet", targetDate: ago(-3), created: ago(60),
                   milestones: [{ id: "m", label: "Taper", note: "", date: ago(2), done: false }] };
    const w = app.weekTarget(goal, plan(), fourWeeks(), TODAY);
    expect(w.reason).toBe("phases done");
    expect(w.phase).toBeNull();
  });

  it("reads the phase off the calendar, not off the tickbox", () => {
    const app = loadApp();
    // Base is ticked and still current by date; Taper is untouched and weeks
    // away. `find(m => !m.done)` would answer Taper here.
    const goal = { id: "g", text: "Meet", targetDate: ago(-40), created: ago(30),
                   milestones: [
                     { id: "m0", label: "Base", note: "", date: ago(-7), done: true },
                     { id: "m1", label: "Taper", note: "", date: ago(-40), done: false },
                   ] };
    expect(app.weekTarget(goal, plan(), fourWeeks(), TODAY).phase).toBe("Base");
  });

  it("counts this week's sessions and volume, with cardio worth zero kilograms", () => {
    const app = loadApp();
    const sessions = [...fourWeeks(), sess(MONDAY, 400), cardio(TODAY)];
    const w = app.weekTarget(goalIn("Base"), plan(), sessions, TODAY);
    expect(w.sessionsDone).toBe(2);
    expect(w.volumeDone).toBe(400);
    expect(w.sessionsPlanned).toBe(3);
  });

  it("does not count a session dated later this week as done yet", () => {
    const app = loadApp();
    // The card says how the week has gone so far. Today is Tuesday; a session
    // carrying Friday's date has not happened, and counting it would show
    // 2/3 sessions on a day only one was trained.
    const friday = "2026-09-04";
    const w = app.weekTarget(goalIn("Base"), plan(), [...fourWeeks(), sess(MONDAY, 400), sess(friday, 900)], TODAY);
    expect(w.sessionsDone).toBe(1);
    expect(w.volumeDone).toBe(400);
  });

  it("keeps this week's own sessions out of the baseline it is measured against", () => {
    const app = loadApp();
    // Four 1000 kg weeks behind, a huge one in progress. If the current week
    // fed the average, the target would chase whatever was just lifted.
    const w = app.weekTarget(goalIn("Build"), plan(), [...fourWeeks(), sess(MONDAY, 9000)], TODAY);
    expect(w.baseline).toBe(1000);
    expect(w.volumeTarget).toBe(1000);
    expect(w.volumeDone).toBe(9000);
  });

  it("leaves the volume rule out for a phase label it has no multiplier for", () => {
    const app = loadApp();
    const w = app.weekTarget(goalIn("Offseason"), plan(), fourWeeks(), TODAY);
    expect(w.reason).toBe("unknown phase");
    expect(w.multiplier).toBeNull();
    expect(w.volumeTarget).toBeNull();
    expect(w.sessionsPlanned).toBe(3);
  });
});

describe("weekTargetLabel", () => {
  it("spells the rule out in one sentence, with the direction as a word", () => {
    const app = loadApp();
    const label = app.weekTargetLabel(app.weekTarget(goalIn("Base"), plan(), fourWeeks(), TODAY));
    expect(label).toContain("Base phase");
    expect(label).toContain("last 4 weeks");
    expect(label).toContain("1000 kg");
    expect(label).toContain("10% above");
  });

  it("says level with rather than 0% above when the phase holds volume", () => {
    const app = loadApp();
    const label = app.weekTargetLabel(app.weekTarget(goalIn("Build"), plan(), fourWeeks(), TODAY));
    expect(label).toContain("level with");
    expect(label).not.toContain("0% above");
  });

  it("passes the refusal through instead of inventing a sentence", () => {
    const app = loadApp();
    const w = app.weekTarget(goalIn("Base"), plan(), [sess(ago(8), 1000)], TODAY);
    expect(app.weekTargetLabel(w)).toBe(w.note);
  });
});

describe("sessionVolume", () => {
  it("is zero for a cardio session rather than throwing", () => {
    const app = loadApp();
    expect(app.sessionVolume(cardio(TODAY))).toBe(0);
    expect(app.sessionVolume({ date: TODAY, exercises: [{ name: "Squat" }] })).toBe(0);
    expect(app.sessionVolume(null)).toBe(0);
  });
});
