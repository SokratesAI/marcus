import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same shape as app-validation.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// `byId` is returned as well because the food picker renders into #foodPicked
// and then reads #foodAmount back, and this stub does not parse HTML — a test
// that drives the picker has to set that input's value itself.
function loadApp(opts: { now?: Date } = {}): { ctx: any; toasts: string[]; byId: Record<string, any>; stored: Record<string, string> } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      content: { firstElementChild: { cloneNode: () => makeNode() } },
      appendChild() {},
      remove() {},
      addEventListener(name: string, fn: any) {
        (node.handlers ??= {})[name] = fn;
      },
      querySelector: () => makeNode(),
      querySelectorAll: () => [],
      getContext: () => ({}),
      handlers: {} as Record<string, any>,
    };
    return node;
  };

  const byId: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (byId[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console, setTimeout, clearTimeout,
    Math, JSON, Number, String, Array, Object,
    // `new Date()` with no argument is the app's only clock. Left real, a test
    // of the timestamp is judged against whatever time the suite happens to run
    // at -- which is why a two-digit hour cannot fail one. Every other call
    // shape passes straight through.
    Date: opts.now
      ? new Proxy(Date, {
          construct(target, args: any[]) {
            return args.length ? new (target as any)(...args) : new (target as any)(opts.now!.getTime());
          },
        })
      : Date,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  // `const`/`let` at the top level of a script are lexical, so unlike a
  // `function` declaration they never land on the context's global object.
  // FOODS is read by every test here and recentMealCache is reassigned on each
  // render, so it is exposed as a getter rather than a snapshot.
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.FOODS = FOODS;" +
      "\n;globalThis.BACKUP_KEYS = BACKUP_KEYS;" +
      "\n;globalThis.BACKUP_VERSION = BACKUP_VERSION;" +
      "\n;Object.defineProperty(globalThis, 'recentMealCache', { get: () => recentMealCache });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}

// The app seeds plan/sessions/weights/meals/chat on load, so a fresh context
// already has real data in it -- these tests read that rather than inventing a
// store, which is also what a user's first export would actually contain.

describe("buildBackup", () => {
  it("carries every store key the app writes, under a versioned envelope", () => {
    const { ctx } = loadApp();
    const out = ctx.buildBackup("2026-09-01T00:00:00.000Z");
    expect(out.app).toBe("marcus");
    expect(out.version).toBe(ctx.BACKUP_VERSION);
    expect(out.exportedAt).toBe("2026-09-01T00:00:00.000Z");
    // seed() writes all of these except goals, which a new user has none of.
    expect(Object.keys(out.data).sort()).toEqual(["chat", "meals", "plan", "sessions", "weights"]);
    expect(out.data.sessions).toEqual(ctx.store.get("sessions", []));
  });

  it("includes goals once there are any", () => {
    const { ctx } = loadApp();
    ctx.store.set("goals", [{ id: "g1", text: "Olympic triathlon", targetDate: "2027-06-01", milestones: [] }]);
    expect(ctx.buildBackup("2026-09-01T00:00:00.000Z").data.goals).toHaveLength(1);
  });

  it("stamps the date itself when none is passed", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-01T09:05:00Z") });
    expect(ctx.buildBackup().exportedAt).toBe("2026-09-01T09:05:00.000Z");
  });
});

describe("backupFilename", () => {
  it("names the file for the day it was exported", () => {
    const { ctx } = loadApp();
    expect(ctx.backupFilename("2026-09-01T22:41:03.000Z")).toBe("marcus-backup-2026-09-01.json");
  });

  it("falls back to now when the stamp is missing", () => {
    const { ctx } = loadApp({ now: new Date("2026-12-24T10:00:00Z") });
    expect(ctx.backupFilename()).toBe("marcus-backup-2026-12-24.json");
  });
});

describe("parseBackup", () => {
  const good = (over: any = {}) =>
    JSON.stringify({ app: "marcus", version: 1, exportedAt: "2026-09-01T00:00:00.000Z", data: { sessions: [{ id: "s1" }], goals: [] }, ...over });

  it("accepts a file this version wrote", () => {
    const { ctx } = loadApp();
    const r = ctx.parseBackup(good());
    expect(r.ok).toBe(true);
    expect(r.data.sessions).toEqual([{ id: "s1" }]);
    expect(r.exportedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("round-trips its own export", () => {
    const { ctx } = loadApp();
    const text = JSON.stringify(ctx.buildBackup("2026-09-01T00:00:00.000Z"));
    const r = ctx.parseBackup(text);
    expect(r.ok).toBe(true);
    expect(r.data.sessions).toEqual(ctx.store.get("sessions", []));
    expect(r.data.plan).toEqual(ctx.store.get("plan", null));
  });

  it("refuses text that is not JSON", () => {
    const { ctx } = loadApp();
    expect(ctx.parseBackup("not json at all").ok).toBe(false);
  });

  it("refuses a JSON file that is not ours", () => {
    const { ctx } = loadApp();
    expect(ctx.parseBackup(JSON.stringify({ app: "strava", version: 1, data: { sessions: [] } })).ok).toBe(false);
    expect(ctx.parseBackup(JSON.stringify([1, 2, 3])).ok).toBe(false);
    expect(ctx.parseBackup("null").ok).toBe(false);
  });

  it("refuses a backup from a newer Marcus rather than reading it half-way", () => {
    const { ctx } = loadApp();
    const r = ctx.parseBackup(good({ version: ctx.BACKUP_VERSION + 1 }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("newer Marcus");
  });

  it("accepts an older version", () => {
    const { ctx } = loadApp();
    expect(ctx.parseBackup(good({ version: 0 })).ok).toBe(true);
  });

  it("refuses a missing or non-numeric version", () => {
    const { ctx } = loadApp();
    expect(ctx.parseBackup(good({ version: undefined })).ok).toBe(false);
    expect(ctx.parseBackup(good({ version: "1" })).ok).toBe(false);
  });

  it("drops keys of the wrong shape instead of restoring garbage", () => {
    const { ctx } = loadApp();
    const r = ctx.parseBackup(JSON.stringify({
      app: "marcus", version: 1,
      data: { sessions: "everything", plan: [1, 2], meals: [{ id: "m1" }], nonsense: [{ id: "x" }] },
    }));
    expect(r.ok).toBe(true);
    expect(Object.keys(r.data)).toEqual(["meals"]);
  });

  it("refuses a file with no data it recognises", () => {
    const { ctx } = loadApp();
    expect(ctx.parseBackup(JSON.stringify({ app: "marcus", version: 1, data: {} })).ok).toBe(false);
    expect(ctx.parseBackup(JSON.stringify({ app: "marcus", version: 1, data: { nonsense: [1] } })).ok).toBe(false);
    expect(ctx.parseBackup(JSON.stringify({ app: "marcus", version: 1 })).ok).toBe(false);
  });
});

describe("backupSummary", () => {
  it("counts entries per section and treats the plan as one thing", () => {
    const { ctx } = loadApp();
    expect(ctx.backupSummary({ sessions: [1, 2, 3], plan: { days: {} } })).toEqual([
      { key: "plan", count: 1 },
      { key: "sessions", count: 3 },
    ]);
  });

  it("names nothing for a section the file does not carry", () => {
    const { ctx } = loadApp();
    expect(ctx.backupSummary({}).length).toBe(0);
  });
});

describe("restoreBackup", () => {
  it("replaces what is in the app rather than merging", () => {
    const { ctx } = loadApp();
    expect(ctx.store.get("sessions", []).length).toBeGreaterThan(0);
    const r = ctx.restoreBackup({ data: { sessions: [{ id: "only-one" }] } });
    expect(r.restored).toEqual(["sessions"]);
    expect(r.failed).toEqual([]);
    expect(ctx.store.get("sessions", [])).toEqual([{ id: "only-one" }]);
  });

  it("leaves sections the file does not carry alone", () => {
    const { ctx } = loadApp();
    const mealsBefore = ctx.store.get("meals", []);
    ctx.restoreBackup({ data: { sessions: [] } });
    expect(ctx.store.get("meals", [])).toEqual(mealsBefore);
  });

  it("reports what a blocked store refused instead of claiming success", () => {
    const { ctx } = loadApp();
    ctx.localStorage.setItem = () => { throw new Error("blocked"); };
    const r = ctx.restoreBackup({ data: { sessions: [{ id: "s1" }], meals: [] } });
    expect(r.restored).toEqual([]);
    expect(r.failed.sort()).toEqual(["meals", "sessions"]);
  });
});
