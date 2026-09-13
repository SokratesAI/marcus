import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { askCoach, buildPrompt, coachConfig, earlierInHisWords, osloDate, stripToolUseMarkers, MAX_EARLIER_CHARS, MAX_HISTORY_TURNS, READ_RETRY_TIMEOUT_MS } from "./coach.js";

const CONFIG = { baseUrl: "http://agora.test:8080", conversationId: "conv-1" };

/** Answers the conversation read with `model` and the ask with `reply`, and
 * records every request so a test can assert what was NOT sent. */
function fakeAgora(model: unknown, reply: unknown = "Nice work on the deadlift.") {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/ask")) {
      return new Response(JSON.stringify({ reply }), { status: 200 });
    }
    // The shape Agora's listing actually returns, which is where the model has
    // to be read from: there is no GET /conversations/<id>.
    return new Response(
      JSON.stringify({
        conversations: [
          { id: "someone-else", model: "anthropic:claude-opus-5" },
          ...(model === "absent" ? [] : [{ id: "conv-1", model }]),
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("coachConfig", () => {
  it("is null unless both the base url and the conversation are set", () => {
    expect(coachConfig({})).toBeNull();
    expect(coachConfig({ AGORA_BASE_URL: "http://a" })).toBeNull();
    expect(coachConfig({ MARCUS_COACH_CONVERSATION_ID: "c" })).toBeNull();
    expect(coachConfig({ AGORA_BASE_URL: "http://a/", MARCUS_COACH_CONVERSATION_ID: "c" })).toEqual({
      baseUrl: "http://a",
      conversationId: "c",
    });
  });
});

describe("buildPrompt", () => {
  it("carries the training data and the message", () => {
    const p = buildPrompt("how am I doing?", { sessions: [{ date: "2026-09-04" }] }, []);
    expect(p).toContain("TRAINING DATA");
    expect(p).toContain("2026-09-04");
    expect(p).toContain("MESSAGE FROM EDVARD");
    expect(p).toContain("how am I doing?");
  });

  it("leaves the history block out entirely when there is none", () => {
    expect(buildPrompt("hi", {}, [])).not.toContain("EARLIER IN THIS CONVERSATION");
  });

  // Idea #209: the coach is the place he states a goal, so the prompt has to
  // tell him how to hand one back. The block is asked for BEFORE the message,
  // so a message that happens to contain the word "goal" cannot read as part
  // of the instruction.
  it("asks for a goal block, and asks before the message", () => {
    const p = buildPrompt("I want to do Oslo Tri next August", {}, []);
    expect(p).toContain("WRITING A GOAL DOWN");
    expect(p).toContain("```goal");
    expect(p.indexOf("WRITING A GOAL DOWN")).toBeLessThan(p.indexOf("MESSAGE FROM EDVARD"));
  });

  it("tells the coach an ongoing goal takes an empty date rather than an invented one", () => {
    expect(buildPrompt("hi", {}, [])).toContain("must not be given an invented date");
  });

  // The bug this block exists for: with no date in the prompt, the newest rows
  // in the log are indistinguishable from current ones, and the coach said
  // "you put up 3,691kg of volume this week" about a week eight days gone.
  it("opens with the date the phone sent, and its weekday", () => {
    const p = buildPrompt("how is my week?", {}, [], "2026-09-08");
    expect(p.startsWith("TODAY\n\n2026-09-08 (Tuesday).")).toBe(true);
    // The date has to come before the data it is meant to judge.
    expect(p.indexOf("TODAY")).toBeLessThan(p.indexOf("TRAINING DATA"));
  });

  it("falls back to Oslo's date rather than dropping the block", () => {
    const bads = [
      undefined,
      "",
      "yesterday",
      "08-09-2026",
      "2026-13-01",
      "2026-02-30",
      20260908,
      "2026-9-8",
      "2026-09-08 ",
      "2026-09-08T00:00:00Z",
      "+002026-09-08",
    ];
    for (const bad of bads) {
      const p = buildPrompt("hi", {}, [], bad as string | undefined);
      expect(p).toContain("TODAY");
      expect(p).toContain(osloDate());
    }
  });

  it("names the weekday of every day of one real week", () => {
    // A whole week, so an off-by-one in the derivation cannot pass by luck.
    const week: [string, string][] = [
      ["2026-09-06", "Sunday"],
      ["2026-09-07", "Monday"],
      ["2026-09-08", "Tuesday"],
      ["2026-09-09", "Wednesday"],
      ["2026-09-10", "Thursday"],
      ["2026-09-11", "Friday"],
      ["2026-09-12", "Saturday"],
    ];
    for (const [iso, name] of week) {
      expect(buildPrompt("hi", {}, [], iso)).toContain(`${iso} (${name})`);
    }
  });
});

describe("osloDate", () => {
  it("is Oslo's date, not the UTC one, just after midnight there", () => {
    // 22:30 UTC on 06-30 is 00:30 on 07-01 in Oslo (CEST, UTC+2).
    expect(osloDate(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    // And in winter, when the offset is one hour.
    expect(osloDate(new Date("2026-01-31T23:30:00Z"))).toBe("2026-02-01");
    // Mid-afternoon the two agree, so this is the case that must NOT move.
    expect(osloDate(new Date("2026-06-30T12:00:00Z"))).toBe("2026-06-30");
  });

  it("keeps only the newest turns in the transcript, so a long chat cannot grow the prompt forever", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 5 }, (_, i) => ({
      role: i % 2 ? "marcus" : "user",
      text: `turn-${i}`,
    }));
    const p = buildPrompt("hi", {}, history);
    const transcript = p.slice(p.indexOf("EARLIER IN THIS CONVERSATION"));
    // turn-0 is his and survives in the older-messages block below; what must
    // not happen is the transcript itself reaching back past the window.
    expect(transcript).not.toContain("turn-0");
    expect(transcript).toContain(`turn-${MAX_HISTORY_TURNS + 4}`);
    expect(p).toContain("Edvard:");
    expect(p).toContain("Marcus:");
  });
});

describe("earlierInHisWords", () => {
  const marcus = (text: string) => ({ role: "marcus", text });
  const him = (text: string) => ({ role: "user", text });

  it("is empty while the whole conversation still fits in the window", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS }, (_, i) => him(`turn-${i}`));
    expect(earlierInHisWords(history)).toEqual({ lines: [], dropped: 0 });
  });

  it("carries his own older messages forward and leaves Marcus's behind", () => {
    const history = [
      him("my doctor wants my cholesterol down"),
      marcus("noted, we can build that in"),
      ...Array.from({ length: MAX_HISTORY_TURNS }, (_, i) => him(`recent-${i}`)),
    ];
    expect(earlierInHisWords(history)).toEqual({
      lines: ["my doctor wants my cholesterol down"],
      dropped: 0,
    });
  });

  it("keeps the newest that fit, in order, and counts the rest rather than hiding them", () => {
    const long = "x".repeat(1500);
    const history = [
      him(`a-${long}`),
      him(`b-${long}`),
      him(`c-${long}`),
      ...Array.from({ length: MAX_HISTORY_TURNS }, () => him("recent")),
    ];
    const { lines, dropped } = earlierInHisWords(history);
    // Two of the three 1,502-character messages fit under 4,000; the oldest does not.
    expect(lines).toEqual([`b-${long}`, `c-${long}`]);
    expect(dropped).toBe(1);
  });

  it("stops at a message too big to fit rather than reaching past it for a smaller one", () => {
    const history = [
      him("short and old"),
      him("y".repeat(MAX_EARLIER_CHARS + 1)),
      ...Array.from({ length: MAX_HISTORY_TURNS }, () => him("recent")),
    ];
    // Reaching past the oversized one would put "short and old" next to the
    // recent turns as though he had just said it.
    expect(earlierInHisWords(history)).toEqual({ lines: [], dropped: 2 });
  });

  it("ignores blank and non-string messages instead of emitting empty lines", () => {
    const history = [
      him("   "),
      { role: "user", text: 17 as unknown as string },
      him("this one counts"),
      ...Array.from({ length: MAX_HISTORY_TURNS }, () => him("recent")),
    ];
    expect(earlierInHisWords(history)).toEqual({ lines: ["this one counts"], dropped: 0 });
  });
});

describe("buildPrompt's older-messages block", () => {
  const him = (text: string) => ({ role: "user", text });
  const filler = Array.from({ length: MAX_HISTORY_TURNS }, (_, i) => him(`recent-${i}`));

  it("is absent entirely while nothing has scrolled out of the window", () => {
    expect(buildPrompt("hi", {}, filler)).not.toContain("EARLIER, IN HIS OWN WORDS");
  });

  it("quotes what he said before the window, ahead of the recent transcript", () => {
    const p = buildPrompt("hi", {}, [him("my doctor wants my cholesterol down"), ...filler]);
    expect(p).toContain("EARLIER, IN HIS OWN WORDS");
    expect(p).toContain("Edvard: my doctor wants my cholesterol down");
    expect(p.indexOf("EARLIER, IN HIS OWN WORDS")).toBeLessThan(p.indexOf("EARLIER IN THIS CONVERSATION"));
  });

  it("says how many are older still, so the model is not told this is the whole of it", () => {
    const long = "z".repeat(MAX_EARLIER_CHARS);
    const p = buildPrompt("hi", {}, [him("the oldest thing"), him(long), ...filler]);
    expect(p).toContain("1 older message(s) of his are older still");
    expect(p).not.toContain("the oldest thing");
  });

  it("does not claim anything is missing when nothing is", () => {
    const p = buildPrompt("hi", {}, [him("one old line"), ...filler]);
    expect(p).not.toContain("older still");
  });
});

describe("askCoach", () => {
  it("asks and returns the reply when the conversation is on a subscription model", async () => {
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "ok", reply: "Nice work on the deadlift." });
    expect(calls.map((c) => c.url)).toEqual([
      "http://agora.test:8080/conversations?active=true",
      "http://agora.test:8080/conversations/conv-1/ask",
    ]);
  });

  it("refuses a metered conversation and never sends the message", async () => {
    const { calls, fetchImpl } = fakeAgora("anthropic:claude-sonnet-5");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "metered", model: "anthropic:claude-sonnet-5" });
    expect(calls.some((c) => c.url.endsWith("/ask"))).toBe(false);
  });

  it("refuses a conversation with no model rather than letting Agora pick one", async () => {
    const { calls, fetchImpl } = fakeAgora(undefined);
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "metered", model: "unset" });
    expect(calls.some((c) => c.url.endsWith("/ask"))).toBe(false);
  });

  it("is unconfigured, and reaches nothing, without a config", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await askCoach("hi", {}, [], { config: null, fetch: fetchImpl })).toEqual({
      status: "unconfigured",
    });
    expect(called).toBe(false);
  });

  it("reports upstream rather than an empty reply", async () => {
    const { fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5", "   ");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result.status).toBe("upstream");
  });

  it("reports upstream when the listing cannot be read", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "upstream", detail: "conversation read returned 404" });
  });

  it("asks for the listing a second time when the first read throws, and goes on to ask the coach", async () => {
    // The failure this exists for: the marcus pod logged
    // `The operation was aborted due to timeout` on 2026-09-13 and answered
    // 502 after ten seconds without the coach ever being asked, on a read
    // whose 30 live samples that afternoon ran 0.17s to 0.88s.
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    let reads = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/ask")) {
        reads += 1;
        if (reads === 1) throw new Error("The operation was aborted due to timeout");
      }
      return fetchImpl(url as string, init);
    }) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: flaky });
    expect(result).toEqual({ status: "ok", reply: "Nice work on the deadlift." });
    expect(reads).toBe(2);
    expect(calls.some((c) => c.url.endsWith("/ask"))).toBe(true);
  });

  it("gives the retry a shorter budget than the first read", async () => {
    const timeouts: number[] = [];
    let reads = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/ask")) return new Response(JSON.stringify({ reply: "ok" }), { status: 200 });
      reads += 1;
      // `AbortSignal.timeout(n)` does not expose n, so the budget is read off
      // how long the signal actually takes to fire.
      const signal = init?.signal as AbortSignal;
      const started = Date.now();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      timeouts.push(Date.now() - started);
      throw new Error("The operation was aborted due to timeout");
    }) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl, readTimeoutMs: 60 });
    expect(result.status).toBe("upstream");
    expect(reads).toBe(2);
    expect(timeouts[0]).toBeGreaterThanOrEqual(55);
    expect(READ_RETRY_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("reports the FIRST read's failure when the retry fails too", async () => {
    let reads = 0;
    const fetchImpl = (async () => {
      reads += 1;
      throw new Error(reads === 1 ? "first stall" : "second stall");
    }) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl, readTimeoutMs: 5 });
    expect(result).toEqual({ status: "upstream", detail: "first stall" });
    expect(reads).toBe(2);
  });

  it("does not read the listing twice when it answered with a status", async () => {
    // A 404 is an answer, not a stall. Asking again returns the same 404 and
    // spends another round trip to learn nothing.
    let reads = 0;
    const fetchImpl = (async () => {
      reads += 1;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "upstream", detail: "conversation read returned 404" });
    expect(reads).toBe(1);
  });

  it("does not read the listing twice when the conversation is simply absent", async () => {
    const { calls, fetchImpl } = fakeAgora("absent");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "upstream", detail: "conversation not in the active listing" });
    expect(calls.length).toBe(1);
  });

  it("still refuses a metered model when the retry is the read that succeeded", async () => {
    // Rule 9: a retry must not become a second path to spending the prepaid
    // balance. The model is read live on whichever attempt answered.
    const { calls, fetchImpl } = fakeAgora("anthropic:claude-opus-5");
    let reads = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/ask")) {
        reads += 1;
        if (reads === 1) throw new Error("The operation was aborted due to timeout");
      }
      return fetchImpl(url as string, init);
    }) as unknown as typeof globalThis.fetch;
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: flaky });
    expect(result).toEqual({ status: "metered", model: "anthropic:claude-opus-5" });
    expect(calls.some((c) => c.url.endsWith("/ask"))).toBe(false);
  });

  it("refuses, rather than asking, when the coach is not in the active listing", async () => {
    // An archived conversation is absent from ?active=true. Asking it anyway
    // would be asking a conversation somebody deliberately shut.
    const { calls, fetchImpl } = fakeAgora("absent");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result).toEqual({ status: "upstream", detail: "conversation not in the active listing" });
    expect(calls.some((c) => c.url.endsWith("/ask"))).toBe(false);
  });

  it("reads the model off its own row and not off some other conversation's", async () => {
    // The first row in the listing is metered. A reader that took the first row
    // it saw would refuse a coach that is perfectly fine.
    const { fetchImpl } = fakeAgora("claude-cli:claude-haiku-4-5-20251001");
    const result = await askCoach("hi", {}, [], { config: CONFIG, fetch: fetchImpl });
    expect(result.status).toBe("ok");
  });
});

describe("POST /api/chat", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-coach-"));
    store = new StateStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("answers with the coach's reply", async () => {
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "how is my week?", context: { sessions: [{ date: "2026-09-04" }] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "Nice work on the deadlift." });
    const ask = calls.find((c) => c.url.endsWith("/ask"));
    expect(String((ask?.body as { text: string }).text)).toContain("2026-09-04");
  });

  it("puts the date from the request body into the prompt", async () => {
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "how is my week?", today: "2026-09-08", context: {} });
    expect(res.status).toBe(200);
    const sent = String((calls.find((c) => c.url.endsWith("/ask"))?.body as { text: string }).text);
    expect(sent).toContain("2026-09-08 (Tuesday)");
  });

  it("still sends a date when the client sends none", async () => {
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    await request(app).post("/api/chat").send({ message: "hi" });
    const sent = String((calls.find((c) => c.url.endsWith("/ask"))?.body as { text: string }).text);
    expect(sent).toContain(osloDate());
  });

  it("refuses an empty message before reaching the network", async () => {
    const { calls, fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5");
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app).post("/api/chat").send({ message: "   " });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 503, not 500, when no coach is configured", async () => {
    const app = createApp(store, undefined, { coach: null });
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
  });

  it("answers 503 on a metered conversation", async () => {
    const { fetchImpl } = fakeAgora("anthropic:claude-opus-5");
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
  });

  it("answers 502 when Agora does not answer", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: CONFIG });
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(502);
  });
});

// Measured on Edvard's own synced chat log (GET /api/state, 2026-09-13): the
// last coach turn he ever received, on 2026-09-07T20:32Z, was one sentence
// followed by `**1 tool use**` and nothing else. The marker is the Claude
// CLI's transcript placeholder for a tool call, not something the coach said.
describe("a tool-use marker in the reply", () => {
  it("is stripped off, leaving the sentence the coach actually wrote", async () => {
    const { fetchImpl } = fakeAgora(
      "claude-cli:claude-sonnet-5",
      "Skal se om jeg har notert noe om deg fra før.\n\n**1 tool use**",
    );
    const result = await askCoach("Bakgrunnen min er at jeg er semi-aktiv.", {}, [], {
      config: CONFIG,
      fetch: fetchImpl,
    });
    expect(result).toEqual({ status: "ok", reply: "Skal se om jeg har notert noe om deg fra før." });
  });

  it("counts as no reply at all when the marker is the whole turn", async () => {
    const { fetchImpl } = fakeAgora("claude-cli:claude-sonnet-5", "**2 tool uses**\n");
    const result = await askCoach("Hva skal jeg gjøre i dag?", {}, [], {
      config: CONFIG,
      fetch: fetchImpl,
    });
    expect(result).toEqual({ status: "upstream", detail: "ask returned only a tool-use marker" });
  });

  it("leaves a sentence that merely talks about tool use alone", () => {
    const spoken = "I made 1 tool use to check your log, and **1 tool use** is all it took.";
    expect(stripToolUseMarkers(spoken)).toBe(spoken);
    expect(stripToolUseMarkers("Bench is up.\n**1 tool used**")).toBe("Bench is up.\n**1 tool used**");
  });
});

// Without this section the model has no record that it ever proposed a goal,
// let alone that he said no to it -- the block is stripped before the reply is
// stored and a decline is a tap, so the same statement in the history window
// produces the same block on every turn after it.
describe("buildPrompt and a goal he turned down", () => {
  it("names the declined goals and tells the model to leave them alone", () => {
    const p = buildPrompt("what should I do this week?", { declinedGoals: ["Olympic triathlon at Oslo Tri"] }, []);
    expect(p).toContain("GOALS HE HAS ALREADY TURNED DOWN");
    expect(p).toContain("- Olympic triathlon at Oslo Tri");
    expect(p).toContain("Do not write a goal block for any of them again");
  });

  it("says nothing at all when he has turned nothing down", () => {
    expect(buildPrompt("hi", {}, [])).not.toContain("GOALS HE HAS ALREADY TURNED DOWN");
    expect(buildPrompt("hi", { declinedGoals: [] }, [])).not.toContain("GOALS HE HAS ALREADY TURNED DOWN");
    expect(buildPrompt("hi", { declinedGoals: ["  ", ""] }, [])).not.toContain("GOALS HE HAS ALREADY TURNED DOWN");
  });

  it("sits after the goal instruction and before his message, so the exception is read last", () => {
    const p = buildPrompt("set up the triathlon", { declinedGoals: ["Olympic triathlon at Oslo Tri"] }, []);
    expect(p.indexOf("WRITING A GOAL DOWN")).toBeLessThan(p.indexOf("GOALS HE HAS ALREADY TURNED DOWN"));
    expect(p.indexOf("GOALS HE HAS ALREADY TURNED DOWN")).toBeLessThan(p.indexOf("MESSAGE FROM EDVARD"));
  });

  // The app builds this list itself and it is always strings, so the only
  // shapes worth defending are the ones an old cached `app.js` can send: the
  // key missing entirely, and holes in the array.
  it("survives a non-array and holes in the list", () => {
    expect(buildPrompt("hi", { declinedGoals: "nope" as unknown as unknown[] }, [])).not.toContain("GOALS HE HAS ALREADY TURNED DOWN");
    const p = buildPrompt("hi", { declinedGoals: [null, undefined, "Race"] }, []);
    expect(p).toContain("- Race");
    expect(p.match(/^- /gm)).toHaveLength(1);
  });
});
