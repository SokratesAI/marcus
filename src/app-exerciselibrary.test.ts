import { appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same seam as app-formguide.test.ts: the library is a pure function over
// FORM_GUIDE, so app-core.js is evaluated alone with no DOM.
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
      "\n;globalThis.MUSCLE_GROUPS = MUSCLE_GROUPS;" +
      "\n;globalThis.formGuide = formGuide;" +
      "\n;globalThis.formGuideLibrary = formGuideLibrary;",
    ctx,
  );
  return ctx;
}

describe("formGuideLibrary", () => {
  const app = loadCore();

  // The whole point of the function: nothing may fall out of it. A guide that
  // reaches no group is a guide that renders nowhere, which is the state the
  // library exists to end.
  it("lists every form guide exactly once", () => {
    const listed = app
      .formGuideLibrary()
      .flatMap((g: any) => g.lifts.map((l: any) => l.name));
    expect(listed.length).toBe(app.FORM_GUIDE.length);
    expect([...listed].sort()).toEqual(app.FORM_GUIDE.map((e: any) => e.name).sort());
  });

  it("keeps MUSCLE_GROUPS order, not alphabetical order", () => {
    const groups = app.formGuideLibrary().map((g: any) => g.group);
    const known = groups.filter((g: string) => app.MUSCLE_GROUPS.indexOf(g) !== -1);
    expect(known).toEqual(app.MUSCLE_GROUPS.filter((g: string) => known.indexOf(g) !== -1));
    expect(known.length).toBeGreaterThan(1);
    expect(known).not.toEqual([...known].sort());
  });

  it("sorts the lifts inside a group alphabetically", () => {
    for (const g of app.formGuideLibrary()) {
      const names = g.lifts.map((l: any) => l.name);
      expect(names).toEqual([...names].sort());
    }
  });

  // Every one of the five groups has a guide today, so the real table cannot
  // show whether the empty ones are dropped or left in to crash the map. Take
  // the Arms guides away and ask again.
  it("leaves out a muscle group no guide covers, instead of crashing on it", () => {
    const arms = app.FORM_GUIDE.filter((e: any) => e.group === "Arms");
    expect(arms.length).toBeGreaterThan(0);
    for (const e of arms) app.FORM_GUIDE.splice(app.FORM_GUIDE.indexOf(e), 1);
    try {
      const groups = app.formGuideLibrary().map((g: any) => g.group);
      expect(groups).not.toContain("Arms");
      expect(groups).toContain("Chest");
    } finally {
      for (const e of arms) app.FORM_GUIDE.push(e);
    }
  });

  it("names no empty group", () => {
    for (const g of app.formGuideLibrary()) {
      expect(g.group.trim().length).toBeGreaterThan(0);
      expect(g.lifts.length).toBeGreaterThan(0);
    }
  });

  // Every name it prints has to be a name the sheet can open, because the
  // button hands `data-form` straight back to `formGuide`.
  it("prints only names formGuide can resolve", () => {
    for (const g of app.formGuideLibrary()) {
      for (const l of g.lifts) {
        expect(app.formGuide(l.name)).not.toBeNull();
        expect(app.formGuide(l.name).group || "Other").toBe(g.group);
      }
    }
  });

  // `Rowing Erg` already exercises this on the real table -- it carries no
  // group, so it lands under `Other`. The pushed entry proves the same path for
  // a group name that exists and is simply not one of the five.
  it("puts a group MUSCLE_GROUPS has never heard of after the known ones, sorted", () => {
    app.FORM_GUIDE.push({
      name: "Zercher Carry", group: "Grip",
      setup: "x", execution: "y", mistakes: ["z"],
    });
    try {
      const groups = app.formGuideLibrary().map((g: any) => g.group);
      const extras = groups.filter((g: string) => app.MUSCLE_GROUPS.indexOf(g) === -1);
      expect(extras).toContain("Grip");
      expect(extras).toContain("Other");
      expect(extras).toEqual([...extras].sort());
      const firstExtra = groups.indexOf(extras[0]);
      const lastKnown = groups.map((g: string) => app.MUSCLE_GROUPS.indexOf(g) !== -1).lastIndexOf(true);
      expect(firstExtra).toBeGreaterThan(lastKnown);
      const grip = app.formGuideLibrary().filter((g: any) => g.group === "Grip")[0];
      expect(grip.lifts.map((l: any) => l.name)).toEqual(["Zercher Carry"]);
    } finally {
      app.FORM_GUIDE.pop();
    }
  });

  // A guide with no group at all is the case the real table already has, and
  // dropping it is exactly the bug this function was written to avoid.
  it("keeps a guide that carries no group, under Other", () => {
    const other = app.formGuideLibrary().filter((g: any) => g.group === "Other")[0];
    const ungrouped = app.FORM_GUIDE.filter((e: any) => !e.group).map((e: any) => e.name).sort();
    expect(ungrouped.length).toBeGreaterThan(0);
    expect(other).toBeTruthy();
    expect(other.lifts.map((l: any) => l.name)).toEqual(ungrouped);
  });

  it("carries the alternate spellings through", () => {
    const bench = app
      .formGuideLibrary()
      .flatMap((g: any) => g.lifts)
      .filter((l: any) => l.name === "Barbell Bench Press")[0];
    expect(bench.aka).toContain("Bench Press");
  });
});

// The card itself, executed rather than string-matched. `exerciseLibraryCard`
// lives in app.js, which cannot be evaluated without a DOM, so the one function
// is lifted out of the source and run against the real core. A test that only
// greps app.js for its own literals would pass against a body rewritten to emit
// broken markup, which is the whole thing worth checking here.
function loadCard(): any {
  const app = loadCore();
  const src = appFile("app.js");
  const fn = /function exerciseLibraryCard\(library\) \{[\s\S]*?\n\}\n/.exec(src);
  expect(fn).not.toBeNull();
  vm.runInContext(
    "globalThis.esc = esc;" + fn![0] + ";globalThis.exerciseLibraryCard = exerciseLibraryCard;",
    app,
  );
  return app;
}

describe("exerciseLibraryCard", () => {
  const app = loadCard();

  it("renders one button per guide, each carrying the name the sheet opens on", () => {
    const html = app.exerciseLibraryCard(app.formGuideLibrary());
    const names = [...html.matchAll(/data-form="([^"]*)"/g)].map((m: any) => m[1]);
    expect(names.length).toBe(app.FORM_GUIDE.length);
    for (const name of names) expect(app.formGuide(name)).not.toBeNull();
  });

  it("prints the alternate spellings, so a lift you know by another name is findable", () => {
    const html = app.exerciseLibraryCard(app.formGuideLibrary());
    expect(html).toContain("also Bench Press, Flat Bench Press");
    expect(html).toContain("also RDL");
    // A guide with no alternate spelling gets no empty line.
    expect(html).not.toContain("also </span>");
  });

  it("escapes a hostile name in both the attribute and the text", () => {
    app.FORM_GUIDE.push({
      name: 'Evil " onclick=x', aka: ['<b>bold</b>'], group: "Chest",
      setup: "a", execution: "b", mistakes: ["c"],
    });
    try {
      const html = app.exerciseLibraryCard(app.formGuideLibrary());
      expect(html).not.toContain('" onclick=x');
      expect(html).not.toContain("<b>bold</b>");
      expect(html).toContain("&quot; onclick=x");
    } finally {
      app.FORM_GUIDE.pop();
    }
  });

  it("renders nothing at all for an empty library", () => {
    expect(app.exerciseLibraryCard([])).toBe("");
  });
});

describe("the exercise library on the Plan tab", () => {
  it("renders from app.js, off the core function", () => {
    const app = appFile("app.js");
    expect(app).toContain("function exerciseLibraryCard(");
    expect(app).toContain("${exerciseLibraryCard(formGuideLibrary())}");
  });

  // One opener, not two: the buttons carry `data-form`, which the delegated
  // listener already turns into the same sheet a Log row opens.
  it("opens the existing sheet rather than adding a second one", () => {
    const app = appFile("app.js");
    expect(app).toContain('data-form="${esc(l.name)}"');
    expect(app.match(/function openForm\(/g)?.length).toBe(1);
  });

  it("defines formGuideLibrary in app-core.js, which loads before app.js", () => {
    expect(appFile("app-core.js")).toContain("function formGuideLibrary(");
  });
});
