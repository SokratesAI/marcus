import fs from "node:fs/promises";
import path from "node:path";

// Issue #227's key result `marcus-kr-coach-first-try` -- "the coach answers on
// the first tap" -- had no instrument, and the reason written beside it was
// that Marcus keeps no record of a coach tap or a retry, so the only way to
// read the share was to drive the live coach a number of times and count.
//
// That is the same reason `coach-latency.ts` was written to retire, and it
// fails here for the same reason: a sampling run is a SYNTHETIC tap, and this
// server already knows the outcome of every REAL one. A number taken by
// hammering /api/plan-draft at 02:00 measures the pod; the share recorded here
// measures Edvard's own taps, which is the share the key result is about.
//
// "Without a retry" is a fact about him, not about the server -- but nothing
// on this server auto-retries a coach call, and the page does not either
// (`fetchWeekDraft` in public/app.js sends once and hands the failure to its
// caller). So one tap is one call, and a call that did not come back with a
// usable answer is a tap he had to take again or give up on. That equivalence
// is what makes a per-call outcome the right reading, and it stops being true
// the day anything here retries on his behalf.
//
// On disk for `coach-latency.ts`'s reason: Marcus rolls several times on a
// busy night and an in-process counter would read empty for reasons that have
// nothing to do with how often the coach is used.
//
// **A call the coach never saw is not recorded at all.** An unconfigured coach
// and a coach pointed at a metered model are both refused by this server
// before anything leaves the pod, and both would fail identically on every
// retry forever -- folding them in would report "the coach answered 0% of
// taps" for a deployment where the coach was never asked a single question.
// What IS recorded as a failure is the coach being asked and not coming back
// with something usable, which is the thing a second tap might fix.

/** One coach call that actually reached the coach. */
export interface CoachOutcomeSample {
  /** ISO-8601, from the same `now()` the rest of the server uses. */
  at: string;
  /** Which surface was tapped: `chat`, `plan-draft` or `goal-phases`. */
  route: string;
  /** True when the caller got a usable answer back. */
  ok: boolean;
}

/** The newest N kept. Same size and same reasoning as the latency log: at
 * human tap rates this is weeks of history, and the file is rewritten on
 * every coach call. */
export const MAX_SAMPLES = 200;

export interface CoachOutcomeSummary {
  /** How many calls the share is over. Always reported beside it: 100% over
   * 1 tap and 100% over 80 taps are the same number and different readings. */
  count: number;
  /** How many of those came back usable. */
  answered: number;
  /** Percent, rounded to one decimal. Null when `count` is 0 -- never 0,
   * which would say every tap failed. */
  firstTryPct: number | null;
  /** ISO of the newest and oldest sample, so a reader can tell a current
   * share from one left over from last week. Null when there are none. */
  newestAt: string | null;
  oldestAt: string | null;
  /** The same pair per route, because one broken surface and three tired ones
   * produce the same overall share and want different fixes. */
  byRoute: Record<string, { count: number; answered: number }>;
}

export function summarise(samples: CoachOutcomeSample[]): CoachOutcomeSummary {
  const byRoute: Record<string, { count: number; answered: number }> = {};
  let answered = 0;
  for (const s of samples) {
    const bucket = byRoute[s.route] ?? (byRoute[s.route] = { count: 0, answered: 0 });
    bucket.count += 1;
    if (s.ok) {
      bucket.answered += 1;
      answered += 1;
    }
  }
  if (samples.length === 0) {
    return { count: 0, answered: 0, firstTryPct: null, newestAt: null, oldestAt: null, byRoute };
  }
  const times = samples.map((s) => s.at).sort();
  return {
    count: samples.length,
    answered,
    firstTryPct: Math.round((answered / samples.length) * 1000) / 10,
    newestAt: times[times.length - 1],
    oldestAt: times[0],
    byRoute,
  };
}

export class CoachOutcomeLog {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, filename = "coach-outcomes.json") {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  async list(): Promise<CoachOutcomeSample[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Dropped rather than thrown, for `coach-latency.ts`'s reason: an
      // instrument must not be able to break the route it watches.
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is CoachOutcomeSample =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as CoachOutcomeSample).at === "string" &&
        typeof (r as CoachOutcomeSample).route === "string" &&
        (r as CoachOutcomeSample).route.length > 0 &&
        typeof (r as CoachOutcomeSample).ok === "boolean",
    );
  }

  /** Append one call the coach was actually asked. Never throws: the caller
   * is a route that has already decided what to answer, and a disk error here
   * must not turn a good draft into a 500. */
  async record(route: string, ok: boolean, nowISO: string): Promise<void> {
    if (typeof route !== "string" || route.length === 0) return;
    await this.serialise(async () => {
      try {
        const current = await this.list();
        const next = [...current, { at: nowISO, route, ok }].slice(-MAX_SAMPLES);
        await this.writeAtomic(next);
      } catch {
        // Swallowed on purpose -- see the docstring.
      }
    });
  }

  async summary(): Promise<CoachOutcomeSummary> {
    return summarise(await this.list());
  }

  private async writeAtomic(samples: CoachOutcomeSample[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(samples), "utf8");
    await fs.rename(tmp, this.file);
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
