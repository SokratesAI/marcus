import { APP_SOURCE } from "./app-source.js";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-planreview.test.ts. Everything under test here is pure:
// a plan and a goal in, a proposal or a new plan out. No DOM node is touched.
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
      "\n;globalThis.DELOAD_SET_FLOOR = DELOAD_SET_FLOOR;" +
      "\n;globalThis.PLAN_DEFAULT_PHASE = PLAN_DEFAULT_PHASE;",
    ctx,
  );
  return ctx;
}

const TODAY = "2026-09-01";

// 4 + 3 + 4 = 11 sets across two training days.
const plan = (phase?: string) => {
  const p: any = {
    blockName: "Block",
    days: [
      { day: "Sunday", focus: "Rest", exercises: [] },
      { day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 4, reps: 8 }, { name: "Dip", sets: 3, reps: 10 }] },
      { day: "Tuesday", focus: "Rest", exercises: [] },
      { day: "Wednesday", focus: "Rest", exercises: [] },
      { day: "Thursday", focus: "Legs", exercises: [{ name: "Squat", sets: 4, reps: 6 }] },
      { day: "Friday", focus: "Rest", exercises: [] },
      { day: "Saturday", focus: "Rest", exercises: [] },
    ],
  };
  if (phase) p.phase = phase;
  return p;
};

// currentPhase() takes the first milestone whose date has not passed, so putting
// every earlier phase in the past is how a goal is placed inside a given phase.
const goalIn = (label: string) => {
  const order = ["Base", "Build", "Peak", "Taper"];
  const i = order.indexOf(label);
  return {
    id: "g", text: "Race", created: "2026-01-01", targetDate: "2026-12-31",
    milestones: order.map((l, n) => ({
      id: "m" + n, label: l, note: "", done: false,
      date: n < i ? "2026-08-0" + (n + 1) : "2026-1" + n + "-01",
    })),
  };
};

describe("the written week tracks the goal's phase", () => {
  it("proposes nothing when there is no goal at all", () => {
    const app = loadApp();
    expect(app.phaseProposal(plan(), null, TODAY)).toBe(null);
  });

  it("reads a plan with no phase recorded as a Build week", () => {
    const app = loadApp();
    expect(app.PLAN_DEFAULT_PHASE).toBe("Build");
    // Build against Build is the same week, so there is nothing to say.
    expect(app.phaseProposal(plan(), goalIn("Build"), TODAY)).toBe(null);
  });

  it("sizes an 11-set week down by 4 sets for a Taper phase", () => {
    const app = loadApp();
    const p = app.phaseProposal(plan(), goalIn("Taper"), TODAY);
    expect(p.kind).toBe("phase");
    expect(p.phase).toBe("Taper");
    // 11 * (0.60 / 1.00) = 6.6 -> 7 sets, so 4 come off.
    expect(p.setDelta).toBe(-4);
    expect(p.reason).toContain("11 sets");
    expect(p.reason).toContain("60%");
  });

  it("sizes the same week up for a Base phase", () => {
    const app = loadApp();
    // 11 * 1.10 = 12.1 -> 12 sets, so one goes on.
    expect(app.phaseProposal(plan(), goalIn("Base"), TODAY).setDelta).toBe(1);
  });

  it("says nothing when the phase ratio rounds to zero sets", () => {
    const app = loadApp();
    const small = plan();
    small.days = [{ day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 3, reps: 8 }] }];
    // 3 * 0.90 = 2.7 -> 3 sets. A button that changes nothing is worse than silence.
    expect(app.phaseProposal(small, goalIn("Peak"), TODAY)).toBe(null);
  });

  it("takes the sets off the heaviest exercises and records the phase", () => {
    const app = loadApp();
    const p = app.phaseProposal(plan(), goalIn("Taper"), TODAY);
    const next = app.applyProposal(plan(), p);
    const sets = next.days.flatMap((d: any) => (d.exercises || []).map((e: any) => e.sets));
    expect(sets.reduce((a: number, b: number) => a + b, 0)).toBe(7);
    // 4/3/4 loses one from Bench, one from Squat, then one each from Bench and
    // Dip once all three are level -- a tie goes to the first in plan order, so
    // Squat keeps the third set rather than the week losing breadth anywhere.
    expect(next.days.find((d: any) => d.day === "Monday").exercises.map((e: any) => e.sets)).toEqual([2, 2]);
    expect(next.days.find((d: any) => d.day === "Thursday").exercises.map((e: any) => e.sets)).toEqual([3]);
    expect(next.phase).toBe("Taper");
  });

  it("cuts the heaviest exercise rather than the lightest", () => {
    const app = loadApp();
    // 6 and 3 sets, Base sized down to Peak: 9 * (0.90 / 1.10) = 7.4 -> 7, two off.
    // The numbers matter -- on an evenly-set week, taking from the heaviest and
    // taking from the lightest land on the same plan, so a test written there
    // passes whichever rule the code uses.
    const lopsided = plan("Base");
    lopsided.days = [{ day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 6, reps: 8 }, { name: "Dip", sets: 3, reps: 8 }] }];
    const p = app.phaseProposal(lopsided, goalIn("Peak"), TODAY);
    expect(p.setDelta).toBe(-2);
    const next = app.applyProposal(lopsided, p);
    expect(next.days[0].exercises.map((e: any) => e.sets)).toEqual([4, 3]);
  });

  it("never cuts an exercise below the deload floor, and still records the phase", () => {
    const app = loadApp();
    const floored = plan();
    floored.days = [{ day: "Monday", focus: "Push", exercises: [{ name: "Bench", sets: 2, reps: 8 }, { name: "Dip", sets: 2, reps: 8 }] }];
    // 4 * 0.60 = 2.4 -> 2 sets, so it wants two off and both exercises are at the floor.
    // Both exercises are already at the floor, so there is no set to move and
    // the proposal is withheld rather than promising two.
    expect(app.phaseProposal(floored, goalIn("Taper"), TODAY)).toBe(null);
  });

  it("headlines only the sets the floor actually lets it move", () => {
    const app = loadApp();
    const tight = plan();
    // Three exercises at 3 sets = 9. Taper wants 9 * 0.60 = 5.4 -> 5, so four off.
    // The floor leaves room for only three, so the headline has to say three.
    tight.days = [{ day: "Monday", focus: "Push", exercises: [
      { name: "Bench", sets: 3, reps: 8 }, { name: "Dip", sets: 3, reps: 8 }, { name: "Row", sets: 3, reps: 8 },
    ] }];
    const p = app.phaseProposal(tight, goalIn("Taper"), TODAY);
    expect(p.setDelta).toBe(-3);
    expect(p.title).toBe("Take 3 sets off the week for the Taper phase");
    const next = app.applyProposal(tight, p);
    expect(next.days[0].exercises.map((e: any) => e.sets)).toEqual([2, 2, 2]);
    expect(next.phase).toBe("Taper");
  });

  it("adds sets to the lightest exercise first", () => {
    const app = loadApp();
    const p = app.phaseProposal(plan(), goalIn("Base"), TODAY);
    const next = app.applyProposal(plan(), p);
    // Dip is the lightest at 3, so the one added set goes there.
    expect(next.days.find((d: any) => d.day === "Monday").exercises.map((e: any) => e.sets)).toEqual([4, 4]);
    expect(next.phase).toBe("Base");
  });

  it("stops proposing once the plan has been sized for that phase", () => {
    const app = loadApp();
    const p = app.phaseProposal(plan(), goalIn("Taper"), TODAY);
    const next = app.applyProposal(plan(), p);
    expect(app.phaseProposal(next, goalIn("Taper"), TODAY)).toBe(null);
  });

  it("offers the phase change before two weeks of sessions exist", () => {
    const app = loadApp();
    // This is the whole point of hoisting it above the REVIEW_MIN_WEEKS gate: a
    // brand-new goal must not stare at a week written for a phase it is not in.
    const review = app.planReview(plan(), [], TODAY, undefined, goalIn("Taper"));
    expect(review.weeks).toBe(0);
    expect(review.proposals.map((x: any) => x.kind)).toEqual(["phase"]);
  });

  it("still reports no proposals with no goal and no history", () => {
    const app = loadApp();
    const review = app.planReview(plan(), [], TODAY, undefined, null);
    expect(review.proposals).toEqual([]);
    expect(review.note).toContain("2 weeks of sessions logged");
  });

  it("puts the phase proposal first when other proposals exist", () => {
    const app = loadApp();
    // Two weeks of Monday-only sessions: Thursday is planned and never trained,
    // which is the existing 'drop a day' proposal.
    const sessions: any[] = [];
    for (let d = 0; d < 21; d++) {
      const iso = new Date(new Date(TODAY + "T00:00:00Z").getTime() - d * 86400000).toISOString().slice(0, 10);
      if (new Date(iso + "T00:00:00Z").getUTCDay() === 1) sessions.push({ id: iso, date: iso, exercises: [{ name: "Squat", sets: [{ reps: 5, weight: 100 }] }] });
    }
    const review = app.planReview(plan(), sessions, TODAY, undefined, goalIn("Taper"));
    expect(review.proposals[0].kind).toBe("phase");
    expect(review.proposals.length).toBeGreaterThan(1);
  });
});
