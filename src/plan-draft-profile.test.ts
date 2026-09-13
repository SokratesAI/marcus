import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./plan-draft.js";
import { MAX_PROFILE_CHARS } from "./coach.js";

// Idea #209. The chat coach has read Edvard's free-text background record since
// issue #157 built it; `buildDraftPrompt` never mentioned it, so the one record
// saying he runs and rides and has never lifted seriously was invisible to the
// thing that writes his strength days. Measured 2026-09-13 against the running
// Marcus: his three real goals with an empty profile drafted a week opening on
// a Barbell Back Squat.
const GOAL = { id: "a", text: "Oslo Triathlon neste august", targetDate: "2027-08-01", created: "2026-09-13", milestones: [] };
const PROFILE = "Semi-aktiv. Loper 4-6 km to-tre ganger i uka og sykler 30 min. Har aldri trent styrke seriost.";

describe("buildDraftPrompt and his background record", () => {
  it("puts what he wrote about himself in front of the model", () => {
    const prompt = buildDraftPrompt(GOAL, { profile: PROFILE } as never, "2026-09-13");
    expect(prompt).toContain("ABOUT EDVARD");
    expect(prompt).toContain(PROFILE);
  });

  it("prints it above the training data, because it decides what the data means", () => {
    const prompt = buildDraftPrompt(GOAL, { profile: PROFILE } as never, "2026-09-13");
    expect(prompt.indexOf("ABOUT EDVARD")).toBeGreaterThan(-1);
    expect(prompt.indexOf("ABOUT EDVARD")).toBeLessThan(prompt.indexOf("TRAINING DATA"));
  });

  it("tells the model to let it decide the week, not merely that it exists", () => {
    const prompt = buildDraftPrompt(GOAL, { profile: PROFILE } as never, "2026-09-13");
    expect(prompt).toContain("let it decide what belongs in the week");
  });

  it("prints no heading at all when he has written nothing", () => {
    // An empty section is worse than none: a heading with nothing under it
    // reads to the model as an answered question.
    for (const empty of [undefined, null, "", "   ", 42, { text: "x" }]) {
      const prompt = buildDraftPrompt(GOAL, { profile: empty } as never, "2026-09-13");
      expect(prompt).not.toContain("ABOUT EDVARD");
    }
  });

  it("says the text was cut when it is over the cap, and stays silent when it is not", () => {
    const long = "a".repeat(MAX_PROFILE_CHARS + 50);
    const cut = buildDraftPrompt(GOAL, { profile: long } as never, "2026-09-13");
    expect(cut).toContain("has been cut off here");
    expect(cut).not.toContain("a".repeat(MAX_PROFILE_CHARS + 1));

    const whole = buildDraftPrompt(GOAL, { profile: PROFILE } as never, "2026-09-13");
    expect(whole).not.toContain("has been cut off here");
  });
});
