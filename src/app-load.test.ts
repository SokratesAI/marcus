import { APP_SOURCE } from "./app-source.js";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same shape as app-validation.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// Every function under test here is pure -- sessions in, numbers or a string
// of HTML out -- so nothing in these tests touches the DOM stub.
function loadApp(opts: { now?: Date } = {}): { ctx: any; toasts: string[]; byId: Record<string, any>; stored: Record<string, string> } {
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
    getElementById: (id: string) => (byId[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console, setTimeout, clearTimeout,
    Math, JSON, Number, String, Array, Object,
    // `new Date()` with no argument is the app's only clock. Left real, a test
    // of the timestamp is judged against whatever time the suite happens to run
    // at -- which is why a two-digit hour cannot fail one. Every other call
    // shape passes straight through.
    Date: opts.now
      ? new Proxy(Date, {
          construct(target, args: any[]) {
            return args.length ? new (target as any)(...args) : new (target as any)(opts.now!.getTime());
          },
        })
      : Date,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  // `const`/`let` at the top level of a script are lexical, so unlike a
  // `function` declaration they never land on the context's global object.
  // The three window constants are read by these tests, so they are exposed
  // here rather than re-spelled in the assertions.
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.LOAD_MIN_DAYS = LOAD_MIN_DAYS;" +
      "\n;globalThis.LOAD_FITNESS_DAYS = LOAD_FITNESS_DAYS;" +
      "\n;globalThis.LOAD_FATIGUE_DAYS = LOAD_FATIGUE_DAYS;",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

// ---------- fixtures ----------
const DAY = 86400000;
const TODAY = "2026-09-01";
const ago = (n: number) => new Date(new Date(TODAY + "T00:00:00Z").getTime() - n * DAY).toISOString().slice(0, 10);
// One exercise, one set: reps x weight is the whole volume, so a scenario reads
// as "this many kilograms on this day" and nothing else.
const sess = (date: string, kg: number) => ({ id: date + "-" + kg, date, day: "Push", exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }] });

// Every other day, inclusive of both ends, counting back from today.
function everyOtherDay(fromAgo: number, toAgo: number, kg: number) {
  const out = [];
  for (let d = fromAgo; d >= toAgo; d -= 2) out.push(sess(ago(d), kg));
  return out;
}

describe("dailyLoads", () => {
  it("adds two sessions logged on the same date into one day's load", () => {
    const { ctx } = loadApp();
    const loads = ctx.dailyLoads([sess("2026-08-20", 1000), sess("2026-08-20", 500), sess("2026-08-21", 700)]);
    expect(loads["2026-08-20"]).toBe(1500);
    expect(loads["2026-08-21"]).toBe(700);
  });

  it("sums every set of every exercise, not just the first", () => {
    const { ctx } = loadApp();
    const loads = ctx.dailyLoads([{ date: "2026-08-20", exercises: [
      { name: "Squat", sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] },
      { name: "Bench", sets: [{ reps: 10, weight: 60 }] },
    ] }]);
    expect(loads["2026-08-20"]).toBe(5 * 100 + 5 * 100 + 10 * 60);
  });

  it("ignores a session with no date rather than bucketing it under undefined", () => {
    const { ctx } = loadApp();
    expect(ctx.dailyLoads([{ exercises: [{ sets: [{ reps: 1, weight: 100 }] }] }])).toEqual({});
  });
});

describe("trainingLoad", () => {
  it("reports nothing logged when there are no sessions", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad([], TODAY);
    expect(load.verdict).toBe("nothing logged");
    expect(load.ratio).toBe(0);
    expect(load.days).toBe(0);
  });

  // The one that pins the rest-day walk. If the loop only visited days that
  // have a session, the last day it saw would be the hard one two weeks back
  // and fatigue would still be high -- a taper would read as "building".
  it("lets a two-week layoff drag the ratio under 0.8, because the empty days count as zero", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad(everyOtherDay(90, 14, 5000), TODAY);
    expect(load.fitness).toBeGreaterThan(0);
    expect(load.ratio).toBeLessThan(0.8);
    // The ratio is what pins the rest-day walk. The verdict is `resting`
    // rather than `backing off` because nothing was logged inside the fatigue
    // window at all -- see the layoff block below.
    expect(load.verdict).toBe("resting");
  });

  // The card was telling Edvard he was "building" -- the middle of the band it
  // describes as training hard enough to improve -- eight days after his last
  // session. It is not an arithmetic bug: with no load at all both averages
  // decay at their own fixed rates, so their ratio settles on a number that
  // depends only on how long ago you stopped, and his real data lands it at
  // 0.81. The ratio has to stop being the headline once there is no recent
  // training for it to be about.
  it("calls a layoff resting rather than reading the decaying ratio as a verdict", () => {
    const { ctx } = loadApp();
    // Deliberately the shape of Edvard's real data on 2026-09-08: about a
    // month of steady training and then eight days of nothing. Fitness is
    // still young, so the ratio lands at 0.82 -- inside the building band.
    const load = ctx.trainingLoad(everyOtherDay(34, 8, 3000), TODAY);
    expect(load.daysSinceLast).toBe(8);
    expect(load.verdict).toBe("resting");
    // The guard against a vacuous pass: the ratio really is inside the
    // building band here, so the old code really would have said "building".
    expect(load.ratio).toBeGreaterThanOrEqual(0.8);
    expect(load.ratio).toBeLessThanOrEqual(1.3);
    expect(ctx.loadVerdict(load.ratio, load.days)).toBe("building");
  });

  // The boundary is the product decision: `resting` means nothing was logged
  // inside the fatigue window, so the window's own length is where it starts.
  it("starts resting on the day the last session leaves the fatigue window", () => {
    const { ctx } = loadApp();
    expect(ctx.trainingLoad(everyOtherDay(35, 7, 3000), TODAY).daysSinceLast).toBe(7);
    expect(ctx.trainingLoad(everyOtherDay(35, 7, 3000), TODAY).verdict).toBe("resting");
    expect(ctx.LOAD_FATIGUE_DAYS).toBe(7);
  });

  it("still judges the ratio on the last day the fatigue window can still see", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad(everyOtherDay(90, 6, 3000), TODAY);
    expect(load.daysSinceLast).toBe(6);
    expect(load.verdict).not.toBe("resting");
  });

  it("counts days since the last session, and reports null when there are none", () => {
    const { ctx } = loadApp();
    expect(ctx.trainingLoad(everyOtherDay(90, 0, 3000), TODAY).daysSinceLast).toBe(0);
    expect(ctx.trainingLoad([], TODAY).daysSinceLast).toBeNull();
  });

  it("says resting before too early, because thin history does not make a layoff a guess", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad([sess(ago(12), 3000), sess(ago(10), 3000)], TODAY);
    expect(load.days).toBeLessThan(ctx.LOAD_MIN_DAYS);
    expect(load.verdict).toBe("resting");
  });

  it("calls three months of steady training building", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad(everyOtherDay(90, 0, 5000), TODAY);
    expect(load.ratio).toBeGreaterThanOrEqual(0.8);
    expect(load.ratio).toBeLessThanOrEqual(1.3);
    expect(load.verdict).toBe("building");
  });

  it("calls a hard week on top of an easy quarter a load spike", () => {
    const { ctx } = loadApp();
    const base = everyOtherDay(90, 8, 1000);
    const spike = [6, 5, 4, 3, 2, 1, 0].map(d => sess(ago(d), 12000));
    const load = ctx.trainingLoad(base.concat(spike), TODAY);
    expect(load.ratio).toBeGreaterThan(1.5);
    expect(load.verdict).toBe("load spike");
  });

  it("refuses to call a spike on a first week of training, however extreme the ratio", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad([sess(ago(2), 20000), sess(ago(0), 20000)], TODAY);
    expect(load.ratio).toBeGreaterThan(1.5);
    expect(load.days).toBeLessThan(ctx.LOAD_MIN_DAYS);
    expect(load.verdict).toBe("too early");
  });

  it("counts calendar days covered, not sessions logged", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad([sess(ago(30), 1000), sess(ago(0), 1000)], TODAY);
    expect(load.days).toBe(31);
  });

  it("calls fitness rising while the load ramps and falling once it stops", () => {
    const { ctx } = loadApp();
    const ramping = ctx.trainingLoad(everyOtherDay(60, 0, 5000), TODAY);
    expect(ramping.trend).toBe("rising");
    const stopped = ctx.trainingLoad(everyOtherDay(90, 20, 5000), TODAY);
    expect(stopped.trend).toBe("falling");
  });

  it("has no trend to report before there is a week of history", () => {
    const { ctx } = loadApp();
    expect(ctx.trainingLoad([sess(ago(1), 1000)], TODAY).trend).toBe("none");
  });

  // Fatigue reacts to the last few days and fitness barely moves, so the same
  // total volume delivered recently rather than long ago has to score higher.
  it("scores recent work as more fatiguing than the same volume a month back", () => {
    const { ctx } = loadApp();
    const recent = ctx.trainingLoad(everyOtherDay(6, 0, 5000), TODAY);
    const old = ctx.trainingLoad(everyOtherDay(36, 30, 5000), TODAY);
    expect(recent.fatigue).toBeGreaterThan(old.fatigue);
  });
});

// The band edges are the product decision this card is built around, so they
// are pinned as literals here. The scenario tests above land in the middle of
// each band by design and cannot tell 0.8 from 0.5.
describe("loadVerdict", () => {
  it("puts the edges of each band on the side the research does", () => {
    const { ctx } = loadApp();
    const v = (r: number) => ctx.loadVerdict(r, 90);
    expect(v(0.79)).toBe("backing off");
    expect(v(0.8)).toBe("building");
    expect(v(1.3)).toBe("building");
    expect(v(1.31)).toBe("overreaching");
    expect(v(1.5)).toBe("overreaching");
    expect(v(1.51)).toBe("load spike");
  });

  it("answers too early for any ratio at all until there is a month of history", () => {
    const { ctx } = loadApp();
    expect(ctx.loadVerdict(0.1, ctx.LOAD_MIN_DAYS - 1)).toBe("too early");
    expect(ctx.loadVerdict(9, ctx.LOAD_MIN_DAYS - 1)).toBe("too early");
    expect(ctx.loadVerdict(9, ctx.LOAD_MIN_DAYS)).toBe("load spike");
  });
});

describe("loadVerdictLabel", () => {
  it("spells out the verdicts whose bare word does not read as a sentence", () => {
    const { ctx } = loadApp();
    expect(ctx.loadVerdictLabel({ verdict: "nothing logged" })).toBe("no sessions logged");
    expect(ctx.loadVerdictLabel({ verdict: "too early" })).toBe("too early to judge");
    expect(ctx.loadVerdictLabel({ verdict: "load spike" })).toContain("ease off");
    expect(ctx.loadVerdictLabel({ verdict: "resting", daysSinceLast: 9 })).toBe("no sessions in 9 days");
  });

  it("passes the self-explanatory ones through unchanged", () => {
    const { ctx } = loadApp();
    expect(ctx.loadVerdictLabel({ verdict: "building" })).toBe("building");
    expect(ctx.loadVerdictLabel({ verdict: "backing off" })).toBe("backing off");
  });
});

describe("trainingLoadCard", () => {
  it("shows both averages and the ratio to two decimals", () => {
    const { ctx } = loadApp();
    const html = ctx.trainingLoadCard({ fitness: 1234.6, fatigue: 987.4, ratio: 0.8, days: 90, trend: "rising", verdict: "building" });
    expect(html).toContain("1,235 kg/day");
    expect(html).toContain("987 kg/day");
    expect(html).toContain("0.80");
    expect(html).toContain("rising");
  });

  it("turns the chip red only when the load is one worth acting on", () => {
    const { ctx } = loadApp();
    const spike = ctx.trainingLoadCard({ fitness: 100, fatigue: 200, ratio: 2, days: 90, trend: "rising", verdict: "load spike" });
    const fine = ctx.trainingLoadCard({ fitness: 100, fatigue: 100, ratio: 1, days: 90, trend: "flat", verdict: "building" });
    expect(spike).toContain("chip--alert");
    expect(fine).not.toContain("chip--alert");
  });

  it("prints how long ago the last session was, and drops the line when it was today", () => {
    const { ctx } = loadApp();
    const base = { fitness: 700, fatigue: 600, ratio: 0.86, days: 40, trend: "falling" };
    const off = ctx.trainingLoadCard({ ...base, daysSinceLast: 8, verdict: "resting" });
    expect(off).toContain("Last session");
    expect(off).toContain("8 days ago");
    expect(off).toContain("no sessions in 8 days");
    const one = ctx.trainingLoadCard({ ...base, daysSinceLast: 1, verdict: "building" });
    expect(one).toContain("1 day ago");
    const todayCard = ctx.trainingLoadCard({ ...base, daysSinceLast: 0, verdict: "building" });
    expect(todayCard).not.toContain("Last session");
    const none = ctx.trainingLoadCard({ fitness: 0, fatigue: 0, ratio: 0, days: 0, daysSinceLast: null, trend: "none", verdict: "nothing logged" });
    expect(none).not.toContain("Last session");
  });

  // The note under the numbers is the sentence that was actively wrong during
  // a layoff: it explains the 0.8-1.3 band while the ratio sits inside it for
  // a reason that has nothing to do with training.
  it("stops explaining the ratio band once the ratio is only decay", () => {
    const { ctx } = loadApp();
    const base = { fitness: 700, fatigue: 600, ratio: 0.86, days: 40, trend: "falling" };
    const off = ctx.trainingLoadCard({ ...base, daysSinceLast: 8, verdict: "resting" });
    expect(off).not.toContain("without digging a hole");
    expect(off).toContain("says nothing about now");
    const on = ctx.trainingLoadCard({ ...base, daysSinceLast: 1, verdict: "building" });
    expect(on).toContain("without digging a hole");
    expect(on).not.toContain("says nothing about now");
  });

  // "7-day average" is what the line said, and with nothing logged for eight
  // days his real 7-day average is zero while the line reads 610 kg/day. The
  // number is right; the word for it was not.
  it("does not call either weighted average a plain average", () => {
    const { ctx } = loadApp();
    const html = ctx.trainingLoadCard({ fitness: 700, fatigue: 600, ratio: 0.86, days: 40, daysSinceLast: 2, trend: "flat", verdict: "building" });
    expect(html).not.toContain("42-day average");
    expect(html).not.toContain("7-day average");
    expect(html).toContain("weighted over 42 days");
    expect(html).toContain("weighted over 7 days");
  });
});
