import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { StateStore } from "./state-store.js";
import { buildDraftPrompt, previousWeekLine } from "./plan-draft.js";

const ROW = { goal: "Olympic triathlon", start: "2026-10-05", phase: "Build", week: 2, weeks: 6, raceWeek: false };
const GOAL = {
  text: "Olympic triathlon", targetDate: "2027-01-10", created: "2026-08-01",
  milestones: [
    { label: "Base", note: "", date: "2026-09-30" },
    { label: "Build", note: "", date: "2026-11-15" },
    { label: "Taper", note: "", date: "2027-01-10" },
  ],
};
const PREVIOUS = {
  start: "2026-09-28",
  label: "Build week 1 of 6",
  days: [{ day: "Monday", focus: "Push", exercises: [{ name: "Back Squat", sets: 4, reps: 6 }] }],
};

describe("previousWeekLine", () => {
  it("names the week it came from and hands over what was in it", () => {
    const line = previousWeekLine(PREVIOUS) as string;
    expect(line).toContain("THE WEEK ALREADY DRAFTED BEFORE IT, starting 2026-09-28 (Build week 1 of 6)");
    expect(line).toContain("this is what the new week continues from, not something to repeat");
    expect(line).toContain("Back Squat");
  });

  it("keeps the date when there is no label", () => {
    const line = previousWeekLine({ ...PREVIOUS, label: null }) as string;
    expect(line).toContain("starting 2026-09-28 -- ");
    expect(line).not.toContain("(");
  });

  it("says nothing rather than something empty", () => {
    for (const bad of [null, "week", 3, {}, { ...PREVIOUS, start: "28 Sep" }, { ...PREVIOUS, days: [] },
                       { ...PREVIOUS, days: "Monday" }, { ...PREVIOUS, start: null }]) {
      expect(previousWeekLine(bad)).toBeNull();
    }
  });

  it("refuses a days array that is not days, rather than putting it in the prompt", () => {
    // A well-formed list holding something that is not a day: the top-level
    // shape passes and the content is what would reach the coach.
    for (const days of [["Monday"], [null], [[{ day: "Monday" }]], [{ focus: "Push" }],
                        [{ day: 3 }], [{ day: "Monday" }, "Tuesday"]]) {
      expect(previousWeekLine({ ...PREVIOUS, days })).toBeNull();
    }
    // And one that is days still passes, so the check is not just "refuse".
    expect(previousWeekLine({ ...PREVIOUS, days: [{ day: "Monday" }, { day: "Tuesday" }] })).toContain("Tuesday");
  });
});

describe("buildDraftPrompt with a week already drafted", () => {
  it("carries that week and tells the coach to move on from it", () => {
    const prompt = buildDraftPrompt(GOAL, {}, "2026-09-16", undefined, ROW, PREVIOUS);
    expect(prompt).toContain("THE WEEK ALREADY DRAFTED BEFORE IT, starting 2026-09-28");
    expect(prompt).toContain("Do not hand back that week again.");
    // It sits above his records, so the model reads the week to continue from
    // before the history it is drawn out of.
    expect(prompt.indexOf("THE WEEK ALREADY DRAFTED BEFORE IT"))
      .toBeLessThan(prompt.indexOf("TRAINING DATA"));
    expect(prompt.indexOf("Draft the week starting 2026-10-05"))
      .toBeLessThan(prompt.indexOf("THE WEEK ALREADY DRAFTED BEFORE IT"));
  });

  it("says none of it when there is no previous week, which is every first draft", () => {
    const prompt = buildDraftPrompt(GOAL, {}, "2026-09-16", undefined, ROW);
    expect(prompt).not.toContain("ALREADY DRAFTED BEFORE IT");
    expect(prompt).not.toContain("Do not hand back that week again.");
    // The progression rule the row itself earns is untouched by any of this.
    expect(prompt).toContain("The week is one step in a progression");
  });
});

describe("POST /api/plan-draft with a week already drafted", () => {
  let dir: string;
  let store: StateStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "marcus-draft-prev-"));
    store = new StateStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("carries the page's previousWeek through to the coach's prompt", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      if (String(url).includes("/conversations?active=true")) {
        return { ok: true, json: async () => [{ id: "c1", model: "claude-cli:claude-sonnet-5" }] } as Response;
      }
      const week = { days: [{ day: "Monday", focus: "Swim", exercises: [] }], note: "Build." };
      return { ok: true, json: async () => ({ reply: JSON.stringify(week) }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    const app = createApp(store, undefined, { fetchImpl, coach: { baseUrl: "http://agora", conversationId: "c1" } });
    const res = await request(app)
      .post("/api/plan-draft")
      .send({ goals: [GOAL], today: "2026-09-16", context: {}, calendarWeek: ROW, previousWeek: PREVIOUS });
    expect(res.status).toBe(200);
    expect(calls.join("")).toContain("THE WEEK ALREADY DRAFTED BEFORE IT, starting 2026-09-28");
  });
});
