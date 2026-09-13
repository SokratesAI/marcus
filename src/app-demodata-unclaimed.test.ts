import { renderApp, settle } from "./app-dom.js";
import { describe, it, expect } from "vitest";

// Edvard's own phone. `demoSeeded` is written at seed time, so a browser filled
// with demo data before that key existed carries no claim and the Home notice
// could never fire in it -- which is every browser that opened Marcus before
// 2026-09-13. I read his synced state that afternoon: 14 demo bodyweights and
// 18 demo meals still there, no goals, the made-up training week still on Home.
//
// The setup below is that browser: seed normally, then take the claim away.
async function preMarkerBrowser(mutate?: (app: any) => void) {
  const app: any = renderApp("home", {});
  await settle();
  const win: any = app.window;
  const helper = {
    ...app,
    win,
    html: () => app.view.innerHTML as string,
    get: (key: string) => {
      const raw = win.localStorage.getItem("marcus." + key);
      return raw === null ? null : JSON.parse(raw);
    },
    set: (key: string, value: unknown) =>
      win.localStorage.setItem("marcus." + key, JSON.stringify(value)),
  };
  // The browser that never had the key.
  win.localStorage.removeItem("marcus.demoSeeded");
  mutate?.(helper);
  return helper;
}

const keys = (summary: any[]) => summary.map((s) => s.key);

// The seeded Monday, spelled out here rather than reached for out of the app, so
// a test that passes because the table moved is not possible.
const DEMO_MONDAY = ["Barbell Bench Press", "Overhead Press", "Incline Dumbbell Press"];

describe("demo data in a browser that never wrote the claim", () => {
  it("recognises all three stores by their contents", async () => {
    const app = await preMarkerBrowser();
    expect(app.get("demoSeeded")).toBe(null);
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "weights", "meals"]);
    app.close();
  });

  it("says so on Home, with the counts", async () => {
    const app = await preMarkerBrowser();
    app.win.renderHome();
    expect(app.html()).toContain("This is demo data");
    expect(app.html()).toContain("bodyweights");
    app.close();
  });

  it("leaves a store alone once one row in it is his", async () => {
    // One session he logged himself. The recogniser is all-or-nothing on the
    // whole store, so the store stops being demo -- the safe direction, because
    // the alternative is offering to delete work he did.
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("sessions");
      rows.push({ id: "mine", date: "2026-09-12", day: "Wednesday", exercises: [{ name: "Zercher Squat", sets: [{ reps: 5, weight: 60 }] }] });
      a.set("sessions", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["weights", "meals"]);
    app.close();
  });

  it("leaves the meals alone once one of them is his", async () => {
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("meals");
      rows.push({ id: "mine", date: "2026-09-12", time: "19:00", name: "Kveldsmat", calories: 400, protein: 20, carbs: 40, fat: 12 });
      a.set("meals", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "weights"]);
    app.close();
  });

  it("leaves the bodyweights alone once he has logged one", async () => {
    // A logged weight lands on today, which breaks the two-day grid the seeded
    // run sits on.
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("weights");
      rows.push({ date: "2026-09-12", kg: 83.1 });
      a.set("weights", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "meals"]);
    app.close();
  });

  it("does not recognise a bodyweight run that never started at the seeded weight", async () => {
    // The whole run shifted up, so the two-day grid and the 0.1-0.2 descent are
    // both intact and the starting weight is the only thing left to read.
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("weights").map((r: any) => ({ ...r, kg: Math.round((r.kg + 7) * 10) / 10 }));
      a.set("weights", rows);
    });
    // The other two still are, so this separates "the weights stopped matching"
    // from "nothing is recognised at all".
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "meals"]);
    app.close();
  });

  it("leaves his own sessions alone when he trains the demo plan's own exercises", async () => {
    // The likeliest false positive there is: the made-up week is a bench/OHP/
    // incline Monday, so the first real session he logs carries exactly those
    // three names. The set count is what separates them -- the seed writes three
    // sets on every exercise and a man following the plan writes whatever he did.
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("sessions");
      rows.push({
        id: "mine",
        date: "2026-09-12",
        day: "Monday",
        exercises: DEMO_MONDAY.map((name) => ({ name, sets: [1, 2, 3, 4].map(() => ({ reps: 8, weight: 60 })) })),
      });
      a.set("sessions", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["weights", "meals"]);
    app.close();
  });

  it("leaves a short session alone that starts with the demo day's first exercise", async () => {
    // One exercise off the plan, three sets, on a demo day. It is a prefix of
    // the seeded Monday, so only the exercise count separates it.
    const app = await preMarkerBrowser((a) => {
      a.set("sessions", [{
        id: "mine",
        date: "2026-09-12",
        day: "Monday",
        exercises: [{ name: DEMO_MONDAY[0], sets: [1, 2, 3].map(() => ({ reps: 8, weight: 60 })) }],
      }]);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["weights", "meals"]);
    app.close();
  });

  it("leaves a meal alone that borrows a demo name but not its macros", async () => {
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("meals");
      // Same name and calories as the seeded row, his own protein.
      rows.push({ id: "mine", date: "2026-09-12", time: "19:00", name: "Protein shake", calories: 220, protein: 41, carbs: 10, fat: 4 });
      a.set("meals", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "weights"]);
    app.close();
  });

  it("leaves a bodyweight run alone that is on the grid but not the seeded descent", async () => {
    // Every other day is a normal weighing habit. Half a kilo a time is not the
    // 0.1-0.2 the seed writes, so the run is his.
    const app = await preMarkerBrowser((a) => {
      const rows = a.get("weights").map((r: any, i: number) => ({ ...r, kg: Math.round((84.4 - i * 0.5) * 10) / 10 }));
      a.set("weights", rows);
    });
    expect(keys(app.win.demoSeededSummary())).toEqual(["sessions", "meals"]);
    app.close();
  });

  it("stays quiet after he answers 'keep it, it is mine now'", async () => {
    // There is no marker left to clear when the rows are recognised by content,
    // so the answer has to be its own stored fact or the card comes straight
    // back on the next render.
    const app = await preMarkerBrowser();
    expect(keys(app.win.demoSeededSummary())).toHaveLength(3);
    app.win.forgetDemoSeeded();
    expect(app.win.demoSeededSummary()).toEqual([]);
    app.win.renderHome();
    expect(app.html()).not.toContain("This is demo data");
    app.close();
  });

  it("clears what it recognised", async () => {
    const app = await preMarkerBrowser();
    app.win.clearDemoData();
    expect(app.get("sessions")).toEqual([]);
    expect(app.get("weights")).toEqual([]);
    expect(app.get("meals")).toEqual([]);
    expect(app.win.demoSeededSummary()).toEqual([]);
    app.close();
  });
});
