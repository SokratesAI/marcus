import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same harness as app-load.test.ts: app.js is a classic script, so its
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
const strength = (date: string, kg: number) => ({
  id: date + "-s", date, kind: "strength", day: "Push",
  exercises: [{ name: "Squat", sets: [{ reps: 1, weight: kg }] }],
});
const cardio = (date: string, minutes: number, distance: number | null) => ({
  id: date + "-c", date, kind: "cardio", activity: "Run", minutes, distance,
});

describe("validateCardio", () => {
  it("accepts an activity and a duration with no distance", () => {
    const { ctx } = loadApp();
    const r = ctx.validateCardio("Swim", "45", "");
    expect(r.ok).toBe(true);
    expect(r.cardio).toEqual({ activity: "Swim", minutes: 45, distance: null });
  });

  it("keeps a distance when one is given", () => {
    const { ctx } = loadApp();
    expect(ctx.validateCardio("Run", "45", "8.2").cardio.distance).toBe(8.2);
  });

  it("refuses a session with no activity named", () => {
    const { ctx } = loadApp();
    const r = ctx.validateCardio("   ", "45", "");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Pick what you did.");
  });

  it("refuses a missing duration rather than storing a zero-minute session", () => {
    const { ctx } = loadApp();
    const r = ctx.validateCardio("Run", "", "8.2");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Duration");
  });

  it("refuses a duration outside the bounds at both ends", () => {
    const { ctx } = loadApp();
    expect(ctx.validateCardio("Run", "0", "").ok).toBe(false);
    expect(ctx.validateCardio("Run", "1441", "").ok).toBe(false);
    expect(ctx.validateCardio("Run", "1", "").ok).toBe(true);
    expect(ctx.validateCardio("Run", "1440", "").ok).toBe(true);
  });

  it("refuses a distance that is present but not a usable number", () => {
    const { ctx } = loadApp();
    expect(ctx.validateCardio("Run", "45", "abc").ok).toBe(false);
    expect(ctx.validateCardio("Run", "45", "0").ok).toBe(false);
    expect(ctx.validateCardio("Run", "45", "501").ok).toBe(false);
  });

  it("trims the activity name", () => {
    const { ctx } = loadApp();
    expect(ctx.validateCardio("  Bike  ", "30", "").cardio.activity).toBe("Bike");
  });
});

describe("paceLabel", () => {
  it("writes minutes per kilometre with a zero-padded seconds field", () => {
    const { ctx } = loadApp();
    expect(ctx.paceLabel(45, 8.2)).toBe("5:29 /km");
    // 40 min over 8 km is exactly 5:00, which is the case a naive
    // `seconds % 60` prints as "5:0".
    expect(ctx.paceLabel(40, 8)).toBe("5:00 /km");
  });

  it("has no pace without a distance", () => {
    const { ctx } = loadApp();
    expect(ctx.paceLabel(45, null)).toBe(null);
    expect(ctx.paceLabel(45, 0)).toBe(null);
    expect(ctx.paceLabel(0, 8)).toBe(null);
  });
});

describe("cardioSummary", () => {
  it("reads duration, distance and pace when all three are known", () => {
    const { ctx } = loadApp();
    expect(ctx.cardioSummary(cardio("2026-09-01", 45, 8.2))).toBe("45 min \u00b7 8.2 km \u00b7 5:29 /km");
  });

  it("is duration alone when there is no distance", () => {
    const { ctx } = loadApp();
    expect(ctx.cardioSummary(cardio("2026-09-01", 45, null))).toBe("45 min");
  });
});

describe("sessionKind", () => {
  it("reads a session stored before cardio existed as strength", () => {
    const { ctx } = loadApp();
    expect(ctx.sessionKind({ id: "x", date: "2026-08-01", day: "Push", exercises: [] })).toBe("strength");
    expect(ctx.sessionKind(undefined)).toBe("strength");
    expect(ctx.sessionKind({ kind: "cardio" })).toBe("cardio");
  });
});

describe("sessionCard", () => {
  it("shows the activity and the summary for a cardio session, and no kilograms", () => {
    const { ctx } = loadApp();
    const html = ctx.sessionCard(cardio("2026-09-01", 45, 8.2));
    expect(html).toContain("Run");
    expect(html).toContain("45 min");
    expect(html).toContain("5:29 /km");
    expect(html).not.toContain("Volume:");
  });

  it("still shows volume for a strength session", () => {
    const { ctx } = loadApp();
    const html = ctx.sessionCard(strength("2026-09-01", 100));
    expect(html).toContain("Volume:");
    expect(html).toContain("Push");
  });

  it("escapes an activity name rather than writing it into the card as markup", () => {
    const { ctx } = loadApp();
    const s: any = cardio("2026-09-01", 30, null);
    s.activity = '<img src=x onerror=1>';
    expect(ctx.sessionCard(s)).not.toContain("<img");
  });
});

describe("a cardio session does not break the strength numbers", () => {
  it("weeklyVolumes counts kilograms and skips a session that has none", () => {
    const { ctx, stored } = loadApp();
    stored["marcus.sessions"] = JSON.stringify([strength("2026-08-31", 100), cardio("2026-08-31", 45, 8.2)]);
    const weeks = ctx.weeklyVolumes();
    expect(weeks).toHaveLength(1);
    expect(weeks[0][1]).toBe(100);
  });

  it("dailyLoads gives a cardio-only day a load of zero rather than throwing", () => {
    const { ctx } = loadApp();
    const loads = ctx.dailyLoads([cardio("2026-08-31", 45, 8.2)]);
    expect(loads["2026-08-31"]).toBe(0);
  });

  it("a cardio session still counts as a session for the streak", () => {
    const { ctx, stored } = loadApp({ now: new Date("2026-09-01T09:00:00Z") });
    stored["marcus.sessions"] = JSON.stringify([cardio("2026-09-01", 45, 8.2)]);
    expect(ctx.streak()).toBe(1);
  });
});
