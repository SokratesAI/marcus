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

// The other half of the record, added the cycle after it existed: the coach
// can now propose a fact about him the same way it proposes a goal, so he does
// not have to open another tab and retype what he just said in the chat.
describe("asking the coach to note something about him", () => {
  it("tells the model the fence, the shape and that nothing is saved without him", () => {
    const p = buildPrompt("I was born in 1994 and I am semi-active", {}, []);
    expect(p).toContain("NOTING SOMETHING ABOUT HIM");
    expect(p).toContain("```profile");
    expect(p).toContain('{"text":');
    expect(p).toContain("He has to confirm it before anything is saved");
  });

  // The app strips the goal fence first and then the profile fence off what is
  // left, so the order it is told to write them in is the order it is parsed.
  it("is printed after the goal instruction and says which block comes first", () => {
    const p = buildPrompt("hi", {}, []);
    expect(p.indexOf("NOTING SOMETHING ABOUT HIM")).toBeGreaterThan(p.indexOf("WRITING A GOAL DOWN"));
    expect(p).toContain("the goal blocks first");
  });

  it("names what a profile block is not, so a single session does not become who he is", () => {
    expect(buildPrompt("hi", {}, [])).toContain("that is training data, not who he is");
  });

  // Pointing the model at a heading that is not in its prompt is how it starts
  // inventing what was under it -- and an empty profile is the state where
  // every fact he says is worth a card.
  it("only tells it not to repeat ABOUT EDVARD when that section is there", () => {
    expect(buildPrompt("hi", { profile: "Born 1994." }, [])).toContain(
      "Do not write a block for anything already in ABOUT EDVARD above.",
    );
    expect(buildPrompt("hi", {}, [])).not.toContain("ABOUT EDVARD");
  });
});

describe("buildPrompt and a fact about him he turned down", () => {
  it("lists it and says not to raise it again", () => {
    const p = buildPrompt("hi", { declinedFacts: ["Born 1994."] }, []);
    expect(p).toContain("THINGS ABOUT HIM HE HAS ALREADY TURNED DOWN");
    expect(p).toContain("- Born 1994.");
    expect(p).toContain("do not treat them as established fact");
  });

  // A heading with nothing under it is worse than no heading -- it tells the
  // model he has refused something and does not say what.
  it("prints no heading when nothing was turned down", () => {
    expect(buildPrompt("hi", {}, [])).not.toContain("THINGS ABOUT HIM HE HAS ALREADY TURNED DOWN");
    expect(buildPrompt("hi", { declinedFacts: ["", "  "] }, [])).not.toContain("THINGS ABOUT HIM HE HAS ALREADY TURNED DOWN");
  });

  // The two lists are separate on purpose: a goal he refused and a fact he
  // refused mean different things to the model.
  it("does not mix them with the declined goals", () => {
    const p = buildPrompt("hi", { declinedGoals: ["Oslo Tri"], declinedFacts: ["Born 1994."] }, []);
    expect(p.indexOf("- Oslo Tri")).toBeLessThan(p.indexOf("- Born 1994."));
    expect(p).toContain("GOALS HE HAS ALREADY TURNED DOWN");
    expect(p).toContain("THINGS ABOUT HIM HE HAS ALREADY TURNED DOWN");
  });
});
