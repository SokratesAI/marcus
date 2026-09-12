// Where a goal stands today, in one sentence the app computed.
//
// This was inside `plan-draft.ts` and is now beside it, because the chat coach
// needs the same sentence and `plan-draft.ts` imports `coach.ts`. Importing it
// back would be a cycle; copying it would be the same arithmetic in two places,
// which is how the drafted week and the chat end up disagreeing about which
// week of which phase Edvard is in. One implementation, two callers.
//
// Nothing about the arithmetic changed in the move -- `plan-draft.ts` still
// exports `phasePosition`, so every existing caller and test reaches it at the
// same name.

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

export function isoDay(value: unknown): string | null {
  return typeof value === "string" && ISO_DAY.test(value) ? value : null;
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000);
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

function dayAfter(iso: string): string {
  return shiftDay(iso, 1);
}

/** Monday of the week containing `iso`, in UTC -- the page's weekStartOf. */
function mondayOf(iso: string): string {
  return shiftDay(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
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
    // Counted over the Mondays the phase owns, the rule the Plan tab's "every
    // week to the race" list (raceCalendar in public/app.js) uses, so the coach
    // and the list never disagree about the same week. A phase that starts
    // mid-week owns from the next Monday; the days before it are its opening
    // days and get no number, so a week's number never changes under it.
    const thisMonday = mondayOf(todayISO);
    const first = mondayOf(shiftDay(start, 6));
    const weeks = Math.max(1, Math.floor(daysBetween(first, mondayOf(phase.date)) / 7) + 1);
    if (first <= thisMonday) {
      const week = Math.min(weeks, Math.floor(daysBetween(first, thisMonday) / 7) + 1);
      line = `This is week ${week} of ${weeks} of the ${phase.label} phase${about}, which ends ${phase.date}`;
      lastWeek = week === weeks;
    } else {
      line = `This week holds the opening days of the ${phase.label} phase${about}, which began ${start} and ends ${phase.date}`;
      if (first <= phase.date) line += `; its week 1 of ${weeks} starts ${first}`;
    }
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
