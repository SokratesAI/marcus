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

  // Front Squat is a different lift. A fuzzy matcher would hand it the back
  // squat's cues, which is worse than handing it nothing.
  it("does not match a different lift that contains a known name", () => {
    expect(app.formGuide("Front Squat")).toBe(null);
    expect(app.formGuide("Deadlift Variation")).toBe(null);
  });

  it("returns null for an empty or missing name", () => {
    expect(app.formGuide("")).toBe(null);
    expect(app.formGuide("   ")).toBe(null);
    expect(app.formGuide(null)).toBe(null);
    expect(app.formGuide(undefined)).toBe(null);
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
