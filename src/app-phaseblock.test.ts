import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-racecalendar-draft.test.ts. `replies` is consumed one
// per /api/plan-draft call, so a test can make the third week fail and check
// that the two before it stayed saved.
function loadApp(sent: string[], replies?: any[], failWriteFrom?: number): any {
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
  let writes = 0;
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      // A real phone runs out of room, and the only way to see what the app
      // says when it does is to make setItem throw the error it really throws.
      // Counted per key, so a test can say "the third planned week fails"
      // without knowing how many other stores the fixture wrote first.
      setItem: (k: string, v: string) => {
        if (k === "marcus.plannedWeeks") writes++;
        if (failWriteFrom && k === "marcus.plannedWeeks" && writes >= failWriteFrom) {
          const err: any = new Error("quota"); err.name = "QuotaExceededError"; throw err;
        }
        stored[k] = v;
      },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async (url: string, init: any) => {
      if (!String(url).includes("/api/plan-draft")) return { ok: true, json: async () => ({}) };
      sent.push(String(init && init.body));
      const next = replies && replies.length ? replies.shift() : null;
      if (next) return next;
      return { ok: true, json: async () => ({ days: [{ day: "Monday", focus: "Push", exercises: [] }], note: "" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      // toast writes to one element with no queue, so the LAST call wins on
      // his screen -- the test keeps them all and then checks which was last.
      "\n;globalThis.__toasts = [];" +
      "\n;const __toast = toast; toast = function (m) { globalThis.__toasts.push(String(m)); };" +
      "\n;globalThis.draftPhase = draftPhase;" +
      "\n;globalThis.phaseBlock = phaseBlock;" +
      "\n;globalThis.phaseBlockLabel = phaseBlockLabel;",
    ctx,
  );
  // Base ends in 40 days, Build in 90, the race in 120 -- so the block this
  // week opens on is Base, and it is followed by weeks of another phase.
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

const rows = (app: any) => JSON.parse(vm.runInContext("JSON.stringify(raceCalendar(store.get('goals')[0]))", app));
const block = (app: any, planned: string[] = []) =>
  JSON.parse(vm.runInContext(
    `JSON.stringify(phaseBlock(raceCalendar(store.get('goals')[0]), ${JSON.stringify(planned)}))`, app));

describe("the block a phase implies", () => {
  it("is every remaining week of this week's phase, and stops at the next one", () => {
    const app = loadApp([]);
    const weeks = rows(app);
    const got = block(app);
    const phase = weeks[0].phase;
    expect(phase).toBe("Base");
    // Never this week: Draft my week is that row's button.
    expect(got.map((w: any) => w.start)).not.toContain(weeks[0].start);
    // Exactly the run of same-phase rows directly after this week.
    let expected = 0;
    while (expected + 1 < weeks.length && weeks[expected + 1].phase === phase) expected++;
    expect(expected).toBeGreaterThan(1);
    expect(got).toHaveLength(expected);
    expect(got.every((w: any) => w.phase === phase)).toBe(true);
    // The first row it stopped before is genuinely another phase, not the end.
    expect(weeks[expected + 1].phase).not.toBe(phase);
  });

  it("skips a week already drafted ahead instead of ending there", () => {
    const app = loadApp([]);
    const weeks = rows(app);
    const whole = block(app);
    const holed = block(app, [whole[0].start]);
    expect(holed.map((w: any) => w.start)).toEqual(whole.slice(1).map((w: any) => w.start));
    // Skipping the FIRST one still reaches the last one -- it is a skip, not a stop.
    expect(holed[holed.length - 1].start).toBe(whole[whole.length - 1].start);
    expect(weeks.length).toBeGreaterThan(whole.length);
  });

  it("is empty when this week has no phase, and when there is no calendar", () => {
    const app = loadApp([]);
    expect(vm.runInContext("phaseBlock([{ start: '2026-01-05', phase: null }, { start: '2026-01-12', phase: 'Base' }], [])", app)).toHaveLength(0);
    expect(vm.runInContext("phaseBlock([{ start: '2026-01-05', phase: 'Base' }], [])", app)).toHaveLength(0);
    expect(vm.runInContext("phaseBlock([], [])", app)).toHaveLength(0);
    expect(vm.runInContext("phaseBlock(null, null)", app)).toHaveLength(0);
  });

  it("names the phase for a dated goal and only the horizon for an ongoing one", () => {
    const app = loadApp([]);
    const label = (weeks: any, n: number) => vm.runInContext(
      `phaseBlockLabel(${JSON.stringify(weeks)}, ${JSON.stringify(new Array(n).fill({}))})`, app);
    expect(label([{ phase: "Base" }], 3)).toBe("Draft the rest of the Base phase (3 weeks)");
    expect(label([{ phase: "Base" }], 1)).toBe("Draft the rest of the Base phase (1 week)");
    expect(label([{ phase: "Ongoing", ongoing: true }], 4)).toBe("Draft the next 4 weeks");
    expect(label([{ phase: "Base" }], 0)).toBe("");
  });
});

describe("drafting the block", () => {
  it("saves one planned week per row of the block, and asks for each row's own week", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    const want = block(app);
    const planBefore: string = vm.runInContext("JSON.stringify(store.get('plan'))", app);
    expect(typeof planBefore).toBe("string");
    expect(planBefore.length).toBeGreaterThan(20);
    await vm.runInContext("draftPhase('g1')", app);
    expect(sent).toHaveLength(want.length);
    const asked = sent.map(b => JSON.parse(b).calendarWeek.start);
    expect(asked).toEqual(want.map((w: any) => w.start));
    const planned = JSON.parse(vm.runInContext("JSON.stringify(store.get('plannedWeeks', []))", app));
    expect(planned.map((w: any) => w.start)).toEqual(want.map((w: any) => w.start));
    expect(planned.every((w: any) => w.days && w.days.length)).toBe(true);
    // It is a stack of drafts waiting for their Mondays, not a plan written
    // today -- the week he is training now is untouched.
    expect(vm.runInContext("JSON.stringify(store.get('plan'))", app)).toBe(planBefore);
  });

  it("keeps the weeks it already saved when a later one fails", async () => {
    const sent: string[] = [];
    const app = loadApp(sent, [null, null, { ok: false, json: async () => ({ error: "Marcus is out of words" }) }]);
    await vm.runInContext("draftPhase('g1')", app);
    const planned = JSON.parse(vm.runInContext("JSON.stringify(store.get('plannedWeeks', []))", app));
    expect(planned).toHaveLength(2);
    expect(sent).toHaveLength(3);
    // And it stopped rather than carrying on past the failure.
    const want = block(app, planned.map((w: any) => w.start));
    expect(want.length).toBeGreaterThan(0);
    expect(vm.runInContext("planDraftBusy", app)).toBe(false);
  });

  it("does not let its own closing toast replace the one about full storage", async () => {
    // store.set toasts the reason it failed, and this run toasts again after
    // the loop. toast has no queue, so whatever it says last is all he sees.
    const sent: string[] = [];
    const app = loadApp(sent, undefined, 3);
    const want = block(app);
    expect(want.length).toBeGreaterThan(2);
    await vm.runInContext("draftPhase('g1')", app);
    const toasts: string[] = vm.runInContext("__toasts", app);
    const last = toasts[toasts.length - 1];
    expect(toasts.some(t => t.includes("Storage is full"))).toBe(true);
    // The message he is left looking at has to carry BOTH facts: how far it
    // got, and the thing he can do about it.
    expect(last).toContain("Drafted 2 of");
    expect(last).toContain("delete some old entries");
    // Three asked for, two of them written down: it stopped at the failure
    // rather than carrying on asking Marcus for weeks it cannot keep.
    expect(sent).toHaveLength(3);
    expect(vm.runInContext("localStorage.getItem('marcus.plannedWeeks')", app)).toContain(want[1].start);
    expect(vm.runInContext("localStorage.getItem('marcus.plannedWeeks')", app)).not.toContain(want[2].start);
  });

  it("refuses to start while another draft is running, and says how far it has got", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    vm.runInContext("planDraftBusy = true", app);
    await vm.runInContext("draftPhase('g1')", app);
    expect(sent).toHaveLength(0);
    expect(JSON.parse(vm.runInContext("JSON.stringify(store.get('plannedWeeks', []))", app))).toHaveLength(0);
    // And the button he is looking at counts the week being written now, not
    // the ones already finished -- 1 of 4 the moment the first one starts.
    vm.runInContext("planDraftProgress = { done: 1, total: 4 }", app);
    const html: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(html).toContain("Marcus is writing 2 of 4");
    expect(html).toContain("disabled");
  });

  it("draws a block button on the calendar and drops it once the phase is drafted", async () => {
    const app = loadApp([]);
    const want = block(app);
    const before: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(before).toContain("draftPhase('g1')");
    expect(before).toContain(`Draft the rest of the Base phase (${want.length} weeks)`);
    await vm.runInContext("draftPhase('g1')", app);
    const after: string = vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]), 'g1')", app);
    expect(after).not.toContain("draftPhase('g1')");
    // A caller with no goal id gets no block button, same as the row buttons.
    expect(vm.runInContext("raceCalendarBlock(raceCalendar(store.get('goals')[0]))", app)).not.toContain("draftPhase(");
  });
});
