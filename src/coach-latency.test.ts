import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { CoachLatencyLog, MAX_SAMPLES, summarise } from "./coach-latency.js";

// Issue #227: the instrument under `marcus-kpi-coach-latency`. See the header
// of coach-latency.ts for why this is a recorded number rather than a sampling
// run against the live coach.

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-coachlat-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("summarise", () => {
  it("reports no median at all when nothing has been recorded", () => {
    // Null and not 0: 0ms is a real reading (the coach answered instantly) and
    // must never be how "nobody has used it" is written down.
    expect(summarise([])).toEqual({ count: 0, medianMs: null, newestAt: null, oldestAt: null });
  });

  it("takes the middle of an odd count", () => {
    const s = summarise([
      { at: "2026-09-14T01:00:00.000Z", ms: 30_000 },
      { at: "2026-09-14T02:00:00.000Z", ms: 10_000 },
      { at: "2026-09-14T03:00:00.000Z", ms: 14_000 },
    ]);
    expect(s.medianMs).toBe(14_000);
    expect(s.count).toBe(3);
  });

  it("averages the two middles of an even count rather than taking the worse", () => {
    const s = summarise([
      { at: "2026-09-14T01:00:00.000Z", ms: 10_000 },
      { at: "2026-09-14T02:00:00.000Z", ms: 15_000 },
    ]);
    expect(s.medianMs).toBe(12_500);
  });

  it("reports the oldest and newest sample, not the order they arrived in", () => {
    const s = summarise([
      { at: "2026-09-14T03:00:00.000Z", ms: 1 },
      { at: "2026-09-14T01:00:00.000Z", ms: 2 },
      { at: "2026-09-14T02:00:00.000Z", ms: 3 },
    ]);
    expect(s.newestAt).toBe("2026-09-14T03:00:00.000Z");
    expect(s.oldestAt).toBe("2026-09-14T01:00:00.000Z");
  });
});

describe("CoachLatencyLog", () => {
  it("survives a restart, which is the whole reason it is on disk", async () => {
    const written = new CoachLatencyLog(dir);
    await written.record(12_000, "2026-09-14T01:00:00.000Z");
    // A second instance over the same directory is what a rolled pod is.
    const reread = new CoachLatencyLog(dir);
    expect(await reread.summary()).toMatchObject({ count: 1, medianMs: 12_000 });
  });

  it("keeps the newest MAX_SAMPLES and drops the oldest", async () => {
    const log = new CoachLatencyLog(dir);
    for (let i = 0; i < MAX_SAMPLES + 5; i += 1) {
      await log.record(i, `2026-09-14T01:00:${String(i % 60).padStart(2, "0")}.000Z`);
    }
    const kept = await log.list();
    expect(kept.length).toBe(MAX_SAMPLES);
    // The five dropped are 0..4, so the oldest surviving ms is 5.
    expect(kept[0].ms).toBe(5);
    expect(kept[kept.length - 1].ms).toBe(MAX_SAMPLES + 4);
  });

  it("reads an empty history rather than throwing over a corrupt file", async () => {
    const log = new CoachLatencyLog(dir);
    await fs.writeFile(log.filePath, "{not json", "utf8");
    expect(await log.summary()).toMatchObject({ count: 0, medianMs: null });
  });

  it("drops a sample that is not a duration instead of averaging it in", async () => {
    const log = new CoachLatencyLog(dir);
    await fs.writeFile(
      log.filePath,
      JSON.stringify([
        { at: "2026-09-14T01:00:00.000Z", ms: 10_000 },
        { at: "2026-09-14T01:00:01.000Z", ms: "soon" },
        { at: 5, ms: 10_000 },
        { at: "2026-09-14T01:00:02.000Z", ms: -1 },
      ]),
      "utf8",
    );
    expect(await log.summary()).toMatchObject({ count: 1, medianMs: 10_000 });
  });

  it("refuses to record a duration that is not a number", async () => {
    const log = new CoachLatencyLog(dir);
    await log.record(Number.NaN, "2026-09-14T01:00:00.000Z");
    await log.record(-5, "2026-09-14T01:00:00.000Z");
    expect(await log.summary()).toMatchObject({ count: 0 });
  });

  it("does not let a junk duration evict a real one", async () => {
    // The guard in `record` is not the same as the filter in `list`, and this
    // is the difference: `list` drops a junk sample when it is read, by which
    // time it has already taken one of the MAX_SAMPLES slots and pushed the
    // oldest real measurement off the end. Without the guard the history here
    // holds 199 readings after 200 good calls and one bad one.
    const log = new CoachLatencyLog(dir);
    for (let i = 0; i < MAX_SAMPLES; i += 1) {
      await log.record(1_000 + i, "2026-09-14T01:00:00.000Z");
    }
    await log.record(Number.NaN, "2026-09-14T02:00:00.000Z");
    const kept = await log.list();
    expect(kept.length).toBe(MAX_SAMPLES);
    expect(kept[0].ms).toBe(1_000);
  });

  it("never throws when the file cannot be written", async () => {
    const log = new CoachLatencyLog(dir);
    // A directory where the history file should be: every write fails.
    await fs.mkdir(log.filePath, { recursive: true });
    await expect(log.record(12_000, "2026-09-14T01:00:00.000Z")).resolves.toBeUndefined();
  });
});

function fakeCoach(delayMs: number) {
  return (async (url: string) => {
    if (String(url).includes("/conversations?active=true")) {
      return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    const week = { days: [{ day: "Monday", focus: "Swim", exercises: [] }], note: "Build." };
    return { ok: true, json: async () => ({ reply: JSON.stringify(week) }) } as Response;
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

describe("GET /api/coach/latency", () => {
  it("has no median before the coach has answered once", async () => {
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachLatency: new CoachLatencyLog(dir) });
    const res = await request(app).get("/api/coach/latency");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, medianMs: null, newestAt: null, oldestAt: null });
  });

  it("reports how long an answered draft actually took", async () => {
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: fakeCoach(60),
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachLatency: new CoachLatencyLog(dir),
    });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(200);

    const res = await request(app).get("/api/coach/latency");
    expect(res.body.count).toBe(1);
    // The clock is around the coach call, so a coach made to take 60ms must
    // read at least that. Without an upper bound the assertion would pass on a
    // recorded constant, so cap it well below a real coach's ~15s.
    expect(res.body.medianMs).toBeGreaterThanOrEqual(55);
    expect(res.body.medianMs).toBeLessThan(5_000);
    expect(typeof res.body.newestAt).toBe("string");
  });

  it("records nothing when the coach did not answer", async () => {
    // `coach: null` is the unconfigured case: the route 503s and no wait ever
    // happened. A fast refusal must not be recorded as a fast answer.
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachLatency: new CoachLatencyLog(dir) });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(503);

    const res = await request(app).get("/api/coach/latency");
    expect(res.body.count).toBe(0);
  });

  it("records nothing when the coach answered something that was not a week", async () => {
    const notAWeek = (async (url: string) => {
      if (String(url).includes("/conversations?active=true")) {
        return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
      }
      return { ok: true, json: async () => ({ reply: "I would rather not." }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(new StateStore(dir), undefined, {
      fetchImpl: notAWeek,
      coach: { baseUrl: "http://agora", conversationId: "c1" },
      coachLatency: new CoachLatencyLog(dir),
    });
    const draft = await request(app).post("/api/plan-draft").send({ goals: [GOAL], today: "2026-09-16", context: {} });
    expect(draft.status).toBe(502);

    const res = await request(app).get("/api/coach/latency");
    expect(res.body.count).toBe(0);
  });

  it("answers a summary and never the individual taps", async () => {
    const log = new CoachLatencyLog(dir);
    await log.record(12_000, "2026-09-14T01:02:03.000Z");
    await log.record(18_000, "2026-09-14T01:09:09.000Z");
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachLatency: log });
    const res = await request(app).get("/api/coach/latency");
    expect(Object.keys(res.body).sort()).toEqual(["count", "medianMs", "newestAt", "oldestAt"]);
    expect(res.text).not.toContain("18000");
  });

  it("is a 500 and not an empty summary when the history cannot be read", async () => {
    const log = new CoachLatencyLog(dir);
    // Not JSON and not ENOENT: an unreadable *directory* at the file's path
    // fails in `readFile` with EISDIR, which `list` re-throws.
    await fs.mkdir(log.filePath, { recursive: true });
    const app = createApp(new StateStore(dir), undefined, { coach: null, coachLatency: log });
    const res = await request(app).get("/api/coach/latency");
    expect(res.status).toBe(500);
    expect(res.body.count).toBeUndefined();
  });
});
