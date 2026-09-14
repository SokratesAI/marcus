import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #208: "after a logged session or week, Marcus proposes plan changes with
// an explicit reason". The proposals have existed since marcus#14 and the
// citations since marcus#53, and both have only ever been visible on the Plan
// tab. Home -- the tab the app opens on -- said nothing, so the review ran for
// a reader who was never told it had.
//
// Same vm harness as app-home-emptyweek.test.ts: app.js is a classic script, so
// its top-level declarations land on the context and the tests read them back.
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

// Four full weeks of Tuesday and Thursday sessions against a plan that also
// calls for Saturday: Saturday is planned and trained zero times, with no rest
// day used instead, which is planReview's 'rest' proposal. Dates are walked back
// from the app's own todayStr() so the fixture cannot age out of the 28-day
// window the way a pinned date would.
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

describe("homeReviewPrompt", () => {
  it("is null when the review proposed nothing, so Home stays quiet", () => {
    const app = loadApp();
    expect(run(app, `homeReviewPrompt({ weeks: 4, proposals: [], note: 'Nothing to change.' })`)).toBe(null);
    expect(run(app, `homeReviewPrompt(null)`)).toBe(null);
    expect(run(app, `homeReviewPrompt({})`)).toBe(null);
  });

  it("leads with proposals[0] rather than a second ranking of its own", () => {
    // planReview pushes in its own order of consequence. Home picking a
    // different one would make the two tabs disagree about what matters.
    const app = loadApp();
    const prompt: any = run(app, `homeReviewPrompt({ weeks: 4, proposals: [
      { id: 'phase', kind: 'phase', title: 'Resize the week for Build', reason: 'because' },
      { id: 'rest-Saturday', kind: 'rest', title: 'Make Saturday a rest day', reason: 'never trained' },
    ], note: '' })`);
    expect(prompt.title).toBe("Resize the week for Build");
    expect(prompt.kind).toBe("phase");
    expect(prompt.reason).toBe("because");
    expect(prompt.count).toBe(2);
  });
});

describe("Home says the review happened", () => {
  it("prints the proposal planReview actually produced, with its reason", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    const proposals: any[] = run(app, `${REVIEW}.proposals`);
    // The fixture has to produce something, or every assertion below is
    // satisfied by a page that says nothing at all.
    expect(proposals.length).toBeGreaterThan(0);
    const html = home(app);
    expect(html).toContain("Marcus suggests");
    expect(html).toContain(proposals[0].title);
    expect(html).toContain(proposals[0].reason);
    expect(html).toContain(`onclick="switchTab('plan')"`);
    expect(html).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it("counts every proposal, not only the one it printed", () => {
    const app = loadApp();
    run(app, KEPT_WEEKS);
    const count: number = run(app, `${REVIEW}.proposals.length`);
    const html = home(app);
    const chip = count === 1 ? "1 change" : `${count} changes`;
    expect(html).toContain(chip);
  });

  it("stays off the screen when there is nothing to propose", () => {
    // The demo week with nothing logged: under two weeks of sessions, no goal,
    // no injury, so planReview's early return proposes nothing.
    const app = loadApp();
    run(app, `store.set('plan', demoPlanTemplate()); store.set('sessions', []); store.set('goals', [])`);
    expect(run(app, `${REVIEW}.proposals.length`)).toBe(0);
    const html = home(app);
    expect(html).not.toContain("Marcus suggests");
  });

  it("does not put the proposal on the home-screen badge", () => {
    // openNudges counts things that go away on their own -- log the session and
    // the nudge is gone. A proposal stands until accepted and cannot be
    // dismissed, so counting it would pin the icon at 1 forever for anyone who
    // reads a suggestion and decides against it.
    const app = loadApp();
    run(app, KEPT_WEEKS);
    expect(run(app, `${REVIEW}.proposals.length`)).toBeGreaterThan(0);
    const nudges: any[] = run(app, `openNudges(store.get('plan'), store.get('sessions', []), todayStr())`);
    expect(nudges.every(n => n.kind !== "review" && n.kind !== "suggest")).toBe(true);
  });
});
