import { describe, it, expect } from "vitest";
import { buildDraftPrompt, calendarWeekLine, weekTargetLine } from "./plan-draft.js";

const ROW = { goal: "Olympic triathlon", start: "2026-10-05", phase: "Build", week: 2, weeks: 6, raceWeek: false };
const TARGET = { reason: "ok", phase: "Build", multiplier: 1, baseline: 3000, baselineWeeks: 3, volumeTarget: 3000 };
const GOAL = {
  text: "Olympic triathlon", targetDate: "2027-01-10", created: "2026-08-01",
  milestones: [
    { label: "Base", note: "", date: "2026-09-30" },
    { label: "Build", note: "", date: "2026-11-15" },
    { label: "Taper", note: "", date: "2027-01-10" },
  ],
};

describe("calendarWeekLine", () => {
  it("names the week, the goal and the row's own count", () => {
    expect(calendarWeekLine(ROW)).toBe(
      "Draft the week starting 2026-10-05, not the current week: in the plan for Olympic triathlon, that week is week 2 of 6 of the Build phase.");
  });

  it("says when it is the race week", () => {
    expect(calendarWeekLine({ ...ROW, raceWeek: true })).toMatch(/, and it is the race week\.$/);
  });

  it("drops a count that is not a count, and keeps the phase", () => {
    for (const bad of [{ week: 7 }, { week: 0 }, { week: "2" }, { weeks: null }]) {
      expect(calendarWeekLine({ ...ROW, ...bad })).toContain("that week is in the Build phase.");
    }
    expect(calendarWeekLine({ ...ROW, phase: null, week: null, weeks: null })).toContain("that week is outside every phase.");
  });

  it("says nothing for a row with no date or no goal, so the draft is of this week", () => {
    for (const bad of [null, "row", {}, { ...ROW, start: "5 Oct" }, { ...ROW, goal: "  " }, { ...ROW, goal: 3 }]) {
      expect(calendarWeekLine(bad)).toBeNull();
    }
  });
});

describe("buildDraftPrompt with a calendar row", () => {
  it("puts the row's line after the goal and shapes the week for it", () => {
    const prompt = buildDraftPrompt(GOAL, {}, "2026-09-16", TARGET, ROW);
    const goalAt = prompt.indexOf("Edvard is training for");
    const rowAt = prompt.indexOf("Draft the week starting 2026-10-05");
    expect(goalAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThan(goalAt);
    expect(prompt).toContain('shape it for the week in the "Draft the week starting" line above, not for the current week');
    expect(prompt).not.toContain("shape it for the phase and the week in it named above");
  });

  it("sizes the kilogram target for that week, not this one", () => {
    const prompt = buildDraftPrompt(GOAL, {}, "2026-09-16", TARGET, ROW);
    expect(prompt).toContain("the week starting 2026-10-05 has a strength target of 3000 kg of volume");
    expect(prompt).toContain("because that week is in the Build phase.");
    expect(prompt).not.toContain("His Home screen sets this week's strength target");
  });

  it("is the old prompt exactly when no row is sent, or a malformed one", () => {
    const plain = buildDraftPrompt(GOAL, {}, "2026-09-16", TARGET);
    expect(buildDraftPrompt(GOAL, {}, "2026-09-16", TARGET, undefined)).toBe(plain);
    expect(buildDraftPrompt(GOAL, {}, "2026-09-16", TARGET, { ...ROW, start: "soon" })).toBe(plain);
    expect(plain).toContain("His Home screen sets this week's strength target at 3000 kg");
  });
});

describe("weekTargetLine for a later week", () => {
  it("keeps this week's wording without a start day", () => {
    expect(weekTargetLine(TARGET)).toBe(weekTargetLine(TARGET, null));
    expect(weekTargetLine(TARGET)).toMatch(/^His Home screen sets this week's strength target at 3000 kg/);
  });
});
