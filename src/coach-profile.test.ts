import { describe, it, expect } from "vitest";
import { aboutHim, buildPrompt, MAX_PROFILE_CHARS } from "./coach.js";

// Issue #157: Marcus's chat has no memory of who Edvard is. On 2026-09-07 he
// typed his training background into the chat and the coach answered that it
// would check whether it had noted anything about him before. It had nowhere
// to note anything. `profile` is that place; these pin what reaches the model.
describe("what Marcus knows about Edvard", () => {
  it("puts his own words in the prompt under a heading that says they are established", () => {
    const prompt = buildPrompt(
      "Hva bor jeg gjore i dag?",
      { profile: "Born 1994, semi-active. Covid in 2020 and my endurance never came back." },
      [],
      "2026-09-13",
    );
    expect(prompt).toContain("ABOUT EDVARD");
    expect(prompt).toContain("Born 1994, semi-active.");
    expect(prompt).toContain("do not ask him for anything it already answers");
    // Above the log, because it is who he is rather than what he did.
    expect(prompt.indexOf("ABOUT EDVARD")).toBeGreaterThan(prompt.indexOf("TRAINING DATA"));
    expect(prompt.indexOf("ABOUT EDVARD")).toBeLessThan(prompt.indexOf("MESSAGE FROM EDVARD"));
  });

  it("prints no heading at all when he has written nothing", () => {
    for (const empty of [undefined, "", "   ", null, 42, { text: "x" }]) {
      expect(buildPrompt("hei", { profile: empty }, [], "2026-09-13")).not.toContain("ABOUT EDVARD");
    }
  });

  it("trims, and keeps everything under the cap whole", () => {
    expect(aboutHim("  semi-active  ")).toEqual({ text: "semi-active", truncated: false });
    const long = "x".repeat(MAX_PROFILE_CHARS);
    expect(aboutHim(long)).toEqual({ text: long, truncated: false });
  });

  it("says out loud when it cut him off, rather than handing the model half a sentence", () => {
    const over = "y".repeat(MAX_PROFILE_CHARS + 50);
    const cut = aboutHim(over);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBe(MAX_PROFILE_CHARS);
    const prompt = buildPrompt("hei", { profile: over }, [], "2026-09-13");
    expect(prompt).toContain("It is longer than this and has been cut off here.");
    // And the unclipped case must not claim a cut that did not happen.
    expect(buildPrompt("hei", { profile: "short" }, [], "2026-09-13")).not.toContain("cut off here");
  });
});
