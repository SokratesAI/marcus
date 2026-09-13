import { describe, expect, it } from "vitest";
import {
  buildPhasePrompt,
  coachPhases,
  parsePhasePlan,
  phaseDates,
  PHASE_LABEL_MAX,
  PHASE_NOTE_MAX,
} from "./goal-plan.js";

const GOAL = {
  id: "g1",
  text: "Olympic triathlon at Oslo Tri",
  targetDate: "2027-08-14",
  created: "2026-09-13",
  milestones: [
    { id: "m1", label: "Base", note: "Build the foundation.", date: "2027-01-01", done: false },
  ],
};

const PLAN = {
  phases: [
    { label: "Aerobic base", note: "Long easy hours in all three sports.", weeks: 20 },
    { label: "Build", note: "Threshold work on the bike and the run.", weeks: 14 },
    { label: "Race specific", note: "Brick sessions at race pace.", weeks: 6 },
    { label: "Taper", note: "Cut volume, keep the sharpness.", weeks: 2 },
  ],
  note: "Long runway, so the base is most of it.",
};

describe("parsePhasePlan refuses anything that is not a block of phases", () => {
  it("takes a fenced block and keeps the fields as written", () => {
    const parsed = parsePhasePlan("Here you go:\n```json\n" + JSON.stringify(PLAN) + "\n```\nGood luck.");
    expect(parsed).toEqual({ ok: true, phases: PLAN.phases, note: PLAN.note });
  });

  it("takes a bare object with prose either side of it", () => {
    const parsed = parsePhasePlan("Sure. " + JSON.stringify(PLAN) + " Shout if that is wrong.");
    expect(parsed.ok).toBe(true);
  });

  it("refuses prose with no JSON in it at all", () => {
    expect(parsePhasePlan("I would start with a long base.")).toEqual({
      ok: false,
      reason: "the coach did not answer with JSON",
    });
  });

  it("refuses a single phase, which is not a block", () => {
    const parsed = parsePhasePlan(JSON.stringify({ phases: [PLAN.phases[0]] }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("at least 2 phases");
  });

  it("refuses more phases than a plan anyone can hold", () => {
    const many = { phases: Array.from({ length: 9 }, (_, i) => ({ label: `P${i}`, note: "x", weeks: 2 })) };
    const parsed = parsePhasePlan(JSON.stringify(many));
    expect(parsed.ok === false && parsed.reason).toContain("more than 8 phases");
  });

  it("refuses weeks that only look like a number, because it is divided by a total", () => {
    const bad = { phases: [{ ...PLAN.phases[0], weeks: "20" }, PLAN.phases[1]] };
    const parsed = parsePhasePlan(JSON.stringify(bad));
    expect(parsed.ok === false && parsed.reason).toBe("Aerobic base has no whole number of weeks");
  });

  it("refuses a fractional week for the same reason", () => {
    const bad = { phases: [{ ...PLAN.phases[0], weeks: 2.5 }, PLAN.phases[1]] };
    expect(parsePhasePlan(JSON.stringify(bad)).ok).toBe(false);
  });

  it("refuses a phase with no note, since the note is what the card shows", () => {
    const bad = { phases: [{ label: "Base", note: "   ", weeks: 4 }, PLAN.phases[1]] };
    const parsed = parsePhasePlan(JSON.stringify(bad));
    expect(parsed.ok === false && parsed.reason).toBe("Base has no note");
  });

  it("refuses a label too long for the card and a note too long for its line", () => {
    const longLabel = { phases: [{ label: "x".repeat(PHASE_LABEL_MAX + 1), note: "n", weeks: 4 }, PLAN.phases[1]] };
    expect(parsePhasePlan(JSON.stringify(longLabel)).ok).toBe(false);
    const longNote = { phases: [{ label: "Base", note: "n".repeat(PHASE_NOTE_MAX + 1), weeks: 4 }, PLAN.phases[1]] };
    expect(parsePhasePlan(JSON.stringify(longNote)).ok).toBe(false);
  });

  it("refuses the same label twice in a row, and allows it twice apart", () => {
    const repeated = { phases: [PLAN.phases[1], { ...PLAN.phases[1], note: "again" }] };
    expect(parsePhasePlan(JSON.stringify(repeated)).ok).toBe(false);
    // A long goal really does run Base/Build twice; the page's own cut does it.
    const apart = { phases: [PLAN.phases[0], PLAN.phases[1], { ...PLAN.phases[0] }, { ...PLAN.phases[1] }] };
    expect(parsePhasePlan(JSON.stringify(apart)).ok).toBe(true);
  });
});

describe("phaseDates keeps the calendar on the app's side", () => {
  it("lands the last phase exactly on the target day", () => {
    const dated = phaseDates(PLAN.phases, "2026-09-13", "2027-08-14");
    expect(dated.ok).toBe(true);
    expect(dated.ok && dated.milestones[dated.milestones.length - 1].date).toBe("2027-08-14");
  });

  it("reads the weeks as ratios, so doubling every one changes nothing", () => {
    const doubled = PLAN.phases.map((p) => ({ ...p, weeks: p.weeks * 2 }));
    const a = phaseDates(PLAN.phases, "2026-09-13", "2027-08-14");
    const b = phaseDates(doubled, "2026-09-13", "2027-08-14");
    expect(a.ok && b.ok && b.milestones).toEqual(a.ok && a.milestones);
  });

  it("shares the span out in proportion, not evenly", () => {
    const dated = phaseDates(PLAN.phases, "2026-09-13", "2027-08-14");
    // 20 of 42 weeks of a 335-day span is 160 days after 2026-09-13.
    expect(dated.ok && dated.milestones[0].date).toBe("2027-02-20");
    expect(dated.ok && dated.milestones.map((m) => m.label)).toEqual([
      "Aerobic base", "Build", "Race specific", "Taper",
    ]);
  });

  it("keeps the dates strictly increasing", () => {
    const dated = phaseDates(PLAN.phases, "2026-09-13", "2027-08-14");
    const days = dated.ok ? dated.milestones.map((m) => m.date) : [];
    expect(days).toEqual([...days].sort());
    expect(new Set(days).size).toBe(days.length);
  });

  it("refuses a phase that would be shorter than a day rather than flattening it", () => {
    // Six phases over 28 days, weighted so lopsidedly that B rounds onto the
    // same day as A (50/57 and 51/57 of 28 both round to day 25). `currentPhase` takes the first phase whose end has not passed,
    // so a repeated date is a phase the page would skip entirely.
    const crowded = [
      { label: "A", note: "n", weeks: 50 },
      { label: "B", note: "n", weeks: 1 },
      { label: "C", note: "n", weeks: 1 },
      { label: "D", note: "n", weeks: 1 },
      { label: "E", note: "n", weeks: 1 },
      { label: "F", note: "n", weeks: 1 },
    ];
    const dated = phaseDates(crowded, "2026-09-13", "2026-10-11");
    expect(dated.ok).toBe(false);
    expect(dated.ok === false && dated.reason).toContain("shorter than a day");
  });

  it("refuses a goal too close to periodise, the same bar the page's own cut uses", () => {
    const dated = phaseDates(PLAN.phases, "2026-09-13", "2026-10-01");
    expect(dated.ok === false && dated.reason).toContain("too few to periodise");
  });
});

describe("buildPhasePrompt tells the coach what it needs and nothing it must not write", () => {
  it("names the goal, both dates and the span in weeks", () => {
    const prompt = buildPhasePrompt(GOAL, "2026-09-13");
    expect(prompt).toContain("Olympic triathlon at Oslo Tri");
    expect(prompt).toContain("2027-08-14");
    expect(prompt).toContain("about 48 weeks");
  });

  it("shows the mechanical cut it is being asked to improve on", () => {
    expect(buildPhasePrompt(GOAL, "2026-09-13")).toContain("Base until 2027-01-01");
  });

  it("says the app owns the dates", () => {
    expect(buildPhasePrompt(GOAL, "2026-09-13")).toContain("Do not write dates");
  });
});

function coachAnswering(reply: string) {
  return async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/conversations?active=true")) {
      return new Response(JSON.stringify({ conversations: [{ id: "c1", model: "claude-cli:opus" }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ reply }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
}

const DEPS = (reply: string) => ({
  config: { baseUrl: "http://agora", conversationId: "c1" },
  fetch: coachAnswering(reply) as unknown as typeof globalThis.fetch,
  today: "2026-09-13",
});

describe("coachPhases refuses before it spends a model call", () => {
  it("refuses an ongoing goal, which has no span to share out", async () => {
    let asked = false;
    const result = await coachPhases({ text: "Get fitter", targetDate: "", created: "2026-09-13" }, {}, {
      config: { baseUrl: "http://agora", conversationId: "c1" },
      fetch: (() => { asked = true; throw new Error("should not be called"); }) as unknown as typeof globalThis.fetch,
      today: "2026-09-13",
    });
    expect(result).toEqual({ status: "unusable", reason: "an ongoing goal has no phases to shape" });
    expect(asked).toBe(false);
  });

  it("refuses a goal closer than four weeks", async () => {
    const result = await coachPhases({ text: "Parkrun", targetDate: "2026-09-30", created: "2026-09-13" }, {}, DEPS(""));
    expect(result).toEqual({ status: "unusable", reason: "this goal is too close to periodise" });
  });

  it("refuses a goal whose race day has already gone, without asking", async () => {
    // Wide enough to clear the four-week bar twice over, and entirely behind
    // him: the span check alone lets this through and the phases it would get
    // back all end before today.
    let asked = false;
    const result = await coachPhases({ text: "Spring marathon", targetDate: "2026-08-01", created: "2026-01-01" }, {}, {
      config: { baseUrl: "http://agora", conversationId: "c1" },
      fetch: (() => { asked = true; throw new Error("should not be called"); }) as unknown as typeof globalThis.fetch,
      today: "2026-09-13",
    });
    expect(result).toEqual({ status: "unusable", reason: "that goal's target date has passed" });
    expect(asked).toBe(false);
  });

  it("still shapes a goal whose target day is today", async () => {
    // The boundary is "passed", not "not ahead": a block can end this morning.
    const result = await coachPhases({ text: "Race today", targetDate: "2026-09-13", created: "2026-01-01" }, {}, DEPS(
      '{"phases":[{"label":"Base","note":"Easy miles.","weeks":8},{"label":"Peak","note":"Sharpen.","weeks":4}],"note":"ok"}'));
    expect(result.status).toBe("ok");
  });

  it("refuses a body that is not a goal", async () => {
    expect(await coachPhases(null, {}, DEPS(""))).toEqual({ status: "unusable", reason: "that is not a goal" });
  });
});

describe("coachPhases hands back dated phases", () => {
  it("turns a good reply into milestones pinned to the target day", async () => {
    const result = await coachPhases(GOAL, {}, DEPS("```json\n" + JSON.stringify(PLAN) + "\n```"));
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.milestones[3]).toEqual({
      label: "Taper", note: "Cut volume, keep the sharpness.", date: "2027-08-14",
    });
    expect(result.status === "ok" && result.note).toBe(PLAN.note);
  });

  it("cuts from the day the goal was SET, not from today", async () => {
    // The same rule `validateGoalEdit` follows: moving a race must not throw
    // away the base weeks already behind him.
    const late = await coachPhases(GOAL, {}, {
      ...DEPS("```json\n" + JSON.stringify(PLAN) + "\n```"),
      today: "2027-01-01",
    });
    const early = await coachPhases(GOAL, {}, DEPS("```json\n" + JSON.stringify(PLAN) + "\n```"));
    expect(late.status === "ok" && late.milestones).toEqual(early.status === "ok" && early.milestones);
  });

  it("reports a reply that is not a block as unusable, not as a dead coach", async () => {
    const result = await coachPhases(GOAL, {}, DEPS("I would start with a long base."));
    expect(result.status).toBe("unusable");
    expect(result.status === "unusable" && result.reason).toBe("the coach did not answer with JSON");
  });

  it("refuses a metered conversation, which is the production rule", async () => {
    const metered = async (url: string | URL | Request) =>
      String(url).endsWith("/conversations?active=true")
        ? new Response(JSON.stringify({ conversations: [{ id: "c1", model: "anthropic:claude-opus-5" }] }), { status: 200 })
        : new Response("{}", { status: 200 });
    const result = await coachPhases(GOAL, {}, {
      config: { baseUrl: "http://agora", conversationId: "c1" },
      fetch: metered as unknown as typeof globalThis.fetch,
      today: "2026-09-13",
    });
    expect(result).toEqual({ status: "metered", model: "anthropic:claude-opus-5" });
  });
});
