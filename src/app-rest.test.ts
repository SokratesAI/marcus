import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-plates.test.ts: restSeconds and restLabel take a
// primitive and return one, so no DOM node is touched here.
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
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.restSeconds = restSeconds;" +
      "\n;globalThis.restSecondsLabel = restSecondsLabel;" +
      "\n;globalThis.restLabel = restLabel;",
    ctx,
  );
  return ctx;
}

describe("restSeconds", () => {
  it("gives a heavy set three minutes", () => {
    const app = loadApp();
    expect(app.restSeconds(1)).toBe(180);
    expect(app.restSeconds(3)).toBe(180);
    expect(app.restSeconds(5)).toBe(180);
  });

  it("gives a moderate set ninety seconds", () => {
    const app = loadApp();
    expect(app.restSeconds(6)).toBe(90);
    expect(app.restSeconds(10)).toBe(90);
    expect(app.restSeconds(12)).toBe(90);
  });

  it("gives a long set one minute", () => {
    const app = loadApp();
    expect(app.restSeconds(13)).toBe(60);
    expect(app.restSeconds(20)).toBe(60);
    expect(app.restSeconds(100)).toBe(60);
  });

  // The two band edges are the whole of the function's opinion, so they are
  // asserted from both sides rather than from inside a band where an
  // off-by-one moves nothing.
  it("puts each boundary rep count in the heavier band", () => {
    const app = loadApp();
    expect(app.restSeconds(5)).not.toBe(app.restSeconds(6));
    expect(app.restSeconds(12)).not.toBe(app.restSeconds(13));
  });

  it("says nothing for anything that is not a set", () => {
    const app = loadApp();
    expect(app.restSeconds("")).toBe(0);
    expect(app.restSeconds("heavy")).toBe(0);
    expect(app.restSeconds(0)).toBe(0);
    expect(app.restSeconds(-5)).toBe(0);
    expect(app.restSeconds(null)).toBe(0);
    expect(app.restSeconds(undefined)).toBe(0);
  });

  it("reads the reps box as the string an input actually holds", () => {
    const app = loadApp();
    expect(app.restSeconds("3")).toBe(180);
    expect(app.restSeconds("10")).toBe(90);
    expect(app.restSeconds("15")).toBe(60);
  });

  it("covers every whole rep count from 1 to 30 with a band", () => {
    const app = loadApp();
    for (let reps = 1; reps <= 30; reps++) {
      expect([180, 90, 60]).toContain(app.restSeconds(reps));
    }
  });
});

describe("restSecondsLabel", () => {
  it("writes whole minutes without a stray zero seconds", () => {
    const app = loadApp();
    expect(app.restSecondsLabel(180)).toBe("3 min");
    expect(app.restSecondsLabel(60)).toBe("1 min");
  });

  it("writes a part minute as minutes and seconds", () => {
    const app = loadApp();
    expect(app.restSecondsLabel(90)).toBe("1 min 30 s");
  });

  it("writes under a minute as seconds alone", () => {
    const app = loadApp();
    expect(app.restSecondsLabel(45)).toBe("45 s");
  });

  it("says nothing for zero", () => {
    const app = loadApp();
    expect(app.restSecondsLabel(0)).toBe("");
  });
});

describe("restLabel", () => {
  // The negative here would pass against a function that always returned "",
  // so the positive is asserted first: 10 reps has to produce a line before an
  // empty box producing none means anything.
  it("names the rest for a real rep count and stays silent otherwise", () => {
    const app = loadApp();
    expect(app.restLabel(10)).toBe("Rest 1 min 30 s between sets");
    expect(app.restLabel("")).toBe("");
  });

  it("names three minutes on a heavy set", () => {
    const app = loadApp();
    expect(app.restLabel(3)).toBe("Rest 3 min between sets");
  });

  it("names one minute on a long set", () => {
    const app = loadApp();
    expect(app.restLabel(15)).toBe("Rest 1 min between sets");
  });
});
