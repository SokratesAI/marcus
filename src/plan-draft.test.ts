import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { buildDraftPrompt, draftWeek, parseDraftReply, PLAN_DAY_NAMES } from "./plan-draft.js";

const WEEK = {
  days: [
    { day: "Monday", focus: "Push", exercises: [{ name: "Bench Press", sets: 4, reps: 8 }] },
    { day: "Tuesday", focus: "Rest", exercises: [] },
  ],
  note: "Two days because that is what you logged.",
};

describe("buildDraftPrompt", () => {
  it("names the goal and its target date", () => {
    const prompt = buildDraftPrompt({ text: "Olympic triathlon", targetDate: "2027-06-01" }, {});
    expect(prompt).toContain("Olympic triathlon");
    expect(prompt).toContain("2027-06-01");
  });

  it("says so rather than inventing one when there is no goal", () => {
    const prompt = buildDraftPrompt(null, {});
    expect(prompt).toContain("has not written a goal");
  });

  it("carries his own records, so the week is built from them", () => {
    const prompt = buildDraftPrompt(null, { sessions: [{ date: "2026-09-01", exercises: [] }] });
    expect(prompt).toContain("2026-09-01");
  });

  it("names every goal, nearest target first, and says the week has to serve all of them", () => {
    const prompt = buildDraftPrompt(
      [
        { text: "Olympic triathlon", targetDate: "2027-06-01" },
        { text: "Squat 140kg", targetDate: "2026-12-01" },
      ],
      {},
    );
    const goalBlock = prompt.split("TRAINING DATA")[0];
    expect(goalBlock).toContain("2 goals at once");
    expect(goalBlock.indexOf("Squat 140kg")).toBeGreaterThan(-1);
    expect(goalBlock.indexOf("Squat 140kg")).toBeLessThan(goalBlock.indexOf("Olympic triathlon"));
    expect(goalBlock).toContain("serve every one of them");
  });

  it("puts a goal with no date after the dated ones", () => {
    const prompt = buildDraftPrompt([{ text: "Get fitter" }, { text: "Olympic triathlon", targetDate: "2027-06-01" }], {});
    const goalBlock = prompt.split("TRAINING DATA")[0];
    expect(goalBlock.indexOf("Olympic triathlon")).toBeLessThan(goalBlock.indexOf("Get fitter"));
  });

  it("reads a one-goal list exactly as it reads the single goal", () => {
    const one = { text: "Olympic triathlon", targetDate: "2027-06-01" };
    expect(buildDraftPrompt([one], {})).toBe(buildDraftPrompt(one, {}));
  });

  it("says his goals have passed, not that he never set one, when none is still ahead", () => {
    const prompt = buildDraftPrompt([], { goals: [{ text: "Olympic triathlon", targetDate: "2026-06-01" }] });
    expect(prompt).toContain("passed its target date");
    expect(prompt).not.toContain("has not written a goal");
  });

  it("treats a list of blank goals as no goal", () => {
    expect(buildDraftPrompt([{ text: "  " }], {})).toContain("has not written a goal");
  });

  it("lists every legal day name, since the parser refuses anything else", () => {
    const prompt = buildDraftPrompt(null, {});
    for (const day of PLAN_DAY_NAMES) expect(prompt).toContain(day);
  });
});

describe("parseDraftReply", () => {
  it("reads a bare JSON object", () => {
    const parsed = parseDraftReply(JSON.stringify(WEEK));
    expect(parsed).toEqual({ ok: true, days: WEEK.days, note: WEEK.note });
  });

  it("reads a fenced block, including when the prose after it carries a brace", () => {
    // The brace is the point: without the fence match, the outer-object slice
    // would run to the last `}` in the whole reply and parse nothing.
    const parsed = parseDraftReply(
      "Here you go:\n```json\n" + JSON.stringify(WEEK) + "\n```\nThen adjust {rest days} to suit.",
    );
    expect(parsed).toEqual({ ok: true, days: WEEK.days, note: WEEK.note });
  });

  it("canonicalises the spelling of a day", () => {
    const parsed = parseDraftReply('{"days":[{"day":"  monday ","focus":"Push","exercises":[]}]}');
    expect(parsed.ok && parsed.days[0].day).toBe("Monday");
  });

  it("refuses prose with no JSON in it at all", () => {
    const parsed = parseDraftReply("I would train four days a week, starting with push.");
    expect(parsed).toEqual({ ok: false, reason: "the coach did not answer with JSON" });
  });

  it("refuses JSON that carries no days", () => {
    expect(parseDraftReply('{"note":"nice week"}').ok).toBe(false);
    expect(parseDraftReply('{"days":[]}').ok).toBe(false);
  });

  it("refuses a day that is not a day of the week", () => {
    const parsed = parseDraftReply('{"days":[{"day":"Someday","focus":"Push","exercises":[]}]}');
    expect(parsed).toEqual({ ok: false, reason: '"Someday" is not a day of the week' });
  });

  it("refuses the same day twice", () => {
    const parsed = parseDraftReply(
      '{"days":[{"day":"Monday","focus":"Push","exercises":[]},{"day":"Monday","focus":"Pull","exercises":[]}]}',
    );
    expect(parsed).toEqual({ ok: false, reason: "Monday appears twice" });
  });

  it("refuses a day with no focus", () => {
    const parsed = parseDraftReply('{"days":[{"day":"Monday","focus":"   ","exercises":[]}]}');
    expect(parsed).toEqual({ ok: false, reason: "Monday has no focus" });
  });

  it("refuses a day with no exercise list, which is not the same as an empty one", () => {
    expect(parseDraftReply('{"days":[{"day":"Monday","focus":"Rest"}]}')).toEqual({
      ok: false,
      reason: "Monday has no exercise list",
    });
    expect(parseDraftReply('{"days":[{"day":"Monday","focus":"Rest","exercises":[]}]}').ok).toBe(true);
  });

  it("refuses sets that only look like a number, because the page does arithmetic on them", () => {
    const parsed = parseDraftReply(
      '{"days":[{"day":"Monday","focus":"Push","exercises":[{"name":"Bench","sets":"4","reps":8}]}]}',
    );
    expect(parsed).toEqual({ ok: false, reason: "Bench on Monday has no whole number of sets" });
  });

  it("refuses fractional or absent reps", () => {
    expect(
      parseDraftReply('{"days":[{"day":"Monday","focus":"Push","exercises":[{"name":"Bench","sets":4,"reps":8.5}]}]}'),
    ).toEqual({ ok: false, reason: "Bench on Monday has no whole number of reps" });
    expect(
      parseDraftReply('{"days":[{"day":"Monday","focus":"Push","exercises":[{"name":"Bench","sets":4}]}]}'),
    ).toEqual({ ok: false, reason: "Bench on Monday has no whole number of reps" });
  });

  it("refuses zero sets, which would render as an exercise nobody does", () => {
    const parsed = parseDraftReply(
      '{"days":[{"day":"Monday","focus":"Push","exercises":[{"name":"Bench","sets":0,"reps":8}]}]}',
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses an exercise with no name", () => {
    const parsed = parseDraftReply('{"days":[{"day":"Monday","focus":"Push","exercises":[{"sets":4,"reps":8}]}]}');
    expect(parsed).toEqual({ ok: false, reason: "Monday has an exercise with no name" });
  });

  it("keeps a missing note as an empty string rather than inventing one", () => {
    const parsed = parseDraftReply('{"days":[{"day":"Monday","focus":"Rest","exercises":[]}]}');
    expect(parsed.ok && parsed.note).toBe("");
  });
});

function coachFetch(reply: string, model = "claude-cli:claude-sonnet-5"): typeof globalThis.fetch {
  return (async (url: string) => {
    if (String(url).includes("/conversations?active=true")) {
      return { ok: true, json: async () => ({ conversations: [{ id: "c1", model }] }) } as Response;
    }
    return { ok: true, json: async () => ({ reply }) } as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("draftWeek", () => {
  const config = { baseUrl: "http://agora", conversationId: "c1" };

  it("returns the parsed week when the coach answers with one", async () => {
    const result = await draftWeek(null, {}, { config, fetch: coachFetch(JSON.stringify(WEEK)) });
    expect(result).toEqual({ status: "ok", days: WEEK.days, note: WEEK.note });
  });

  it("reports an answer that is not a week as unusable, not as an upstream failure", async () => {
    const result = await draftWeek(null, {}, { config, fetch: coachFetch("four days a week, I reckon") });
    expect(result).toEqual({ status: "unusable", reason: "the coach did not answer with JSON" });
  });

  it("never reaches a metered conversation", async () => {
    const result = await draftWeek(
      null,
      {},
      { config, fetch: coachFetch(JSON.stringify(WEEK), "anthropic:claude-sonnet-5") },
    );
    expect(result).toEqual({ status: "metered", model: "anthropic:claude-sonnet-5" });
  });

  it("passes an unconfigured coach straight back", async () => {
    const result = await draftWeek(null, {}, { config: null, fetch: coachFetch("{}") });
    expect(result).toEqual({ status: "unconfigured" });
  });
});

describe("POST /api/plan-draft", () => {
  const CONFIG = { baseUrl: "http://agora", conversationId: "c1" };
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-draft-"));
    store = new StateStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("answers with the drafted week and sends his records to the coach", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      if (String(url).includes("/conversations?active=true")) {
        return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
      }
      return { ok: true, json: async () => ({ reply: JSON.stringify(WEEK) }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app)
      .post("/api/plan-draft")
      .send({ goal: { text: "Olympic triathlon" }, context: { sessions: [{ date: "2026-09-04" }] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ days: WEEK.days, note: WEEK.note });
    expect(calls.join("")).toContain("2026-09-04");
    expect(calls.join("")).toContain("Olympic triathlon");
  });

  it("sends every goal in a `goals` list to the coach, not only the first", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      if (String(url).includes("/conversations?active=true")) {
        return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
      }
      return { ok: true, json: async () => ({ reply: JSON.stringify(WEEK) }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app)
      .post("/api/plan-draft")
      .send({ goals: [{ text: "Squat 140kg", targetDate: "2026-12-01" }, { text: "Olympic triathlon", targetDate: "2027-06-01" }], context: {} });
    expect(res.status).toBe(200);
    // The context carries no goals, so both names can only have come from the goal lines.
    const sent = calls.join("");
    expect(sent).toContain("2 goals at once");
    expect(sent).toContain("Squat 140kg");
    expect(sent).toContain("Olympic triathlon");
  });

  it("never writes the draft into the store — it is a proposal, not a plan", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes("/conversations?active=true")
        ? ({ ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response)
        : ({ ok: true, json: async () => ({ reply: JSON.stringify(WEEK) }) } as Response)) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    await request(app).post("/api/plan-draft").send({});
    const state = await store.read();
    expect(state.rev).toBe(0);
    expect(state.data).toBeNull();
  });

  it("answers 502 with the reason when the coach answers something that is not a week", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes("/conversations?active=true")
        ? ({ ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response)
        : ({ ok: true, json: async () => ({ reply: '{"days":[{"day":"Someday","focus":"Push","exercises":[]}]}' }) } as Response)) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app).post("/api/plan-draft").send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("is not a day of the week");
  });

  it("answers 503, not 500, when no coach is configured", async () => {
    const app = createApp(store, undefined, { coach: null });
    const res = await request(app).post("/api/plan-draft").send({});
    expect(res.status).toBe(503);
  });

  it("answers 503 on a metered conversation, and never asks it", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      return String(url).includes("/conversations?active=true")
        ? ({ ok: true, json: async () => [{ id: "c1", model: "anthropic:claude-opus-5" }] } as Response)
        : ({ ok: true, json: async () => ({ reply: JSON.stringify(WEEK) }) } as Response);
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app).post("/api/plan-draft").send({});
    expect(res.status).toBe(503);
    expect(asked.some((u) => u.endsWith("/ask"))).toBe(false);
  });
});

import { PLAN_CARDIO_ACTIVITIES } from "./plan-draft.js";
import { appFile } from "./app-source.js";

describe("cardio in a drafted week", () => {
  const reply = (day: Record<string, unknown>) => JSON.stringify({ days: [day], note: "" });

  it("asks for cardio by the activities the plan knows", () => {
    const prompt = buildDraftPrompt({ text: "Olympic triathlon" }, {});
    for (const a of PLAN_CARDIO_ACTIVITIES) expect(prompt).toContain(a);
    expect(prompt).toContain('"cardio"');
  });

  it("keeps a swim the coach put on a day", () => {
    const r = parseDraftReply(reply({ day: "Tuesday", focus: "Swim", exercises: [], cardio: { activity: "swim", minutes: 45 } }));
    expect(r).toEqual({ ok: true, days: [{ day: "Tuesday", focus: "Swim", exercises: [], cardio: { activity: "Swim", minutes: 45 } }], note: "" });
  });

  it("reads an absent or null cardio as no cardio, not as a refusal", () => {
    for (const cardio of [undefined, null]) {
      const r = parseDraftReply(reply({ day: "Monday", focus: "Push", exercises: [], cardio }));
      expect(r.ok).toBe(true);
      if (r.ok) expect("cardio" in r.days[0]).toBe(false);
    }
  });

  it("refuses an activity the Plan tab could never have written", () => {
    const r = parseDraftReply(reply({ day: "Monday", focus: "Cardio", exercises: [], cardio: { activity: "Zumba", minutes: 30 } }));
    expect(r).toEqual({ ok: false, reason: '"Zumba" on Monday is not an activity the plan knows' });
  });

  it("refuses minutes that are not a whole positive number", () => {
    for (const minutes of ["45", 30.5, 0, undefined]) {
      const r = parseDraftReply(reply({ day: "Monday", focus: "Run", exercises: [], cardio: { activity: "Run", minutes } }));
      expect(r).toEqual({ ok: false, reason: "the Run on Monday has no whole number of minutes" });
    }
  });

  it("refuses cardio that is not an object", () => {
    const r = parseDraftReply(reply({ day: "Monday", focus: "Run", exercises: [], cardio: "a long run" }));
    expect(r).toEqual({ ok: false, reason: "the cardio on Monday is not a session" });
  });

  it("uses exactly the front end's activity list", () => {
    const m = appFile("app-core.js").match(/const CARDIO_ACTIVITIES = (\[[^\]]*\]);/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1].replace(/'/g, '"'))).toEqual([...PLAN_CARDIO_ACTIVITIES]);
  });
});

import { PLAN_CARDIO_MAX_MINUTES } from "./plan-draft.js";

describe("cardio in a drafted week, inside the Plan tab's own bounds", () => {
  const reply = (day: Record<string, unknown>) => JSON.stringify({ days: [day], note: "" });

  it("refuses a session longer than the form would accept, and takes one at the limit", () => {
    const over = parseDraftReply(reply({ day: "Sunday", focus: "Bike", exercises: [], cardio: { activity: "Bike", minutes: 1441 } }));
    expect(over).toEqual({ ok: false, reason: "the Bike on Sunday is longer than 1440 minutes" });
    const at = parseDraftReply(reply({ day: "Sunday", focus: "Bike", exercises: [], cardio: { activity: "Bike", minutes: 1440 } }));
    expect(at.ok).toBe(true);
  });

  it("uses exactly the front end's minutes ceiling", () => {
    const m = appFile("app-core.js").match(/minutes:\s*\{\s*min:\s*1,\s*max:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(PLAN_CARDIO_MAX_MINUTES);
  });

  it("names a Rest day with a session on it after the session, as the Plan tab does", () => {
    const r = parseDraftReply(reply({ day: "Tuesday", focus: "Rest", exercises: [], cardio: { activity: "Swim", minutes: 45 } }));
    expect(r.ok && r.days[0].focus).toBe("Swim");
    const kept = parseDraftReply(reply({ day: "Monday", focus: "Legs", exercises: [], cardio: { activity: "Run", minutes: 20 } }));
    expect(kept.ok && kept.days[0].focus).toBe("Legs");
  });
});
