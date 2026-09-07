import { APP_SOURCE } from "./app-source.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same shape as app-validation.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// `byId` is returned as well because the food picker renders into #foodPicked
// and then reads #foodAmount back, and this stub does not parse HTML — a test
// that drives the picker has to set that input's value itself.
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
  // FOODS is read by every test here and recentMealCache is reassigned on each
  // render, so it is exposed as a getter rather than a snapshot.
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.FOODS = FOODS;" +
      "\n;Object.defineProperty(globalThis, 'recentMealCache', { get: () => recentMealCache });" +
      // `mealParse` is lexical too, and these tests drive the add/drop handlers
      // that read and write it, so it needs a setter as well as a getter.
      "\n;Object.defineProperty(globalThis, 'mealParse', { get: () => mealParse, set: (v) => { mealParse = v; } });" +
      "\n;Object.defineProperty(globalThis, 'logSentence', { get: () => logSentence, set: (v) => { logSentence = v; } });" +
      "\n;Object.defineProperty(globalThis, 'logKind', { get: () => logKind, set: (v) => { logKind = v; } });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

const PLAN = {
  days: [
    { day: "Sunday", focus: "Rest", exercises: [] },
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench Press", sets: 4, reps: 8 }, { name: "Overhead Press", sets: 3, reps: 10 }] },
    { day: "Tuesday", focus: "Pull", exercises: [{ name: "Deadlift", sets: 3, reps: 5 }] },
    { day: "Wednesday", focus: "Rest", exercises: [] },
    { day: "Thursday", focus: "Legs", exercises: [{ name: "Back Squat", sets: 4, reps: 6 }] },
    { day: "Friday", focus: "Upper", exercises: [{ name: "Lat Pulldown", sets: 3, reps: 10 }] },
    { day: "Saturday", focus: "Conditioning", exercises: [{ name: "Kettlebell Swing", sets: 4, reps: 20 }] },
  ],
};
// 2026-09-01 is a Tuesday, which is the Pull day above.
const TUE = "2026-09-01";

describe("parseSessionSentence — cardio", () => {
  it("reads Edvard's run sentence into an activity, a distance and an injury flag", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence(
      "I ran 7km today, got a small injury in my leg so I want to take it easy next run.",
      PLAN, TUE);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("cardio");
    expect(r.cardio.activity).toBe("Run");
    expect(r.cardio.distance).toBe(7);
    expect(r.date).toBe(TUE);
    expect(r.injury).toBe(true);
    // "take it easy next run" is about the next run. Reading a feel out of it
    // would write a report of this session that he never made.
    expect(r.feel).toBe(null);
  });

  it("leaves the duration null and names it as missing rather than deriving it from the distance", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("I ran 7km today", PLAN, TUE);
    expect(r.cardio.minutes).toBe(null);
    expect(r.missing).toContain("minutes");
  });

  it("reads a duration when it is there, and then nothing is missing", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("swam for 45 minutes yesterday", PLAN, TUE);
    expect(r.cardio.activity).toBe("Swim");
    expect(r.cardio.minutes).toBe(45);
    expect(r.cardio.distance).toBe(null);
    expect(r.missing).toEqual([]);
    expect(r.date).toBe("2026-08-31");
  });

  it("reads hours, including half an hour", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("biked 1.5 hours", PLAN, TUE).cardio.minutes).toBe(90);
    expect(ctx.parseSessionSentence("walked for half an hour", PLAN, TUE).cardio.minutes).toBe(30);
    expect(ctx.parseSessionSentence("rowed for an hour", PLAN, TUE).cardio.minutes).toBe(60);
  });

  it("does not read a bare m as metres, because that is how people write minutes", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 45 m", PLAN, TUE);
    expect(r.cardio.distance).toBe(null);
  });

  it("reads metres spelled out, as kilometres", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("swam 1500 metres", PLAN, TUE).cardio.distance).toBe(1.5);
  });

  it("prefers the named activity over a plan reference in the same sentence", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan's easy run today, 5 km", PLAN, TUE);
    expect(r.kind).toBe("cardio");
    expect(r.cardio.activity).toBe("Run");
  });
});

describe("parseSessionSentence — the plan", () => {
  it("reads Edvard's plan sentence into that day's exercises and a feel", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence(
      "I followed the training plan today, felt easy. Drank a lot of water", PLAN, TUE);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("strength");
    expect(r.day).toBe("Tuesday");
    expect(r.exercises).toEqual([{ name: "Deadlift", sets: 3, reps: 5 }]);
    expect(r.feel).toBe("easy");
    expect(r.injury).toBe(false);
    expect(r.note).toBe("I followed the training plan today, felt easy. Drank a lot of water");
  });

  it("names the weight as missing, because a plan carries sets and reps and no kilos", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("followed the plan", PLAN, TUE);
    expect(r.missing).toEqual(["weight"]);
  });

  it("resolves a weekday backwards to the session you already did", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan on Thursday", PLAN, TUE);
    expect(r.day).toBe("Thursday");
    expect(r.date).toBe("2026-08-27");
  });

  it("refuses a plan day with nothing on it instead of saving an empty session", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("followed the plan yesterday", PLAN, "2026-09-03");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Wednesday");
  });
});

describe("parseSessionSentence — refusing to guess", () => {
  it("refuses a sentence that names neither an activity nor the plan", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("felt pretty good about things today", PLAN, TUE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not tell");
  });

  it("refuses an empty sentence", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("  ", PLAN, TUE).ok).toBe(false);
  });
});

describe("sessionSentenceSummary", () => {
  it("says the duration is missing rather than leaving the blank silent", () => {
    const { ctx } = loadApp();
    const s = ctx.sessionSentenceSummary(ctx.parseSessionSentence("ran 7 km today", PLAN, TUE));
    expect(s).toContain("Run");
    expect(s).toContain("7 km");
    expect(s).toContain("duration");
  });

  it("says the plan carries no weights", () => {
    const { ctx } = loadApp();
    const s = ctx.sessionSentenceSummary(ctx.parseSessionSentence("followed the plan today", PLAN, TUE));
    expect(s).toContain("Tuesday");
    expect(s).toContain("weights");
  });

  it("is empty for a refusal", () => {
    const { ctx } = loadApp();
    expect(ctx.sessionSentenceSummary({ ok: false, reason: "no" })).toBe("");
  });
});

describe("sessionNote", () => {
  it("carries the feel and the injury flag when the note is still the sentence", () => {
    const { ctx, byId } = loadApp();
    const parsed = ctx.parseSessionSentence("ran 7 km today, sore knee, felt hard", PLAN, TUE);
    ctx.logSentence = parsed;
    byId["logNote"] = { value: parsed.note };
    expect(ctx.sessionNote()).toEqual({ note: parsed.note, feel: "hard", injury: true });
  });

  it("drops the flags when the note was edited, because the words no longer say it", () => {
    const { ctx, byId } = loadApp();
    const parsed = ctx.parseSessionSentence("ran 7 km today, sore knee", PLAN, TUE);
    ctx.logSentence = parsed;
    byId["logNote"] = { value: "ran 7 km today" };
    expect(ctx.sessionNote()).toEqual({ note: "ran 7 km today" });
  });

  it("writes nothing at all when the note box is empty", () => {
    const { ctx, byId } = loadApp();
    ctx.logSentence = null;
    byId["logNote"] = { value: "  " };
    expect(ctx.sessionNote()).toEqual({});
  });
});

describe("renderLog with a sentence in hand", () => {
  // The shared stub cannot clone a <template>, so the exercise rows get a
  // minimal one here. Everything else is the real render path.
  function stubTemplate(byId: Record<string, any>) {
    byId["tpl-log-exercise-row"] = {
      content: {
        cloneNode: () => ({
          querySelector: () => ({ value: "", dataset: {}, addEventListener() {}, closest: () => ({ remove() {} }) }),
        }),
      },
    };
  }

  it("renders the cardio form from a run sentence without throwing", () => {
    const { ctx } = loadApp();
    ctx.store.set("plan", PLAN);
    const cardio = ctx.parseSessionSentence("ran 7 km today", PLAN, TUE);
    ctx.logSentence = { ...cardio, summary: ctx.sessionSentenceSummary(cardio) };
    ctx.logKind = "cardio";
    expect(() => ctx.renderLog()).not.toThrow();
  });

  it("renders the strength form from a plan sentence without throwing", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    stubTemplate(byId);
    const strength = ctx.parseSessionSentence("followed the plan today", PLAN, TUE);
    ctx.logSentence = { ...strength, summary: ctx.sessionSentenceSummary(strength) };
    ctx.logKind = "strength";
    expect(() => ctx.renderLog()).not.toThrow();
  });

  it("still renders with no sentence read at all", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    stubTemplate(byId);
    ctx.logSentence = null;
    ctx.logKind = "strength";
    expect(() => ctx.renderLog()).not.toThrow();
  });
});

describe("a feel is read from what you did, not from what you plan to do", () => {
  it("ignores easy in a clause about the next session", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km, want to take it easy next time", PLAN, TUE).feel).toBe(null);
  });

  it("still reads a feel from the clause about this session", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 5 km, felt hard, will take it easy next run", PLAN, TUE);
    expect(r.feel).toBe("hard");
  });

  it("reads a plain feel with no future clause at all", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km, felt easy", PLAN, TUE).feel).toBe("easy");
  });

  it("keeps the injury flag, which is about what already happened", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 5 km, sore knee, want to take it easy next run", PLAN, TUE);
    expect(r.injury).toBe(true);
    expect(r.feel).toBe(null);
  });
});

describe("which half of a sentence the feel comes from", () => {
  it("reads the feel before a 'so', when the intention follows it", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km felt hard so I will rest tomorrow", PLAN, TUE).feel).toBe("hard");
  });

  it("reads the feel before a 'but'", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km felt good but I want to go harder", PLAN, TUE).feel).toBe("good");
  });

  it("drops a feel in a bare intention with no future time word", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km, want to take it easy", PLAN, TUE).feel).toBe(null);
  });

  it("drops a feel in a bare future time clause with no intention phrase", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("ran 5 km, next run easy", PLAN, TUE).feel).toBe(null);
  });

  it("still reads an injury named in a forward-looking clause, because the injury is real either way", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 5 km, will rest tomorrow because my knee is sore", PLAN, TUE);
    expect(r.injury).toBe(true);
  });
});

// ---------- exercise detail typed into the sentence (idea #220) ----------
// The half of #220 that was left unbuilt for five days: until now the only way
// to get strength rows out of a sentence was to say "I followed the plan", and
// the rows were the plan's, not what was actually lifted.

describe("parseSessionSentence — sets, reps and weight from the sentence", () => {
  it("reads the row this idea names by title", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("3x10 squats at 80kg", PLAN, TUE);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("strength");
    expect(r.source).toBe("sentence");
    expect(r.exercises).toEqual([{ name: "Squats", sets: 3, reps: 10, weight: 80 }]);
    // Nothing is missing: the sentence carried the kilos itself.
    expect(r.missing).toEqual([]);
  });

  it("reads several exercises out of one sentence, with the name after the numbers or before them", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did 3x10 squats at 80kg and bench press 3x8 at 60 kg", PLAN, TUE);
    expect(r.exercises).toEqual([
      { name: "Squats", sets: 3, reps: 10, weight: 80 },
      { name: "Bench press", sets: 3, reps: 8, weight: 60 },
    ]);
  });

  it("leaves the weight off a row that did not carry one, and says so rather than inventing a kilo", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("3x10 squats at 80kg, 3x12 lunges", PLAN, TUE);
    expect(r.exercises[1]).toEqual({ name: "Lunges", sets: 3, reps: 12 });
    expect(r.missing).toEqual(["weight"]);
    expect(ctx.sessionSentenceSummary({ ...r, summary: "" })).toContain("type what you lifted");
  });

  it("reads 'sets of' as well as the x form", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("5 sets of 5 deadlifts at 100kg", PLAN, TUE).exercises).toEqual([
      { name: "Deadlifts", sets: 5, reps: 5, weight: 100 },
    ]);
  });

  it("does not cut a decimal weight in half on its own comma", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("3x10 squats at 82,5 kg", PLAN, TUE).exercises).toEqual([
      { name: "Squats", sets: 3, reps: 10, weight: 82.5 },
    ]);
  });

  it("carries the date, the feel and the injury flag the same way a plan sentence does", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("yesterday I did 3x5 deadlifts at 120kg, felt hard, my back is sore", PLAN, TUE);
    expect(r.date).toBe("2026-08-31");
    expect(r.feel).toBe("hard");
    expect(r.injury).toBe(true);
  });

  it("beats a plan reference in the same sentence, because it is what was actually done", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("followed the plan today, 3x10 squats at 80kg", PLAN, TUE);
    expect(r.source).toBe("sentence");
    expect(r.exercises).toEqual([{ name: "Squats", sets: 3, reps: 10, weight: 80 }]);
  });

  it("refuses a sentence that describes a run and lifting at once instead of dropping one of them", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 5 km and did 3x10 squats at 80kg", PLAN, TUE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("one at a time");
  });

  it("does not read a cardio sentence as an exercise row", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("ran 7km today in 45 minutes", PLAN, TUE);
    expect(r.kind).toBe("cardio");
  });

  it("says the rows back in the summary rather than counting them", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("3x10 squats at 80kg", PLAN, TUE);
    expect(ctx.sessionSentenceSummary(r)).toContain("3×10 Squats at 80 kg");
  });
});

describe("a weight named for an exercise the plan already carries", () => {
  it("fills the plan's rows in and then nothing is missing", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan today, deadlift at 140kg", PLAN, TUE);
    expect(r.source).toBe("plan");
    expect(r.exercises).toEqual([{ name: "Deadlift", sets: 3, reps: 5, weight: 140 }]);
    expect(r.missing).toEqual([]);
  });

  it("still asks for the weights it was not told, one row at a time", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan, bench press at 70kg", PLAN, "2026-08-31");
    expect(r.day).toBe("Monday");
    expect(r.exercises).toEqual([
      { name: "Bench Press", sets: 4, reps: 8, weight: 70 },
      { name: "Overhead Press", sets: 3, reps: 10 },
    ]);
    expect(r.missing).toEqual(["weight"]);
  });

  it("does not put a number from elsewhere in the sentence onto a plan row", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan today, drank 2 kg of water afterwards", PLAN, TUE);
    expect(r.exercises).toEqual([{ name: "Deadlift", sets: 3, reps: 5 }]);
    expect(r.missing).toEqual(["weight"]);
  });
});

describe("what the exercise parser refuses to guess", () => {
  it("does not read a bare number as kilos — the unit is what makes it a weight", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("3x10 squats at 80", PLAN, TUE);
    // Still the right exercise: the number is dropped, not the row.
    expect(r.exercises).toEqual([{ name: "Squats", sets: 3, reps: 10 }]);
    expect(r.missing).toEqual(["weight"]);
  });

  it("does not invent an exercise out of a segment that is only numbers", () => {
    const { ctx } = loadApp();
    expect(ctx.parseSessionSentence("3x10 at 80kg", PLAN, TUE).ok).toBe(false);
  });

  it("does not read a bare number as kilos on a plan row either", () => {
    const { ctx } = loadApp();
    const r = ctx.parseSessionSentence("did the plan today, deadlift at 140", PLAN, TUE);
    expect(r.exercises).toEqual([{ name: "Deadlift", sets: 3, reps: 5 }]);
  });
});

describe("the kilos reach the form, not just the summary", () => {
  // A recording version of the template stub above: each cloned row keeps one
  // node per selector, so the test can read back what the render actually wrote
  // into the weight input. Without this the prefill is invisible to every test.
  function recordingTemplate(byId: Record<string, any>) {
    const rows: Array<Record<string, any>> = [];
    byId["tpl-log-exercise-row"] = {
      content: {
        cloneNode: () => {
          // Seeded with all four inputs, so "the render never touched this one"
          // is a blank value rather than a missing key.
          const fields: Record<string, any> = {};
          for (const sel of [".ex-name", ".ex-sets", ".ex-reps", ".ex-weight", ".ex-remove", ".ex-form"]) {
            fields[sel] = { value: "", dataset: {}, addEventListener() {}, closest: () => ({ remove() {} }) };
          }
          rows.push(fields);
          return {
            querySelector: (sel: string) =>
              (fields[sel] ??= { value: "", dataset: {}, addEventListener() {}, closest: () => ({ remove() {} }) }),
          };
        },
      },
    };
    return rows;
  }

  it("puts a weight read out of the sentence into the row's kg input", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    // No history, so the only thing that can put a number in a kg box here is
    // the sentence. The Log tab also prefills an empty box from the last time
    // you did the lift, which is a different question and is tested below.
    ctx.store.set("sessions", []);
    const rows = recordingTemplate(byId);
    const heard = ctx.parseSessionSentence("3x10 squats at 80kg and 3x12 lunges", PLAN, TUE);
    ctx.logSentence = { ...heard, summary: ctx.sessionSentenceSummary(heard) };
    ctx.logKind = "strength";
    ctx.renderLog();
    expect(rows.length).toBe(2);
    expect(rows[0][".ex-name"].value).toBe("Squats");
    expect(rows[0][".ex-sets"].value).toBe(3);
    expect(rows[0][".ex-reps"].value).toBe(10);
    expect(rows[0][".ex-weight"].value).toBe(80);
    // The row the sentence gave no kilos for stays blank rather than borrowing
    // the one above it.
    expect(rows[1][".ex-weight"].value).toBe("");
  });

  it("leaves every weight blank when the sentence carried none", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    ctx.store.set("sessions", []);
    const rows = recordingTemplate(byId);
    const heard = ctx.parseSessionSentence("followed the plan today", PLAN, TUE);
    ctx.logSentence = { ...heard, summary: ctx.sessionSentenceSummary(heard) };
    ctx.logKind = "strength";
    ctx.renderLog();
    expect(rows.length).toBe(1);
    expect(rows[0][".ex-weight"].value).toBe("");
  });

  it("fills an empty kg box with what you lifted last time", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    ctx.store.set("sessions", [
      { id: "s1", date: "2026-01-05", kind: "strength", day: "Tuesday",
        exercises: [{ name: "Deadlift", sets: [{ reps: 5, weight: 82.5 }] }] },
    ]);
    const rows = recordingTemplate(byId);
    const heard = ctx.parseSessionSentence("followed the plan today", PLAN, TUE);
    ctx.logSentence = { ...heard, summary: ctx.sessionSentenceSummary(heard) };
    ctx.logKind = "strength";
    ctx.renderLog();
    expect(rows.length).toBe(1);
    // The precondition: the sentence carried no weight, so 82.5 can only have
    // come out of the session above -- the test right before this one is the
    // control, same sentence and an empty history, and it reads "".
    expect(rows[0][".ex-name"].value).toBe("Deadlift");
    expect(rows[0][".ex-weight"].value).toBe("82.5");
  });

  it("re-reads history when the exercise name is retyped", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    ctx.store.set("sessions", [
      { id: "s1", date: "2026-01-05", kind: "strength", day: "Thursday",
        exercises: [{ name: "Back Squat", sets: [{ reps: 6, weight: 95 }] }] },
    ]);
    // A template stub that keeps the listeners as well as the values, so the
    // typing can actually be replayed. The plain recordingTemplate above drops
    // them, which is why removing the listener survived every other test here.
    const rows: Array<Record<string, any>> = [];
    byId["tpl-log-exercise-row"] = {
      content: {
        cloneNode: () => {
          const fields: Record<string, any> = {};
          const make = () => {
            const node: any = {
              value: "", textContent: "", hidden: false, dataset: {} as Record<string, string>, listeners: {} as Record<string, any[]>,
              addEventListener(evt: string, fn: any) { (node.listeners[evt] ??= []).push(fn); },
              closest: () => ({ remove() {} }),
            };
            return node;
          };
          for (const sel of [".ex-name", ".ex-sets", ".ex-reps", ".ex-weight", ".ex-rpe", ".ex-remove", ".ex-warmup", ".ex-last", ".ex-form"]) {
            fields[sel] = make();
          }
          rows.push(fields);
          return { querySelector: (sel: string) => (fields[sel] ??= make()) };
        },
      },
    };
    ctx.logSentence = null;
    ctx.logKind = "strength";
    ctx.renderLog();
    const row = rows[0];
    // The precondition: the row the plan opened with is NOT the lift in the
    // history, so the line starts empty and the retype is what finds it.
    expect(row[".ex-name"].value).not.toBe("Back Squat");
    expect(row[".ex-last"].hidden).toBe(true);
    row[".ex-name"].value = "back  SQUAT";
    for (const fn of row[".ex-name"].listeners["input"]) fn();
    expect(row[".ex-last"].hidden).toBe(false);
    expect(row[".ex-last"].textContent).toContain("Last time 95 kg × 6");
  });

  it("does not let history overwrite a weight the sentence gave", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("plan", PLAN);
    ctx.store.set("sessions", [
      { id: "s1", date: "2026-01-05", kind: "strength", day: "Tuesday",
        exercises: [{ name: "Squats", sets: [{ reps: 10, weight: 82.5 }] }] },
    ]);
    const rows = recordingTemplate(byId);
    const heard = ctx.parseSessionSentence("3x10 squats at 80kg", PLAN, TUE);
    ctx.logSentence = { ...heard, summary: ctx.sessionSentenceSummary(heard) };
    ctx.logKind = "strength";
    ctx.renderLog();
    expect(rows[0][".ex-weight"].value).toBe(80);
  });
});
