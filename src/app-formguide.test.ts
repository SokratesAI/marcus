import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same seam as app-glossary.test.ts: the guide is pure data plus three string
// functions, so app-core.js is evaluated alone with no DOM.
function loadCore(): any {
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, RegExp,
    document: undefined, navigator: {},
    localStorage: (() => {
      const mem: Record<string, string> = {};
      return { getItem: (k: string) => (k in mem ? mem[k] : null), setItem: (k: string, v: string) => { mem[k] = v; } };
    })(),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    appFile("app-core.js") +
      "\n;globalThis.FORM_GUIDE = FORM_GUIDE;" +
      "\n;globalThis.formGuide = formGuide;" +
      "\n;globalThis.formGuideBody = formGuideBody;" +
      "\n;globalThis.BARBELL_LIFTS = BARBELL_LIFTS;" +
      "\n;globalThis.MUSCLE_GROUPS = MUSCLE_GROUPS;" +
      "\n;globalThis.muscleGroupFor = muscleGroupFor;" +
      "\n;globalThis.seededPlan = store.get('plan');",
    ctx,
  );
  return ctx;
}

describe("form guide data", () => {
  const app = loadCore();

  it("gives every entry setup, execution and at least one mistake", () => {
    expect(app.FORM_GUIDE.length).toBeGreaterThan(0);
    for (const e of app.FORM_GUIDE) {
      expect(typeof e.name).toBe("string");
      expect(e.name.trim().length).toBeGreaterThan(0);
      expect(e.setup.trim().length).toBeGreaterThan(20);
      expect(e.execution.trim().length).toBeGreaterThan(20);
      expect(Array.isArray(e.mistakes)).toBe(true);
      expect(e.mistakes.length).toBeGreaterThan(0);
    }
  });

  it("names each exercise once across every spelling", () => {
    const seen = new Set<string>();
    for (const e of app.FORM_GUIDE) {
      for (const word of [e.name, ...(e.aka || [])]) {
        const key = String(word).trim().toLowerCase().replace(/\s+/g, " ");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  // The boundary that decides whether this feature is ever seen: the guide is
  // written for the lifts the seeded plan actually names. A plan exercise with
  // no guide is a row where the icon never appears.
  it("covers every exercise the seeded plan names", () => {
    const planned: string[] = [];
    for (const day of app.seededPlan.days || []) {
      for (const ex of day.exercises || []) planned.push(ex.name);
    }
    expect(planned.length).toBeGreaterThan(10);
    const missing = planned.filter((name) => app.formGuide(name) === null);
    expect(missing).toEqual([]);
  });
});

describe("formGuide lookup", () => {
  const app = loadCore();

  it("matches case- and space-insensitively, like exerciseKey", () => {
    expect(app.formGuide("back squat").name).toBe("Back Squat");
    expect(app.formGuide("  BACK   SQUAT ").name).toBe("Back Squat");
  });

  it("resolves an alternate spelling to the same entry", () => {
    expect(app.formGuide("Squat")).toBe(app.formGuide("Back Squat"));
    expect(app.formGuide("RDL")).toBe(app.formGuide("Romanian Deadlift"));
  });

  // Front Squat is a different lift from Back Squat and now has cues of its
  // own, so the thing to hold is that it never inherits the back squat's.
  it("does not match a different lift that contains a known name", () => {
    expect(app.formGuide("Front Squat")).not.toBe(app.formGuide("Back Squat"));
    expect(app.formGuide("Front Squat").name).toBe("Front Squat");
    expect(app.formGuide("Deadlift Variation")).toBe(null);
    expect(app.formGuide("Squat Jump")).toBe(null);
  });

  it("returns null for an empty or missing name", () => {
    expect(app.formGuide("")).toBe(null);
    expect(app.formGuide("   ")).toBe(null);
    expect(app.formGuide(null)).toBe(null);
    expect(app.formGuide(undefined)).toBe(null);
  });
});

// Two tables in this file name the same lifts for different reasons, and until
// now nothing compared them. `BARBELL_LIFTS` decides whether the Log row can
// tell you how to load the bar; `FORM_GUIDE` decides whether that row has cues
// AND -- through `muscleGroupFor`, which reads the guide entry's `group` and
// nothing else -- whether the sets count toward anything on the weekly muscle
// balance card. Front Squat was in the first table and not the second, so the
// app could load its bar, had nothing to say about it, and counted a week of
// them as no leg work at all.
describe("the lift tables agree with each other", () => {
  const app = loadCore();

  it("has a form guide entry for every barbell lift, under every spelling", () => {
    const names: string[] = [];
    for (const lift of app.BARBELL_LIFTS) names.push(lift.name, ...(lift.aka || []));
    expect(names.length).toBeGreaterThan(9);
    expect(names.filter((n) => app.formGuide(n) === null)).toEqual([]);
  });

  it("counts every barbell lift toward a muscle group", () => {
    const ungrouped = app.BARBELL_LIFTS
      .map((lift: any) => lift.name)
      .filter((name: string) => app.MUSCLE_GROUPS.indexOf(app.muscleGroupFor(name)) === -1);
    expect(ungrouped).toEqual([]);
  });

  // The positive control for the two above: they are filters over a list, so
  // both pass vacuously if the list is empty or the lookup answers everything.
  it("still reports a lift that is in neither table", () => {
    expect(app.formGuide("Zercher Squat")).toBe(null);
    expect(app.muscleGroupFor("Zercher Squat")).toBe(null);
  });
});

describe("formGuideBody", () => {
  const app = loadCore();

  it("puts the three parts in one block, blank-line separated", () => {
    const body = app.formGuideBody(app.formGuide("Deadlift"));
    expect(body).toContain("Set up\n");
    expect(body).toContain("Do it\n");
    expect(body).toContain("Common mistakes\n");
    expect(body.split("\n\n").length).toBe(3);
    for (const m of app.formGuide("Deadlift").mistakes) expect(body).toContain("• " + m);
  });

  it("is empty for no entry", () => {
    expect(app.formGuideBody(null)).toBe("");
  });
});

// The wiring, checked against the shipped source rather than a rebuilt copy:
// the sheet is shared with the glossary, so the click handler has to reach a
// data-form handle before it falls through to data-term.
describe("wiring", () => {
  it("hides the row handle until the typed name has a guide", () => {
    expect(APP_SOURCE).toContain("formNode.hidden = !guide");
  });

  it("routes a data-form click to openForm and keeps data-term working", () => {
    const handler = APP_SOURCE.slice(APP_SOURCE.indexOf("const form = ev.target.closest('[data-form]')"));
    expect(handler.slice(0, 400)).toContain("openForm(form.dataset.form)");
    expect(handler.slice(0, 400)).toContain("closest('[data-term]')");
  });

  it("keeps the blank lines formGuideBody writes", () => {
    expect(appFile("styles.css")).toContain("white-space:pre-line");
  });

  it("has the handle in the log row template", () => {
    expect(appFile("index.html")).toContain('class="icon-btn ex-form"');
  });
});
