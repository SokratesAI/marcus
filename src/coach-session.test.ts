import { describe, it, expect } from "vitest";
import { buildPrompt, SESSION_INSTRUCTION } from "./coach.js";

// Idea #208: his synced state carries 21 chat messages and zero sessions. The
// coach could propose a goal and a fact about him and not the one record every
// card in this app reasons from. These pin what reaches the model.
describe("the session block instruction", () => {
  it("asks for the fence and names the fields", () => {
    const text = SESSION_INSTRUCTION("2026-09-15");
    expect(text).toContain("```session");
    expect(text).toContain('"date"');
    expect(text).toContain('"exercises"');
    expect(text).toContain('"rpe"');
  });

  // The date is the field a model gets wrong: it reasons from a training
  // cutoff months behind the day he is typing on, and the client refuses a
  // block outside its window outright rather than shifting it -- so a prompt
  // that does not print today's date produces no card at all.
  it("prints the day it is being asked on, in the example too", () => {
    const text = SESSION_INSTRUCTION("2026-09-15");
    expect(text).toContain("Today is 2026-09-15");
    expect(text).toContain('{"date": "2026-09-15"');
  });

  it("forbids a future day, a planned workout and a guess", () => {
    const text = SESSION_INSTRUCTION("2026-09-15");
    expect(text).toContain("never a day in the future");
    expect(text).toContain("planning to do");
    expect(text).toContain("do not guess");
  });

  // Nothing is saved without a tap, and a model that says it logged something
  // has told him a thing that is not true.
  it("tells the model it has not logged anything", () => {
    expect(SESSION_INSTRUCTION("2026-09-15")).toContain("do not claim you have logged it");
  });
});

describe("the session instruction in the prompt", () => {
  it("is in every prompt, dated with the day the prompt was built for", () => {
    const p = buildPrompt("hei", {}, [], "2026-09-15");
    expect(p).toContain("LOGGING A SESSION HE DID");
    expect(p).toContain("Today is 2026-09-15");
  });

  // `today` is optional on buildPrompt and the resolved day is what every
  // other section reads. An instruction built from the raw argument would say
  // "Today is undefined" on the call that omits it.
  it("falls back to the same day the rest of the prompt uses", () => {
    const p = buildPrompt("hei", {}, []);
    expect(p).not.toContain("Today is undefined");
    const today = p.match(/Today is (\d{4}-\d{2}-\d{2})/);
    expect(today).not.toBeNull();
    expect(p).toContain(`TODAY\n\n${today![1]} (`);
  });

  it("comes after the goal and profile blocks, so the model writes it last", () => {
    const p = buildPrompt("hei", {}, [], "2026-09-15");
    expect(p.indexOf("WRITING A GOAL DOWN")).toBeLessThan(p.indexOf("LOGGING A SESSION HE DID"));
    expect(p.indexOf("NOTING SOMETHING ABOUT HIM")).toBeLessThan(p.indexOf("LOGGING A SESSION HE DID"));
  });

  it("carries what he turned down under its own heading", () => {
    const p = buildPrompt("hei", { declinedSessions: ["5×5 Knebøy at 100 kg (2026-09-15)"] }, [], "2026-09-15");
    expect(p).toContain("SESSIONS HE HAS ALREADY TURNED DOWN");
    expect(p).toContain("- 5×5 Knebøy at 100 kg (2026-09-15)");
  });

  // A heading with nothing under it tells the model he refused something and
  // does not say what.
  it("prints no heading when nothing was turned down", () => {
    expect(buildPrompt("hei", {}, [], "2026-09-15")).not.toContain("SESSIONS HE HAS ALREADY TURNED DOWN");
    expect(buildPrompt("hei", { declinedSessions: ["", "  "] }, [], "2026-09-15"))
      .not.toContain("SESSIONS HE HAS ALREADY TURNED DOWN");
  });

  it("keeps the three declined lists apart", () => {
    const p = buildPrompt("hei", {
      declinedGoals: ["Oslo Tri"], declinedFacts: ["Born 1994."], declinedSessions: ["5×5 Knebøy (2026-09-15)"],
    }, [], "2026-09-15");
    expect(p.indexOf("- Oslo Tri")).toBeLessThan(p.indexOf("- Born 1994."));
    expect(p.indexOf("- Born 1994.")).toBeLessThan(p.indexOf("- 5×5 Knebøy (2026-09-15)"));
  });
});
