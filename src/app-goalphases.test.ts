import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-phaseblock.test.ts. `reply` is what /api/goal-phases
// answers; `sent` collects the request bodies so a test can check what the goal
// card actually asked for.
function loadApp(sent: string[], reply?: any): any {
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
    fetch: async (url: string, init: any) => {
      if (!String(url).includes("/api/goal-phases")) return { ok: true, json: async () => ({}) };
      sent.push(String(init && init.body));
      return reply ?? { ok: true, json: async () => ({ milestones: PROPOSED, note: "Long runway." }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.__toasts = [];" +
      "\n;const __toast = toast; toast = function (m) { globalThis.__toasts.push(String(m)); };" +
      "\n;globalThis.requestGoalPhases = requestGoalPhases;" +
      "\n;globalThis.acceptGoalPhases = acceptGoalPhases;" +
      "\n;globalThis.declineGoalPhases = declineGoalPhases;",
    ctx,
  );
  // A race 200 days out, set 30 days ago -- long enough that the coached block
  // is worth asking for.
  vm.runInContext(`(() => {
    const t = todayStr();
    globalThis.__target = shiftDay(t, 200);
    store.set('goals', [{ id: 'g1', text: 'Olympic triathlon', targetDate: globalThis.__target,
      created: shiftDay(t, -30),
      milestones: [{ id: 'a', label: 'Base', note: 'foundation', date: shiftDay(t, 60), done: true },
                   { id: 'b', label: 'Build', note: 'intensity', date: shiftDay(t, 150), done: false },
                   { id: 'c', label: 'Taper', note: 'arrive fresh', date: globalThis.__target, done: false }] }]);
  })()`, ctx);
  return ctx;
}

// Dated by the server, so the last one is the race day itself. The vm rewrites
// the last date to the fixture's own target before each test that needs it.
const PROPOSED = [
  { label: "Aerobic base", note: "Long easy hours.", date: "2099-01-01" },
  { label: "Race specific", note: "Bricks at race pace.", date: "2099-02-01" },
  { label: "Taper", note: "Cut volume.", date: "2099-03-01" },
];

const goal = (app: any) => JSON.parse(vm.runInContext("JSON.stringify(store.get('goals')[0])", app));
const run = (app: any, code: string) => vm.runInContext(code, app);
/** The proposal the page holds, with its last date pinned onto the fixture's
 * own target day -- the server does that, and the accept gate checks it. */
const replyFor = (app: any) => {
  const target = run(app, "globalThis.__target");
  return { ok: true, json: async () => ({ milestones: PROPOSED.map((m, i) =>
    i === PROPOSED.length - 1 ? { ...m, date: target } : m), note: "Long runway." }) };
};

describe("asking Marcus to shape the phases", () => {
  it("offers the button only on a dated goal far enough out to periodise", () => {
    const app = loadApp([]);
    const ask = (g: any) => run(app, `goalPhasesAskable(${JSON.stringify(g)}, todayStr())`);
    const t = run(app, "todayStr()");
    const shift = (n: number) => run(app, `shiftDay(todayStr(), ${n})`);
    expect(ask({ targetDate: shift(200), created: shift(-30) })).toBe(true);
    // An ongoing goal has no span to share out.
    expect(ask({ targetDate: "", created: t })).toBe(false);
    // Under four weeks the app's own cut writes one straight Build; there is
    // nothing to periodise, and the server refuses the same question.
    expect(ask({ targetDate: shift(20), created: t })).toBe(false);
    // The Plan tab draws a card for every goal, passed ones included, so a race
    // that has gone would otherwise show a live button: 200 days wide, all of
    // it behind him, and the phases it comes back with end before today.
    expect(ask({ targetDate: shift(-40), created: shift(-240) })).toBe(false);
    // Today still counts -- a block can end this morning.
    expect(ask({ targetDate: t, created: shift(-240) })).toBe(true);
  });

  it("sends the goal, his calendar day and his records", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    await run(app, "requestGoalPhases('g1')");
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]);
    expect(body.goal.id).toBe("g1");
    expect(body.today).toBe(run(app, "todayStr()"));
    expect(body.context).toHaveProperty("sessions");
    expect(body.context).toHaveProperty("profile");
  });

  it("writes nothing to the goal until he accepts", async () => {
    const app = loadApp([]);
    const before = goal(app);
    await run(app, "requestGoalPhases('g1')");
    expect(goal(app)).toEqual(before);
    expect(run(app, "goalPhaseDraft && goalPhaseDraft.goalId")).toBe("g1");
  });

  it("replaces the phases on accept and carries the ticks he earned", async () => {
    const app = loadApp([], undefined);
    run(app, "globalThis.__unused = 0");
    // Re-point fetch at a reply dated onto this fixture's own target day.
    const pinned = replyFor(app);
    app.fetch = async (url: string) =>
      String(url).includes("/api/goal-phases") ? pinned : { ok: true, json: async () => ({}) };
    await run(app, "requestGoalPhases('g1')");
    run(app, "acceptGoalPhases()");
    const after = goal(app);
    expect(after.milestones.map((m: any) => m.label)).toEqual(["Aerobic base", "Race specific", "Taper"]);
    expect(after.phasesCoached).toBe(true);
    // Every phase gets an id, because `toggleMilestone` finds one by it.
    expect(after.milestones.every((m: any) => !!m.id)).toBe(true);
    // The first phase was ticked before; label-and-occurrence matching does not
    // carry a tick onto a phase with a different name, so it is honestly gone.
    expect(after.milestones[0].done).toBe(false);
    expect(run(app, "goalPhaseDraft")).toBe(null);
  });

  it("refuses to save onto a goal whose target day moved while the card was open", async () => {
    const app = loadApp([]);
    const pinned = replyFor(app);
    app.fetch = async (url: string) =>
      String(url).includes("/api/goal-phases") ? pinned : { ok: true, json: async () => ({}) };
    await run(app, "requestGoalPhases('g1')");
    // The other phone moves the race a week later.
    run(app, `(() => { const gs = store.get('goals'); gs[0].targetDate = shiftDay(gs[0].targetDate, 7); store.set('goals', gs); })()`);
    const before = goal(app);
    run(app, "acceptGoalPhases()");
    expect(goal(app).milestones).toEqual(before.milestones);
    expect(run(app, "globalThis.__toasts").slice(-1)[0]).toContain("target date moved");
    expect(run(app, "goalPhaseDraft")).toBe(null);
  });

  it("keeps the phases he has when he declines", async () => {
    const app = loadApp([]);
    const before = goal(app);
    await run(app, "requestGoalPhases('g1')");
    run(app, "declineGoalPhases()");
    expect(goal(app)).toEqual(before);
    expect(run(app, "goalPhaseDraft")).toBe(null);
  });

  it("says what went wrong and holds no proposal when the coach refuses", async () => {
    const app = loadApp([], { ok: false, json: async () => ({ error: "the coach did not shape the phases: no JSON" }) });
    await run(app, "requestGoalPhases('g1')");
    expect(run(app, "globalThis.__toasts").slice(-1)[0]).toContain("did not shape the phases");
    expect(run(app, "goalPhaseDraft")).toBe(null);
  });

  it("says on the card whether the phases are coached or cut", () => {
    const app = loadApp([]);
    const line = (g: any) => run(app, `goalPhaseSubtitle(${JSON.stringify(g)})`);
    expect(line({ targetDate: "2027-08-14" })).toContain("not coached yet");
    expect(line({ targetDate: "2027-08-14", phasesCoached: true })).toContain("shaped by Marcus");
    // The exact line, separator and all: renderPlan's ongoing-goal test pins it,
    // and "contains ongoing goal" passes whichever dash is in the middle.
    expect(line({ targetDate: "" })).toBe("No target date \u00b7 an ongoing goal, so there are no phases to cut");
  });
});
