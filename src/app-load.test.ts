import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

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
  it("calls a two-week layoff backing off, because the empty days count as zero", () => {
    const { ctx } = loadApp();
    const load = ctx.trainingLoad(everyOtherDay(90, 14, 5000), TODAY);
    expect(load.fitness).toBeGreaterThan(0);
    expect(load.ratio).toBeLessThan(0.8);
    expect(load.verdict).toBe("backing off");
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
});
