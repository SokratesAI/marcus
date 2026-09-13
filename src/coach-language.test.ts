import { describe, expect, it } from "vitest";
import { LANGUAGE_RULE, LANGUAGE_RULE_FIXED_KEYS } from "./goal-phase.js";
import { buildPhasePrompt } from "./goal-plan.js";
import { buildDraftPrompt, PLAN_CARDIO_ACTIVITIES, PLAN_DAY_NAMES } from "./plan-draft.js";

// Measured live on 2026-09-13 against the running app, before a line of this
// existed: POST /api/chat with "Målet mitt er å ta opp igjen triatlon -- en
// sprint og kanskje en olympisk på Oslo Triatlon i august neste år" answered in
// Norwegian and proposed three Norwegian goals, and POST /api/goal-phases on
// the dated one of those came back "Base -- Build aerobic volume across all
// three disciplines", six English phases for a Norwegian goal. The chat mirrors
// him because his own sentence is in the window; the two structured prompts
// send his goal text and a JSON schema and ask nothing, so the model answers in
// the schema's language.
//
// He asked for Norwegian in his first message to Marcus, 2026-08-31.
const NORWEGIAN_GOAL = {
  id: "g1",
  text: "Sprint-triatlon, oppkjøring mot Olympisk distanse på Oslo Triatlon",
  created: "2026-09-13",
  targetDate: "2027-08-14",
};

describe("the coach answers in the language he writes in", () => {
  it("tells the phase prompt to follow his language", () => {
    const prompt = buildPhasePrompt(NORWEGIAN_GOAL, "2026-09-13");
    expect(prompt).toContain(LANGUAGE_RULE);
  });

  // The phase schema enumerates nothing, so a sentence about "the values listed
  // here" has no referent and the likeliest field for a model to read as fixed
  // is `label` -- the one this change exists to translate.
  it("does not carve out fixed keys in the phase prompt, which has none", () => {
    const prompt = buildPhasePrompt(NORWEGIAN_GOAL, "2026-09-13");
    expect(prompt).not.toContain(LANGUAGE_RULE_FIXED_KEYS.trim());
  });

  it("tells the week prompt to follow his language", () => {
    const prompt = buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13");
    expect(prompt).toContain(LANGUAGE_RULE);
  });

  // A week answered with "Mandag" and "Svømming" is a week `parseDraftReply`
  // throws away, so the rule that turns the prose Norwegian has to name the two
  // fields it must not reach -- and it has to name them in the same rule, not in
  // a separate line the model can follow independently.
  it("carves the enumerated values out of the week prompt", () => {
    const prompt = buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13");
    expect(prompt).toContain(LANGUAGE_RULE + LANGUAGE_RULE_FIXED_KEYS);
  });

  // The carve-out says "the day names and the cardio activities"; that is only
  // true while those are what the prompt actually enumerates. If a later change
  // adds a third allowlist, this fails and the sentence gets updated with it.
  it("carves out exactly what the week prompt enumerates", () => {
    const prompt = buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13");
    expect(prompt).toContain(`"day" must be one of ${PLAN_DAY_NAMES.join(", ")}`);
    expect(prompt).toContain(`"activity" is one of ${PLAN_CARDIO_ACTIVITIES.join(", ")}`);
    expect(LANGUAGE_RULE_FIXED_KEYS).toContain("day names");
    expect(LANGUAGE_RULE_FIXED_KEYS).toContain("cardio activities");
  });

  // Both prompts get the rule from one place. Two copies of "answer in his
  // language" is two rules that can drift, and the drift would be invisible --
  // the phases and the week they belong to would come back in different
  // languages and both would look like the model being inconsistent.
  it("uses one rule in both prompts", () => {
    expect(buildPhasePrompt(NORWEGIAN_GOAL, "2026-09-13")).toContain(LANGUAGE_RULE);
    expect(buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13")).toContain(LANGUAGE_RULE);
  });

  // The rule points the model at his words rather than guessing for it. If it
  // ever stops naming where his words are, the model has nothing to detect from
  // and falls back to the schema's language, which is the bug.
  it("points the model at his own words rather than detecting for it", () => {
    expect(LANGUAGE_RULE).toContain("goal text");
  });

  // And it names no heading. `buildDraftPrompt` prints ABOUT EDVARD only when
  // he has a background record and the phase prompt never prints it, so a rule
  // naming it puts a heading in front of a model that cannot see one -- which
  // src/plan-draft-profile.test.ts already asserts against for the section
  // itself, and which caught this on its first run.
  it("names no heading that a prompt might not be printing", () => {
    expect(LANGUAGE_RULE).not.toContain("ABOUT EDVARD");
    expect(LANGUAGE_RULE).not.toContain("TRAINING DATA");
    expect(buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13")).not.toContain("ABOUT EDVARD");
  });

  // His goal text is what the rule tells the model to read, so it has to
  // actually be in the prompt -- in both of them.
  it("puts his own words in both prompts for the rule to read", () => {
    expect(buildPhasePrompt(NORWEGIAN_GOAL, "2026-09-13")).toContain(NORWEGIAN_GOAL.text);
    expect(buildDraftPrompt(NORWEGIAN_GOAL, {}, "2026-09-13")).toContain(NORWEGIAN_GOAL.text);
  });
});
