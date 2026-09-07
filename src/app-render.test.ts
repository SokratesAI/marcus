import { describe, it, expect } from "vitest";
import { renderApp } from "./app-dom.js";

// The first tests in this repo that read the markup the app actually produces.
// Everything else evaluates the same source against a fake DOM whose `innerHTML`
// is a plain string property, so a renderer can write anything at all and every
// assertion still passes. These render into jsdom and ask the parsed document.
//
// What they are pointed at is escaping. `esc()` exists in app-core.js and most
// of app.js uses it, but the two screens that show the training plan -- Today
// and Plan -- interpolated the day name, the focus and every exercise name raw.
// None of that is typed by a developer: the drafted week comes back from the
// coach model, and the Log tab lets you name a lift anything you like.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// A fixed Monday, so `planDayName()` picks a day this plan actually has.
const MONDAY = new Date("2026-09-07T09:00:00");

function planWith(day: string, focus: string, exerciseName: string) {
  return {
    blockName: "Test block",
    phase: "Hypertrophy",
    days: DAYS.map((d) =>
      d === day
        ? { day, focus, exercises: [{ name: exerciseName, sets: 3, reps: 10 }] }
        : { day: d, focus: "Rest", exercises: [] },
    ),
  };
}

describe("the render harness itself", () => {
  it("renders the real Home screen, not an empty container", () => {
    const app = renderApp("home", {}, { now: MONDAY });
    // Only the real app can produce this: it is the seeded Monday plan, parsed
    // out of markup the renderer wrote. An empty `#view` would fail here.
    expect(app.text()).toContain("Barbell Bench Press");
    expect(app.lines().length).toBeGreaterThan(0);
    app.close();
  });

  it("switches to the Plan screen and shows every day of the week", () => {
    const app = renderApp("plan", {}, { now: MONDAY });
    const names = Array.from(app.view.querySelectorAll(".plan-day__name")).map(
      (n: any) => n.textContent,
    );
    expect(names).toEqual(DAYS.slice(1).concat(DAYS[0]).filter((d) => names.includes(d)));
    expect(names.length).toBe(7);
    app.close();
  });
});

describe("Today shows a lift name exactly as it was written", () => {
  it("keeps a name containing angle brackets visible", () => {
    const name = "Bench Press <paused>";
    const app = renderApp("home", { plan: planWith("Monday", "Push", name) }, { now: MONDAY });
    expect(app.lines()[0]).toContain(name);
    app.close();
  });

  it("does not let a lift name add elements to the card", () => {
    const app = renderApp(
      "home",
      { plan: planWith("Monday", "Push", '<img src=x onerror="1">Curl') },
      { now: MONDAY },
    );
    expect(app.view.querySelector("img")).toBeNull();
    expect(app.text()).toContain("Curl");
    app.close();
  });

  it("keeps an ampersand in a lift name", () => {
    const name = "Squat & Press";
    const app = renderApp("home", { plan: planWith("Monday", "Push", name) }, { now: MONDAY });
    expect(app.lines()[0]).toContain(name);
    app.close();
  });

  it("shows the day's focus verbatim", () => {
    const focus = "Push <heavy>";
    const app = renderApp("home", { plan: planWith("Monday", focus, "Curl") }, { now: MONDAY });
    expect(app.text()).toContain(focus);
    app.close();
  });
});

describe("Plan shows a lift name exactly as it was written", () => {
  it("keeps a name containing angle brackets visible", () => {
    const name = "Row <wide grip>";
    const app = renderApp("plan", { plan: planWith("Tuesday", "Pull", name) }, { now: MONDAY });
    expect(app.text()).toContain(name);
    app.close();
  });

  it("does not let a lift name add elements to the day card", () => {
    const app = renderApp(
      "plan",
      { plan: planWith("Tuesday", "Pull", '<img src=x onerror="1">Row') },
      { now: MONDAY },
    );
    expect(app.view.querySelector(".plan-day img")).toBeNull();
    expect(app.text()).toContain("Row");
    app.close();
  });

  it("shows a day's focus verbatim", () => {
    // `&` alone proves nothing here: an HTML parser reads a bare `&` back as
    // `&`, so the assertion would pass over an un-escaped interpolation. The
    // angle brackets are what make this a real question.
    const focus = "Legs <heavy> & core";
    const app = renderApp("plan", { plan: planWith("Thursday", focus, "Squat") }, { now: MONDAY });
    const shown = Array.from(app.view.querySelectorAll(".plan-day__focus")).map(
      (n: any) => n.textContent,
    );
    expect(shown).toContain(focus);
    app.close();
  });

  it("shows a day name verbatim, the way the picker above it already did", () => {
    // The day picker's `<option>`s were escaped and the card heading below them
    // was not, so one screen rendered the same string two different ways. A day
    // name is normally one of seven words, but the plan is also whatever a
    // restored backup file said it was, so this is reachable.
    const plan = planWith("Monday", "Push", "Curl");
    plan.days[2] = { day: "Tues<day>", focus: "Pull", exercises: [] };
    const app = renderApp("plan", { plan }, { now: MONDAY });
    const names = Array.from(app.view.querySelectorAll(".plan-day__name")).map(
      (n: any) => n.textContent,
    );
    expect(names).toContain("Tues<day>");
    const options = Array.from(app.view.querySelectorAll("#planCardioDay option")).map(
      (n: any) => n.textContent,
    );
    expect(options).toContain("Tues<day>");
    app.close();
  });
});
