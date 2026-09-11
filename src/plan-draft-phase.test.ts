import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { buildDraftPrompt, phasePosition } from "./plan-draft.js";

// The shape the page's buildMilestones writes: each phase carries the day it ends.
const TRIATHLON = {
  text: "Olympic triathlon",
  targetDate: "2026-12-05",
  created: "2026-09-01",
  milestones: [
    { label: "Base", note: "Build the foundation.", date: "2026-10-10", done: false },
    { label: "Build", note: "Add intensity.", date: "2026-11-10", done: false },
    { label: "Peak", note: "Sharpen.", date: "2026-11-27", done: false },
    { label: "Taper", note: "Arrive fresh.", date: "2026-12-05", done: false },
  ],
};

describe("phasePosition", () => {
  it("names the week of the phase he is in, counted over the Mondays since the goal was set", () => {
    // Set on a Tuesday, so Base owns from Monday 09-07 to Monday 10-05.
    const line = phasePosition(TRIATHLON, "2026-09-15");
    expect(line).toContain("week 2 of 5 of the Base phase (Build the foundation.)");
    expect(line).toContain("ends 2026-10-10");
    expect(line).toContain("Build follows until 2026-11-10");
    expect(line).not.toContain("last week");
  });

  it("starts a later phase the day after the one before it ends", () => {
    // Build starts on Sunday 10-11, so on that day its first week is the one it started in.
    expect(phasePosition(TRIATHLON, "2026-10-11")).toContain("week 1 of 6 of the Build phase");
    // From the Monday after, that partial week no longer shows, and Build owns five.
    expect(phasePosition(TRIATHLON, "2026-10-12")).toContain("week 1 of 5 of the Build phase");
  });

  it("reads the phase you are in by the calendar, whatever order the milestones are stored in", () => {
    const shuffled = { ...TRIATHLON, milestones: [...TRIATHLON.milestones].reverse() };
    expect(phasePosition(shuffled, "2026-10-11")).toBe(phasePosition(TRIATHLON, "2026-10-11"));
  });

  it("says when this is the last week of a phase, so the week can lead into the next", () => {
    const line = phasePosition(TRIATHLON, "2026-10-06");
    expect(line).toContain("week 5 of 5 of the Base phase");
    expect(line).toContain("last week of Base, so let it lead into Build");
  });

  it("never calls a week the last one while its own count says another follows", () => {
    // Sunday 10-04 is six days before Base ends, but Base's last Monday (10-05) is still to come.
    const line = phasePosition(TRIATHLON, "2026-10-04");
    expect(line).toContain("week 4 of 5 of the Base phase");
    expect(line).not.toContain("last week");
  });

  it("says the taper runs up to the target day rather than naming a phase that does not exist", () => {
    const line = phasePosition(TRIATHLON, "2026-12-05");
    // Taper starts on Saturday 11-28, so it owns one Monday: the race week's.
    expect(line).toContain("week 1 of 1 of the Taper phase");
    expect(line).toContain("it runs up to the target day");
    expect(line).toContain("last week before the target day");
  });

  it("names the phase without a week count when the goal carries no start day", () => {
    const { created, ...undated } = TRIATHLON;
    void created;
    const line = phasePosition(undated, "2026-09-15");
    expect(line).toContain("in the Base phase");
    expect(line).not.toContain("week 3");
  });

  it("has nothing to say once every phase has passed, or when there are no phases", () => {
    expect(phasePosition(TRIATHLON, "2026-12-06")).toBeNull();
    expect(phasePosition({ text: "Get fitter", targetDate: "2027-01-01" }, "2026-09-15")).toBeNull();
  });
});

describe("a drafted week knows where it sits in the progression", () => {
  it("puts the phase and the week in it beside the goal, and asks for the week to fit it", () => {
    const prompt = buildDraftPrompt(TRIATHLON, {}, "2026-09-15");
    expect(prompt).toContain("week 2 of 5 of the Base phase");
    expect(prompt).toContain("one step in a progression from Base through Build and Peak to Taper");
  });

  it("gives each of several goals its own position", () => {
    const squat = {
      text: "Squat 140kg",
      targetDate: "2026-10-20",
      created: "2026-09-10",
      milestones: [{ label: "Build", note: "", date: "2026-10-20", done: false }],
    };
    const prompt = buildDraftPrompt([TRIATHLON, squat], {}, "2026-09-15");
    expect(prompt).toContain("- Squat 140kg (target date 2026-10-20). This is week 1 of 6 of the Build phase");
    expect(prompt).toContain("- Olympic triathlon (target date 2026-12-05). This is week 2 of 5 of the Base phase");
  });

  it("leaves the prompt as it was for a goal with no phases", () => {
    const prompt = buildDraftPrompt({ text: "Get fitter", targetDate: "2027-01-01" }, {}, "2026-09-15");
    expect(prompt).not.toContain("progression");
    expect(prompt).not.toContain("phase");
  });

  it("counts from the day the page sends, not from the server's clock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-phase-"));
    try {
      const calls: string[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push(String(init?.body ?? ""));
        if (String(url).includes("/conversations?active=true")) {
          return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
        }
        const week = { days: [{ day: "Monday", focus: "Swim", exercises: [] }], note: "Base, week 3." };
        return { ok: true, json: async () => ({ reply: JSON.stringify(week) }) } as Response;
      }) as unknown as typeof globalThis.fetch;
      const app = createApp(new StateStore(dir), undefined, {
        fetchImpl,
        coach: { baseUrl: "http://agora", conversationId: "c1" },
      });
      const res = await request(app)
        .post("/api/plan-draft")
        .send({ goals: [TRIATHLON], today: "2026-10-11", context: {} });
      expect(res.status).toBe(200);
      expect(calls.join("")).toContain("week 1 of 6 of the Build phase");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
