import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-racecalendar-ongoing.test.ts. draftVolume,
// draftVolumeLabel and draftCard are pure over their arguments, so no DOM node
// is read back -- draftCard returns markup as a string on purpose.
function loadApp(): any {
  const stored: Record<string, string> = {};
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
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const TODAY = "2026-09-09";

// A log with one working weight per exercise. lastPerformance reduces to the
// heaviest set WITHIN one `exercises[]` entry, so the 80 kg on 09-02 is what a
// squat is projected at and not the 60 kg beside it. It also takes the heavier
// of two separate entries for the same exercise in one session -- a top set
// and a back-off set logged as two rows -- which it did not until cycle 1437;
// the test below the arithmetic ones holds that, because this projection
// multiplies whatever it returns by a whole week of sets.
const SESSIONS = [
  { date: "2026-08-26", exercises: [{ name: "Back Squat", sets: [{ reps: 5, weight: 70 }] }] },
  { date: "2026-09-02", exercises: [
    { name: "Back Squat", sets: [{ reps: 5, weight: 60 }, { reps: 5, weight: 80 }] },
    { name: "Barbell Bench Press", sets: [{ reps: 8, weight: 50 }] },
    { name: "Pull-up", sets: [{ reps: 6, weight: 0 }] },
  ] },
];

const DAYS = [
  { day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 4, reps: 5 }] },
  { day: "Wednesday", focus: "Push", exercises: [{ name: "Barbell Bench Press", sets: 3, reps: 8 }] },
];

// The requestDraft tests below go through the page's own `todayStr`, which is a
// const and cannot be stubbed, so their fixture is cut from the real clock: a
// goal whose four phases are ahead of today and four completed weeks of one
// session behind it, which is what gives weekTarget a baseline to size from.
// Local calendar fields, never `toISOString`: the page's own `todayStr` is
// built from getFullYear/getMonth/getDate, and app-core.js says in as many
// words why. A UTC fixture agrees with it only on a CI box running UTC, and
// disagrees by a day every evening in Oslo -- which silently moves a session
// out of the week bucket `weekTarget` buckets it into.
const shift = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
       + "-" + String(d.getDate()).padStart(2, "0");
};

const WEEKLY_LOG = [-7, -14, -21, -28].map(days => ({
  date: shift(days),
  exercises: [{ name: "Back Squat", sets: [{ reps: 5, weight: 80 }, { reps: 5, weight: 80 }] }],
}));

const DATED_GOAL = {
  id: "g-race", text: "Sprint triathlon", targetDate: shift(28), created: shift(-1),
  milestones: [
    { label: "Base", note: "", date: shift(7), done: false },
    { label: "Build", note: "", date: shift(14), done: false },
    { label: "Peak", note: "", date: shift(21), done: false },
    { label: "Taper", note: "", date: shift(28), done: false },
  ],
};

const WEEK = {
  phase: "Base", phaseEnds: "2026-10-10", multiplier: 1.1, baseline: 2000, baselineWeeks: 4,
  volumeTarget: 2200, volumeDone: 0, sessionsPlanned: 4, sessionsDone: 0, reason: "ok", note: null,
};

describe("draftVolume", () => {
  it("projects sets x reps x the last weight logged for that exercise", () => {
    // 4x5 at 80 = 1600, 3x8 at 50 = 1200.
    expect(loadApp().draftVolume(DAYS, SESSIONS, TODAY))
      .toEqual({ kg: 2800, known: 2, estimated: 0, unknown: 0 });
  });

  it("is the same arithmetic as a logged week, so the two are comparable", () => {
    const app = loadApp();
    const logged = { date: TODAY, exercises: [{ name: "Back Squat", sets: [
      { reps: 5, weight: 80 }, { reps: 5, weight: 80 }, { reps: 5, weight: 80 }, { reps: 5, weight: 80 }] }] };
    expect(app.draftVolume([DAYS[0]], SESSIONS, TODAY).kg).toBe(app.sessionVolume(logged));
  });

  it("gives whole kilograms, because the plates step in halves", () => {
    // 82.5 kg is a real bar (a 1.25 plate each side off 80), and 3 x 7 of it is
    // 1732.5 -- a projection is not precise enough to print half a kilogram.
    const sessions = [{ date: "2026-09-02",
      exercises: [{ name: "Back Squat", sets: [{ reps: 5, weight: 82.5 }] }] }];
    const days = [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 3, reps: 7 }] }];
    expect(loadApp().draftVolume(days, sessions, TODAY).kg).toBe(1733);
  });

  // Never zero, and no longer dropped either. Romanian Deadlift is a Legs lift
  // he has never logged; the only loaded Legs weight in SESSIONS is the 80 kg
  // squat, so 3 x 10 of it prices at 2400 and the projection says it estimated
  // one of the three. Zero remains the one answer this must never give -- it
  // reads as "this week is light" when the truth is the opposite.
  it("prices an exercise never logged from the rest of its muscle group", () => {
    const withNew = DAYS.concat([{ day: "Friday", focus: "Pull",
      exercises: [{ name: "Romanian Deadlift", sets: 3, reps: 10 }] }]);
    expect(loadApp().draftVolume(withNew, SESSIONS, TODAY))
      .toEqual({ kg: 5200, known: 2, estimated: 1, unknown: 0 });
  });

  // The group has to have a loaded lift in it. Back in SESSIONS is one pull-up
  // row at 0 kg, which is a real answer about the pull-up and says nothing
  // about what a pulldown weighs -- so this stays unknown rather than becoming
  // an estimate of zero, which is the exact reading the whole rule exists to
  // avoid.
  it("leaves an exercise unknown when its group holds nothing but bodyweight", () => {
    const days = [{ day: "Monday", focus: "Pull",
      exercises: [{ name: "Lat Pulldown", sets: 3, reps: 10 }] }];
    expect(loadApp().draftVolume(days, SESSIONS, TODAY))
      .toEqual({ kg: 0, known: 0, estimated: 0, unknown: 1 });
  });

  it("leaves an exercise unknown when nothing says which muscle it is", () => {
    const days = [{ day: "Monday", focus: "Odd",
      exercises: [{ name: "Sled Push", sets: 3, reps: 10 }] }];
    expect(loadApp().draftVolume(days, SESSIONS, TODAY))
      .toEqual({ kg: 0, known: 0, estimated: 0, unknown: 1 });
  });

  // The median, not the mean, and this fixture separates them. Back holds a
  // 180 kg deadlift beside a 60 kg row and a 50 kg pulldown: the median is 60
  // and the mean is 96.67, so a mean would price every new back exercise off
  // the one lift in the group that is nothing like the others. 3 x 10 at 60 is
  // 1800; at the mean it would have been 2900.
  it("takes the median of the group, so one heavy lift does not set the price", () => {
    const sessions = [{ date: "2026-09-02", exercises: [
      { name: "Deadlift", sets: [{ reps: 3, weight: 180 }] },
      { name: "Barbell Row", sets: [{ reps: 8, weight: 60 }] },
      { name: "Lat Pulldown", sets: [{ reps: 10, weight: 50 }] },
    ] }];
    const days = [{ day: "Monday", focus: "Pull",
      exercises: [{ name: "Face Pull", sets: 3, reps: 10 }] }];
    expect(loadApp().draftVolume(days, sessions, TODAY).kg).toBe(1800);
  });

  // Each exercise votes once, at its own last working weight. The squat here is
  // logged three weeks running and the other two lifts once each, so the
  // distinct weights are 50, 100 and 120 and the median is 100. Counting every
  // logged row instead would make the median 50 and let the lift he happens to
  // repeat most often set the price for the whole group.
  it("weights the median by exercise, not by how often each was logged", () => {
    const squat = (date: string) => ({ date,
      exercises: [{ name: "Back Squat", sets: [{ reps: 5, weight: 50 }] }] });
    const sessions = [squat("2026-08-19"), squat("2026-08-26"),
      { date: "2026-09-02", exercises: [
        { name: "Leg Press", sets: [{ reps: 10, weight: 100 }] },
        { name: "Calf Raise", sets: [{ reps: 12, weight: 120 }] },
      ] }];
    const days = [{ day: "Monday", focus: "Legs",
      exercises: [{ name: "Romanian Deadlift", sets: 2, reps: 5 }] }];
    expect(loadApp().draftVolume(days, sessions, TODAY).kg).toBe(1000);
  });

  it("does not price an estimate off a session logged after the day it is asked about", () => {
    const days = [{ day: "Monday", focus: "Legs",
      exercises: [{ name: "Romanian Deadlift", sets: 3, reps: 10 }] }];
    const later = SESSIONS.concat([{ date: "2026-09-20",
      exercises: [{ name: "Leg Press", sets: [{ reps: 10, weight: 200 }] }] }]);
    // 09-20 is after TODAY, so Legs is still just the 80 kg squat.
    expect(loadApp().draftVolume(days, later, TODAY).kg).toBe(2400);
  });

  it("counts a bodyweight row as known and adds nothing, the way the log does", () => {
    const days = [{ day: "Monday", focus: "Pull", exercises: [{ name: "Pull-up", sets: 3, reps: 6 }] }];
    expect(loadApp().draftVolume(days, SESSIONS, TODAY))
      .toEqual({ kg: 0, known: 1, estimated: 0, unknown: 0 });
  });

  it("does not see a session logged after the day it is asked about", () => {
    const later = SESSIONS.concat([{ date: "2026-09-20",
      exercises: [{ name: "Back Squat", sets: [{ reps: 5, weight: 200 }] }] }]);
    expect(loadApp().draftVolume([DAYS[0]], later, TODAY).kg).toBe(1600);
  });

  // The consequence of lastPerformance's same-session tie-break, at the level
  // where it is printed as a headline: a week of 4x5 squats projected off a
  // 100 kg top set is 2000 kg, and off the 80 kg back-off logged beside it,
  // 1600 -- a 400 kg gap on one exercise, which the card reads out as a share
  // of the week's target. Both orders, because the old rule took whichever row
  // was typed second and so was right by accident half the time.
  it("projects a two-row session off the top set, not the back-off set", () => {
    const app = loadApp();
    const rows = (a: any, b: any) => [{ date: "2026-09-02", exercises: [
      { name: "Back Squat", sets: [{ reps: a.reps, weight: a.weight }] },
      { name: "Back Squat", sets: [{ reps: b.reps, weight: b.weight }] },
    ] }];
    const top = { reps: 3, weight: 100 }, backoff = { reps: 8, weight: 80 };
    expect(app.draftVolume([DAYS[0]], rows(top, backoff), TODAY).kg).toBe(2000);
    expect(app.draftVolume([DAYS[0]], rows(backoff, top), TODAY).kg).toBe(2000);
  });

  it("reads an empty or malformed draft as nothing to project rather than throwing", () => {
    const app = loadApp();
    const none = { kg: 0, known: 0, estimated: 0, unknown: 0 };
    expect(app.draftVolume(null, SESSIONS, TODAY)).toEqual(none);
    expect(app.draftVolume([{ day: "Monday" }], SESSIONS, TODAY)).toEqual(none);
    expect(app.draftVolume([{ day: "Monday", exercises: [{ name: "  " }] }], SESSIONS, TODAY))
      .toEqual(none);
    expect(app.draftVolume([{ day: "Monday", exercises: [{ name: "Back Squat", sets: 0, reps: 5 }] }],
      SESSIONS, TODAY)).toEqual({ kg: 0, known: 0, estimated: 0, unknown: 1 });
  });
});

describe("draftVolumeLabel", () => {
  it("names the projection and its share of the week's own target", () => {
    const app = loadApp();
    const line = app.draftVolumeLabel(app.draftVolume(DAYS, SESSIONS, TODAY), WEEK);
    expect(line).toBe("About 2800 kg at your last weights — 127% of this week’s 2200 kg target.");
  });

  it("names a later week's target as that week's, not this week's", () => {
    const app = loadApp();
    const projection = app.draftVolume(DAYS, SESSIONS, TODAY);
    expect(app.draftVolumeLabel(projection, WEEK, true))
      .toBe("About 2800 kg at your last weights — 127% of that week’s 2200 kg target.");
    expect(app.draftVolumeLabel(projection, WEEK, false))
      .toContain("this week’s");
  });

  it("still gives the projection when the week has no target to check it against", () => {
    const app = loadApp();
    const projection = app.draftVolume(DAYS, SESSIONS, TODAY);
    for (const week of [undefined, null, { ...WEEK, reason: "too early", volumeTarget: null },
                        { ...WEEK, volumeTarget: 0 }, { ...WEEK, volumeTarget: "2200" }]) {
      expect(app.draftVolumeLabel(projection, week)).toBe("About 2800 kg at your last weights.");
    }
  });

  it("refuses a target from a week the page did not actually size", () => {
    // volumeTarget is only ever written beside reason 'ok'; a draft object that
    // arrives carrying a number under any other reason is describing a week
    // nothing computed, and quoting a share of it would invent a target.
    const app = loadApp();
    const projection = app.draftVolume(DAYS, SESSIONS, TODAY);
    for (const reason of ["too early", "unknown phase", "no goal", "phases done"]) {
      expect(app.draftVolumeLabel(projection, { ...WEEK, reason, volumeTarget: 2200 }))
        .toBe("About 2800 kg at your last weights.");
    }
  });

  it("says how many exercises it could not price, singular and plural", () => {
    const app = loadApp();
    expect(app.draftVolumeLabel({ kg: 2800, known: 2, estimated: 0, unknown: 1 }, null))
      .toContain("1 exercise is not counted \u2014 nothing comparable is logged either.");
    expect(app.draftVolumeLabel({ kg: 2800, known: 2, estimated: 0, unknown: 2 }, null))
      .toContain("2 exercises are not counted \u2014 nothing comparable is logged either.");
  });

  // An estimate is a weaker number than a logged one and the card has to say so
  // -- the whole reason `estimated` is a separate count from `known` is that it
  // reaches this sentence.
  it("says how many exercises were priced from their muscle group", () => {
    const app = loadApp();
    expect(app.draftVolumeLabel({ kg: 5200, known: 2, estimated: 1, unknown: 0 }, null))
      .toBe("About 5200 kg at your last weights."
        + " 1 exercise you have never logged is priced at your usual weight for that muscle.");
    expect(app.draftVolumeLabel({ kg: 5200, known: 2, estimated: 2, unknown: 0 }, null))
      .toContain("2 exercises you have never logged are priced at your usual weight for that muscle.");
  });

  // "at your last weights" is a claim about where the number came from, and for
  // a week made entirely of lifts he has never done it is simply false.
  it("does not say 'your last weights' about a week it priced entirely by estimate", () => {
    const app = loadApp();
    const line = app.draftVolumeLabel({ kg: 1800, known: 0, estimated: 1, unknown: 0 }, WEEK);
    expect(line).toContain("About 1800 kg at typical weights for those muscles");
    expect(line).not.toContain("your last weights");
    expect(app.draftVolumeLabel({ kg: 2800, known: 1, estimated: 1, unknown: 0 }, null))
      .toContain("at your last weights");
  });

  it("says nothing at all when it could price no exercise, rather than 'about 0 kg'", () => {
    const app = loadApp();
    expect(app.draftVolumeLabel({ kg: 0, known: 0, estimated: 0, unknown: 3 }, WEEK)).toBeNull();
    expect(app.draftVolumeLabel(null, WEEK)).toBeNull();
  });
});

// Driving requestDraft rather than handing draftCard a `week` by hand: the
// field crosses the fetch boundary, and every assertion either side of it
// passes with the draft forgetting its own target on the way through.
describe("requestDraft keeps the target it sent", () => {
  // `store`, `planDraft` and `requestDraft` are top-level bindings in the page,
  // which are lexical and not properties of the vm's global object -- reading
  // them off `ctx` gives undefined. Evaluating the name in the same context is
  // what reaches the page's own value.
  const evalIn = (app: any, code: string) => vm.runInContext(code, app);

  it("hands the draft card the same target object it posted to the coach", async () => {
    const sent: any[] = [];
    const app = loadApp();
    app.fetch = async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ days: DAYS, note: "" }) };
    };
    evalIn(app, "store.set('sessions', " + JSON.stringify(SESSIONS) + ")");
    await evalIn(app, "requestDraft()");
    expect(sent).toHaveLength(1);
    const week = evalIn(app, "planDraft.week");
    expect(week).toEqual(sent[0].week);
    expect(week).not.toBeNull();
    expect(evalIn(app, "draftCard(store.get('plan'), planDraft, store.get('sessions', []), '" + TODAY + "')"))
      .toContain("at your last weights");
  });

  it("keeps a later calendar row's own target, not this week's", async () => {
    const sent: any[] = [];
    const app = loadApp();
    app.fetch = async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ days: DAYS, note: "" }) };
    };
    evalIn(app, "store.set('sessions', " + JSON.stringify(WEEKLY_LOG) + ")");
    evalIn(app, "store.set('goals', " + JSON.stringify([DATED_GOAL]) + ")");
    const rows = evalIn(app, "raceCalendar(store.get('goals')[0], todayStr())");
    const later = rows.find((r: any) => r.phase === "Taper");
    expect(later).toBeTruthy();
    await evalIn(app, "requestDraft('" + DATED_GOAL.id + "', '" + later.start + "')");
    const week = evalIn(app, "planDraft.week");
    expect(week.phase).toBe("Taper");
    expect(week.multiplier).toBe(later.multiplier);
    // The Taper row cuts volume, so its target is not the one Home is showing.
    expect(week.volumeTarget).not.toBe(evalIn(app, "homeWeekTarget().volumeTarget"));
    expect(week).toEqual(sent[0].week);
  });
});

describe("the draft card", () => {
  it("carries the projection, so the card that asks for a target also answers it", () => {
    const app = loadApp();
    const plan = { days: [{ day: "Monday", focus: "Legs", exercises: [] },
                          { day: "Wednesday", focus: "Push", exercises: [] }] };
    const html = app.draftCard(plan, { days: DAYS, note: "", week: WEEK }, SESSIONS, TODAY);
    expect(html).toContain("About 2800 kg at your last weights");
    expect(html).toContain("this week’s 2200 kg target");
    // A card for a later week says so, because it is not the target Home shows.
    const later = app.draftCard(plan, { days: DAYS, note: "", week: WEEK, weekOf: "2026-10-05" },
                                SESSIONS, TODAY);
    expect(later).toContain("that week’s 2200 kg target");
  });

  it("draws no projection line when nothing in the draft can be priced", () => {
    // A bare "the line is absent" assertion passes against a build with the
    // whole feature deleted, because the old two-argument draftCard ignores the
    // extra arguments and draws no line for any input. The priceable card below
    // is what makes the absent one mean something: same card, same call, one
    // exercise swapped, and only the unpriceable one goes quiet.
    const app = loadApp();
    const plan = { days: [{ day: "Monday", focus: "Legs", exercises: [] }] };
    const unpriceable = [{ day: "Monday", focus: "Legs", exercises: [{ name: "Sled Push", sets: 3, reps: 10 }] }];
    const priceable = [{ day: "Monday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 3, reps: 10 }] }];
    const quiet = app.draftCard(plan, { days: unpriceable, note: "", week: WEEK }, SESSIONS, TODAY);
    const loud = app.draftCard(plan, { days: priceable, note: "", week: WEEK }, SESSIONS, TODAY);
    expect(loud).toContain("at your last weights");
    expect(quiet).not.toContain("at your last weights");
    expect(quiet).toContain("Sled Push");
  });
});
