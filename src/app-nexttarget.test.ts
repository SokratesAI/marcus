import { APP_SOURCE, appFile } from "./app-source.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-lastweight.test.ts: nextTarget and nextTargetLabel take
// plain values and return plain values, so no DOM node is touched here.
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
      "\n;globalThis.nextTarget = nextTarget;" +
      "\n;globalThis.nextTargetLabel = nextTargetLabel;" +
      "\n;globalThis.lastPerformance = lastPerformance;" +
      "\n;globalThis.PROGRESSION_STEP_KG = PROGRESSION_STEP_KG;",
    ctx,
  );
  return ctx;
}

// The shape lastPerformance returns, which is the only thing nextTarget is ever
// handed in the app.
function last(weight: number, reps: number, rpe: number | null = null) {
  return { date: "2026-09-01", name: "Back Squat", weight, reps, sets: 3, rpe };
}

describe("nextTarget", () => {
  it("adds the smallest jump once you hit the rep target", () => {
    const app = loadApp();
    const next = app.nextTarget(last(60, 8), 8);
    expect(next.kind).toBe("add");
    expect(next.weight).toBe(62.5);
    expect(next.reps).toBe(8);
  });

  it("stays at the weight when you were short of the target", () => {
    const app = loadApp();
    const next = app.nextTarget(last(60, 6), 8);
    expect(next.kind).toBe("hold");
    expect(next.reason).toBe("short");
    expect(next.weight).toBe(60);
    expect(next.reps).toBe(8);
  });

  // The rep target is the box on the row, not last session's reps. The same
  // history has to give opposite answers for a 5-rep row and a 12-rep row, or
  // the function is quietly ignoring the argument the plan sets.
  it("reads the rep target off the row rather than off the history", () => {
    const app = loadApp();
    const history = last(60, 8);
    expect(app.nextTarget(history, 5).kind).toBe("add");
    expect(app.nextTarget(history, 12).kind).toBe("hold");
  });

  it("jumps by exactly one PROGRESSION_STEP_KG, whatever that constant says", () => {
    const app = loadApp();
    expect(app.nextTarget(last(60, 8), 8).weight).toBe(60 + app.PROGRESSION_STEP_KG);
    expect(app.nextTarget(last(102.5, 5), 5).weight).toBe(102.5 + app.PROGRESSION_STEP_KG);
  });

  // RPE 10 is the one value on that scale with a definition rather than a
  // feeling: nothing left in reserve. The positive is asserted beside it, so
  // "holds on RPE 10" cannot pass against a function that holds on everything.
  it("holds on RPE 10 even when the reps were there, and adds on RPE 9", () => {
    const app = loadApp();
    const held = app.nextTarget(last(60, 8, 10), 8);
    expect(held.kind).toBe("hold");
    expect(held.reason).toBe("rpe");
    expect(app.nextTarget(last(60, 8, 9), 8).kind).toBe("add");
    expect(app.nextTarget(last(60, 8, null), 8).kind).toBe("add");
  });

  // A pull-up logs 0 kg. Adding 2.5 kg to it would be the app telling you to
  // put a plate on a bar that is not there.
  it("progresses a bodyweight lift in reps, not in kilos", () => {
    const app = loadApp();
    const next = app.nextTarget(last(0, 8), 8);
    expect(next.kind).toBe("reps");
    expect(next.weight).toBe(0);
    expect(next.reps).toBe(9);
  });

  it("still holds a bodyweight lift you were short on", () => {
    const app = loadApp();
    const next = app.nextTarget(last(0, 6), 8);
    expect(next.kind).toBe("hold");
    expect(next.weight).toBe(0);
  });

  it("reads the reps box as the string an input actually holds", () => {
    const app = loadApp();
    expect(app.nextTarget(last(60, 8), "8").kind).toBe("add");
    expect(app.nextTarget(last(60, 6), "8").kind).toBe("hold");
  });

  // The negative cases below would all pass against a function that always
  // returned null, so the positive sits first.
  it("proposes nothing without history, without a target, or without a rep count", () => {
    const app = loadApp();
    expect(app.nextTarget(last(60, 8), 8)).not.toBe(null);
    expect(app.nextTarget(null, 8)).toBe(null);
    expect(app.nextTarget(last(60, 8), "")).toBe(null);
    expect(app.nextTarget(last(60, 8), 0)).toBe(null);
    expect(app.nextTarget(last(60, 8), -5)).toBe(null);
    expect(app.nextTarget(last(60, 8), "heavy")).toBe(null);
    expect(app.nextTarget({ date: "2026-09-01", weight: 60, reps: null, sets: 3, rpe: null }, 8)).toBe(null);
    expect(app.nextTarget({ date: "2026-09-01", weight: null, reps: 8, sets: 3, rpe: null }, 8)).toBe(null);
  });

  // The one number a suggestion must never be is one you cannot load. 2.5 kg on
  // top of a weight the plate set can build is a weight the plate set can
  // build, and the test walks a real progression rather than asserting it once.
  it("only ever proposes a weight in half-plate steps", () => {
    const app = loadApp();
    let weight = 60;
    for (let i = 0; i < 20; i++) {
      const next = app.nextTarget(last(weight, 8), 8);
      expect(next.kind).toBe("add");
      expect(Math.round(next.weight * 4) % 10).toBe(0); // a multiple of 2.5
      weight = next.weight;
    }
    expect(weight).toBe(110);
  });

  it("takes what lastPerformance hands it, end to end", () => {
    const app = loadApp();
    const sessions = [{
      id: "1", date: "2026-09-01", kind: "strength", day: "Monday",
      exercises: [{ name: "Back Squat", rpe: 8, sets: [{ weight: 80, reps: 5 }, { weight: 80, reps: 5 }] }],
    }];
    const found = app.lastPerformance(sessions, "back squat", "2026-09-07");
    expect(found.weight).toBe(80);
    expect(app.nextTarget(found, 5)).toMatchObject({ kind: "add", weight: 82.5, reps: 5 });
  });
});

describe("nextTargetLabel", () => {
  it("names the weight and the reps to go for", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(app.nextTarget(last(60, 8), 8))).toBe("Next: 62.5 kg × 8");
  });

  it("says to stay put, and says which rep count to chase", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(app.nextTarget(last(60, 6), 8))).toBe("Next: stay at 60 kg, aim for 8");
  });

  it("says why it is holding when the reason is RPE rather than reps", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(app.nextTarget(last(60, 8, 10), 8)))
      .toBe("Next: stay at 60 kg × 8, RPE 10 last time");
  });

  it("never writes 0 kg at a bodyweight lift", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(app.nextTarget(last(0, 8), 8))).toBe("Next: bodyweight × 9");
    expect(app.nextTargetLabel(app.nextTarget(last(0, 6), 8))).toBe("Next: stay at bodyweight, aim for 8");
  });

  it("says nothing when there is nothing to propose", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(null)).toBe("");
  });

  it("writes a whole number without a trailing .0", () => {
    const app = loadApp();
    expect(app.nextTargetLabel(app.nextTarget(last(62.5, 8), 8))).toBe("Next: 65 kg × 8");
  });
});

// Every test above calls nextTarget directly, so renaming the class in the
// template, or dropping either listener, would leave all of them green and put
// nothing on the screen.
describe("the Log tab wiring", () => {
  const html = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
    "utf8",
  );
  const template = html.slice(
    html.indexOf('<template id="tpl-log-exercise-row">'),
    html.indexOf("</template>", html.indexOf('<template id="tpl-log-exercise-row">')),
  );

  it("has a next-target line in the exercise row template", () => {
    expect(template).toContain('class="ex-next"');
    expect(template).toMatch(/class="ex-next"[^>]*hidden/);
  });

  it("fills that line from nextTargetLabel", () => {
    const app = appFile("app.js");
    expect(app).toContain("nextTargetLabel(nextTarget(lastSeen, repsInput.value))");
    expect(app).toContain("querySelector('.ex-next')");
  });

  // Two inputs move this line and both have bitten a sibling label before: the
  // name box is what finds the history, the reps box is what sets the target.
  it("re-reads it when either the name or the reps change", () => {
    const app = appFile("app.js");
    expect(app).toContain("repsInput.addEventListener('input', showNext)");
    // showLast is what the name box is wired to, and it is where the row it
    // just found is handed over.
    expect(app).toContain("nameInput.addEventListener('input', showLast)");
    expect(app).toMatch(/lastSeen = last;\s*\n\s*showNext\(\);/);
  });

  it("styles the line so it reads as a proposal rather than as more history", () => {
    expect(appFile("styles.css")).toContain(".ex-next{");
  });

  it("defines nextTarget in app-core.js, which loads before app.js", () => {
    expect(appFile("app-core.js")).toContain("function nextTarget(");
    expect(appFile("app-core.js")).toContain("function nextTargetLabel(");
    expect(appFile("app.js")).not.toContain("function nextTarget(");
  });
});
