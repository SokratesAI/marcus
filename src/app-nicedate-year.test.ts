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

// Deliberately NOT the real today. A fixture year equal to the wall clock's
// makes `todayISO` and `new Date()` agree, so a mutation that drops the
// parameter entirely and reads the clock passes every assertion -- measured,
// cycle 1474, where exactly that mutation SURVIVED against a 2026 fixture.
const TODAY = "2031-09-14"; // a Sunday, and a year this box will not reach

describe("niceDate names the year only when it is not this one", () => {
  it("leaves the year off a date in the current year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2031-12-29", TODAY)).toBe("Mon, Dec 29");
  });

  it("names the year on a date in a later year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2032-01-05", TODAY)).toBe("Mon, Jan 5, 2032");
  });

  it("names the year on a date in an earlier year", () => {
    const { niceDate } = loadApp();
    expect(niceDate("2030-12-29", TODAY)).toBe("Sun, Dec 29, 2030");
  });

  it("separates the two adjacent race-calendar rows that read identically before", () => {
    const { niceDate } = loadApp();
    // Consecutive Mondays on either side of a New Year. Before this change
    // these differed only in the month, so a reader had no way to tell that
    // eight days had crossed a year.
    const dec = niceDate("2031-12-29", TODAY);
    const jan = niceDate("2032-01-05", TODAY);
    expect(dec).not.toContain("2031");
    expect(jan).toContain("2032");
  });

  it("ignores a second argument that is not a date string", () => {
    const { niceDate } = loadApp();
    // Three chart axes call this as `.map(niceDate)`, which hands the array
    // index to the second parameter. `new Date('0T00:00')` is Invalid Date and
    // `getFullYear()` is NaN, which is never equal to anything -- so without
    // this guard every chart label printed a year. The call sites pass one
    // argument now and this pins the function against the next one that does not.
    const thisYear = new Date().getFullYear();
    expect(niceDate(`${thisYear}-06-15`, 0 as any)).not.toContain(String(thisYear));
    expect(niceDate(`${thisYear}-06-15`, 2 as any)).not.toContain(String(thisYear));
    expect([`${thisYear}-06-15`, `${thisYear}-06-16`].map(niceDate).join(" "))
      .not.toContain(String(thisYear));
  });

  it("reads the current year off the clock when no date is passed", () => {
    const { niceDate } = loadApp();
    const thisYear = new Date().getFullYear();
    expect(niceDate(`${thisYear}-06-15`)).not.toContain(String(thisYear));
    expect(niceDate(`${thisYear + 1}-06-15`)).toContain(String(thisYear + 1));
  });
});
