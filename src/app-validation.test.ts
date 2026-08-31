import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect, beforeEach, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

interface Harness {
  ctx: any;
  toasts: string[];
  stored: Record<string, string>;
}

// app.js is a classic script, not a module: top-level `function` declarations
// land on the context's global object, which is how the tests reach them.
// It boots itself on load (switchTab('home')), so the DOM stub has to be real
// enough to render every tab, the same way sw.test.ts stubs a ServiceWorker.
function loadApp(opts: { storageThrows?: Error } = {}): Harness {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      content: { firstElementChild: { cloneNode: () => makeNode() } },
      appendChild() {},
      remove() {},
      addEventListener(name: string, fn: any) {
        (node.handlers ??= {})[name] = fn;
      },
      querySelector: () => makeNode(),
      querySelectorAll: () => [],
      getContext: () => ({}),
      handlers: {} as Record<string, any>,
    };
    return node;
  };

  const byId: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById(id: string) {
      return (byId[id] ??= makeNode());
    },
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => {
        if (opts.storageThrows) throw opts.storageThrows;
        stored[k] = v;
      },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () {
      return { destroy() {} };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  // The real toast writes into #toast; read what it wrote rather than stubbing
  // the function, so the message under test is the one a user would see. This
  // has to be wired before the script runs, because boot itself can toast.
  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;", ctx);

  return { ctx, toasts, stored };
}

describe("planDayName", () => {
  it("is the single source of truth every tab now calls", () => {
    const { ctx } = loadApp();
    // 2026-08-31 is a Monday; 2026-09-06 is a Sunday.
    expect(ctx.planDayName(new Date("2026-08-31T12:00:00Z"))).toBe("Monday");
    expect(ctx.planDayName(new Date("2026-09-06T12:00:00Z"))).toBe("Sunday");
    expect(APP_SOURCE).not.toMatch(/DAY_NAMES\[new Date\(\)\.getDay\(\)\]/);
    expect(APP_SOURCE.match(/planDayName\(\)/g)?.length).toBe(4);
  });
});

describe("validateExerciseRow", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    name: "Back Squat",
    sets: "3",
    reps: "10",
    weight: "100",
    ...over,
  });

  it("accepts a fully filled row and expands it into sets", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row());
    expect(r.ok).toBe(true);
    expect(r.exercise.sets).toEqual([
      { reps: 10, weight: 100 },
      { reps: 10, weight: 100 },
      { reps: 10, weight: 100 },
    ]);
  });

  it("skips a row the user left entirely blank", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow({ name: "", sets: "", reps: "", weight: "" });
    expect(r).toEqual({ ok: true, skip: true });
  });

  it("skips a prefilled row whose name was cleared, which is how you skip an exercise", () => {
    const { ctx } = loadApp();
    // The Log tab prefills name/sets/reps from the plan and leaves weight blank.
    const r = ctx.validateExerciseRow({ name: "", sets: "3", reps: "10", weight: "" });
    expect(r).toEqual({ ok: true, skip: true });
  });

  it("rejects blank reps instead of silently saving 1", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ reps: "" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Reps is required");
  });

  it("rejects zero reps", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ reps: "0" })).ok).toBe(false);
  });

  it("rejects blank weight instead of silently saving 0kg", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ weight: "" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Weight is required");
  });

  it("allows a genuine bodyweight exercise at 0kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ name: "Pull-ups", weight: "0" })).ok).toBe(true);
  });

  it("rejects a named row whose numbers are all blank rather than skipping it", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow({ name: "Back Squat", sets: "", reps: "", weight: "" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Back Squat");
  });

  it("rejects an absurd weight", () => {
    const { ctx } = loadApp();
    expect(ctx.validateExerciseRow(row({ weight: "5000" })).ok).toBe(false);
  });

  it("rejects text where a number belongs", () => {
    const { ctx } = loadApp();
    const r = ctx.validateExerciseRow(row({ reps: "ten" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("must be a number");
  });
});

describe("validateSession", () => {
  it("keeps the filled rows and drops the blank ones", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([
      { name: "Bench", sets: "3", reps: "8", weight: "80" },
      { name: "", sets: "", reps: "", weight: "" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.exercises).toHaveLength(1);
  });

  it("refuses a session where every row is blank", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([{ name: "", sets: "", reps: "", weight: "" }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("at least one exercise");
  });

  it("fails the whole session on one bad row rather than saving the rest", () => {
    const { ctx } = loadApp();
    const r = ctx.validateSession([
      { name: "Bench", sets: "3", reps: "8", weight: "80" },
      { name: "Row", sets: "3", reps: "", weight: "60" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Row:");
  });
});

describe("validateMeal", () => {
  it("accepts a normal meal", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("Grandiosa", "1200")).toEqual({
      ok: true,
      meal: { name: "Grandiosa", calories: 1200 },
    });
  });

  it("rejects a fat-fingered 50000 instead of saving it", () => {
    const { ctx } = loadApp();
    const r = ctx.validateMeal("Pizza", "50000");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("between 1 and 10000 kcal");
  });

  it("rejects 0 kcal with a message rather than returning in silence", () => {
    const { ctx } = loadApp();
    const r = ctx.validateMeal("Water", "0");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("between 1 and 10000");
  });

  it("rejects a missing calorie count", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("Lunch", "").ok).toBe(false);
  });

  it("rejects a missing name", () => {
    const { ctx } = loadApp();
    expect(ctx.validateMeal("  ", "500").message).toBe("Give the meal a name.");
  });
});

describe("validateBodyweight", () => {
  it("accepts a plausible bodyweight", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("83.4")).toEqual({ ok: true, kg: 83.4 });
  });

  it("rejects a typo of 8 kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("8").ok).toBe(false);
  });

  it("rejects a typo of 834 kg", () => {
    const { ctx } = loadApp();
    expect(ctx.validateBodyweight("834").ok).toBe(false);
  });
});

describe("store.set under a failing localStorage", () => {
  it("tells the user when storage is full instead of failing silently", () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.set("meals", [])).toBe(false);
    expect(toasts.at(-1)).toContain("Storage is full");
    // and the value is still readable for the rest of the session
    expect(ctx.store.get("meals", null)).toEqual([]);
  });

  it("tells the user when the browser blocks storage entirely", () => {
    const err = new Error("denied");
    err.name = "SecurityError";
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.set("meals", [])).toBe(false);
    expect(toasts.at(-1)).toContain("blocking storage");
  });

  it("stops shadowing localStorage once a write succeeds again", () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    const { ctx, stored } = loadApp({ storageThrows: err });
    // storage was full: the value lives only in memory
    expect(ctx.store.set("meals", [{ id: "held" }])).toBe(false);
    expect(ctx.store.get("meals", null)).toEqual([{ id: "held" }]);
    // storage recovers; the persisted value must win, not the stale copy
    stored["marcus.meals"] = JSON.stringify([{ id: "persisted" }]);
    ctx.localStorage.setItem = (k: string, v: string) => {
      stored[k] = v;
    };
    expect(ctx.store.set("meals", [{ id: "persisted" }])).toBe(true);
    stored["marcus.meals"] = JSON.stringify([{ id: "from-disk" }]);
    expect(ctx.store.get("meals", null)).toEqual([{ id: "from-disk" }]);
  });

  it("still boots and renders when localStorage is blocked outright", () => {
    const err = new Error("denied");
    err.name = "SecurityError";
    // loadApp() runs the whole script, including switchTab('home'). Before the
    // in-memory fallback existed this threw: seed() could not write the plan,
    // so renderHome read undefined and the app died with a blank screen.
    const { ctx, toasts } = loadApp({ storageThrows: err });
    expect(ctx.store.get("plan", null)).not.toBeNull();
    expect(toasts.at(-1)).toContain("blocking storage");
  });

  it("returns true and stores the value when storage works", () => {
    const { ctx, stored, toasts } = loadApp();
    expect(toasts).toHaveLength(0); // a healthy boot says nothing
    expect(ctx.store.set("meals", [{ id: "a" }])).toBe(true);
    expect(JSON.parse(stored["marcus.meals"])).toEqual([{ id: "a" }]);
    expect(toasts).toHaveLength(0);
  });
});

describe("goals", () => {
  describe("validateGoal", () => {
    it("turns a sentence plus a date into a goal with dated phases", () => {
      const { ctx } = loadApp();
      const r = ctx.validateGoal("Olympic triathlon next summer", "2027-07-01", "2026-08-31");
      expect(r.ok).toBe(true);
      expect(r.goal.text).toBe("Olympic triathlon next summer");
      expect(r.goal.targetDate).toBe("2027-07-01");
      expect(r.goal.milestones.map((m: any) => m.label)).toEqual(["Base", "Build", "Peak", "Taper"]);
    });

    it("refuses an empty sentence, a missing date and a date already gone", () => {
      const { ctx } = loadApp();
      expect(ctx.validateGoal("   ", "2027-07-01", "2026-08-31").message).toMatch(/what you are training for/);
      expect(ctx.validateGoal("Run a marathon", "", "2026-08-31").message).toMatch(/target date/);
      expect(ctx.validateGoal("Run a marathon", "2026-08-30", "2026-08-31").message).toMatch(/in the future/);
      expect(ctx.validateGoal("Run a marathon", "2026-08-31", "2026-08-31").message).toMatch(/in the future/);
    });

    it("refuses a date that is not a date and a year that is a typo", () => {
      const { ctx } = loadApp();
      expect(ctx.validateGoal("Run a marathon", "next july", "2026-08-31").message).toMatch(/not a real date/);
      // 2027-02-31 does not throw in JS -- it rolls forward to 3 March, so
      // without the component check this is silently accepted as a March target.
      expect(ctx.validateGoal("Run a marathon", "2027-02-31", "2026-08-31").message).toMatch(/not a real date/);
      expect(ctx.validateGoal("Run a marathon", "2027-13-01", "2026-08-31").message).toMatch(/not a real date/);
      expect(ctx.validateGoal("Run a marathon", "2027-02-28", "2026-08-31").ok).toBe(true);
      expect(ctx.validateGoal("Run a marathon", "2226-07-01", "2026-08-31").message).toMatch(/ten years/);
    });
  });

  describe("buildMilestones", () => {
    it("lands the last phase exactly on the target date", () => {
      const { ctx } = loadApp();
      // 2026-08-31 to 2027-07-01 is 304 days, so the phase ends fall at day
      // 122, 228, 280 and 304 — counted out by hand rather than copied from a
      // run, because a snapshot of the output cannot disagree with the output.
      const ms = ctx.buildMilestones("2026-08-31", "2027-07-01");
      expect(ms.at(-1).date).toBe("2027-07-01");
      expect(ms.map((m: any) => m.date)).toEqual(["2026-12-31", "2027-04-16", "2027-06-07", "2027-07-01"]);
    });

    it("is honest about a window too short to periodise", () => {
      const { ctx } = loadApp();
      const ms = ctx.buildMilestones("2026-08-31", "2026-09-20"); // 20 days
      expect(ms).toHaveLength(1);
      expect(ms[0].label).toBe("Build");
      expect(ms[0].date).toBe("2026-09-20");
    });

    it("gives nothing back when there is no window at all", () => {
      const { ctx } = loadApp();
      expect(ctx.buildMilestones("2026-08-31", "2026-08-31")).toEqual([]);
      expect(ctx.buildMilestones("2026-08-31", "2026-08-01")).toEqual([]);
    });
  });

  describe("goalCountdown", () => {
    it("reads as a person would say it at each distance", () => {
      const { ctx } = loadApp();
      expect(ctx.goalCountdown("2026-08-31", "2026-08-31")).toBe("today");
      expect(ctx.goalCountdown("2026-09-01", "2026-08-31")).toBe("1 day to go");
      expect(ctx.goalCountdown("2026-09-10", "2026-08-31")).toBe("10 days to go");
      expect(ctx.goalCountdown("2027-07-01", "2026-08-31")).toBe("43 weeks to go");
      expect(ctx.goalCountdown("2026-08-30", "2026-08-31")).toBe("target date passed");
    });
  });

  describe("goalsSorted", () => {
    it("puts the nearest target first whatever order they were added", () => {
      const { ctx } = loadApp();
      ctx.store.set("goals", [
        { id: "far", targetDate: "2027-07-01", milestones: [] },
        { id: "near", targetDate: "2026-10-01", milestones: [] },
      ]);
      expect(ctx.goalsSorted().map((g: any) => g.id)).toEqual(["near", "far"]);
    });

    it("does not reorder the stored list when storage is blocked", () => {
      // With localStorage working, store.get re-parses JSON every call and hands
      // back a fresh array, so an in-place sort could never be seen. The
      // in-memory fallback returns the live object, and that is the only place
      // the copy in goalsSorted actually does anything -- so it is where the
      // copy has to be tested.
      const err = new Error("denied");
      err.name = "SecurityError";
      const { ctx } = loadApp({ storageThrows: err });
      ctx.store.set("goals", [
        { id: "far", targetDate: "2027-07-01", milestones: [] },
        { id: "near", targetDate: "2026-10-01", milestones: [] },
      ]);
      expect(ctx.goalsSorted().map((g: any) => g.id)).toEqual(["near", "far"]);
      expect(ctx.store.get("goals", []).map((g: any) => g.id)).toEqual(["far", "near"]);
    });
  });

  describe("goalProgress", () => {
    // One goal shape reused across the verdicts: a year-long window whose four
    // phases fall on known dates, so "overdue" is a date comparison I can check
    // by hand rather than a percentage I have to trust.
    const goal = () => ({
      id: "g1",
      text: "Olympic triathlon",
      created: "2026-01-01",
      targetDate: "2026-12-31",
      milestones: [
        { id: "m1", label: "Base", date: "2026-05-31", done: false },
        { id: "m2", label: "Build", date: "2026-09-13", done: false },
        { id: "m3", label: "Peak", date: "2026-11-14", done: false },
        { id: "m4", label: "Taper", date: "2026-12-31", done: false },
      ],
    });

    it("reports the clock and the ticks as two separate numbers", () => {
      const { ctx } = loadApp();
      const g = goal();
      g.milestones[0].done = true;
      // 2026-07-02 is day 182 of a 364-day window: half the time gone, one of
      // four phases ticked. A single merged "percent complete" could not say
      // both of those, which is why there are two bars.
      const p = ctx.goalProgress(g, "2026-07-02");
      expect(p.elapsedPct).toBe(50);
      expect(p.donePct).toBe(25);
      expect(p.doneCount).toBe(1);
      expect(p.total).toBe(4);
      expect(p.daysLeft).toBe(182);
    });

    it("calls a passed-but-unticked phase overdue, and names how many", () => {
      const { ctx } = loadApp();
      // Base was due 31 May and Build 13 September; on 14 September with
      // neither ticked, two dates have gone by.
      const p = ctx.goalProgress(goal(), "2026-09-14");
      expect(p.overdue).toBe(2);
      expect(p.verdict).toBe("behind");
      expect(ctx.goalVerdictLabel(p)).toBe("2 phases overdue");
    });

    it("says one phase in the singular", () => {
      const { ctx } = loadApp();
      const p = ctx.goalProgress(goal(), "2026-06-01");
      expect(p.overdue).toBe(1);
      expect(ctx.goalVerdictLabel(p)).toBe("1 phase overdue");
    });

    it("is on track when every phase whose date has passed is ticked", () => {
      const { ctx } = loadApp();
      const g = goal();
      g.milestones[0].done = true;
      const p = ctx.goalProgress(g, "2026-06-01");
      expect(p.overdue).toBe(0);
      expect(p.verdict).toBe("on track");
      expect(ctx.goalVerdictLabel(p)).toBe("on track");
    });

    it("is ahead only when something not yet due is ticked", () => {
      const { ctx } = loadApp();
      const g = goal();
      g.milestones[0].done = true;
      g.milestones[1].done = true; // Build is not due until 13 September
      const p = ctx.goalProgress(g, "2026-06-01");
      expect(p.verdict).toBe("ahead");
      expect(ctx.goalVerdictLabel(p)).toBe("ahead of the dates");
    });

    it("judges nothing when the goal carries no phases", () => {
      // A goal stored before phases existed would otherwise read 0% ticked and
      // look permanently behind, which is a verdict on my own data model rather
      // than on the user.
      const { ctx } = loadApp();
      const p = ctx.goalProgress({ created: "2026-01-01", targetDate: "2026-12-31", milestones: [] }, "2026-07-02");
      expect(p.total).toBe(0);
      expect(p.donePct).toBe(0);
      expect(p.overdue).toBe(0);
      expect(p.verdict).toBe("no phases");
      expect(ctx.goalVerdictLabel(p)).toBe("no phases to judge");
    });

    it("clamps the clock at both ends instead of running past 100", () => {
      const { ctx } = loadApp();
      expect(ctx.goalProgress(goal(), "2027-06-01").elapsedPct).toBe(100);
      expect(ctx.goalProgress(goal(), "2025-06-01").elapsedPct).toBe(0);
      expect(ctx.goalProgress(goal(), "2027-01-02").daysLeft).toBe(-2);
    });
  });

  describe("the Progress tab", () => {
    it("puts a goal-progress card above the graphs, and none when there is no goal", () => {
      // goalProgressCard being right is worth nothing if the tab never calls it,
      // and that wiring is one line of a template literal -- the exact kind of
      // line a unit test on the function alone cannot pin.
      const { ctx } = loadApp();
      // `view` is a top-level const, so it never lands on the vm's global -- the
      // same node comes back through the document stub's own id cache.
      const viewHtml = () => ctx.document.getElementById("view").innerHTML;
      ctx.store.set("goals", []);
      ctx.switchTab("progress");
      expect(viewHtml()).not.toContain("Goal progress");
      expect(viewHtml()).toContain("Bodyweight");

      ctx.store.set("goals", [{
        id: "g1", text: "Olympic triathlon", created: "2026-01-01", targetDate: "2099-12-31",
        milestones: [{ id: "m1", label: "Base", date: "2099-05-31", done: false }],
      }]);
      ctx.switchTab("progress");
      expect(viewHtml()).toContain("Goal progress");
      expect(viewHtml()).toContain("Olympic triathlon");
      expect(viewHtml()).toContain("Bodyweight");
    });
  });

  describe("goalProgressCard", () => {
    it("puts the verdict, both meters and the target date on the card", () => {
      const { ctx } = loadApp();
      const g = {
        id: "g1", text: "Olympic triathlon", created: "2026-01-01", targetDate: "2026-12-31",
        milestones: [
          { id: "m1", label: "Base", date: "2026-05-31", done: true },
          { id: "m2", label: "Build", date: "2026-09-13", done: false },
        ],
      };
      const html = ctx.goalProgressCard(g, "2026-07-02");
      expect(html).toContain("Olympic triathlon");
      expect(html).toContain("on track");
      expect(html).toContain('style="width:50%"');
      expect(html).toContain("1 of 2");
      expect(html).toContain("182 days left");
      expect(html).not.toContain("chip--alert");
    });

    it("marks an overdue goal with the alert chip, not with colour alone", () => {
      const { ctx } = loadApp();
      const g = {
        id: "g1", text: "Olympic triathlon", created: "2026-01-01", targetDate: "2026-12-31",
        milestones: [{ id: "m1", label: "Base", date: "2026-05-31", done: false }],
      };
      const html = ctx.goalProgressCard(g, "2026-07-02");
      expect(html).toContain("chip--alert");
      expect(html).toContain("1 phase overdue");
    });

    it("escapes the goal text it was given", () => {
      const { ctx } = loadApp();
      const g = {
        id: "g1", text: '<img src=x onerror="alert(1)">', created: "2026-01-01",
        targetDate: "2026-12-31", milestones: [],
      };
      const html = ctx.goalProgressCard(g, "2026-07-02");
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    });
  });

  describe("toggleMilestone", () => {
    it("flips one milestone and leaves the rest alone", () => {
      const { ctx } = loadApp();
      ctx.store.set("goals", [
        { id: "g1", text: "Marathon", targetDate: "2027-07-01", milestones: [
          { id: "m1", label: "Base", note: "n", date: "2027-01-01", done: false },
          { id: "m2", label: "Build", note: "n", date: "2027-04-13", done: false },
        ] },
      ]);
      ctx.toggleMilestone("g1", "m1");
      const after = ctx.store.get("goals", [])[0].milestones;
      expect(after.map((m: any) => m.done)).toEqual([true, false]);
      ctx.toggleMilestone("g1", "m1");
      expect(ctx.store.get("goals", [])[0].milestones[0].done).toBe(false);
    });

    it("does nothing when the goal or the milestone is gone", () => {
      const { ctx } = loadApp();
      ctx.store.set("goals", [{ id: "g1", targetDate: "2027-07-01", milestones: [] }]);
      expect(() => ctx.toggleMilestone("missing", "m1")).not.toThrow();
      expect(() => ctx.toggleMilestone("g1", "missing")).not.toThrow();
    });
  });
});

describe("the Plan tab with goals on it", () => {
  it("draws the goal, its countdown and every phase", () => {
    const { ctx } = loadApp();
    ctx.store.set("goals", [
      { id: "g1", text: "Olympic triathlon", targetDate: "2099-07-01", milestones: [
        { id: "m1", label: "Base", note: "Volume.", date: "2099-01-01", done: false },
        { id: "m2", label: "Taper", note: "Fresh.", date: "2099-07-01", done: true },
      ] },
    ]);
    ctx.switchTab("plan");
    const html = ctx.document.getElementById("view").innerHTML;
    expect(html).toContain("Olympic triathlon");
    expect(html).toContain("weeks to go");
    expect(html).toContain("Base");
    expect(html).toContain("Taper");
    expect(html).toContain("check_box_outline_blank"); // m1 open
    expect(html).toContain(">check_box<"); // m2 ticked
    expect(html).toContain(ctx.store.get("plan").blockName); // the week is still there
  });

  it("says so plainly when there is no goal yet", () => {
    const { ctx } = loadApp();
    ctx.switchTab("plan");
    expect(ctx.document.getElementById("view").innerHTML).toContain("No goal yet");
  });

  it("escapes a goal the user typed HTML into", () => {
    const { ctx } = loadApp();
    ctx.store.set("goals", [{ id: "g1", text: "<img src=x onerror=1>", targetDate: "2099-07-01", milestones: [] }]);
    ctx.switchTab("plan");
    expect(ctx.document.getElementById("view").innerHTML).not.toContain("<img src=x");
  });
});
