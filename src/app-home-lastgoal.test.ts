import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209, the end of the flow. `homeGoal()` deliberately keeps handing back
// the last goal once every target date has passed, so Home kept a heading that
// said "Next goal" over a race that had already happened -- and every other
// #209 feature goes quiet at that same moment, because the race calendar, the
// phase sentence and the volume trend all need a day still ahead. Nothing asked
// what was next. This is that ask, and it is a DIFFERENT card from the no-goal
// one (cycle 1470): telling a man who has raced "what are you training for?"
// reads as if Marcus forgot.
//
// Same vm harness as app-home-nogoal.test.ts.
function loadApp(): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const nodes: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (nodes[id] ??= makeNode()),
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
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);
const home = (app: any) => {
  run(app, "renderHome()");
  return run(app, "view.innerHTML") as string;
};

const raced = (targetDate: string) =>
  `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '${targetDate}', created: '2020-01-01', milestones: [{ id: 'm1', label: 'Base', note: 'aerobic base', date: '2020-04-01', done: false }] }])`;

describe("goalIsBehind", () => {
  it("is null while the day is still ahead, and on the day itself", () => {
    const app = loadApp();
    const g = (d: string) => `({ targetDate: '${d}' })`;
    expect(run(app, `goalIsBehind(${g("2026-09-20")}, '2026-09-12')`)).toBeNull();
    // The target day is the race. It is not behind him until it is over.
    expect(run(app, `goalIsBehind(${g("2026-09-12")}, '2026-09-12')`)).toBeNull();
  });

  it("counts the days once the day has gone", () => {
    const app = loadApp();
    expect(run(app, `goalIsBehind({ targetDate: '2026-09-11' }, '2026-09-12')`)).toEqual({ daysAgo: 1 });
    expect(run(app, `goalIsBehind({ targetDate: '2026-08-13' }, '2026-09-12')`)).toEqual({ daysAgo: 30 });
  });

  it("never reports an ongoing goal as behind, whatever the date", () => {
    // An ongoing goal has no day to pass, and draftGoals keeps it in front
    // forever -- so a fallback past one can never happen and a card that asked
    // "what is next?" over it would be wrong every day of its life.
    const app = loadApp();
    expect(run(app, `goalIsBehind({ targetDate: '' }, '2026-09-12')`)).toBeNull();
    expect(run(app, `goalIsBehind(null, '2026-09-12')`)).toBeNull();
  });
});

describe("Home once the race is behind him", () => {
  it("asks what is next instead of counting down to a day that has gone", () => {
    const app = loadApp();
    run(app, raced("2020-08-14"));
    // The precondition: there IS a goal, homeGoal falls back to it, and it is
    // genuinely past -- otherwise a passing assertion below proves nothing.
    expect(run(app, "goalsSorted().length")).toBe(1);
    expect(run(app, "homeGoal().id")).toBe("a");
    expect(run(app, "goalIsBehind(homeGoal())")).not.toBeNull();

    const html = home(app);
    expect(html).toContain("Your last goal");
    expect(html).toContain("Oslo Triathlon");
    expect(html).toContain("What is next?");
    expect(html).not.toContain("Next goal");
    // The no-goal card's question stays off this one: he told Marcus already.
    expect(html).not.toContain("What are you training for?");
    expect(html).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it("offers the chat first, the same order as the no-goal card", () => {
    const app = loadApp();
    run(app, raced("2020-08-14"));
    const html = home(app);
    expect(html).toContain('onclick="openChat()"');
    expect(html).toContain(`onclick="switchTab('plan')"`);
    expect(html.indexOf('onclick="openChat()"')).toBeLessThan(html.indexOf(`onclick="switchTab('plan')"`));
  });

  it("does not draw the stale phase line the countdown card draws", () => {
    // The old card showed the first unticked phase -- "Base phase through
    // 1 Apr 2020" -- which is the sort of line that makes an app look broken.
    const app = loadApp();
    run(app, raced("2020-08-14"));
    const html = home(app);
    expect(html).not.toContain("Base phase");
    expect(html).not.toContain("target date passed");
  });

  it("leaves the countdown card alone while the day is ahead", () => {
    const app = loadApp();
    run(app, raced("2099-08-14"));
    const html = home(app);
    expect(html).toContain("Next goal");
    expect(html).not.toContain("Your last goal");
    expect(html).not.toContain("What is next?");
  });

  it("prefers a goal still ahead over one behind, and says nothing of the sort", () => {
    const app = loadApp();
    run(app, `store.set('goals', [
      { id: 'old', text: 'Oslo Triathlon', targetDate: '2020-08-14', created: '2020-01-01', milestones: [] },
      { id: 'new', text: 'Bergen Half', targetDate: '2099-05-01', created: '2020-01-01', milestones: [] }
    ])`);
    expect(run(app, "homeGoal().id")).toBe("new");
    const html = home(app);
    expect(html).toContain("Bergen Half");
    expect(html).toContain("Next goal");
    expect(html).not.toContain("Your last goal");
  });

  it("says yesterday rather than 1 days ago", () => {
    const app = loadApp();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    run(app, raced(yesterday));
    const html = home(app);
    expect(html).toContain("was yesterday");
    expect(html).not.toContain("1 days ago");
  });
});
