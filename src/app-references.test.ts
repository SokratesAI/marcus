import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// The reference table is pure data plus one lookup, so this evaluates the app
// in a context with no DOM at all -- the same seam app-split.test.ts pins.
function loadApp(): any {
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document: undefined, navigator: {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    appFile("app-core.js") +
      "\n;globalThis.TRAINING_REFERENCES = TRAINING_REFERENCES;" +
      "\n;globalThis.PROPOSAL_REFERENCES = PROPOSAL_REFERENCES;" +
      "\n;globalThis.referencesFor = referencesFor;" +
      "\n;globalThis.referenceById = referenceById;",
    ctx,
  );
  return ctx;
}

// The five kinds planReview can emit. Written out rather than read off the
// source, so a kind added without a decision about its citation fails here.
const KINDS = ["deload", "build", "move", "rest", "phase"];

describe("training-science references (idea #214)", () => {
  it("every reference carries an identifier a reader can check", () => {
    const app = loadApp();
    expect(app.TRAINING_REFERENCES.length).toBeGreaterThan(0);
    for (const r of app.TRAINING_REFERENCES) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(r.title.length).toBeGreaterThan(20);
      expect(r.authors.length).toBeGreaterThan(0);
      expect(r.year).toBeGreaterThanOrEqual(2000);
      expect(r.venue.length).toBeGreaterThan(0);
      // A link is the whole point: a citation nobody can open is a claim.
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.finding.length).toBeGreaterThan(40);
    }
  });

  it("no two references share an id", () => {
    const app = loadApp();
    const ids = app.TRAINING_REFERENCES.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every pinned reference resolves to a real entry in the table", () => {
    const app = loadApp();
    const ids = new Set(app.TRAINING_REFERENCES.map((r: any) => r.id));
    for (const kind of Object.keys(app.PROPOSAL_REFERENCES)) {
      for (const pin of app.PROPOSAL_REFERENCES[kind]) {
        expect(ids.has(pin.id)).toBe(true);
      }
    }
  });

  it("every pin says how far the paper actually goes", () => {
    const app = loadApp();
    for (const kind of Object.keys(app.PROPOSAL_REFERENCES)) {
      for (const pin of app.PROPOSAL_REFERENCES[kind]) {
        expect(pin.stretch.length).toBeGreaterThan(40);
      }
    }
    // And referencesFor hands that sentence on rather than dropping it -- a
    // citation rendered without it reads as "the paper says do this".
    for (const c of app.referencesFor("phase")) {
      expect(c.stretch.length).toBeGreaterThan(40);
    }
  });

  it("only kinds planReview can emit are pinned", () => {
    const app = loadApp();
    for (const kind of Object.keys(app.PROPOSAL_REFERENCES)) {
      expect(KINDS).toContain(kind);
    }
  });

  it("the three uncited kinds stay uncited", () => {
    const app = loadApp();
    // deload's 1.5 line is injury-risk workload research, not endurance
    // science; move and rest are adherence. Attaching a Norwegian endurance
    // paper to any of them is the invented citation this table exists to stop,
    // so this asserts the absence deliberately.
    expect(app.referencesFor("deload")).toEqual([]);
    expect(app.referencesFor("move")).toEqual([]);
    expect(app.referencesFor("rest")).toEqual([]);
    // The positive beside the negative: an empty list here has to mean "not
    // pinned" and not "referencesFor returns nothing for anything".
    expect(app.referencesFor("phase").length).toBeGreaterThan(0);
    expect(app.referencesFor("build").length).toBeGreaterThan(0);
  });

  it("an unknown kind is an empty list, not a throw", () => {
    const app = loadApp();
    expect(app.referencesFor("no-such-kind")).toEqual([]);
    expect(app.referencesFor(undefined)).toEqual([]);
  });

  it("referencesFor joins the pin to its paper", () => {
    const app = loadApp();
    const cited = app.referencesFor("build");
    expect(cited.length).toBe(1);
    expect(cited[0].ref.id).toBe("seiler2006");
    expect(cited[0].ref.year).toBe(2006);
    expect(cited[0].ref.url).toContain("10.1111/j.1600-0838.2004.00418.x");
  });

  it("referenceById answers null for an id that is not in the table", () => {
    const app = loadApp();
    expect(app.referenceById("nope")).toBe(null);
    expect(app.referenceById("seiler2006").authors).toContain("Seiler");
  });

  it("the table lives in the DOM-free half", () => {
    // If it moves into app.js it stops being loadable without a document, and
    // this whole file would have to grow a fake DOM to keep passing.
    expect(appFile("app-core.js")).toContain("TRAINING_REFERENCES");
    expect(appFile("app.js")).not.toContain("const TRAINING_REFERENCES");
  });

  it("the plan tab renders the table and the per-proposal citation", () => {
    const src = appFile("app.js");
    expect(src).toContain("The research behind this");
    expect(src).toContain("referencesFor(p.kind)");
    // The old blanket disclaimer is gone -- it is now false.
    expect(APP_SOURCE).not.toContain("Marcus does not cite research here yet");
  });
});
