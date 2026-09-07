import { APP_SOURCE, appFile } from "./app-source.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same vm shape as app-warmup.test.ts: checkRpe and validateExerciseRow take a
// plain object and return a value, so no DOM node is touched.
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

const row = (over: Record<string, unknown> = {}) => ({
  name: "Bench", sets: "3", reps: "8", weight: "80", ...over,
});

describe("checkRpe", () => {
  it("accepts a blank box and reports no value, because RPE is optional", () => {
    const ctx = loadApp();
    for (const blank of ["", "   ", null, undefined]) {
      const r = ctx.checkRpe(blank);
      expect(r.ok).toBe(true);
      expect(r.value).toBeUndefined();
    }
  });

  it("accepts both ends of the 1-10 scale", () => {
    const ctx = loadApp();
    expect(ctx.checkRpe("1")).toEqual({ ok: true, value: 1 });
    expect(ctx.checkRpe("10")).toEqual({ ok: true, value: 10 });
  });

  it("refuses a value off either end of the scale", () => {
    const ctx = loadApp();
    expect(ctx.checkRpe("0").ok).toBe(false);
    expect(ctx.checkRpe("11").ok).toBe(false);
    expect(ctx.checkRpe("0").message).toContain("between 1 and 10");
  });

  it("refuses text rather than storing NaN", () => {
    const ctx = loadApp();
    const r = ctx.checkRpe("hard");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("must be a number");
  });

  it("rounds a half step to a whole number, because the scale has no halves here", () => {
    const ctx = loadApp();
    expect(ctx.checkRpe("7.5").value).toBe(8);
  });
});

describe("validateExerciseRow with RPE", () => {
  it("leaves rpe off the exercise entirely when the box is blank", () => {
    const ctx = loadApp();
    const r = ctx.validateExerciseRow(row({ rpe: "" }));
    expect(r.ok).toBe(true);
    // Absent, not 0 -- a 0 would read as "no effort at all" to anything
    // averaging these, and could not be told back from a real answer.
    expect("rpe" in r.exercise).toBe(false);
  });

  it("carries a recorded RPE onto the saved exercise", () => {
    const ctx = loadApp();
    const r = ctx.validateExerciseRow(row({ rpe: "9" }));
    expect(r.ok).toBe(true);
    expect(r.exercise.rpe).toBe(9);
  });

  it("names the exercise when the RPE is out of range", () => {
    const ctx = loadApp();
    const r = ctx.validateExerciseRow(row({ rpe: "12" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Bench:");
    expect(r.message).toContain("between 1 and 10");
  });

  it("still rejects a bad weight ahead of a bad RPE, so the required boxes come first", () => {
    const ctx = loadApp();
    const r = ctx.validateExerciseRow(row({ weight: "", rpe: "12" }));
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("RPE");
  });

  it("fails a whole session on one bad RPE rather than saving the rest", () => {
    const ctx = loadApp();
    const r = ctx.validateSession([row(), row({ name: "Row", rpe: "99" })]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Row:");
  });
});

describe("the RPE box is actually on the page", () => {
  // The form is built from this template, so a validator that accepts RPE with
  // no box to type it in would pass every test above and ship nothing.
  const html = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const tpl = html.slice(html.indexOf('<template id="tpl-log-exercise-row">'));

  it("puts an ex-rpe input in the exercise row template, bounded to the scale", () => {
    const input = tpl.slice(tpl.indexOf('class="ex-rpe"'), tpl.indexOf('ex-remove'));
    expect(input).toContain('min="1"');
    expect(input).toContain('max="10"');
  });

  it("reads that box when the session is saved", () => {
    expect(appFile("app.js")).toContain("rpe: r.querySelector('.ex-rpe').value");
  });

  it("gives the grid a column for it, so the row does not overflow", () => {
    const css = readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    const line = css.split("\n").find((l) => l.startsWith(".ex-fields{"));
    expect(line).toContain("2fr 1fr 1fr 1fr 1fr auto");
  });
});
