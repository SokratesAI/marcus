import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore, emptyState } from "./state-store.js";

let dir: string;
let store: StateStore;
let app: ReturnType<typeof createApp>;
let clock: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-state-"));
  store = new StateStore(dir);
  clock = "2026-09-01T04:00:00.000Z";
  app = createApp(store, () => clock);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/state", () => {
  it("answers with an empty record before anything has been stored", async () => {
    const res = await request(app).get("/api/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyState());
  });

  it("answers with what was stored", async () => {
    await request(app).put("/api/state").send({ rev: 0, data: { weights: [{ kg: 82 }] } });
    const res = await request(app).get("/api/state");
    expect(res.status).toBe(200);
    expect(res.body.rev).toBe(1);
    expect(res.body.updatedAt).toBe(clock);
    expect(res.body.data).toEqual({ weights: [{ kg: 82 }] });
  });

  it("reports a state file it cannot parse rather than serving an empty one", async () => {
    // An empty record and a corrupt file are opposite facts: one means "start
    // fresh", the other means "do not overwrite what is here".
    await fs.writeFile(path.join(dir, "marcus-state.json"), "{ not json", "utf8");
    const res = await request(app).get("/api/state");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not read/);
  });
});

describe("PUT /api/state", () => {
  it("stores the first write against revision 0 and hands back revision 1", async () => {
    const res = await request(app).put("/api/state").send({ rev: 0, data: { sessions: [] } });
    expect(res.status).toBe(200);
    expect(res.body.rev).toBe(1);
    expect(res.body.data).toEqual({ sessions: [] });
  });

  it("refuses a write built on a stale revision and hands back the current state", async () => {
    await request(app).put("/api/state").send({ rev: 0, data: { sessions: [{ id: "a" }] } });
    const res = await request(app).put("/api/state").send({ rev: 0, data: { sessions: [] } });
    expect(res.status).toBe(409);
    expect(res.body.state.rev).toBe(1);
    expect(res.body.state.data).toEqual({ sessions: [{ id: "a" }] });
  });

  it("does not write the losing body to disk", async () => {
    await request(app).put("/api/state").send({ rev: 0, data: { sessions: [{ id: "a" }] } });
    await request(app).put("/api/state").send({ rev: 0, data: { sessions: [] } });
    expect((await store.read()).data).toEqual({ sessions: [{ id: "a" }] });
  });

  it("refuses a body with no revision", async () => {
    const res = await request(app).put("/api/state").send({ data: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rev/);
  });

  it("refuses data that is not an object", async () => {
    const res = await request(app).put("/api/state").send({ rev: 0, data: [1, 2, 3] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/object/);
  });

  it("survives the process: the record is on disk in the backup envelope", async () => {
    await request(app).put("/api/state").send({ rev: 0, data: { goals: [{ id: "g" }] } });
    const raw = JSON.parse(await fs.readFile(path.join(dir, "marcus-state.json"), "utf8"));
    expect(raw.app).toBe("marcus");
    expect(raw.version).toBe(1);
    expect(raw.rev).toBe(1);
    expect(raw.data).toEqual({ goals: [{ id: "g" }] });
  });

  it("gives two overlapping writes two different revisions, and only one wins", async () => {
    // Both are built on rev 0. Without serialising the read-modify-write they
    // would both read 0, both write 1, and one logged session would vanish.
    const [a, b] = await Promise.all([
      request(app).put("/api/state").send({ rev: 0, data: { sessions: [{ id: "a" }] } }),
      request(app).put("/api/state").send({ rev: 0, data: { sessions: [{ id: "b" }] } }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    expect((await store.read()).rev).toBe(1);
  });

  it("creates the data directory when it is not there yet", async () => {
    const nested = new StateStore(path.join(dir, "deep", "deeper"));
    const res = await request(createApp(nested, () => clock)).put("/api/state").send({ rev: 0, data: { plan: {} } });
    expect(res.status).toBe(200);
    expect((await nested.read()).data).toEqual({ plan: {} });
  });
});
