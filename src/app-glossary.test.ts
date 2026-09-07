import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// The glossary is pure data plus three string functions, so this evaluates
// app-core.js alone in a context with no DOM -- the same seam
// app-references.test.ts pins.
function loadApp(): any {
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, RegExp,
    document: undefined, navigator: {},
    // A real in-memory store rather than a stub that swallows writes: the
    // seeded plan is one of the strings this file checks a term against, and
    // seed() only produces it if store.set() actually keeps something.
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
      "\n;globalThis.GLOSSARY = GLOSSARY;" +
      "\n;globalThis.TRAINING_REFERENCES = TRAINING_REFERENCES;" +
      "\n;globalThis.PROPOSAL_REFERENCES = PROPOSAL_REFERENCES;" +
      "\n;globalThis.seedBlockName = store.get('plan').blockName;" +
      "\n;globalThis.glossaryTerm = glossaryTerm;" +
      "\n;globalThis.linkGlossary = linkGlossary;",
    ctx,
  );
  return ctx;
}

const app = loadApp();

describe("the glossary table", () => {
  it("gives every entry a term, a title and a body", () => {
    expect(app.GLOSSARY.length).toBeGreaterThan(0);
    for (const e of app.GLOSSARY) {
      expect(typeof e.term).toBe("string");
      expect(e.term.length).toBeGreaterThan(1);
      expect(e.title.length).toBeGreaterThan(1);
      expect(e.body.length).toBeGreaterThan(40);
    }
  });

  // The contract that makes this a glossary rather than an encyclopaedia: a
  // term earns its entry by being a word Marcus already puts on the screen, so
  // there is a sentence to read it from.
  //
  // This is asserted against strings the app actually renders, not against a
  // grep of the source, and the difference is not academic -- it is the bug this
  // test was rewritten to catch. `deload` and `acute:chronic` both had entries
  // and both would have passed a source grep: the first appears as
  // `kind === 'deload'`, the second only in a comment. Neither word is ever on
  // the screen -- the chip says "ease off" -- so both entries were unreachable
  // and are gone.
  it("only defines words that appear in text the app renders", () => {
    const rendered: string[] = [
      ...app.TRAINING_REFERENCES.map((r: any) => r.finding),
      ...Object.keys(app.PROPOSAL_REFERENCES).flatMap((k) =>
        app.PROPOSAL_REFERENCES[k].map((pin: any) => pin.stretch)),
      app.seedBlockName,
      "RPE",
    ];
    for (const e of app.GLOSSARY) {
      const surfaced = rendered.some((text) =>
        app.linkGlossary(text).includes(`data-term="${e.term}"`));
      expect(surfaced, `${e.term} is defined but nothing on screen says it`).toBe(true);
    }
  });

  // The other half of that boundary, and the one worth a test rather than a
  // comment: the app explains Fitness/Fatigue/Form in the card that shows it,
  // and each goal phase carries its own note. A tappable word that repeats the
  // sentence it sits in is noise.
  it("leaves alone the terms the app already explains inline", () => {
    const terms = app.GLOSSARY.map((e: any) => e.term.toLowerCase());
    for (const already of ["fitness", "fatigue", "base", "build", "peak"]) {
      expect(terms).not.toContain(already);
    }
  });

  it("never sells a training recommendation as a definition", () => {
    for (const e of app.GLOSSARY) {
      expect(e.body).not.toMatch(/\byou should\b|\bmust\b|\bwe recommend\b/i);
    }
  });
});

describe("glossaryTerm", () => {
  it("finds an entry however the app happened to capitalise it", () => {
    expect(app.glossaryTerm("RPE").term).toBe("RPE");
    expect(app.glossaryTerm("rpe").term).toBe("RPE");
    expect(app.glossaryTerm("Taper").term).toBe("taper");
  });

  it("finds an entry by an alternative spelling", () => {
    expect(app.glossaryTerm("rate of perceived exertion").term).toBe("RPE");
    expect(app.glossaryTerm("tapering").term).toBe("taper");
  });

  it("returns null for a word it does not define", () => {
    expect(app.glossaryTerm("squat")).toBe(null);
    expect(app.glossaryTerm("")).toBe(null);
    expect(app.glossaryTerm(null)).toBe(null);
  });
});

describe("linkGlossary", () => {
  it("wraps a term it knows in a button carrying that term", () => {
    const html = app.linkGlossary("Take a taper week.");
    expect(html).toContain('data-term="taper"');
    expect(html).toContain(">taper</button>");
    expect(html).toContain("Take a ");
    expect(html).toContain(" week.");
  });

  it("keeps the word exactly as it was written", () => {
    expect(app.linkGlossary("Taper now")).toContain(">Taper</button>");
  });

  it("escapes the text around a term", () => {
    const html = app.linkGlossary('<img src=x onerror=alert(1)> taper');
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  // It replaces an esc() call at every site that uses it, so text with no term
  // in it has to come back escaped rather than raw.
  it("escapes text that contains no term at all", () => {
    expect(app.linkGlossary('<b>hi</b>')).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("only matches a whole word", () => {
    expect(app.linkGlossary("tapered trousers")).not.toContain("data-term");
    expect(app.linkGlossary("SUPERRPEX")).not.toContain("data-term");
  });

  it("links the first mention of a term and not the rest", () => {
    const html = app.linkGlossary("A taper is a taper is a taper.");
    expect(html.split("data-term").length - 1).toBe(1);
  });

  // `rate of perceived exertion` after `RPE` is the same idea a second time.
  it("links a term once even when a second spelling of it follows", () => {
    const html = app.linkGlossary("Log the RPE, the rate of perceived exertion.");
    expect(html.split("data-term").length - 1).toBe(1);
  });

  it("links two different terms in one sentence", () => {
    const html = app.linkGlossary("A hypertrophy block before the taper.");
    expect(html).toContain('data-term="hypertrophy"');
    expect(html).toContain('data-term="taper"');
  });

  it("returns an empty string for nothing", () => {
    expect(app.linkGlossary("")).toBe("");
    expect(app.linkGlossary(null)).toBe("");
  });
});

describe("where the explainers surface", () => {
  const appJs = appFile("app.js");
  const html = appFile("index.html");

  // The row asks for these to be read where the word appears, not from a flat
  // article list. These three assertions are what stops the glossary shipping
  // as a table nothing renders.
  it("links the terms in a plan proposal's reason", () => {
    expect(appJs).toContain("${linkGlossary(p.reason)}");
  });

  it("links the terms in the research quoted under a proposal", () => {
    expect(appJs).toContain("linkGlossary(c.ref.finding)");
    expect(appJs).toContain("linkGlossary(c.stretch)");
  });

  it("links the term in the plan's block name", () => {
    expect(appJs).toContain("${linkGlossary(plan.blockName)}");
  });

  it("gives the RPE box on the log form its own handle", () => {
    expect(html).toContain('data-term="RPE"');
  });

  // The cards are rebuilt by innerHTML on every tab switch, so a handler bound
  // to a button would be thrown away with the button.
  it("opens the sheet from one delegated listener, not per button", () => {
    expect(appJs).toContain("closest('[data-term]')");
    expect(appJs).toContain("document.addEventListener('click'");
  });

  it("has a sheet in the page for the explainer to render into", () => {
    expect(html).toContain('id="termSheet"');
    expect(html).toContain('id="termTitle"');
    expect(html).toContain('id="termBody"');
  });
});
