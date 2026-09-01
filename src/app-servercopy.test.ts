import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// A deliberately smaller harness than app-backup.test.ts's: everything under
// test here is a `function` declaration, and those land on the context's global
// object on their own, so nothing has to be re-exported by hand. `fetch` is
// passed in rather than stubbed globally, which is the whole reason
// pushServerCopy takes it as an argument.
function loadApp(): any {
  const node: any = {
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    content: { firstElementChild: { cloneNode: () => node } },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => node, querySelectorAll: () => [], getContext: () => ({}),
  };
  const stored: Record<string, string> = {};
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isNaN,
    document: {
      body: node, getElementById: () => node, querySelector: () => node,
      querySelectorAll: () => [], createElement: () => node, addEventListener() {},
    },
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
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;\n;globalThis.BACKUP_VERSION = BACKUP_VERSION;", ctx);
  return ctx;
}

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("describeServerCopy", () => {
  it("says it is still checking before the first answer comes back", () => {
    expect(loadApp().describeServerCopy({ state: "unknown" })).toMatch(/checking/);
  });

  it("says the browser still has everything when the server cannot be reached", () => {
    // The failure mode this line exists for: a user who reads "not saved" and
    // concludes their training log is gone.
    const out = loadApp().describeServerCopy({ state: "unreachable" });
    expect(out).toMatch(/not reachable/);
    expect(out).toMatch(/still has everything/);
  });

  it("distinguishes an empty server from an unreachable one", () => {
    expect(loadApp().describeServerCopy({ state: "empty" })).toMatch(/nothing saved/);
  });

  it("prints when the copy was last saved", () => {
    const out = loadApp().describeServerCopy({ state: "saved", updatedAt: "2026-09-01T04:30:00.000Z" });
    expect(out).toMatch(/last saved/);
    expect(out).not.toMatch(/unknown time/);
  });

  it("does not print an invalid date as a timestamp", () => {
    expect(loadApp().describeServerCopy({ state: "saved", updatedAt: "not a date" })).toMatch(/unknown time/);
  });
});

describe("shouldPush", () => {
  it("pushes from a browser that has synced before", () => {
    expect(loadApp().shouldPush(4, 4)).toBe(true);
  });

  it("pushes when the server has nothing", () => {
    expect(loadApp().shouldPush(0, 0)).toBe(true);
  });

  it("refuses to push a never-synced browser over a server copy that exists", () => {
    // A fresh browser has just seeded itself with an empty plan. Pushing that
    // writes blank seed data over a real training history nothing else holds.
    expect(loadApp().shouldPush(0, 7)).toBe(false);
  });
});

describe("describeServerCopy, the ahead state", () => {
  it("tells the user to load it before this browser saves over it", () => {
    const out = loadApp().describeServerCopy({ state: "ahead", updatedAt: "2026-09-01T04:00:00.000Z" });
    expect(out).toMatch(/never seen/);
    expect(out).toMatch(/Load it/);
  });
});

describe("serverStateToBackup", () => {
  it("refuses a state with nothing in it", () => {
    const ctx = loadApp();
    expect(ctx.serverStateToBackup(null)).toBeNull();
    expect(ctx.serverStateToBackup({ rev: 0, data: null })).toBeNull();
    expect(ctx.serverStateToBackup({ rev: 1, data: [1, 2] })).toBeNull();
  });

  it("wraps the server's data into an envelope the file validator accepts", () => {
    // One validator for the file and for the server: if these two ever needed
    // different code, a bad server payload would be restorable and a bad file
    // would not.
    const ctx = loadApp();
    const envelope = ctx.serverStateToBackup({ rev: 3, updatedAt: "2026-09-01T04:00:00.000Z", data: { sessions: [{ id: "a" }] } });
    const parsed = ctx.parseBackup(JSON.stringify(envelope));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sessions).toEqual([{ id: "a" }]);
    expect(parsed.exportedAt).toBe("2026-09-01T04:00:00.000Z");
  });
});

describe("pushServerCopy", () => {
  it("sends the revision it was given and reports the one it got back", async () => {
    const ctx = loadApp();
    const calls: any[] = [];
    const fetchFn = async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return res(200, { rev: 5, updatedAt: "t" }); };
    const out = await ctx.pushServerCopy(fetchFn, { sessions: [] }, 4);
    expect(calls).toEqual([{ rev: 4, data: { sessions: [] } }]);
    expect(out).toEqual({ ok: true, rev: 5, updatedAt: "t" });
  });

  it("retries a 409 at the revision the server named, and only once", async () => {
    const ctx = loadApp();
    const sent: number[] = [];
    const fetchFn = async (_url: string, init: any) => {
      const rev = JSON.parse(init.body).rev;
      sent.push(rev);
      return rev === 9 ? res(200, { rev: 10, updatedAt: "t" }) : res(409, { state: { rev: 9 } });
    };
    const out = await ctx.pushServerCopy(fetchFn, {}, 4);
    expect(sent).toEqual([4, 9]);
    expect(out.ok).toBe(true);
    expect(out.rev).toBe(10);
  });

  it("gives up on a 409 whose body does not name a revision, rather than guessing one", async () => {
    const ctx = loadApp();
    let calls = 0;
    const fetchFn = async () => { calls += 1; return res(409, { error: "no" }); };
    const out = await ctx.pushServerCopy(fetchFn, {}, 4);
    expect(calls).toBe(1);
    expect(out).toEqual({ ok: false, reason: "conflict" });
  });

  it("reports a refusal rather than treating it as saved", async () => {
    const ctx = loadApp();
    const out = await ctx.pushServerCopy(async () => res(400, { error: "bad" }), {}, 0);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
  });

  it("does not report success when the server answers 200 with no revision in it", async () => {
    // A proxy or an offline page can answer 200 with something that is not the
    // API's body; treating that as saved would advance the local revision past
    // anything the server has and refuse every later push.
    const ctx = loadApp();
    const out = await ctx.pushServerCopy(async () => res(200, { hello: "world" }), {}, 0);
    expect(out).toEqual({ ok: false, reason: "refused" });
  });
});
