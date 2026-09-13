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

import { aboutHim, askCoach, type ChatTurn, type CoachConfig, type CoachContext } from "./coach.js";
import { isoDay, phasePosition, type DraftGoal } from "./goal-phase.js";

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

// Re-exported at the name every existing caller and test already uses.
export { phasePosition };
export type { DraftGoal };

function describeGoal(goal: DraftGoal, todayISO: string): string {
  const text = String(goal.text).trim();
  const described = typeof goal.targetDate === "string" && goal.targetDate
    ? `${text} (target date ${goal.targetDate})`
    : `${text} (an ongoing goal with no target date, so no phases: a steady week that builds toward it)`;
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
 * phase must be one the page has a multiplier for, since it is written into
 * the prompt -- the four periodised ones, plus `Ongoing` for a goal with no
 * target date. */
const TARGET_PHASES = new Set(["Base", "Build", "Peak", "Taper", "Ongoing"]);

/** The phase `weekTarget` gives a goal with no target date. It is not one of
 * the four periodised phases and it has no end date, so the prompt has to say
 * why the week is sized the way it is in different words. */
const ONGOING_PHASE = "Ongoing";

export function weekTargetLine(week: unknown, startISO?: string | null): string | null {
  if (!week || typeof week !== "object") return null;
  const w = week as DraftWeekTarget;
  if (w.reason !== "ok" || typeof w.phase !== "string" || !TARGET_PHASES.has(w.phase.trim())) return null;
  if (!finite(w.volumeTarget) || w.volumeTarget <= 0 || !finite(w.baseline) || w.baseline <= 0) return null;
  if (!finite(w.multiplier) || w.multiplier <= 0 || !finite(w.baselineWeeks) || w.baselineWeeks < 1) return null;
  const pct = Math.round(Math.abs(w.multiplier - 1) * 100);
  const direction = pct === 0 ? "level with" : w.multiplier > 1 ? `${pct}% above` : `${pct}% below`;
  const weeks = Math.round(w.baselineWeeks);
  // A calendar row's week is sized by the same rule Home uses on this one.
  const lead = startISO
    ? `Sized the way his Home screen sizes a week, the week starting ${startISO} has a strength target of`
    : "His Home screen sets this week's strength target at";
  const reason = w.phase.trim() === ONGOING_PHASE
    ? "his goal has no target date, so there are no phases and every week is sized the same way"
    : `${startISO ? "that week is in" : "this is"} the ${w.phase.trim()} phase`;
  return (
    `${lead} ${Math.round(w.volumeTarget)} kg of volume ` +
    `(sets x reps x kilograms, summed over the week): ${direction} his own average of ${Math.round(w.baseline)} kg ` +
    `over the last ${weeks} completed week${weeks === 1 ? "" : "s"}, because ${reason}.`
  );
}

/** One row of the Plan tab's "every week to the race" list (raceCalendar in
 * public/app.js), as the row's Draft button sends it. */
export interface DraftCalendarWeek {
  goal?: unknown;
  start?: unknown;
  phase?: unknown;
  week?: unknown;
  weeks?: unknown;
  raceWeek?: unknown;
}

/** Idea #209's per-row Draft button. The row's label is sent rather than
 * re-derived from its date, because `phasePosition` judged on a future Monday
 * counts a phase that began mid-week this week one week short of the row he
 * tapped. Anything malformed says nothing, and the draft is of this week. */
export function calendarWeekLine(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as DraftCalendarWeek;
  const start = isoDay(r.start);
  if (!start || typeof r.goal !== "string" || !r.goal.trim()) return null;
  const phase = typeof r.phase === "string" && r.phase.trim() ? r.phase.trim() : null;
  const counted = Number.isInteger(r.week) && Number.isInteger(r.weeks)
    && (r.week as number) >= 1 && (r.week as number) <= (r.weeks as number);
  // An ongoing goal's rows all carry the same phase and no week number, so
  // "in the Ongoing phase" would name a phase that does not exist -- the goal
  // has none. Say why the week is the way it is instead, in the same words
  // weekTargetLine uses for it.
  const position = phase === ONGOING_PHASE
    ? "no different from any other: his goal has no target date, so there are no phases"
    : phase
      ? counted ? `week ${r.week} of ${r.weeks} of the ${phase} phase` : `in the ${phase} phase`
      : "outside every phase";
  return (
    `Draft the week starting ${start}, not the current week: in the plan for ${r.goal.trim()}, that week is ${position}` +
    (r.raceWeek === true ? ", and it is the race week." : ".")
  );
}

/** A week already drafted ahead, as the page holds it in `plannedWeeks`. */
export interface DraftPreviousWeek {
  start?: unknown;
  label?: unknown;
  days?: unknown;
}

/** The week drafted immediately before the one being asked for.
 *
 * Every draft so far has been blind to every other draft: TRAINING DATA carries
 * his logged sessions, which stop at today, so a block of four Base weeks was
 * four calls that could each see his history and none of the three weeks beside
 * it. The prompt told the model the week was "one step in a progression" and
 * then gave it no previous step, so the only thing that actually moved between
 * those weeks was the kilogram target the page computed. This is the step.
 *
 * It is the drafted week, not the calendar week before it: if week 3 was never
 * drafted, week 2 is what week 4 has to build on, and the date says how far
 * back that was rather than leaving the model to assume it was last week. */
export function previousWeekLine(previous: unknown): string | null {
  if (!previous || typeof previous !== "object") return null;
  const p = previous as DraftPreviousWeek;
  const start = isoDay(p.start);
  if (!start) return null;
  // Every field this then interpolates is checked, the way `calendarWeekLine`
  // checks its row: the days come from the page unread, and a `days` holding
  // prose rather than days would be dumped into the prompt as if it were a week.
  // The shape check is deliberately shallow -- `parseDraftReply` is what knows
  // what a day must contain, and re-stating its rules here would be the same
  // rules in two places disagreeing later.
  if (!Array.isArray(p.days) || !p.days.length) return null;
  if (!p.days.every((d) => d && typeof d === "object" && !Array.isArray(d) && typeof (d as { day?: unknown }).day === "string")) {
    return null;
  }
  const label = typeof p.label === "string" && p.label.trim() ? ` (${p.label.trim()})` : "";
  return [
    `THE WEEK ALREADY DRAFTED BEFORE IT, starting ${start}${label} -- ` +
      "this is what the new week continues from, not something to repeat:",
    JSON.stringify(p.days, null, 1),
  ].join("\n");
}

/** The prompt is built here rather than in the browser for the same reason
 * `buildPrompt` is: what reaches the model is decided in one place and is
 * testable. */
/** Who he is, as the week drafter sees it.
 *
 * `coach.ts` has printed this section into the chat prompt since issue #157 and
 * the drafter never read it, so the one record saying he runs and rides and has
 * never lifted seriously was invisible to the thing that writes his barbell
 * days. Measured 2026-09-13 against the running Marcus: his three real goals
 * with no profile drafted a week opening on a Barbell Back Squat.
 *
 * Same `aboutHim` as the chat, deliberately -- the cap and the "it was cut off"
 * sentence are one decision, not two -- and an empty profile prints no heading
 * at all rather than an empty one. */
function aboutHimLines(profile: unknown): string[] {
  const about = aboutHim(profile);
  if (!about.text) return [];
  return [
    "ABOUT EDVARD",
    [
      "What he has told the app about himself. Treat it as established fact and let it decide what belongs in the week -- what he has actually trained, what he has time for, and anything he cannot do.",
      about.truncated ? "It is longer than this and has been cut off here." : "",
    ]
      .filter(Boolean)
      .join(" "),
    about.text,
  ];
}

export function buildDraftPrompt(
  goals: DraftGoal | DraftGoal[] | null,
  context: CoachContext,
  todayISO?: string,
  week?: unknown,
  calendarWeek?: unknown,
  previousWeek?: unknown,
): string {
  const today = isoDay(todayISO) ?? new Date().toISOString().slice(0, 10);
  const phased = (Array.isArray(goals) ? goals : goals ? [goals] : []).some(
    (g) => g && typeof g.text === "string" && g.text.trim() && phasePosition(g, today),
  );
  const calendar = calendarWeekLine(calendarWeek);
  const previous = previousWeekLine(previousWeek);
  const progression = calendar
    ? [
        '- The week is one step in a progression from Base through Build and Peak to Taper: shape it for the week in the "Draft the week starting" line above, not for the current week, and name that phase and week in the note. Where his goals pull in different directions, that goal\'s week comes first.',
      ]
    : phased
    ? [
        "- The week is one step in a progression from Base through Build and Peak to Taper: shape it for the phase and the week in it named above, not for the goal in general, and name that phase and week in the note.",
      ]
    : [];
  const target = weekTargetLine(week, calendar ? isoDay((calendarWeek as DraftCalendarWeek).start) : null);
  const sizing = target
    ? [
        "- Size the strength sessions so the week, at the weights he has been lifting, lands near the kilogram target named above. If it cannot, say so in the note.",
      ]
    : [];
  return [
    "Draft one week of training for Edvard.",
    goalLines(goals, context.goals, today),
    ...(calendar ? [calendar] : []),
    ...(target ? [target] : []),
    ...(previous ? [previous] : []),
    ...aboutHimLines(context.profile),
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
      ...(previous
        ? [
            "- Move on from the week already drafted before it: keep the shape he is training in, and change what a week of progress changes -- a set, a rep, a distance, a session's emphasis. Do not hand back that week again.",
          ]
        : []),
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
    /** A Plan-tab calendar row, unchecked; `calendarWeekLine` checks it. */
    calendarWeek?: unknown;
    /** The week drafted before this one, unchecked; `previousWeekLine` checks it. */
    previousWeek?: unknown;
  },
): Promise<DraftResult> {
  // No history: a draft is a single question about his records, not a turn in
  // a conversation, and re-sending the chat would put the chat's tone in it.
  const empty: ChatTurn[] = [];
  const result = await askCoach(
    buildDraftPrompt(goal, context, deps.today, deps.week, deps.calendarWeek, deps.previousWeek),
    context, empty, deps);
  if (result.status !== "ok") return result;
  const parsed = parseDraftReply(result.reply);
  if (!parsed.ok) return { status: "unusable", reason: parsed.reason };
  return { status: "ok", days: parsed.days, note: parsed.note };
}
