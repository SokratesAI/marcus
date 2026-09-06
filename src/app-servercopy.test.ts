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
function loadApp(preset: Record<string, string> = {}, fetchImpl?: any): any {
  const node: any = {
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    content: { firstElementChild: { cloneNode: () => node } },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => node, querySelectorAll: () => [], getContext: () => ({}),
  };
  const stored: Record<string, string> = { ...preset };
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
  // Left undefined by default: every function under test takes its fetch as an
  // argument, and boot's own fetch is only wanted by the boot test.
  if (fetchImpl) ctx.fetch = fetchImpl;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.BACKUP_VERSION = BACKUP_VERSION;" +
      // A top-level `let` does not land on the context object the way a function
      // declaration does, and this one changes, so it needs a live getter.
      "\n;Object.defineProperty(globalThis, 'seededThisBoot', { get: () => seededThisBoot });",
    ctx,
  );
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
    expect(out).toEqual({ ok: true, rev: 5, updatedAt: "t", merged: null });
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

// Issue #153's remaining half: a second device. Everything below is about the
// one case where pulling the server copy without asking destroys nothing.
describe("shouldAdoptServerCopy", () => {
  it("adopts only on a browser that seeded itself this boot and a server that has something", () => {
    expect(loadApp().shouldAdoptServerCopy(0, 7, true)).toBe(true);
  });

  it("refuses once this browser has synced, however new it looks", () => {
    // A browser at rev 3 has pushed before, so whatever is in it now is a fact
    // the user created -- including deleting everything -- and pulling on top
    // would undo that silently.
    expect(loadApp().shouldAdoptServerCopy(3, 7, true)).toBe(false);
  });

  it("refuses when the server has nothing", () => {
    expect(loadApp().shouldAdoptServerCopy(0, 0, true)).toBe(false);
  });

  it("refuses on a returning browser, which is every boot after the first", () => {
    expect(loadApp().shouldAdoptServerCopy(0, 7, false)).toBe(false);
  });
});

describe("the fresh-boot flag", () => {
  it("is set by a browser that has never opened Marcus, and not by one that has", () => {
    // The precondition the whole feature rests on, asserted rather than assumed:
    // loadApp starts from an empty localStorage, so seed() must have fired.
    const fresh = loadApp();
    expect(fresh.seededThisBoot).toBe(true);
    expect(fresh.store.get("sessions", [])).not.toHaveLength(0);

    // And a browser that already holds a plan does not seed again. The demo
    // data is what makes this the only usable signal: a new browser is NOT
    // empty, so nothing about its contents separates it from a used one.
    const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const returning = loadApp({
      "marcus.plan": JSON.stringify({ blockName: "mine", days: DAYS.map((day) => ({ day, focus: "Rest", exercises: [] })) }),
    });
    expect(returning.seededThisBoot).toBe(false);
  });

  it("is cleared by the first real write, so a slow boot fetch cannot overwrite it", () => {
    const ctx = loadApp();
    expect(ctx.seededThisBoot).toBe(true);
    ctx.store.set("sessions", [{ id: "logged while the fetch was in flight" }]);
    expect(ctx.seededThisBoot).toBe(false);
    expect(ctx.adoptServerCopy({ rev: 7, updatedAt: null, data: { sessions: [] } })).toBe(null);
  });

  it("is not cleared by a write the backup does not carry", () => {
    const ctx = loadApp();
    ctx.store.set("syncRev", 0);
    expect(ctx.seededThisBoot).toBe(true);
  });
});

describe("adoptServerCopy", () => {
  const serverState = (rev: number) => ({
    rev,
    updatedAt: "2026-09-06T10:00:00.000Z",
    data: { sessions: [{ id: "s1" }, { id: "s2" }], weights: [{ kg: 82 }] },
  });

  it("puts the server's sessions into a fresh browser and records the revision", () => {
    const ctx = loadApp();
    const out = ctx.adoptServerCopy(serverState(7));
    expect(out.ok).toBe(true);
    expect(out.rev).toBe(7);
    expect(ctx.store.get("sessions", [])).toEqual([{ id: "s1" }, { id: "s2" }]);
    expect(ctx.store.get("weights", [])).toEqual([{ kg: 82 }]);
    // Without this the next push would go up at rev 0 and be refused forever.
    expect(ctx.store.get("syncRev", null)).toBe(7);
  });

  it("leaves alone the keys the server copy does not carry", () => {
    // The seeded meals are not in serverState, and a restore replaces rather
    // than empties -- wiping them would be a silent second decision.
    const ctx = loadApp();
    const meals = ctx.store.get("meals", []);
    expect(meals.length).toBeGreaterThan(0);
    ctx.adoptServerCopy(serverState(7));
    expect(ctx.store.get("meals", [])).toEqual(meals);
  });

  it("declines, and changes nothing, on a browser that has synced before", () => {
    const ctx = loadApp();
    ctx.store.set("syncRev", 3);
    const before = ctx.store.get("sessions", []);
    expect(ctx.adoptServerCopy(serverState(7))).toBe(null);
    expect(ctx.store.get("sessions", [])).toEqual(before);
    expect(ctx.store.get("syncRev", null)).toBe(3);
  });

  it("declines when the server has never been written to", () => {
    expect(loadApp().adoptServerCopy({ rev: 0, data: null })).toBe(null);
  });

  it("declines when the server could not be reached at all", () => {
    expect(loadApp().adoptServerCopy(null)).toBe(null);
  });

  it("refuses a server copy this version cannot read, instead of writing garbage", () => {
    const ctx = loadApp();
    const before = ctx.store.get("sessions", []);
    const out = ctx.adoptServerCopy({ rev: 4, updatedAt: null, data: { sessions: "not an array" } });
    expect(out.ok).toBe(false);
    expect(ctx.store.get("sessions", [])).toEqual(before);
    expect(ctx.store.get("syncRev", null)).toBe(null);
  });
});

describe("the boot pull", () => {
  it("asks the server once at boot and adopts what it finds on a new browser", async () => {
    // This is the whole feature end to end: nothing is clicked, and boot is the
    // only thing that ran. app-barcode.test.ts drops this same request from its
    // call log, so this is the test that keeps it honest.
    const asked: string[] = [];
    const ctx = loadApp({}, async (url: string) => {
      asked.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ rev: 12, updatedAt: "2026-09-06T10:00:00.000Z", data: { sessions: [{ id: "from-the-server" }] } }),
      };
    });
    expect(asked).toEqual(["/api/state"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.store.get("sessions", [])).toEqual([{ id: "from-the-server" }]);
    expect(ctx.store.get("syncRev", null)).toBe(12);
  });

  it("leaves a returning browser exactly as it was", async () => {
    const asked: string[] = [];
    const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const ctx = loadApp(
      {
        "marcus.plan": JSON.stringify({ blockName: "mine", days: DAYS.map((day) => ({ day, focus: "Rest", exercises: [] })) }),
        "marcus.sessions": JSON.stringify([{ id: "mine" }]),
      },
      async (url: string) => {
        asked.push(url);
        return { ok: true, status: 200, json: async () => ({ rev: 12, updatedAt: null, data: { sessions: [{ id: "from-the-server" }] } }) };
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    // It still asks -- the status line needs the answer -- and it does not act.
    expect(asked).toEqual(["/api/state"]);
    expect(ctx.store.get("sessions", [])).toEqual([{ id: "mine" }]);
    expect(ctx.store.get("syncRev", null)).toBe(null);
  });
});

// Issue #153: a 409 used to be retried with this browser's payload, which
// wrote over whatever the other phone had logged. These pin the union.
describe("mergeBackupData", () => {
  it("keeps a session only the server holds and one only this browser holds", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData(
      { sessions: [{ id: "a", date: "2026-09-01" }] },
      { sessions: [{ id: "b", date: "2026-09-02" }] },
    );
    expect(out.sessions.map((s: any) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("prefers this browser's copy of a record both sides hold", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData(
      { meals: [{ id: "m", name: "mine" }] },
      { meals: [{ id: "m", name: "theirs" }] },
    );
    expect(out.meals).toEqual([{ id: "m", name: "mine" }]);
  });

  it("identifies a weight by its date, because those records carry no id", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData(
      { weights: [{ date: "2026-09-01", kg: 84 }] },
      { weights: [{ date: "2026-09-01", kg: 99 }, { date: "2026-09-02", kg: 83 }] },
    );
    expect(out.weights).toEqual([{ date: "2026-09-01", kg: 84 }, { date: "2026-09-02", kg: 83 }]);
  });

  it("puts a merged chat back in time order, because it is rendered in stored order", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData(
      { chat: [{ role: "you", text: "a", ts: 3 }] },
      { chat: [{ role: "marcus", text: "b", ts: 1 }] },
    );
    expect(out.chat.map((m: any) => m.ts)).toEqual([1, 3]);
  });

  it("does not merge the plan -- one object with no identity, this browser wins", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData({ plan: { blockName: "mine" } }, { plan: { blockName: "theirs" } });
    expect(out.plan).toEqual({ blockName: "mine" });
  });

  it("takes the server's list whole when this browser has no such key", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData({}, { goals: [{ id: "g" }] });
    expect(out.goals).toEqual([{ id: "g" }]);
  });

  it("drops a server record with no usable identity rather than duplicating it every sync", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData({ sessions: [{ id: "a" }] }, { sessions: [{ date: "2026-09-01" }] });
    expect(out.sessions).toEqual([{ id: "a" }]);
  });

  it("keeps this browser's own unidentifiable record, which is data nothing else holds", () => {
    const ctx = loadApp();
    const out = ctx.mergeBackupData({ sessions: [{ date: "2026-09-01" }] }, { sessions: [] });
    expect(out.sessions).toEqual([{ date: "2026-09-01" }]);
  });
});

describe("pushServerCopy on a conflict", () => {
  it("re-sends the union of both copies, not this browser's payload", async () => {
    const ctx = loadApp();
    const sent: any[] = [];
    const fetchFn = async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return body.rev === 9
        ? res(200, { rev: 10, updatedAt: "t" })
        : res(409, { state: { rev: 9, updatedAt: "s", data: { sessions: [{ id: "theirs" }] } } });
    };
    const out = await ctx.pushServerCopy(fetchFn, { sessions: [{ id: "mine" }] }, 4);
    expect(out.ok).toBe(true);
    expect(sent[1].data.sessions.map((s: any) => s.id).sort()).toEqual(["mine", "theirs"]);
    // And the caller is told, so it can put those records into this browser too.
    expect(out.merged.sessions.map((s: any) => s.id).sort()).toEqual(["mine", "theirs"]);
  });

  it("reports no merge when the push landed first time", async () => {
    const ctx = loadApp();
    const out = await ctx.pushServerCopy(async () => res(200, { rev: 5, updatedAt: "t" }), { sessions: [] }, 4);
    expect(out.merged).toBe(null);
  });

  it("falls back to re-sending this payload when the 409 carries no data", async () => {
    const ctx = loadApp();
    const sent: any[] = [];
    const fetchFn = async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return body.rev === 9 ? res(200, { rev: 10, updatedAt: "t" }) : res(409, { state: { rev: 9 } });
    };
    const out = await ctx.pushServerCopy(fetchFn, { sessions: [{ id: "mine" }] }, 4);
    expect(out.ok).toBe(true);
    expect(out.merged).toBe(null);
    expect(sent[1].data).toEqual({ sessions: [{ id: "mine" }] });
  });
});

describe("adoptMergedCopy", () => {
  it("writes the merged records into this browser and says it gained some", () => {
    const ctx = loadApp({ "marcus.sessions": JSON.stringify([{ id: "mine" }]) });
    const gained = ctx.adoptMergedCopy({ sessions: [{ id: "mine" }, { id: "theirs" }] });
    expect(gained).toBe(true);
    expect(ctx.store.get("sessions", []).map((s: any) => s.id).sort()).toEqual(["mine", "theirs"]);
  });

  it("says it gained nothing when the merge added nothing, so nothing repaints", () => {
    const ctx = loadApp({ "marcus.sessions": JSON.stringify([{ id: "mine" }]) });
    expect(ctx.adoptMergedCopy({ sessions: [{ id: "mine" }] })).toBe(false);
  });
});

describe("adoptMergedCopy on an empty list", () => {
  it("does not call an empty list arriving where there was no key a gain", () => {
    const ctx = loadApp();
    expect(ctx.adoptMergedCopy({ goals: [] })).toBe(false);
  });
});
