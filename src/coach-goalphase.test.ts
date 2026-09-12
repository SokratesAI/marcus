import { describe, expect, it } from "vitest";
import { buildPrompt } from "./coach.js";
import { phasePosition } from "./plan-draft.js";

// The same goal record the app writes: `validateGoal` cuts Base/Build/Peak/Taper
// off the target date and stores them on the goal.
const TRIATHLON = {
  id: "g1",
  text: "Sprint triathlon at Oslo Tri",
  targetDate: "2026-12-05",
  created: "2026-09-01",
  milestones: [
    { id: "m1", label: "Base", note: "Build the foundation — volume over intensity.", date: "2026-10-11", done: false },
    { id: "m2", label: "Build", note: "Add intensity while the volume holds.", date: "2026-11-14", done: false },
    { id: "m3", label: "Peak", note: "Sharpen — the hardest quality work of the block.", date: "2026-11-30", done: false },
    { id: "m4", label: "Taper", note: "Cut volume, keep intensity, arrive fresh.", date: "2026-12-05", done: false },
  ],
};

const ONGOING = { id: "g2", text: "Improve overall health and fitness", targetDate: "", created: "2026-09-01", milestones: [] };

function promptFor(goals: unknown[], today = "2026-09-15") {
  return buildPrompt("what should this week look like?", { goals }, [], today);
}

describe("the chat coach is told where each goal stands today", () => {
  it("carries the phase sentence, not just the milestone dates", () => {
    const prompt = promptFor([TRIATHLON]);
    expect(prompt).toContain("WHERE EACH GOAL STANDS TODAY");
    expect(prompt).toContain("Sprint triathlon at Oslo Tri: ");
    expect(prompt).toContain("of the Base phase");
  });

  it("says the same thing the drafted week is told, word for word", () => {
    // One implementation, two callers. If these ever diverge, the coach and the
    // Plan tab are describing different weeks to the same person.
    const line = phasePosition(TRIATHLON, "2026-09-15")!;
    expect(promptFor([TRIATHLON])).toContain(line);
  });

  it("moves the week on as the calendar does", () => {
    expect(promptFor([TRIATHLON], "2026-09-15")).not.toContain("Build phase");
    const later = promptFor([TRIATHLON], "2026-10-12");
    expect(later).toContain("of the Build phase");
    expect(later).not.toContain("of the Base phase");
  });

  it("reads today from the phone's date, not the server's clock", () => {
    // The whole point is arithmetic against a clock the app owns. If the block
    // ignored `today` it would describe the same phase forever.
    expect(promptFor([TRIATHLON], "2026-09-15")).not.toEqual(promptFor([TRIATHLON], "2026-12-01"));
  });

  it("writes no block for an ongoing goal, which has no phases", () => {
    expect(promptFor([ONGOING])).not.toContain("WHERE EACH GOAL STANDS TODAY");
  });

  it("writes no block once the target day has passed", () => {
    expect(promptFor([TRIATHLON], "2026-12-06")).not.toContain("WHERE EACH GOAL STANDS TODAY");
  });

  it("names each goal, so two goals cannot be read as one", () => {
    const second = { ...TRIATHLON, id: "g3", text: "Oslo Marathon", targetDate: "2027-09-18", created: "2026-09-01",
      milestones: [{ id: "n1", label: "Base", note: "", date: "2027-01-01", done: false }] };
    const prompt = promptFor([TRIATHLON, second]);
    expect(prompt).toContain("Sprint triathlon at Oslo Tri: ");
    expect(prompt).toContain("Oslo Marathon: ");
    expect(prompt.split("\n").filter((l) => l.includes("phase")).length).toBeGreaterThanOrEqual(2);
  });

  it("leaves the prompt byte-identical when there are no goals at all", () => {
    // Edvard's own synced state holds no goals today, so this is the live case.
    expect(promptFor([])).not.toContain("WHERE EACH GOAL STANDS TODAY");
  });

  it("survives a goal row that is not an object", () => {
    expect(() => promptFor([null, "nonsense", 7, TRIATHLON])).not.toThrow();
    expect(promptFor([null, "nonsense", 7, TRIATHLON])).toContain("of the Base phase");
  });
});
