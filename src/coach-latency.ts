import fs from "node:fs/promises";
import path from "node:path";

// Issue #227's KPI `marcus-kpi-coach-latency` -- "how long the coach makes you
// wait" -- had no instrument, and the reason written down for that was: the
// only way to time it is to drive the live coach, which is a sampling run
// against a production LLM route rather than a fact readable off the box.
//
// That reason is true about a *synthetic* sample and false about a recorded
// one. Marcus is the process that already waits for the coach, so the wall
// clock it wants is a number this server measures anyway and then throws away.
// Recording it turns the KPI from a number somebody types after driving the
// route by hand into a reading off Edvard's own taps -- which is also the only
// latency that matters, since a sample the loop generates is measured on an
// idle pod at 02:00.
//
// On disk rather than in memory, and that is the decision this file turns on.
// Marcus rolls several times on a busy night; an in-process ring buffer would
// be empty for most of the cycles that read it, so the instrument would report
// "no data" far more often than it reported a number, for reasons that have
// nothing to do with how often he uses the coach. The volume the subscriptions
// and the state already live on survives a roll.
//
// It records only calls that ANSWERED. A refused or failed draft has its own
// measure (`marcus-kr-coach-first-try`), and folding the two together would
// make a fast 502 look like good news.

/** One answered coach call. `ms` is wall clock around the coach call itself. */
export interface CoachLatencySample {
  /** ISO-8601, from the same `now()` the rest of the server uses. */
  at: string;
  /** Milliseconds, integer. */
  ms: number;
}

/** The newest N kept. Small on purpose: at human tap rates this is weeks of
 * history, and the file is read and rewritten on every answered call. */
export const MAX_SAMPLES = 200;

export interface CoachLatencySummary {
  /** How many samples the median is over. Always reported beside the median:
   * 14.9s over 40 taps and 14.9s over 1 tap are the same number and different
   * readings. */
  count: number;
  /** Null when `count` is 0 -- never 0, which is a real and very different
   * reading (the coach answered instantly). */
  medianMs: number | null;
  /** ISO of the newest and oldest sample, so a reader can tell a current
   * number from one left over from last week. Null when there are none. */
  newestAt: string | null;
  oldestAt: string | null;
}

export function summarise(samples: CoachLatencySample[]): CoachLatencySummary {
  if (samples.length === 0) {
    return { count: 0, medianMs: null, newestAt: null, oldestAt: null };
  }
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  // Even counts average the two middles rather than taking the upper one, so
  // two samples report what was actually waited on average and not the worse
  // of the pair.
  const medianMs = ms.length % 2 === 1 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
  const times = samples.map((s) => s.at).sort();
  return { count: ms.length, medianMs, newestAt: times[times.length - 1], oldestAt: times[0] };
}

export class CoachLatencyLog {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, filename = "coach-latency.json") {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  async list(): Promise<CoachLatencySample[]> {
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
      // A corrupt file is dropped rather than thrown, unlike the subscription
      // store above it: losing a subscription silently stops reaching a phone,
      // where losing a latency history costs a measurement nobody has taken
      // yet. An instrument must not be able to break the route it watches.
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is CoachLatencySample =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as CoachLatencySample).at === "string" &&
        Number.isFinite((r as CoachLatencySample).ms) &&
        (r as CoachLatencySample).ms >= 0,
    );
  }

  /** Append one answered call. Never throws: the caller is a route that has
   * already produced a good answer, and a disk error here must not turn it
   * into a 500. */
  async record(ms: number, nowISO: string): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) return;
    await this.serialise(async () => {
      try {
        const current = await this.list();
        const next = [...current, { at: nowISO, ms: Math.round(ms) }].slice(-MAX_SAMPLES);
        await this.writeAtomic(next);
      } catch {
        // Swallowed on purpose -- see the docstring.
      }
    });
  }

  async summary(): Promise<CoachLatencySummary> {
    return summarise(await this.list());
  }

  private async writeAtomic(samples: CoachLatencySample[]): Promise<void> {
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
