import { describe, it, expect } from "vitest";
import { draftWeek } from "./plan-draft.js";
import { coachPhases } from "./goal-plan.js";

// Measured live on 2026-09-13 against the running pod: six identical
// `POST /api/plan-draft` calls returned five weeks and one "the coach did not
// answer with JSON". Same body every time, so the failure is the model
// sampling differently and a second ask is what fixes it. These tests pin the
// second ask, and pin the three places it must NOT happen.

const config = { baseUrl: "http://agora", conversationId: "c1" };

const WEEK = {
  days: [{ day: "Monday", focus: "Push", exercises: [{ name: "Bench Press", sets: 4, reps: 8 }] }],
  note: "One day because that is what you logged.",
};

const PHASES = {
  phases: [
    { label: "Base", weeks: 6, note: "Aerobic volume." },
    { label: "Peak", weeks: 6, note: "Race pace." },
  ],
  note: "Twelve weeks, cut in two.",
};

/** Answers each successive ask with the next reply in the list, and keeps the
 * count. The last reply is reused if it is asked more times than there are
 * replies, so a test that expects one ask and gets three still fails on the
 * count rather than on an undefined body. */
function scriptedCoach(replies: string[], model = "claude-cli:claude-sonnet-5") {
  const asks: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/conversations?active=true")) {
      return { ok: true, json: async () => ({ conversations: [{ id: "c1", model }] }) } as Response;
    }
    const reply = replies[Math.min(asks.length, replies.length - 1)];
    asks.push(reply);
    return { ok: true, json: async () => ({ reply }) } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, asks };
}

describe("a structured answer that did not parse is asked for again", () => {
  it("draftWeek asks a second time and returns the week that second answer carried", async () => {
    const coach = scriptedCoach(["four days a week, I reckon", JSON.stringify(WEEK)]);
    const result = await draftWeek(null, {}, { config, fetch: coach.fetch });
    expect(result).toEqual({ status: "ok", days: WEEK.days, note: WEEK.note });
    expect(coach.asks).toHaveLength(2);
  });

  it("draftWeek asks once when the first answer is already a week", async () => {
    const coach = scriptedCoach([JSON.stringify(WEEK)]);
    const result = await draftWeek(null, {}, { config, fetch: coach.fetch });
    expect(result).toEqual({ status: "ok", days: WEEK.days, note: WEEK.note });
    expect(coach.asks).toHaveLength(1);
  });

  it("draftWeek stops after one resample rather than asking until it works", async () => {
    const coach = scriptedCoach(["nope", "still nope"]);
    const result = await draftWeek(null, {}, { config, fetch: coach.fetch });
    expect(result).toEqual({ status: "unusable", reason: "the coach did not answer with JSON" });
    expect(coach.asks).toHaveLength(2);
  });

  it("draftWeek resamples a reply that was valid JSON and broke a rule, not only unparseable text", async () => {
    // "Someday" is not a day of the week: this answer was JSON, it just failed
    // a rule. `parseDraftReply` returns the same `ok: false` for that as it
    // does for prose, so both get the second chance -- which is the deliberate
    // line, because a model that names a bad day once often names a good one
    // next time. Pinned so that a future change narrowing the resample to
    // "did not parse at all" is a decision rather than an accident.
    const coach = scriptedCoach([
      '{"days":[{"day":"Someday","focus":"Push","exercises":[]}]}',
      JSON.stringify(WEEK),
    ]);
    const result = await draftWeek(null, {}, { config, fetch: coach.fetch });
    expect(result).toEqual({ status: "ok", days: WEEK.days, note: WEEK.note });
    expect(coach.asks).toHaveLength(2);
  });

  it("draftWeek reports the answer it did get when the resample cannot reach the coach", async () => {
    // The first ask answered and it was not a week. The second never arrived.
    // "the coach did not answer" would be a lie about the first one.
    let asks = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/conversations?active=true")) {
        return {
          ok: true,
          json: async () => ({ conversations: [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] }),
        } as Response;
      }
      asks += 1;
      if (asks === 1) return { ok: true, json: async () => ({ reply: "no JSON here" }) } as Response;
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const result = await draftWeek(null, {}, { config, fetch: fetchImpl });
    expect(result).toEqual({ status: "unusable", reason: "the coach did not answer with JSON" });
    expect(asks).toBe(2);
  });

  it("draftWeek does not ask twice when the conversation is on a metered model", async () => {
    // Rule: production never spends the metered API. A resample must not turn
    // one refusal into two attempts at spending it.
    const coach = scriptedCoach([JSON.stringify(WEEK)], "anthropic:claude-sonnet-5");
    const result = await draftWeek(null, {}, { config, fetch: coach.fetch });
    expect(result).toEqual({ status: "metered", model: "anthropic:claude-sonnet-5" });
    expect(coach.asks).toHaveLength(0);
  });

  it("coachPhases asks a second time and returns the block that second answer carried", async () => {
    const coach = scriptedCoach(["twelve weeks, roughly", JSON.stringify(PHASES)]);
    const result = await coachPhases(
      { text: "Olympic triathlon", targetDate: "2027-06-01", created: "2026-09-13" },
      {},
      { config, fetch: coach.fetch, today: "2026-09-13" },
    );
    expect(result.status).toBe("ok");
    expect(coach.asks).toHaveLength(2);
  });

  it("coachPhases never asks at all for a goal it refuses on its own", async () => {
    // An ongoing goal has no span to cut. That refusal is decided here, before
    // the coach is reached, so the resample must not turn it into two calls --
    // or into one.
    const coach = scriptedCoach([JSON.stringify(PHASES)]);
    const result = await coachPhases(
      { text: "get fitter", created: "2026-09-13" },
      {},
      { config, fetch: coach.fetch, today: "2026-09-13" },
    );
    expect(result).toEqual({ status: "unusable", reason: "an ongoing goal has no phases to shape" });
    expect(coach.asks).toHaveLength(0);
  });
});
