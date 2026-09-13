import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// `niceDate` is the one date formatter the whole front end shares -- 29 call
// sites -- and it printed no year at all. Nothing caught it because every
// fixture date in the suite sits inside one calendar year, which is exactly
// the case where printing the year would be noise. It took a real browser and
// a real eleven-month goal to see it: the race calendar drew 49 rows crossing
// a New Year with `Mon, Dec 28` directly above `Mon, Jan 4`.
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
  vm.runInContext(APP_SOURCE + "\n;globalThis.niceDate = niceDate;", ctx);
  return ctx;
}

const TODAY = "2026-09-13"; // a Sunday

describe("niceDate names the year only when it is not this one", () => {
  it("leaves the year off a date in the current year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2026-12-28", TODAY)).toBe("Mon, Dec 28");
  });

  it("names the year on a date in a later year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2027-01-04", TODAY)).toBe("Mon, Jan 4, 2027");
  });

  it("names the year on a date in an earlier year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2025-12-28", TODAY)).toBe("Sun, Dec 28, 2025");
  });

  it("separates the two adjacent race-calendar rows that read identically before", () => {
    const { niceDate } = loadApp();
    // Consecutive Mondays on either side of a New Year. Before this change
    // these differed only in the month, so a reader had no way to tell that
    // eight days had crossed a year.
    const dec = niceDate("2026-12-28", TODAY);
    const jan = niceDate("2027-01-04", TODAY);
    expect(dec).not.toContain("2026");
    expect(jan).toContain("2027");
  });

  it("reads the current year off the clock when no date is passed", () => {
    const { niceDate } = loadApp();
    const thisYear = new Date().getFullYear();
    expect(niceDate(`${thisYear}-06-15`)).not.toContain(String(thisYear));
    expect(niceDate(`${thisYear + 1}-06-15`)).toContain(String(thisYear + 1));
  });
});
