import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-warmup.test.ts. plateLoad and plateLoadLabel take
// primitives and return values -- no DOM node is touched.
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
      "\n;globalThis.plateLoad = plateLoad;" +
      "\n;globalThis.plateLoadLabel = plateLoadLabel;" +
      "\n;globalThis.isBarbellLift = isBarbellLift;" +
      "\n;globalThis.BARBELL_LIFTS = BARBELL_LIFTS;" +
      "\n;globalThis.PLATES = PLATES;" +
      "\n;globalThis.BAR_KG = BAR_KG;" +
      "\n;globalThis.formGuide = formGuide;",
    ctx,
  );
  return ctx;
}

describe("plateLoad", () => {
  it("loads a bar biggest plate first", () => {
    const app = loadApp();
    // 100 kg = a 20 kg bar plus 40 a side: a 25 and a 15.
    expect(app.plateLoad(100)).toEqual({
      bar: 20,
      perSide: [{ kg: 25, count: 1 }, { kg: 15, count: 1 }],
      loaded: 100,
      short: 0,
    });
  });

  it("stacks more than one of the same plate", () => {
    const app = loadApp();
    const load = app.plateLoad(170);
    // 75 a side is three 25s, and nothing smaller.
    expect(load.perSide).toEqual([{ kg: 25, count: 3 }]);
    expect(load.short).toBe(0);
  });

  it("reaches every 2.5 kg step between the bar and 200 kg exactly", () => {
    const app = loadApp();
    // The point of the plate set, asserted rather than assumed: nothing in the
    // range a person actually loads comes back short.
    for (let total = 22.5; total <= 200; total += 2.5) {
      const load = app.plateLoad(total);
      expect(load, `total ${total}`).not.toBeNull();
      expect(load.short, `total ${total}`).toBe(0);
      expect(load.loaded, `total ${total}`).toBe(total);
    }
  });

  it("reports a weight the plates cannot reach as short, and names what they do reach", () => {
    const app = loadApp();
    // 61 kg is 20.5 a side. The 1.25s get to 20; half a kilo is left over.
    const load = app.plateLoad(61);
    expect(load.short).toBe(0.5);
    expect(load.loaded).toBe(60);
    expect(load.perSide).toEqual([{ kg: 20, count: 1 }]);
  });

  it("keeps the remainder free of float dust on a weight that is not a binary fraction", () => {
    const app = loadApp();
    // 61.1 kg is 20.55 a side. Plain floating point leaves 0.5499999999999972
    // here, which reads on the phone as a number nobody typed.
    expect(app.plateLoad(61.1).short).toBe(0.55);
  });

  it("says nothing at or below the bar", () => {
    const app = loadApp();
    expect(app.plateLoad(20)).toBeNull();
    expect(app.plateLoad(15)).toBeNull();
    expect(app.plateLoad(0)).toBeNull();
    // A bodyweight row stores 0 kg, which is the case above; a negative weight
    // cannot be typed into the box but is the same answer.
    expect(app.plateLoad(-40)).toBeNull();
  });

  it("says nothing for a weight that is not a number", () => {
    const app = loadApp();
    expect(app.plateLoad("")).toBeNull();
    expect(app.plateLoad("heavy")).toBeNull();
    expect(app.plateLoad(null)).toBeNull();
    expect(app.plateLoad(undefined)).toBeNull();
  });

  it("returns an empty side for a weight above the bar that no plate pair fits", () => {
    const app = loadApp();
    // 21 kg is half a kilo a side and the smallest plate is 1.25.
    const load = app.plateLoad(21);
    expect(load.perSide).toEqual([]);
    expect(load.loaded).toBe(20);
    expect(load.short).toBe(0.5);
  });
});

describe("isBarbellLift", () => {
  it("knows the barbell lifts in the seeded plan", () => {
    const app = loadApp();
    for (const name of ["Back Squat", "Deadlift", "Barbell Bench Press", "Overhead Press", "Barbell Row", "Barbell Curl", "Romanian Deadlift", "Incline Bench Press", "Front Squat"]) {
      expect(app.isBarbellLift(name), name).toBe(true);
    }
  });

  it("matches an alternate spelling and ignores case and spacing", () => {
    const app = loadApp();
    expect(app.isBarbellLift("Bench Press")).toBe(true);
    expect(app.isBarbellLift("RDL")).toBe(true);
    expect(app.isBarbellLift("  squat  ")).toBe(true);
    expect(app.isBarbellLift("BENCH   PRESS")).toBe(true);
  });

  it("says no to a lift loaded with anything other than a bar", () => {
    const app = loadApp();
    for (const name of ["Lat Pulldown", "Leg Press", "Lateral Raise", "Incline Dumbbell Press", "Face Pull", "Triceps Pushdown", "Pull-ups", "Kettlebell Swing", "Calf Raise", "Rowing Erg"]) {
      expect(app.isBarbellLift(name), name).toBe(false);
    }
  });

  it("says no to an empty or unknown name rather than guessing a bar", () => {
    const app = loadApp();
    expect(app.isBarbellLift("")).toBe(false);
    expect(app.isBarbellLift("   ")).toBe(false);
    expect(app.isBarbellLift(null)).toBe(false);
    expect(app.isBarbellLift("Zercher Squat")).toBe(false);
  });

  it("has a form guide for every barbell lift except Front Squat", () => {
    const app = loadApp();
    // Front Squat is deliberately in one table and not the other: it is a
    // barbell lift, and the form guide deliberately gives it nothing rather
    // than the back squat's cues. Pinning both directions here means neither
    // table can be edited into agreeing with the other by accident.
    for (const e of app.BARBELL_LIFTS) {
      if (e.name === "Front Squat") expect(app.formGuide(e.name)).toBeNull();
      else expect(app.formGuide(e.name), e.name).not.toBeNull();
    }
  });
});

describe("plateLoadLabel", () => {
  it("writes the load for a barbell lift", () => {
    const app = loadApp();
    expect(app.plateLoadLabel("Back Squat", 100)).toBe("Bar 20 kg + 25, 15 per side");
  });

  it("counts a repeated plate instead of repeating it", () => {
    const app = loadApp();
    expect(app.plateLoadLabel("Deadlift", 170)).toBe("Bar 20 kg + 25 × 3 per side");
  });

  it("names the closest loadable weight rather than rounding to it silently", () => {
    const app = loadApp();
    expect(app.plateLoadLabel("Back Squat", 61)).toBe("Bar 20 kg + 20 per side = 60 kg, the closest you can load");
  });

  it("says the bar alone when nothing fits on it", () => {
    const app = loadApp();
    expect(app.plateLoadLabel("Back Squat", 21)).toBe("Bar 20 kg alone = 20 kg, the closest you can load");
  });

  it("is empty for a lift that is not loaded with a bar, whatever the weight", () => {
    const app = loadApp();
    // The precondition: this weight does produce a label on a barbell lift, so
    // the empty string is the exercise name deciding and not the number.
    expect(app.plateLoadLabel("Back Squat", 100)).not.toBe("");
    expect(app.plateLoadLabel("Lat Pulldown", 100)).toBe("");
    expect(app.plateLoadLabel("Incline Dumbbell Press", 40)).toBe("");
  });

  it("is empty at or below the bar even on a barbell lift", () => {
    const app = loadApp();
    expect(app.plateLoadLabel("Overhead Press", 20)).toBe("");
    expect(app.plateLoadLabel("Overhead Press", 0)).toBe("");
    expect(app.plateLoadLabel("Overhead Press", "")).toBe("");
  });
});

describe("the Log row shows it", () => {
  it("has a plate line under the warm-up line, hidden until there is one", () => {
    const html = appFile("index.html");
    expect(html).toContain('<div class="ex-plates" hidden></div>');
    expect(html.indexOf('class="ex-warmup"')).toBeLessThan(html.indexOf('class="ex-plates"'));
  });

  it("redraws the plate line when either the weight or the name changes", () => {
    const app = appFile("app.js");
    // Both paths matter and each has failed alone before: the weight box
    // decides the plates, and the name box decides whether there are any.
    expect(app).toContain("const showPlates = ()");
    const showWarmup = app.slice(app.indexOf("const showWarmup = ()"), app.indexOf("weightInput.addEventListener('input', showWarmup)"));
    expect(showWarmup).toContain("showPlates()");
    const showLast = app.slice(app.indexOf("const showLast = ()"), app.indexOf("nameInput.addEventListener('input', showLast)"));
    expect(showLast).toContain("showPlates()");
  });
});
