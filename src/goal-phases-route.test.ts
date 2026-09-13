import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";

const GOAL = {
  id: "g1",
  text: "Olympic triathlon at Oslo Tri",
  targetDate: "2027-08-14",
  created: "2026-09-13",
  milestones: [],
};

const PLAN = {
  phases: [
    { label: "Aerobic base", note: "Long easy hours in all three sports.", weeks: 20 },
    { label: "Build", note: "Threshold work on the bike and the run.", weeks: 14 },
    { label: "Taper", note: "Cut volume, keep the sharpness.", weeks: 2 },
  ],
  note: "Long runway, so the base is most of it.",
};

/** Agora as the coach reads it: the active listing, then the ask. */
function agora(reply: string, model = "claude-cli:opus") {
  return async (url: string | URL | Request) =>
    String(url).endsWith("/conversations?active=true")
      ? new Response(JSON.stringify({ conversations: [{ id: "c1", model }] }), { status: 200 })
      : new Response(JSON.stringify({ reply }), { status: 200 });
}

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-phases-"));
  store = new StateStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function appWith(fetchImpl: unknown, coach: unknown = { baseUrl: "http://agora", conversationId: "c1" }) {
  return createApp(store, undefined, {
    fetchImpl: fetchImpl as typeof globalThis.fetch,
    coach: coach as never,
  });
}

describe("POST /api/goal-phases", () => {
  it("answers with dated phases and the coach's note", async () => {
    const app = appWith(agora("```json\n" + JSON.stringify(PLAN) + "\n```"));
    const res = await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-13" });
    expect(res.status).toBe(200);
    expect(res.body.milestones.map((m: { label: string }) => m.label)).toEqual([
      "Aerobic base", "Build", "Taper",
    ]);
    // The app owns the calendar: the last phase lands on the race day itself.
    expect(res.body.milestones[2].date).toBe("2027-08-14");
    expect(res.body.note).toBe(PLAN.note);
  });

  it("writes nothing to the store — the page holds the accept gate", async () => {
    const app = appWith(agora("```json\n" + JSON.stringify(PLAN) + "\n```"));
    await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-13" });
    const after = await request(app).get("/api/state");
    expect(after.body.rev).toBe(0);
    expect(after.body.data).toBeNull();
  });

  it("answers 502 with the reason when the coach did not answer with phases", async () => {
    const app = appWith(agora("I would start with a long base."));
    const res = await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-13" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("the coach did not answer with JSON");
  });

  it("answers 502 for an ongoing goal rather than inventing phases for it", async () => {
    const app = appWith(agora("```json\n" + JSON.stringify(PLAN) + "\n```"));
    const res = await request(app).post("/api/goal-phases")
      .send({ goal: { ...GOAL, targetDate: "" }, today: "2026-09-13" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("ongoing goal has no phases");
  });

  it("answers 503 when there is no coach configured here", async () => {
    const app = appWith(agora(""), null);
    const res = await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-13" });
    expect(res.status).toBe(503);
  });

  it("answers 503 rather than spending the metered API", async () => {
    const app = appWith(agora("{}", "anthropic:claude-opus-5"));
    const res = await request(app).post("/api/goal-phases").send({ goal: GOAL, today: "2026-09-13" });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("subscription model");
  });

  it("answers 502 for an empty body instead of throwing", async () => {
    const app = appWith(agora("{}"));
    const res = await request(app).post("/api/goal-phases").send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("that is not a goal");
  });
});
