import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { CoachOutcomeLog, MAX_SAMPLES, summarise } from "./coach-outcome.js";

// Issue #227: the instrument under `marcus-kr-coach-first-try`. See the header
// of coach-outcome.ts for why a per-call outcome is the right reading and why
// a refusal the coach never saw is deliberately not one.

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-coachout-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("summarise", () => {
  it("reports no share at all when nothing has been recorded", () => {
    // Null and not 0: 0% says every tap failed, which is the opposite reading
    // from "the coach has not been asked anything yet".
    expect(summarise([])).toEqual({
      count: 0, answered: 0, firstTryPct: null, newestAt: null, oldestAt: null, byRoute: {},
      probes: { count: 0, answered: 0 },
    });
  });

  it("is the share of calls that came back usable", () => {
    const s = summarise([
      { at: "2026-09-14T01:00:00.000Z", route: "plan-draft", ok: true },
      { at: "2026-09-14T02:00:00.000Z", route: "plan-draft", ok: false },
      { at: "2026-09-14T03:00:00.000Z", route: "plan-draft", ok: true },
      { at: "2026-09-14T04:00:00.000Z", route: "plan-draft", ok: true },
    ]);
    expect(s.count).toBe(4);
    expect(s.answered).toBe(3);
    expect(s.firstTryPct).toBe(75);
  });

  it("keeps one decimal rather than rounding a share to a whole percent", () => {
    // 2 of 3 is 66.7 and not 67: the target is 99, so the last decimal is
    // where this measure actually lives.
    const s = summarise([
      { at: "2026-09-14T01:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T02:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T03:00:00.000Z", route: "chat", ok: false },
    ]);
    expect(s.firstTryPct).toBe(66.7);
  });

  it("splits by route, because one broken surface and three tired ones read alike", () => {
    const s = summarise([
      { at: "2026-09-14T01:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T02:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T03:00:00.000Z", route: "goal-phases", ok: false },
      { at: "2026-09-14T04:00:00.000Z", route: "goal-phases", ok: false },
    ]);
    expect(s.firstTryPct).toBe(50);
    expect(s.byRoute).toEqual({
      chat: { count: 2, answered: 2 },
      "goal-phases": { count: 2, answered: 0 },
    });
  });

  it("reports the oldest and newest sample, not the order they arrived in", () => {
    const s = summarise([
      { at: "2026-09-14T03:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T01:00:00.000Z", route: "chat", ok: true },
      { at: "2026-09-14T02:00:00.000Z", route: "chat", ok: true },
    ]);
    expect(s.newestAt).toBe("2026-09-14T03:00:00.000Z");
    expect(s.oldestAt).toBe("2026-09-14T01:00:00.000Z");
  });
});

describe("CoachOutcomeLog", () => {
  it("survives a restart, which is the whole reason it is on disk", async () => {
    await new CoachOutcomeLog(dir).record("chat", true, "2026-09-14T01:00:00.000Z");
    const reopened = await new CoachOutcomeLog(dir).summary();
    expect(reopened.count).toBe(1);
    expect(reopened.firstTryPct).toBe(100);
  });

  it("keeps only the newest MAX_SAMPLES", async () => {
    const log = new CoachOutcomeLog(dir);
    for (let i = 0; i < MAX_SAMPLES + 5; i += 1) {
      await log.record("chat", i >= 5, `2026-09-14T01:00:0${i % 10}.000Z`);
    }
    const kept = await log.list();
    expect(kept.length).toBe(MAX_SAMPLES);
    // The five failures were the oldest, so they are the five that fell off.
    expect(kept.every((s) => s.ok)).toBe(true);
  });

  it("reads an empty history off a file that is not there", async () => {
    expect(await new CoachOutcomeLog(dir).list()).toEqual([]);
  });

  it("drops junk rather than reporting it as a tap", async () => {
    const log = new CoachOutcomeLog(dir);
    await fs.writeFile(
      log.filePath,
      JSON.stringify([
        { at: "2026-09-14T01:00:00.000Z", route: "chat", ok: true },
        { at: "2026-09-14T02:00:00.000Z", route: "chat", ok: "yes" },
        { at: "2026-09-14T03:00:00.000Z", route: "", ok: false },
        { at: 5, route: "chat", ok: false },
      ]),
      "utf8",
    );
    const kept = await log.list();
    expect(kept.length).toBe(1);
    expect(kept[0].route).toBe("chat");
  });

  it("does not let a routeless call evict a real one", async () => {
    // The guard in `record` is not the same as the filter in `list`: `list`
    // drops a junk sample when it is read, by which time it has already taken
    // one of the MAX_SAMPLES slots and pushed the oldest real call off the end.
    const log = new CoachOutcomeLog(dir);
    for (let i = 0; i < MAX_SAMPLES; i += 1) {
      await log.record("chat", true, "2026-09-14T01:00:00.000Z");
    }
    await log.record("", false, "2026-09-14T02:00:00.000Z");
    const kept = await log.list();
    expect(kept.length).toBe(MAX_SAMPLES);
    expect(kept.every((s) => s.ok)).toBe(true);
  });

  it("reads an empty history off a corrupt file instead of breaking the route", async () => {
    const log = new CoachOutcomeLog(dir);
    await fs.writeFile(log.filePath, "{not json", "utf8");
    expect(await log.list()).toEqual([]);
  });

  it("never throws when the file cannot be written", async () => {
    const log = new CoachOutcomeLog(dir);
    await fs.mkdir(log.filePath, { recursive: true });
    await expect(log.record("chat", true, "2026-09-14T01:00:00.000Z")).resolves.toBeUndefined();
  });
});

describe("GET /api/coach/outcomes", () => {
  it("has no share before the coach has been asked once", async () => {
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachOutcomes: new CoachOutcomeLog(dir) });
    const res = await request(app).get("/api/coach/outcomes");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.firstTryPct).toBeNull();
  });

  it("records an answered draft as a tap that needed no second try", async () => {
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(200);

    const res = await request(app).get("/api/coach/outcomes");
    expect(res.body.count).toBe(1);
    expect(res.body.firstTryPct).toBe(100);
    expect(res.body.byRoute).toEqual({ "plan-draft": { count: 1, answered: 1 } });
  });

  it("records a coach that answered something unusable as a failed tap", async () => {
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: notAWeek(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(502);

    const res = await request(app).get("/api/coach/outcomes");
    expect(res.body.count).toBe(1);
    expect(res.body.answered).toBe(0);
    expect(res.body.firstTryPct).toBe(0);
  });

  it("records the chat and the phases as well, not only the week draft", async () => {
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    const chat = await request(app).post("/api/chat").send({ message: "how am I doing?", context: {} });
    expect(chat.status).toBe(200);
    const phases = await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-16", context: {} });
    expect(phases.status).toBe(200);

    const res = await request(app).get("/api/coach/outcomes");
    expect(res.body.byRoute.chat).toEqual({ count: 1, answered: 1 });
    expect(res.body.byRoute["goal-phases"]).toEqual({ count: 1, answered: 1 });
  });

  it("records nothing at all when the coach was never asked", async () => {
    // `coach: null` is the unconfigured case: this server refuses before
    // anything leaves the pod, and every retry would refuse identically
    // forever. Counting it would report a coach that answered 0% of taps for
    // a deployment where the coach was asked nothing.
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachOutcomes: new CoachOutcomeLog(dir) });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(503);
    const chat = await request(app).post("/api/chat").send({ message: "hi", context: {} });
    expect(chat.status).toBe(503);

    const res = await request(app).get("/api/coach/outcomes");
    expect(res.body.count).toBe(0);
    expect(res.body.firstTryPct).toBeNull();
  });

  it("records nothing for a body this server rejected before asking anyone", async () => {
    // A 400 never reached the coach either.
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    const chat = await request(app).post("/api/chat").send({ message: "   ", context: {} });
    expect(chat.status).toBe(400);

    const res = await request(app).get("/api/coach/outcomes");
    expect(res.body.count).toBe(0);
  });

  it("answers a summary and never the individual taps", async () => {
    const log = new CoachOutcomeLog(dir);
    await log.record("chat", true, "2026-09-14T01:00:00.000Z");
    // The middle tap: the only timestamp that is neither the newest nor the
    // oldest, so it is the one a leaked sample list would put in the body.
    await log.record("chat", false, "2026-09-14T01:02:03.000Z");
    await log.record("chat", true, "2026-09-14T01:09:09.000Z");
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachOutcomes: log });
    const res = await request(app).get("/api/coach/outcomes");
    expect(Object.keys(res.body).sort()).toEqual(
      ["answered", "byRoute", "count", "firstTryPct", "newestAt", "oldestAt", "probes"],
    );
    expect(res.text).not.toContain("01:02:03");
  });

  it("is a 500 and not an empty summary when the history cannot be read", async () => {
    const log = new CoachOutcomeLog(dir);
    // Not JSON and not ENOENT: an unreadable *directory* at the file's path
    // fails in `readFile` with EISDIR, which `list` re-throws.
    await fs.mkdir(log.filePath, { recursive: true });
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachOutcomes: log });
    const res = await request(app).get("/api/coach/outcomes");
    expect(res.status).toBe(500);
    expect(res.body.count).toBeUndefined();
  });
});

function fakeCoach() {
  return (async (url: string) => {
    if (String(url).includes("/conversations?active=true")) {
      return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
    }
    const body = String(url);
    void body;
    // One reply that satisfies every structured route at once: `askCoach`
    // takes any text, `plan-draft` reads `days` and `goal-phases` reads
    // `phases`, so the two keys sit side by side rather than needing a fetch
    // stub per route.
    const reply = JSON.stringify({
      days: [{ day: "Monday", focus: "Swim", exercises: [] }],
      phases: [
        { label: "Aerobic base", note: "Long easy hours in all three sports.", weeks: 8 },
        { label: "Build", note: "Threshold work on the bike and the run.", weeks: 6 },
        { label: "Taper", note: "Cut volume, keep the sharpness.", weeks: 2 },
      ],
      note: "Build.",
    });
    return { ok: true, json: async () => ({ reply }) } as Response;
  }) as unknown as typeof globalThis.fetch;
}

function notAWeek() {
  return (async (url: string) => {
    if (String(url).includes("/conversations?active=true")) {
      return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
    }
    return { ok: true, json: async () => ({ reply: "I would rather not." }) } as Response;
  }) as unknown as typeof globalThis.fetch;
}

const GOAL = {
  text: "Olympic triathlon",
  targetDate: "2027-01-10",
  created: "2026-08-01",
  milestones: [
    { label: "Base", note: "", date: "2026-09-30" },
    { label: "Build", note: "", date: "2026-11-15" },
    { label: "Taper", note: "", date: "2027-01-10" },
  ],
};

describe("a probe is not one of his taps", () => {
  // Cycle 1603 drove the live /api/chat once to check the coach was still a
  // real conversation, and the key result went from "no data yet" to
  // "100% over 1 tap" -- a number about a curl. See coach-outcome.ts.
  it("keeps a probe out of the share, the routes and the timestamps", () => {
    const s = summarise([
      { at: "2026-09-14T10:00:00.000Z", route: "chat", ok: true, probe: true },
      { at: "2026-09-14T11:00:00.000Z", route: "chat", ok: false, probe: true },
    ]);
    expect(s.count).toBe(0);
    expect(s.answered).toBe(0);
    expect(s.firstTryPct).toBeNull();
    expect(s.newestAt).toBeNull();
    expect(s.oldestAt).toBeNull();
    expect(s.byRoute).toEqual({});
    expect(s.probes).toEqual({ count: 2, answered: 1 });
  });

  it("does not move a share a real tap already set", () => {
    // The separating case: without the split, one failed probe halves a
    // perfect share and the reading is about the prober, not about him.
    const real = { at: "2026-09-14T09:00:00.000Z", route: "chat", ok: true };
    const withProbe = summarise([
      real,
      { at: "2026-09-14T10:00:00.000Z", route: "chat", ok: false, probe: true },
    ]);
    expect(withProbe.firstTryPct).toBe(100);
    expect(withProbe.count).toBe(1);
    expect(withProbe.newestAt).toBe("2026-09-14T09:00:00.000Z");
    expect(withProbe.probes).toEqual({ count: 1, answered: 0 });
  });

  it("treats a sample written before the flag existed as a real tap", () => {
    // Every sample already on disk has no `probe` key at all; absent must not
    // read as a probe, or the whole history vanishes from the share.
    const s = summarise([{ at: "2026-09-13T09:00:00.000Z", route: "chat", ok: true }]);
    expect(s.count).toBe(1);
    expect(s.probes.count).toBe(0);
  });

  it("keeps the flag across a restart", async () => {
    const log = new CoachOutcomeLog(dir);
    await log.record("chat", true, "2026-09-14T10:00:00.000Z", true);
    await log.record("chat", true, "2026-09-14T10:01:00.000Z");
    const summary = await new CoachOutcomeLog(dir).summary();
    expect(summary.count).toBe(1);
    expect(summary.probes).toEqual({ count: 1, answered: 1 });
  });

  it("drops a sample whose probe field is not a boolean", async () => {
    // Same direction as the junk test above: an unreadable marker must not
    // fall through to "real tap", which is the reading that inflates the share.
    await fs.writeFile(
      path.join(dir, "coach-outcomes.json"),
      JSON.stringify([{ at: "2026-09-14T10:00:00.000Z", route: "chat", ok: true, probe: "yes" }]),
      "utf8",
    );
    expect(await new CoachOutcomeLog(dir).list()).toEqual([]);
  });

  it("POST /api/chat with probe:true answers him and records no tap", async () => {
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    const res = await request(app).post("/api/chat").send({ message: "still there?", context: {}, probe: true });
    expect(res.status).toBe(200);
    const summary = await request(app).get("/api/coach/outcomes");
    expect(summary.body.count).toBe(0);
    expect(summary.body.firstTryPct).toBeNull();
    expect(summary.body.probes).toEqual({ count: 1, answered: 1 });
  });

  it("POST /api/chat without the flag still records the tap", async () => {
    // The mirror, so the test above cannot pass by the route being broken.
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachOutcomes: new CoachOutcomeLog(dir),
    });
    await request(app).post("/api/chat").send({ message: "hei", context: {} });
    const summary = await request(app).get("/api/coach/outcomes");
    expect(summary.body.count).toBe(1);
    expect(summary.body.probes).toEqual({ count: 0, answered: 0 });
  });
});
