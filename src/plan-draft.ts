// Idea #187's remaining half: turning a sentence like "Olympic triathlon next
// summer" into actual training days. Every other piece of the Plan tab is
// arithmetic Edvard can check -- the phase dates come from his own target date,
// the weekly kilogram target from his own four-week average -- and a week
// written by a model is not that. So this deliberately does two things and no
// more: it asks the coach for a week, and it refuses anything that is not a
// week. Whether the week is any good is Edvard's call, at the accept gate on
// the page; nothing here writes into the plan.
//
// The refusal half is the reason this file exists at all rather than the route
// calling `askCoach` and handing the text to the browser. A model that answers
// with prose, with five Mondays, or with `sets: "a few"` must fail as loudly as
// one that does not answer -- a plan that half-parsed is worse than no plan,
// because it looks like it worked.

import { askCoach, type ChatTurn, type CoachConfig, type CoachContext } from "./coach.js";

/** Same order and spelling as the front end's own `DAY_NAMES`. A day the app
 * cannot match to a plan day is a day that silently never renders. */
export const PLAN_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Same list and spelling as the front end's own `CARDIO_ACTIVITIES`. A plan
 * day's cardio is picked from that list on the Plan tab, so an activity outside
 * it is one the page could never have written itself. */
export const PLAN_CARDIO_ACTIVITIES = ["Run", "Bike", "Swim", "Row", "Ski", "Walk", "Other"] as const;

/** The front end's `BOUNDS.minutes.max`: the longest session the Plan tab's
 * form accepts, so a drafted one can be no longer. */
export const PLAN_CARDIO_MAX_MINUTES = 1440;

export interface DraftExercise {
  name: string;
  sets: number;
  reps: number;
}

export interface DraftCardio {
  activity: string;
  minutes: number;
}

export interface DraftDay {
  day: string;
  focus: string;
  exercises: DraftExercise[];
  /** Absent when the coach put no cardio on the day. An endurance goal -- the
   * triathlon in the goal form's own placeholder -- is mostly this. */
  cardio?: DraftCardio;
}

export interface DraftGoal {
  text?: unknown;
  targetDate?: unknown;
  /** The day the goal was set; the first phase starts here. */
  created?: unknown;
  /** The Base/Build/Peak/Taper checkpoints the page cut from the target date,
   * each `{label, note, date}` where `date` is the day the phase ends. */
  milestones?: unknown;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(value: unknown): string | null {
  return typeof value === "string" && ISO_DAY.test(value) ? value : null;
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000);
}

function dayAfter(iso: string): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
}

interface Phase {
  label: string;
  note: string;
  date: string;
}

function phasesOf(goal: DraftGoal): Phase[] {
  if (!Array.isArray(goal.milestones)) return [];
  return goal.milestones
    .filter((m) => m && typeof m.label === "string" && m.label.trim() && isoDay(m.date))
    .map((m) => ({ label: m.label.trim(), note: typeof m.note === "string" ? m.note.trim() : "", date: m.date as string }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Idea #209's "week-by-week progression". A drafted week is one week, so the
 * progression lives in telling the coach which week of which phase this one is
 * -- the phase dates are the page's own arithmetic off his target date, and
 * without them every draft is the same generic week whether the race is eight
 * months or eight days away. The phase you are in is the first one whose end
 * date has not passed, the same rule the page's `currentPhase` uses. */
export function phasePosition(goal: DraftGoal, todayISO: string): string | null {
  const phases = phasesOf(goal);
  const index = phases.findIndex((p) => p.date >= todayISO);
  if (index < 0) return null;
  const phase = phases[index];
  const start = index > 0 ? dayAfter(phases[index - 1].date) : isoDay(goal.created);
  const about = phase.note ? ` (${phase.note})` : "";
  let line = `This week is in the ${phase.label} phase${about}, which ends ${phase.date}`;
  // With a start day the week count decides; without one, the calendar does.
  let lastWeek = daysBetween(todayISO, phase.date) < 7;
  if (start && start <= todayISO) {
    const weeks = Math.max(1, Math.ceil((daysBetween(start, phase.date) + 1) / 7));
    const week = Math.min(weeks, Math.floor(daysBetween(start, todayISO) / 7) + 1);
    line = `This is week ${week} of ${weeks} of the ${phase.label} phase${about}, which ends ${phase.date}`;
    lastWeek = week === weeks;
  }
  const next = phases[index + 1];
  line += next ? `; ${next.label} follows until ${next.date}.` : "; it runs up to the target day.";
  if (lastWeek) {
    line += next
      ? ` It is the last week of ${phase.label}, so let it lead into ${next.label}.`
      : ` It is the last week before the target day.`;
  }
  return line;
}

function describeGoal(goal: DraftGoal, todayISO: string): string {
  const text = String(goal.text).trim();
  const described = typeof goal.targetDate === "string" && goal.targetDate ? `${text} (target date ${goal.targetDate})` : text;
  const position = phasePosition(goal, todayISO);
  return position ? `${described}. ${position}` : described;
}

/** Idea #209 asks for "one or more goals". The page used to send only the
 * nearest, so a second goal reached the model as a row in the JSON dump and
 * nothing told it the week had to serve it. Sorted here rather than trusted
 * from the caller, because the prompt says "nearest first". */
function goalLines(goals: DraftGoal | DraftGoal[] | null, storedGoals: unknown, todayISO: string): string {
  const list = (Array.isArray(goals) ? goals : goals ? [goals] : [])
    .filter((g) => g && typeof g.text === "string" && g.text.trim().length)
    .map((g, i) => ({ g, i, date: typeof g.targetDate === "string" && g.targetDate ? g.targetDate : "\uffff" }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i)
    .map(({ g }) => g);
  if (!list.length) {
    // The page sends only goals still ahead of him, so an empty list beside a
    // non-empty stored list means every goal's date has passed -- which is not
    // the same as never having set one, and the coach should say so.
    return Array.isArray(storedGoals) && storedGoals.length
      ? "Every goal Edvard has written has passed its target date, so build a sensible general week and suggest in the note that he sets a new goal."
      : "Edvard has not written a goal yet, so build a sensible general week.";
  }
  if (list.length === 1) return `Edvard is training for: ${describeGoal(list[0], todayISO)}`;
  return [
    `Edvard is training for ${list.length} goals at once, nearest first:`,
    ...list.map((g) => `- ${describeGoal(g, todayISO)}`),
    "The week has to serve every one of them. Where they pull in different directions, favour the nearest target date, and say in the note what you traded off.",
  ].join("\n");
}

/** The Home card's "This week" target, as the page's `weekTarget` returns it.
 * Only the fields the prompt reads; the page sends the whole object. */
export interface DraftWeekTarget {
  reason?: unknown;
  phase?: unknown;
  multiplier?: unknown;
  baseline?: unknown;
  baselineWeeks?: unknown;
  volumeTarget?: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Idea #209's "weekly goals". The Home card sizes this week in kilograms off
 * his own four-week average and the phase (PHASE_VOLUME in the page), and the
 * draft never saw that number, so Marcus could draft a week twice the size the
 * card asks for. Anything but a complete `ok` target says nothing: "too early",
 * "no goal" and a malformed body are all the same prompt as before. So is an
 * `ok` target of 0 kg -- an all-cardio log -- because nothing can be sized to
 * zero strength volume; the goal and phase lines still shape that week. The
 * phase must be one of the four the page has a multiplier for, since it is
 * written into the prompt. */
const TARGET_PHASES = new Set(["Base", "Build", "Peak", "Taper"]);

export function weekTargetLine(week: unknown): string | null {
  if (!week || typeof week !== "object") return null;
  const w = week as DraftWeekTarget;
  if (w.reason !== "ok" || typeof w.phase !== "string" || !TARGET_PHASES.has(w.phase.trim())) return null;
  if (!finite(w.volumeTarget) || w.volumeTarget <= 0 || !finite(w.baseline) || w.baseline <= 0) return null;
  if (!finite(w.multiplier) || w.multiplier <= 0 || !finite(w.baselineWeeks) || w.baselineWeeks < 1) return null;
  const pct = Math.round(Math.abs(w.multiplier - 1) * 100);
  const direction = pct === 0 ? "level with" : w.multiplier > 1 ? `${pct}% above` : `${pct}% below`;
  const weeks = Math.round(w.baselineWeeks);
  return (
    `His Home screen sets this week's strength target at ${Math.round(w.volumeTarget)} kg of volume ` +
    `(sets x reps x kilograms, summed over the week): ${direction} his own average of ${Math.round(w.baseline)} kg ` +
    `over the last ${weeks} completed week${weeks === 1 ? "" : "s"}, because this is the ${w.phase.trim()} phase.`
  );
}

/** The prompt is built here rather than in the browser for the same reason
 * `buildPrompt` is: what reaches the model is decided in one place and is
 * testable. */
export function buildDraftPrompt(
  goals: DraftGoal | DraftGoal[] | null,
  context: CoachContext,
  todayISO?: string,
  week?: unknown,
): string {
  const today = isoDay(todayISO) ?? new Date().toISOString().slice(0, 10);
  const phased = (Array.isArray(goals) ? goals : goals ? [goals] : []).some(
    (g) => g && typeof g.text === "string" && g.text.trim() && phasePosition(g, today),
  );
  const progression = phased
    ? [
        "- The week is one step in a progression from Base through Build and Peak to Taper: shape it for the phase and the week in it named above, not for the goal in general, and name that phase and week in the note.",
      ]
    : [];
  const target = weekTargetLine(week);
  const sizing = target
    ? [
        "- Size the strength sessions so the week, at the weights he has been lifting, lands near the kilogram target named above. If it cannot, say so in the note.",
      ]
    : [];
  return [
    "Draft one week of training for Edvard.",
    goalLines(goals, context.goals, today),
    ...(target ? [target] : []),
    "TRAINING DATA (his own records, as stored by the app)",
    JSON.stringify(
      {
        plan: context.plan ?? null,
        sessions: context.sessions ?? [],
        weights: context.weights ?? [],
        goals: context.goals ?? [],
      },
      null,
      1,
    ),
    "ANSWER WITH JSON AND NOTHING ELSE, in exactly this shape:",
    '{"days":[{"day":"Monday","focus":"Push","exercises":[{"name":"Barbell Bench Press","sets":4,"reps":8}]},{"day":"Tuesday","focus":"Swim","exercises":[],"cardio":{"activity":"Swim","minutes":45}}],"note":"one sentence on why this week looks like this"}',
    [
      "Rules:",
      `- "day" must be one of ${PLAN_DAY_NAMES.join(", ")}, each at most once.`,
      "- A rest day is a day with an empty exercises list, no cardio and a focus of Rest.",
      '- "sets" and "reps" are whole numbers.',
      `- "cardio" is optional, at most one per day: "activity" is one of ${PLAN_CARDIO_ACTIVITIES.join(", ")} and "minutes" is a whole number. Leave it out on a day with no cardio.`,
      "- Use the exercises he already logs where they fit; the week is his, not a textbook's.",
      '- "note" is one plain sentence he will read above the week.',
      ...progression,
      ...sizing,
    ].join("\n"),
  ].join("\n\n");
}

export type DraftParse =
  | { ok: true; days: DraftDay[]; note: string }
  | { ok: false; reason: string };

/** Pulls the JSON out of a reply that may be fenced or may carry a sentence
 * either side of it, then checks every field. Nothing is coerced: a model that
 * answers `sets: "4"` is answering the wrong shape and is told so, because the
 * front end does arithmetic on that number. */
export function parseDraftReply(reply: string): DraftParse {
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
    return { ok: false, reason: "the coach did not answer with a week" };
  }
  const rawDays = (body as { days?: unknown }).days;
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    return { ok: false, reason: "the coach did not answer with a week" };
  }

  const days: DraftDay[] = [];
  const seen = new Set<string>();
  for (const raw of rawDays) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "one of the days is not a day" };
    }
    const row = raw as { day?: unknown; focus?: unknown; exercises?: unknown; cardio?: unknown };
    const day = canonicalDay(row.day);
    if (!day) return { ok: false, reason: `"${String(row.day)}" is not a day of the week` };
    if (seen.has(day)) return { ok: false, reason: `${day} appears twice` };
    seen.add(day);
    const focus = typeof row.focus === "string" ? row.focus.trim() : "";
    if (!focus) return { ok: false, reason: `${day} has no focus` };
    if (!Array.isArray(row.exercises)) return { ok: false, reason: `${day} has no exercise list` };
    const exercises: DraftExercise[] = [];
    for (const rawEx of row.exercises) {
      const parsed = parseExercise(rawEx, day);
      if ("reason" in parsed) return { ok: false, reason: parsed.reason };
      exercises.push(parsed.exercise);
    }
    // `null` and absent both mean "no cardio"; anything else has to be a
    // session the Plan tab could have written by hand.
    if (row.cardio === undefined || row.cardio === null) {
      days.push({ day, focus, exercises });
      continue;
    }
    const cardio = parseCardio(row.cardio, day);
    if ("reason" in cardio) return { ok: false, reason: cardio.reason };
    // A day with a swim on it is not a rest day. Same rename the Plan tab's
    // `withPlanCardio` makes when he adds cardio to a Rest day by hand.
    const named = focus.toLowerCase() === "rest" ? cardio.cardio.activity : focus;
    days.push({ day, focus: named, exercises, cardio: cardio.cardio });
  }

  const rawNote = (body as { note?: unknown }).note;
  return { ok: true, days, note: typeof rawNote === "string" ? rawNote.trim() : "" };
}

function parseExercise(raw: unknown, day: string): { exercise: DraftExercise } | { reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: `${day} has an exercise that is not an exercise` };
  }
  const row = raw as { name?: unknown; sets?: unknown; reps?: unknown };
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return { reason: `${day} has an exercise with no name` };
  // A positive integer, and nothing that merely looks like one: `planTotalSets`
  // sums this and the log form prefills from it.
  if (!Number.isInteger(row.sets) || (row.sets as number) < 1) {
    return { reason: `${name} on ${day} has no whole number of sets` };
  }
  if (!Number.isInteger(row.reps) || (row.reps as number) < 1) {
    return { reason: `${name} on ${day} has no whole number of reps` };
  }
  return { exercise: { name, sets: row.sets as number, reps: row.reps as number } };
}

function parseCardio(raw: unknown, day: string): { cardio: DraftCardio } | { reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: `the cardio on ${day} is not a session` };
  }
  const row = raw as { activity?: unknown; minutes?: unknown };
  const wanted = typeof row.activity === "string" ? row.activity.trim().toLowerCase() : "";
  const activity = PLAN_CARDIO_ACTIVITIES.find((a) => a.toLowerCase() === wanted);
  if (!activity) return { reason: `"${String(row.activity)}" on ${day} is not an activity the plan knows` };
  // Whole minutes inside the form's own bounds, as the Plan tab insists: the
  // card shows the number as written.
  if (!Number.isInteger(row.minutes) || (row.minutes as number) < 1) {
    return { reason: `the ${activity} on ${day} has no whole number of minutes` };
  }
  if ((row.minutes as number) > PLAN_CARDIO_MAX_MINUTES) {
    return { reason: `the ${activity} on ${day} is longer than ${PLAN_CARDIO_MAX_MINUTES} minutes` };
  }
  return { cardio: { activity, minutes: row.minutes as number } };
}

function canonicalDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const wanted = value.trim().toLowerCase();
  return PLAN_DAY_NAMES.find((d) => d.toLowerCase() === wanted) ?? null;
}

/** The first `{` to the last `}`. Deliberately not a brace counter: a reply
 * with trailing prose after the object parses either way, and one with two
 * objects in it is not a week and should fail. */
function sliceOuterObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export type DraftResult =
  | { status: "ok"; days: DraftDay[]; note: string }
  | { status: "unconfigured" }
  | { status: "metered"; model: string }
  | { status: "upstream"; detail: string }
  /** The coach answered, and what it said is not a week. Separate from
   * `upstream` because nothing is wrong with the connection. */
  | { status: "unusable"; reason: string };

export async function draftWeek(
  goal: DraftGoal | DraftGoal[] | null,
  context: CoachContext,
  deps: {
    config: CoachConfig | null;
    fetch: typeof globalThis.fetch;
    readTimeoutMs?: number;
    timeoutMs?: number;
    /** His calendar day as the page reads it; the phase counts come from it. */
    today?: string;
    /** The Home card's weekTarget, unchecked; `weekTargetLine` checks it. */
    week?: unknown;
  },
): Promise<DraftResult> {
  // No history: a draft is a single question about his records, not a turn in
  // a conversation, and re-sending the chat would put the chat's tone in it.
  const empty: ChatTurn[] = [];
  const result = await askCoach(buildDraftPrompt(goal, context, deps.today, deps.week), context, empty, deps);
  if (result.status !== "ok") return result;
  const parsed = parseDraftReply(result.reply);
  if (!parsed.ok) return { status: "unusable", reason: parsed.reason };
  return { status: "ok", days: parsed.days, note: parsed.note };
}
