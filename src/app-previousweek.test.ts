import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-phaseblock.test.ts. `replies` is consumed one per
// /api/plan-draft call so a block can be made to draft distinguishable weeks.
function loadApp(sent: string[], replies?: any[]): any {
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
  const stored: Record<string, string> = {};
  let drafted = 0;
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async (url: string, init: any) => {
      if (!String(url).includes("/api/plan-draft")) return { ok: true, json: async () => ({}) };
      sent.push(String(init && init.body));
      const next = replies && replies.length ? replies.shift() : null;
      if (next) return next;
      drafted++;
      // Each drafted week is distinguishable, so a test can tell WHICH week
      // came back as the next call's previousWeek rather than only that one did.
      return { ok: true, json: async () => ({
        days: [{ day: "Monday", focus: "Push #" + drafted, exercises: [] }], note: "" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.draftPhase = draftPhase;" +
      "\n;globalThis.requestDraft = requestDraft;" +
      "\n;globalThis.previousDraftedWeek = previousDraftedWeek;",
    ctx,
  );
  vm.runInContext(`(() => {
    const t = todayStr();
    store.set('goals', [{ id: 'g1', text: 'Olympic triathlon', targetDate: shiftDay(t, 120), created: shiftDay(t, -30),
      milestones: [{ label: 'Base', note: '', date: shiftDay(t, 40), done: false },
                   { label: 'Build', note: '', date: shiftDay(t, 90), done: false },
                   { label: 'Taper', note: '', date: shiftDay(t, 120), done: false }] }]);
    store.set('sessions', [8, 15, 22].map(n => ({ date: shiftDay(t, -n),
      exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] }] })));
  })()`, ctx);
  return ctx;
}

const pick = (app: any, saved: any[], start: any) =>
  JSON.parse(vm.runInContext(
    `JSON.stringify(previousDraftedWeek(${JSON.stringify(saved)}, ${JSON.stringify(start)}))`, app));

const week = (start: string, extra: any = {}) =>
  Object.assign({ start, days: [{ day: "Monday", focus: "Push", exercises: [] }], label: "Base week 1 of 6" }, extra);

describe("which week a draft continues from", () => {
  it("is the nearest drafted week before it, never one at or after it", () => {
    const app = loadApp([]);
    const saved = [week("2026-01-05"), week("2026-01-12"), week("2026-01-26")];
    expect(pick(app, saved, "2026-01-19").start).toBe("2026-01-12");
    // The week being drafted is not its own previous week, and a later one is not either.
    expect(pick(app, saved, "2026-01-05")).toBe(null);
    expect(pick(app, saved, "2026-02-02").start).toBe("2026-01-26");
  });

  it("reaches back over a gap rather than giving up", () => {
    const app = loadApp([]);
    // Week 3 was never drafted; week 2 is still what week 4 builds on, and its
    // own date is carried so the distance is not guessed at.
    const got = pick(app, [week("2026-01-05"), week("2026-01-12")], "2026-01-26");
    expect(got.start).toBe("2026-01-12");
    expect(got.days).toHaveLength(1);
    expect(got.label).toBe("Base week 1 of 6");
  });

  it("does not depend on the list being in order", () => {
    const app = loadApp([]);
    const shuffled = [week("2026-01-26"), week("2026-01-05"), week("2026-01-12")];
    expect(pick(app, shuffled, "2026-01-19").start).toBe("2026-01-12");
    expect(pick(app, shuffled, "2026-02-02").start).toBe("2026-01-26");
  });

  it("ignores a saved row with nothing in it, and answers null when there is none", () => {
    const app = loadApp([]);
    expect(pick(app, [week("2026-01-05", { days: [] })], "2026-01-12")).toBe(null);
    expect(pick(app, [{ start: "2026-01-05" }], "2026-01-12")).toBe(null);
    expect(pick(app, [{ days: [{ day: "Monday" }] }], "2026-01-12")).toBe(null);
    expect(pick(app, [], "2026-01-12")).toBe(null);
    expect(pick(app, null as any, "2026-01-12")).toBe(null);
    expect(pick(app, [week("2026-01-05")], null as any)).toBe(null);
  });
});

describe("what a drafted week is sent with", () => {
  it("gives each week of a block the week drafted just before it", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await vm.runInContext("draftPhase('g1')", app);
    expect(sent.length).toBeGreaterThan(2);
    const bodies = sent.map(b => JSON.parse(b));
    // The first week of the block has nothing ahead of it to continue from.
    expect(bodies[0].previousWeek == null).toBe(true);
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i].previousWeek.start).toBe(bodies[i - 1].calendarWeek.start);
      // And it is the week that actually came back, not a placeholder.
      expect(bodies[i].previousWeek.days[0].focus).toBe("Push #" + i);
    }
  });

  it("sends none for this week, whose previous week is his own logged sessions", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await vm.runInContext("draftPhase('g1')", app);
    sent.length = 0;
    await vm.runInContext("requestDraft()", app);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]);
    expect(body.calendarWeek).toBe(undefined);
    expect(body.previousWeek).toBe(undefined);
  });
});
