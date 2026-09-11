import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { buildDraftPrompt, weekTargetLine } from "./plan-draft.js";

// The shape the page's weekTarget returns when the Home card has a real number.
const BASE_WEEK = {
  phase: "Base", phaseEnds: "2026-10-10", multiplier: 1.1, baseline: 8000, baselineWeeks: 4,
  volumeTarget: 8800, volumeDone: 1200, sessionsPlanned: 4, sessionsDone: 1, reason: "ok", note: null,
};
const GOAL = { text: "Olympic triathlon", targetDate: "2026-12-05" };

describe("weekTargetLine", () => {
  it("names the target, his own average and the phase behind it", () => {
    const line = weekTargetLine(BASE_WEEK);
    expect(line).toContain("this week's strength target at 8800 kg of volume");
    expect(line).toContain("10% above his own average of 8000 kg over the last 4 completed weeks");
    expect(line).toContain("because this is the Base phase");
  });

  it("says below for a phase that cuts and level for one that holds", () => {
    expect(weekTargetLine({ ...BASE_WEEK, phase: "Taper", multiplier: 0.6, volumeTarget: 4800 }))
      .toContain("4800 kg of volume (sets x reps x kilograms, summed over the week): 40% below his own average");
    expect(weekTargetLine({ ...BASE_WEEK, phase: "Build", multiplier: 1, volumeTarget: 8000 }))
      .toContain("level with his own average of 8000 kg");
  });

  it("says nothing unless the card itself has a complete target", () => {
    expect(weekTargetLine(undefined)).toBeNull();
    expect(weekTargetLine(null)).toBeNull();
    expect(weekTargetLine("8800")).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, reason: "too early", volumeTarget: null })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, reason: "no goal" })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, volumeTarget: "8800" })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, volumeTarget: Number.NaN })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, baseline: 0 })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, multiplier: -1 })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, baselineWeeks: 0 })).toBeNull();
    expect(weekTargetLine({ ...BASE_WEEK, phase: " " })).toBeNull();
  });

  it("says one week, not one weeks", () => {
    expect(weekTargetLine({ ...BASE_WEEK, baselineWeeks: 1 })).toContain("over the last 1 completed week,");
  });
});

describe("a drafted week is sized to the Home card's target", () => {
  it("puts the target beside the goal and asks for the week to land near it", () => {
    const prompt = buildDraftPrompt(GOAL, {}, "2026-09-15", BASE_WEEK);
    expect(prompt).toContain("8800 kg of volume");
    expect(prompt).toContain("lands near the kilogram target named above");
    expect(prompt.indexOf("8800 kg")).toBeGreaterThan(prompt.indexOf("Olympic triathlon"));
    expect(prompt.indexOf("8800 kg")).toBeLessThan(prompt.indexOf("TRAINING DATA"));
  });

  it("leaves the prompt exactly as it was when the card has no target", () => {
    const before = buildDraftPrompt(GOAL, {}, "2026-09-15");
    expect(buildDraftPrompt(GOAL, {}, "2026-09-15", { ...BASE_WEEK, reason: "too early" })).toBe(before);
    expect(buildDraftPrompt(GOAL, {}, "2026-09-15", undefined)).toBe(before);
    expect(before).not.toContain("kilogram target");
  });

  it("reaches the coach from the page's request body", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-week-"));
    try {
      const calls: string[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push(String(init?.body ?? ""));
        if (String(url).includes("/conversations?active=true")) {
          return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
        }
        const week = { days: [{ day: "Monday", focus: "Legs", exercises: [] }], note: "Base week." };
        return { ok: true, json: async () => ({ reply: JSON.stringify(week) }) } as Response;
      }) as unknown as typeof globalThis.fetch;
      const app = createApp(new StateStore(dir), undefined, {
        fetchImpl,
        coach: { baseUrl: "http://agora", conversationId: "c1" },
      });
      const res = await request(app)
        .post("/api/plan-draft")
        .send({ goals: [GOAL], today: "2026-09-15", week: BASE_WEEK, context: {} });
      expect(res.status).toBe(200);
      expect(calls.join("")).toContain("8800 kg of volume");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
