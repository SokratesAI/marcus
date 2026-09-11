import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-plandraft.test.ts, plus a fetch that records what the
// Draft button sends. The server counts phase weeks from the day in that body,
// because its own clock is UTC and his is Oslo.
function loadApp(sent: string[]): any {
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
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    // Loading the app fetches its stored state as well; only the draft call counts.
    fetch: async (url: string, init: any) => {
      if (String(url).includes("/api/plan-draft")) sent.push(String(init && init.body));
      return { ok: true, json: async () => ({ days: [], note: "" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.requestDraft = requestDraft;globalThis.todayStr = todayStr;", ctx);
  return ctx;
}

describe("the Draft button", () => {
  it("sends his own calendar day with the goals", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await app.requestDraft();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.today).toBe(app.todayStr());
    expect(Array.isArray(body.goals)).toBe(true);
  });

  it("sends the kilogram target the Home card is showing, so the draft is sized to it", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    // A goal in its Base phase and three completed weeks of lifting, so the
    // card has a real target rather than "too early".
    vm.runInContext(`(() => {
      const t = todayStr();
      store.set('goals', [{ text: 'Olympic triathlon', targetDate: shiftDay(t, 120), created: shiftDay(t, -30),
        milestones: [{ label: 'Base', note: '', date: shiftDay(t, 40), done: false },
                     { label: 'Taper', note: '', date: shiftDay(t, 120), done: false }] }]);
      store.set('sessions', [8, 15, 22].map(n => ({ date: shiftDay(t, -n),
        exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] }] })));
    })()`, app);
    await app.requestDraft();
    const body = JSON.parse(sent[0]);
    const expected = vm.runInContext(
      "weekTarget(goalsSorted()[0], store.get('plan'), store.get('sessions', []), todayStr())", app);
    expect(expected.reason).toBe("ok");
    expect(expected.phase).toBe("Base");
    expect(body.week).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});
