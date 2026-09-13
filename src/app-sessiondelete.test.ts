import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same harness as app-clearlog.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// `sessionDeleteArmed` is a top-level `let` and is therefore NOT on the context,
// which is the right shape here -- every test below arms through
// `armDeleteSession` exactly the way the bin does.
function loadApp(): { ctx: any; toasts: string[] } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      content: { firstElementChild: { cloneNode: () => makeNode() }, cloneNode: () => makeNode() },
      appendChild() {},
      remove() {},
      closest: () => makeNode(),
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
    Math, JSON, Number, String, Array, Object, Date,
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
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;", ctx);
  return { ctx, toasts };
}

const strength = (id: string) => ({
  id, date: "2026-09-01", day: "Push",
  exercises: [
    { name: "Bench press", sets: [{ reps: 5, weight: 80 }, { reps: 5, weight: 80 }, { reps: 5, weight: 80 }] },
    { name: "Row", sets: [{ reps: 8, weight: 60 }] },
  ],
});
const cardio = (id: string) => ({ id, date: "2026-09-02", kind: "cardio", activity: "Run", minutes: 45, distance: 8.2 });

function seed(ctx: any, sessions: any[]) {
  ctx.store.set("sessions", sessions);
  ctx.store.set("deletions", []);
}

describe("the bin on a session card", () => {
  it("arms the card instead of deleting, so one tap can no longer empty a session", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1")]);
    const html = ctx.sessionCard(strength("s1"));
    expect(html).toContain("armDeleteSession('s1')");
    expect(html).not.toContain("deleteSession('s1')");
  });

  it("draws no confirm until the card is armed", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1")]);
    expect(ctx.sessionCard(strength("s1"))).not.toContain("Are you sure?");
  });
});

describe("an armed session card", () => {
  it("asks are you sure, says what is in the session, and takes the bin away", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1")]);
    ctx.armDeleteSession("s1");
    const html = ctx.sessionCard(strength("s1"));
    expect(html).toContain("Are you sure?");
    expect(html).toContain("2 exercises, 4 sets");
    expect(html).toContain("cannot be undone");
    expect(html).toContain("deleteSession('s1')");
    expect(html).toContain("cancelDeleteSession()");
    expect(html).not.toContain("armDeleteSession('s1')");
  });

  it("counts a cardio session by its own summary rather than by sets", () => {
    const { ctx } = loadApp();
    seed(ctx, [cardio("c1")]);
    ctx.armDeleteSession("c1");
    const html = ctx.sessionCard(cardio("c1"));
    expect(html).toContain("45 min");
    expect(html).not.toContain("exercises,");
  });

  it("arms one card only, so arming a second puts the first card back", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1"), strength("s2")]);
    ctx.armDeleteSession("s1");
    ctx.armDeleteSession("s2");
    expect(ctx.sessionCard(strength("s1"))).not.toContain("Are you sure?");
    expect(ctx.sessionCard(strength("s2"))).toContain("Are you sure?");
  });

  it("keeps the session when Keep it is tapped", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1")]);
    ctx.armDeleteSession("s1");
    ctx.cancelDeleteSession();
    expect(ctx.sessionCard(strength("s1"))).not.toContain("Are you sure?");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s1"]);
  });
});

describe("deleteSession", () => {
  it("deletes the session and records the tombstone once it is armed", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1"), strength("s2")]);
    ctx.armDeleteSession("s1");
    ctx.deleteSession("s1");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s2"]);
    expect(ctx.store.get("deletions", []).map((d: any) => d.id)).toEqual(["s1"]);
  });

  it("refuses and says so when nothing was armed", () => {
    const { ctx, toasts } = loadApp();
    seed(ctx, [strength("s1")]);
    ctx.deleteSession("s1");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s1"]);
    expect(ctx.store.get("deletions", [])).toEqual([]);
    expect(toasts.join(" ")).toContain("Tap the bin");
  });

  it("refuses a different session than the one armed", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1"), strength("s2")]);
    ctx.armDeleteSession("s1");
    ctx.deleteSession("s2");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s1", "s2"]);
  });

  it("disarms after deleting, so the next card needs arming of its own", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1"), strength("s2")]);
    ctx.armDeleteSession("s1");
    ctx.deleteSession("s1");
    ctx.deleteSession("s2");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s2"]);
  });
});

describe("leaving the screen", () => {
  it("disarms on a full redraw of the Log tab -- a confirm that outlived its screen is not an answer", () => {
    const { ctx } = loadApp();
    seed(ctx, [strength("s1")]);
    ctx.armDeleteSession("s1");
    ctx.renderLog();
    expect(ctx.sessionCard(strength("s1"))).not.toContain("Are you sure?");
    ctx.deleteSession("s1");
    expect(ctx.store.get("sessions", []).map((s: any) => s.id)).toEqual(["s1"]);
  });
});

describe("sessionDeleteSummary", () => {
  it("says nothing logged in it for a session with no exercises", () => {
    const { ctx } = loadApp();
    expect(ctx.sessionDeleteSummary({ id: "x", date: "2026-09-01", day: "Push", exercises: [] })).toBe("nothing logged in it");
  });

  it("writes one exercise and one set in the singular", () => {
    const { ctx } = loadApp();
    expect(ctx.sessionDeleteSummary({
      id: "x", date: "2026-09-01", day: "Push",
      exercises: [{ name: "Bench press", sets: [{ reps: 5, weight: 80 }] }],
    })).toBe("1 exercise, 1 set");
  });
});
