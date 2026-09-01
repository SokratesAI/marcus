import fs from "node:fs/promises";
import path from "node:path";

// The server-side copy of everything Marcus knows. Issue #153: until now the
// only copy lived in one browser's localStorage, so clearing site data or
// switching phone lost the lot.
//
// The payload is deliberately the same envelope `buildBackup` already writes in
// public/app.js -- `{ app, version, exportedAt, data }` -- so an exported file
// and a stored state are the same shape, and idea #198's nightly job can read
// this without a second format.
export const STATE_VERSION = 1;

export interface StateRecord {
  rev: number;
  updatedAt: string;
  data: Record<string, unknown> | null;
}

export interface PutOk {
  ok: true;
  state: StateRecord;
}

export interface PutConflict {
  ok: false;
  reason: "conflict" | "invalid";
  message: string;
  state: StateRecord;
}

export const emptyState = (): StateRecord => ({ rev: 0, updatedAt: "", data: null });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A single JSON document on the volume mounted at /data, guarded by a
 * monotonic revision.
 *
 * The revision is the whole conflict story and it is deliberately coarse: a
 * client sends the rev it last saw, and a PUT built on an older rev is refused
 * with the current state rather than merged. Merging two divergent copies of a
 * training log by hand is a guess about which one is right, and a guess that
 * silently deletes a logged session is worse than an error the client can act
 * on.
 */
export class StateStore {
  private readonly file: string;
  // Every read-modify-write is chained onto this so two overlapping requests
  // cannot both read rev 4 and both write rev 5.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, filename = "marcus-state.json") {
    this.file = path.join(dir, filename);
  }

  get filePath(): string {
    return this.file;
  }

  async read(): Promise<StateRecord> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      // Nothing stored yet is the normal first-run state, not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // A truncated or hand-edited file: report it rather than serving a
      // half-parsed object the client would then overwrite history with.
      throw new Error(`state file at ${this.file} is not valid JSON`);
    }
    if (!isPlainObject(raw) || typeof raw.rev !== "number" || !Number.isFinite(raw.rev)) {
      throw new Error(`state file at ${this.file} has no usable revision`);
    }
    return {
      rev: raw.rev,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      data: isPlainObject(raw.data) ? raw.data : null,
    };
  }

  async put(expectedRev: unknown, data: unknown, nowISO: string): Promise<PutOk | PutConflict> {
    return this.serialise(async () => {
      const current = await this.read();
      if (typeof expectedRev !== "number" || !Number.isInteger(expectedRev) || expectedRev < 0) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          message: "rev must be a whole number, and the one you last read.",
          state: current,
        };
      }
      if (!isPlainObject(data)) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          message: "data must be an object of Marcus store keys.",
          state: current,
        };
      }
      if (expectedRev !== current.rev) {
        return {
          ok: false as const,
          reason: "conflict" as const,
          message: `this was built on revision ${expectedRev} and the server is at ${current.rev}.`,
          state: current,
        };
      }
      const next: StateRecord = { rev: current.rev + 1, updatedAt: nowISO, data };
      await this.writeAtomic(next);
      return { ok: true as const, state: next };
    });
  }

  private async writeAtomic(record: StateRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify({ app: "marcus", version: STATE_VERSION, ...record });
    // A half-written file is indistinguishable from a truncated one on the next
    // read, so the bytes land under a temporary name and are renamed into place.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
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
