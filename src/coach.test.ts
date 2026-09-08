import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { askCoach, buildPrompt, coachConfig, osloDate, MAX_HISTORY_TURNS } from "./coach.js";

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

  it("keeps only the newest turns, so a long chat cannot grow the prompt forever", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 5 }, (_, i) => ({
      role: i % 2 ? "marcus" : "user",
      text: `turn-${i}`,
    }));
    const p = buildPrompt("hi", {}, history);
    expect(p).not.toContain("turn-0");
    expect(p).toContain(`turn-${MAX_HISTORY_TURNS + 4}`);
    expect(p).toContain("Edvard:");
    expect(p).toContain("Marcus:");
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
