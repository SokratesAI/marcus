import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #208: "Edvard always approves/rejects/edits; never auto-applied." A
// suggestion could be accepted and could not be turned down -- it stood on Home
// and the Plan tab until his log moved the numbers under it. These read the real
// review the app computes, never a title typed here, so a fixture that stops
// producing a proposal fails loudly instead of passing over an empty page.
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
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);
const home = (app: any) => {
  run(app, "renderHome()");
  return run(app, "view.innerHTML") as string;
};

// The review's own arguments, as renderHome and renderPlan both pass them. The
// tests read the real review through this rather than asserting a title they
// typed, so a change to planReview's ordering fails here instead of letting
// Home and the Plan tab drift apart in silence.
const REVIEW = `planReview(store.get('plan'), store.get('sessions', []), todayStr(), undefined, homeGoal())`;

const KEPT_WEEKS = `
  const p = emptyPlanTemplate();
  const put = (day, name) => { const d = p.days.find(x => x.day === day); d.focus = name; d.exercises = [{ name: 'Back Squat', sets: 3, reps: 5 }]; };
  put('Tuesday', 'Lower'); put('Thursday', 'Upper'); put('Saturday', 'Full body');
  store.set('plan', p);
  const sessions = [];
  for (let back = 1; back <= 26; back++) {
    const iso = shiftDay(todayStr(), -back);
    const wd = weekdayOf(iso);
    if (wd === 'Tuesday' || wd === 'Thursday') {
      sessions.push({ id: 's' + back, date: iso, label: wd + ' work',
                      exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 80 }, { reps: 5, weight: 80 }, { reps: 5, weight: 80 }] }] });
    }
  }
  store.set('sessions', sessions);
`;


const plan = (app: any) => {
  run(app, "renderPlan()");
  return run(app, "view.innerHTML") as string;
};

describe("saying no to a suggestion", () => {
  it("draws a No thanks button beside every Change the plan button", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    const proposals: any[] = run(app, `${REVIEW}.proposals`);
    expect(proposals.length).toBeGreaterThan(0);
    const html = plan(app);
    for (const p of proposals) expect(html).toContain(`onclick="declineProposal('${p.id}')"`);
    expect(html.match(/No thanks/g)!.length).toBe(html.match(/Change the plan/g)!.length);
  });

  it("takes it off Home and the Plan tab, and leaves the plan itself alone", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    const first: any = run(app, `${REVIEW}.proposals[0]`);
    const before = JSON.stringify(run(app, "store.get('plan')"));
    expect(home(app)).toContain(first.title);
    run(app, `declineProposal(${JSON.stringify(first.id)})`);
    expect(JSON.stringify(run(app, "store.get('plan')"))).toBe(before);
    expect(home(app)).not.toContain(first.title);
    expect(plan(app)).not.toContain(first.title);
  });

  it("says so on the Plan tab when he has declined all of them, instead of a blank", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    const ids: string[] = run(app, `${REVIEW}.proposals.map(p => p.id)`);
    ids.forEach(id => run(app, `declineProposal(${JSON.stringify(id)})`));
    const html = plan(app);
    expect(html).toContain("You said no to every suggestion");
    expect(home(app)).not.toContain("Marcus suggests");
  });

  it("asks again when the numbers behind the suggestion change", () => {
    // The key is the id AND the reason. Same id with a different reading is a
    // new observation, so it must not be hidden by the old no.
    const app = loadApp();
    const out: any[] = run(app, `withoutDeclined(
      [{ id: 'rest-Saturday', reason: 'trained on Saturday 0 times over 4 weeks' }],
      [{ key: declinedKey({ id: 'rest-Saturday', reason: 'trained on Saturday 0 times over 3 weeks' }), ts: 1 }])`);
    expect(out.length).toBe(1);
    const hidden: any[] = run(app, `withoutDeclined(
      [{ id: 'rest-Saturday', reason: 'trained on Saturday 0 times over 4 weeks' }],
      [{ key: declinedKey({ id: 'rest-Saturday', reason: 'trained on Saturday 0 times over 4 weeks' }), ts: 1 }])`);
    expect(hidden.length).toBe(0);
  });

  it("writes nothing for a suggestion that is no longer current", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    run(app, "declineProposal('no-such-proposal')");
    expect(run(app, "store.get('declinedProposals', [])").length).toBe(0);
  });

  it("syncs: a no on one phone survives a push from the other", () => {
    const app = loadApp();
    const merged: any = run(app, `mergeBackupData(
      { declinedProposals: [{ key: 'rest-Saturday\\nA', ts: 1 }] },
      { declinedProposals: [{ key: 'build\\nB', ts: 2 }, { key: 'rest-Saturday\\nA', ts: 1 }] })`);
    expect(merged.declinedProposals.map((d: any) => d.key)).toEqual(["rest-Saturday\nA", "build\nB"]);
    expect(run(app, "BACKUP_KEYS")).toContain("declinedProposals");
  });
});
