// Idea #209's last open half: the phases under a goal were arithmetic and
// nothing else. `buildMilestones` in public/app-core.js cuts Base/Build/Peak/
// Taper off the span between the day the goal was set and its target date, and
// the four notes come from a fixed table -- so an Olympic triathlon, a
// powerlifting meet and "get my cholesterol down by March" are given the same
// four phases with the same four sentences, and the goal card says so on its
// face: "phases are cut from your dates, not coached yet".
//
// This asks the coach to shape the block instead. It is deliberately the same
// contract `plan-draft.ts` has, for the same reason: the model contributes
// judgement and the app keeps the arithmetic.
//
//   - the coach names the phases, writes each one's note, and says how many
//     weeks each should get RELATIVE to the others;
//   - this module turns those weights into dates, and the last phase is pinned
//     exactly onto the target day rather than landing near it;
//   - nothing here writes to the store. The route returns a proposal and the
//     page puts it behind an accept gate, the same as a drafted week.
//
// Asking the coach for the dates themselves was the obvious shape and is the
// wrong one. A date is checkable arithmetic Edvard can do in his head off his
// own target day, and a model that answers with a phase ending after the race
// -- or two phases ending on the same day -- has produced something the Plan
// tab's `currentPhase`, `raceCalendar` and `phasePosition` would all read as
// real. Weights cannot express that: any positive integers land on a legal
// calendar, so the failure mode disappears rather than being validated against.

import { askCoach, type ChatTurn, type CoachConfig, type CoachContext } from "./coach.js";
import { isoDay, LANGUAGE_RULE, type DraftGoal } from "./goal-phase.js";

/** A phase as the coach proposes it: a name, a sentence, and how long it should
 * be relative to its neighbours. No date -- see the header. */
export interface PhaseWeights {
  label: string;
  note: string;
  weeks: number;
}

/** A phase as the goal card stores it. Same three fields `buildMilestones`
 * writes, so the page's own readers need no new shape. */
export interface PhaseMilestone {
  label: string;
  note: string;
  date: string;
}

/** A phase name sits in a chip beside a date on a narrow card, and it is
 * written into the drafted-week prompt as a word. */
export const PHASE_LABEL_MAX = 24;
/** The note renders on one line of the goal card under the label. */
export const PHASE_NOTE_MAX = 200;
/** Fewer than two is not a block, and the page's own cut is four. More than
 * eight on a one-year goal is a phase every six weeks, which is a plan nobody
 * can hold; it is a ceiling on nonsense, not a coaching opinion. */
export const PHASE_MIN = 2;
export const PHASE_MAX = 8;
/** The longest single phase the page's own cut can produce is capped at 84
 * days; a weight larger than two years is a model that has lost the scale. */
export const PHASE_WEEKS_MAX = 104;
/** Under four weeks the page refuses to periodise at all (`buildMilestones`
 * returns one straight Build), so there is nothing here to coach either. */
export const PHASE_MIN_SPAN_DAYS = 28;

const DAY_MS = 86400000;

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / DAY_MS);
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

export type PhasePlanParse =
  | { ok: true; phases: PhaseWeights[]; note: string }
  | { ok: false; reason: string };

/** The JSON out of a reply that may be fenced or may carry a sentence either
 * side of it, then every field checked. Nothing is coerced: `weeks: "4"` is the
 * wrong shape, and this number is divided by a total. */
export function parsePhasePlan(reply: string): PhasePlanParse {
  const text = String(reply ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : sliceOuterObject(text);
  if (!candidate) return { ok: false, reason: "the coach did not answer with JSON" };

  let body: unknown;
  try {
    body = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "the coach did not answer with JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "the coach did not answer with a set of phases" };
  }
  const raw = (body as { phases?: unknown }).phases;
  if (!Array.isArray(raw) || raw.length < PHASE_MIN) {
    return { ok: false, reason: `the coach did not answer with at least ${PHASE_MIN} phases` };
  }
  if (raw.length > PHASE_MAX) {
    return { ok: false, reason: `the coach answered with more than ${PHASE_MAX} phases` };
  }

  const phases: PhaseWeights[] = [];
  let previousLabel = "";
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "one of the phases is not a phase" };
    }
    const row = entry as { label?: unknown; note?: unknown; weeks?: unknown };
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) return { ok: false, reason: "one of the phases has no name" };
    if (label.length > PHASE_LABEL_MAX) {
      return { ok: false, reason: `"${label}" is longer than ${PHASE_LABEL_MAX} characters` };
    }
    // Two phases with one name is not a duplicate the card can be tidied of:
    // `carryMilestonesDone` matches a ticked phase by label and occurrence, and
    // `phasePosition` names the phase the coach is told the week sits in. Two
    // "Build"s a year apart are a real block and the page handles them; two in
    // a row are a model that repeated itself.
    const key = label.toLowerCase();
    if (key === previousLabel) return { ok: false, reason: `"${label}" is used twice in a row` };
    previousLabel = key;
    const note = typeof row.note === "string" ? row.note.trim() : "";
    if (!note) return { ok: false, reason: `${label} has no note` };
    if (note.length > PHASE_NOTE_MAX) {
      return { ok: false, reason: `the note on ${label} is longer than ${PHASE_NOTE_MAX} characters` };
    }
    if (!Number.isInteger(row.weeks) || (row.weeks as number) < 1) {
      return { ok: false, reason: `${label} has no whole number of weeks` };
    }
    if ((row.weeks as number) > PHASE_WEEKS_MAX) {
      return { ok: false, reason: `${label} is longer than ${PHASE_WEEKS_MAX} weeks` };
    }
    phases.push({ label, note, weeks: row.weeks as number });
  }

  const rawNote = (body as { note?: unknown }).note;
  return { ok: true, phases, note: typeof rawNote === "string" ? rawNote.trim() : "" };
}

export type PhaseDates =
  | { ok: true; milestones: PhaseMilestone[] }
  | { ok: false; reason: string };

/** The weights turned into the dates the goal card stores.
 *
 * Cumulative rather than per-phase lengths added up, the same idiom
 * `buildMilestones` uses and for the same reason: the last boundary then lands
 * exactly on the target day instead of several roundings away from it. The
 * weights only decide how the span is shared out, so a coach that answers
 * 4/4/2/1 and one that answers 8/8/4/2 produce identical dates -- which is the
 * property that lets the model think in weeks without owning the calendar. */
export function phaseDates(phases: PhaseWeights[], startISO: string, targetISO: string): PhaseDates {
  const start = isoDay(startISO);
  const target = isoDay(targetISO);
  if (!start || !target) return { ok: false, reason: "the goal has no usable dates" };
  const span = daysBetween(start, target);
  if (span < PHASE_MIN_SPAN_DAYS) {
    return { ok: false, reason: `there are only ${span} days to the target, which is too few to periodise` };
  }
  const total = phases.reduce((sum, p) => sum + p.weeks, 0);
  if (total < 1) return { ok: false, reason: "the phases add up to no time at all" };

  const milestones: PhaseMilestone[] = [];
  let cumulative = 0;
  let previousOffset = 0;
  for (let i = 0; i < phases.length; i++) {
    cumulative += phases[i].weeks;
    // The last phase is pinned rather than rounded, so the block ends on the
    // race day even when the weights do not divide the span evenly.
    const offset = i === phases.length - 1 ? span : Math.round((cumulative / total) * span);
    // Every phase has to own at least one day, or two boundaries land on the
    // same date and `currentPhase` -- first phase whose end has not passed --
    // skips one of them entirely. That is a shape the weights can produce on a
    // short goal (six phases over 28 days), so it is refused rather than
    // silently flattened.
    if (offset <= previousOffset) {
      return { ok: false, reason: `${phases[i].label} would be shorter than a day` };
    }
    previousOffset = offset;
    milestones.push({ label: phases[i].label, note: phases[i].note, date: shiftDay(start, offset) });
  }
  return { ok: true, milestones };
}

/** What the coach is asked. The goal's own words and dates, plus what the page
 * already cut, so the answer is a considered alternative rather than a first
 * guess made blind -- and TRAINING DATA above it carries his log and profile,
 * which is the whole reason this is worth asking a coach at all. */
export function buildPhasePrompt(goal: DraftGoal, todayISO: string): string {
  const text = String(goal.text ?? "").trim();
  const target = String(goal.targetDate ?? "").trim();
  const created = isoDay(goal.created) ?? todayISO;
  const span = daysBetween(created, target);
  const existing = Array.isArray(goal.milestones)
    ? goal.milestones
        .filter((m): m is { label: string; date: string } =>
          !!m && typeof (m as { label?: unknown }).label === "string" && !!isoDay((m as { date?: unknown }).date))
        .map((m) => `${m.label} until ${m.date}`)
    : [];
  return [
    `Edvard is training for: ${text}. The goal was set on ${created}, the target day is ${target}, and today is ${todayISO}.`,
    `That is ${span} days, about ${Math.round(span / 7)} weeks.`,
    existing.length
      ? `The app has already cut it mechanically into: ${existing.join("; ")}. Those are a fixed table applied to the span, not coaching -- keep what is right for this goal and change what is not.`
      : "The app has not cut it into phases yet.",
    "",
    "Shape the block yourself, for THIS goal and for the person in TRAINING DATA above. Answer with JSON and nothing else:",
    '{"phases": [{"label": "Base", "note": "what this phase is for, in one sentence he can act on", "weeks": 8}], "note": "one short sentence on why you shaped it this way"}',
    "",
    `Rules: between ${PHASE_MIN} and ${PHASE_MAX} phases, in order, first to last. \`label\` is the phase's name, at most ${PHASE_LABEL_MAX} characters -- use the standard names where they fit and a better one where they do not. \`note\` is one sentence, at most ${PHASE_NOTE_MAX} characters, about what he actually does in that phase. \`weeks\` is a whole number of weeks and is RELATIVE: the app scales the block onto his real dates and pins the last phase to the target day, so the ratios matter and the total does not have to hit ${Math.round(span / 7)} exactly. Do not write dates -- the app owns those. Do not repeat a label twice in a row.`,
    LANGUAGE_RULE,
    "He confirms this before anything is saved, so do not say you have changed his plan.",
  ].join("\n");
}

export type PhasePlanResult =
  | { status: "ok"; milestones: PhaseMilestone[]; note: string }
  | { status: "unconfigured" }
  | { status: "metered"; model: string }
  | { status: "upstream"; detail: string }
  /** The coach answered, and what it said is not a block of phases. Separate
   * from `upstream` because nothing is wrong with the connection. */
  | { status: "unusable"; reason: string };

export async function coachPhases(
  goal: unknown,
  context: CoachContext,
  deps: {
    config: CoachConfig | null;
    fetch: typeof globalThis.fetch;
    readTimeoutMs?: number;
    timeoutMs?: number;
    /** His calendar day as the page reads it, not this server's UTC one. */
    today?: string;
  },
): Promise<PhasePlanResult> {
  const g = (goal ?? null) as DraftGoal | null;
  if (!g || typeof g.text !== "string" || !g.text.trim()) {
    return { status: "unusable", reason: "that is not a goal" };
  }
  const target = isoDay(g.targetDate);
  // An ongoing goal has no target day, so it has no span to share out and the
  // card already says there are no phases to cut. Refused here rather than
  // asked, because the coach would answer something and the page would then
  // have phases on a goal that cannot have them.
  if (!target) return { status: "unusable", reason: "an ongoing goal has no phases to shape" };
  // The page always sends his own calendar day. Without one, the day the goal
  // was set is the honest fallback -- the block is cut from it anyway, and
  // falling back to the target date would tell the coach that today is race
  // day.
  const start = isoDay(g.created) ?? isoDay(deps.today) ?? target;
  const todayISO = isoDay(deps.today) ?? start;
  // A race day that has gone is not a short span, it is no span at all. The
  // card still renders such a goal -- `goalsSorted` shows every goal and
  // `homeGoal` deliberately keeps handing one back so Home can ask what is
  // next -- so without this the button spends a model call and gets back four
  // phases that all ended before today. `phaseDates` accepts them (their last
  // one is pinned onto the target, which is what the accept gate checks), the
  // goal then reads "phases shaped by Marcus", and `currentPhase`,
  // `phasePosition` and `raceCalendar` all find nothing in them.
  if (target < todayISO) {
    return { status: "unusable", reason: "that goal's target date has passed" };
  }
  if (daysBetween(start, target) < PHASE_MIN_SPAN_DAYS) {
    return { status: "unusable", reason: "this goal is too close to periodise" };
  }

  // No history, for the same reason the drafted week sends none: this is a
  // single question about his records, not a turn in the chat.
  const empty: ChatTurn[] = [];
  const result = await askCoach(buildPhasePrompt(g, todayISO), context, empty, deps);
  if (result.status !== "ok") return result;
  const parsed = parsePhasePlan(result.reply);
  if (!parsed.ok) return { status: "unusable", reason: parsed.reason };
  const dated = phaseDates(parsed.phases, start, target);
  if (!dated.ok) return { status: "unusable", reason: dated.reason };
  return { status: "ok", milestones: dated.milestones, note: parsed.note };
}

/** The first `{` to the last `}`. Same helper and same reasoning as
 * `plan-draft.ts`: trailing prose parses either way, and a reply with two
 * objects in it is not a block of phases. */
function sliceOuterObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
