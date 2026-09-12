import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same harness as app-backup.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
function loadApp(): { ctx: any; toasts: string[]; byId: Record<string, any> } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      style: {},
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
    Math, JSON, Number, String, Array, Object, Date,
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
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.LOGGED_STORES = LOGGED_STORES;",
    ctx,
  );
  return { ctx, toasts, byId };
}

// seed() has already run by the time loadApp returns, so every context here
// starts with the demo log a new phone actually holds -- which is the state
// this feature exists for.

describe("clearTrainingLog", () => {
  it("empties the seeded log a new browser starts with", () => {
    const { ctx } = loadApp();
    expect(ctx.store.get("sessions", []).length).toBeGreaterThan(0);
    expect(ctx.store.get("weights", []).length).toBeGreaterThan(0);
    expect(ctx.store.get("meals", []).length).toBeGreaterThan(0);

    const result = ctx.clearTrainingLog();

    expect(ctx.store.get("sessions", null)).toEqual([]);
    expect(ctx.store.get("weights", null)).toEqual([]);
    expect(ctx.store.get("meals", null)).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.cleared.map((s: any) => s.key).sort()).toEqual(["meals", "sessions", "weights"]);
  });

  it("leaves the plan and the chat alone -- neither is a record of a workout", () => {
    const { ctx } = loadApp();
    const plan = ctx.store.get("plan", null);
    const chat = ctx.store.get("chat", []);
    expect(plan).toBeTruthy();
    expect(chat.length).toBeGreaterThan(0);

    ctx.clearTrainingLog();

    expect(ctx.store.get("plan", null)).toEqual(plan);
    expect(ctx.store.get("chat", [])).toEqual(chat);
  });

  it("tombstones every cleared record that carries an id, so the other phone cannot merge it back", () => {
    const { ctx } = loadApp();
    const sessionIds = ctx.store.get("sessions", []).map((s: any) => s.id);
    const mealIds = ctx.store.get("meals", []).map((m: any) => m.id);
    expect(sessionIds.length).toBeGreaterThan(0);

    ctx.clearTrainingLog();

    const gone = ctx.store.get("deletions", []);
    sessionIds.forEach((id: string) => {
      expect(gone.some((d: any) => d.store === "sessions" && d.id === id)).toBe(true);
    });
    mealIds.forEach((id: string) => {
      expect(gone.some((d: any) => d.store === "meals" && d.id === id)).toBe(true);
    });
  });

  it("a cleared session does not come back from the server copy", () => {
    const { ctx } = loadApp();
    const sessions = ctx.store.get("sessions", []);
    ctx.clearTrainingLog();

    // The other phone still holds the whole seeded log. A merge of mine into
    // theirs has to honour the tombstones, or clearing is undone by the next sync.
    const merged = ctx.mergeBackupData(ctx.buildBackup().data, { sessions, meals: [] });
    expect(merged.sessions).toEqual([]);
  });

  it("reports nothing cleared when the log is already empty", () => {
    const { ctx } = loadApp();
    ctx.clearTrainingLog();
    const again = ctx.clearTrainingLog();
    expect(again.cleared).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it("counts only the stores that actually hold something", () => {
    const { ctx } = loadApp();
    const rows = ctx.clearableSummary();
    expect(rows.map((r: any) => r.key).sort()).toEqual(["meals", "sessions", "weights"]);
    rows.forEach((r: any) => expect(r.count).toBeGreaterThan(0));
    // measurements/photos/goals/plannedWeeks are in LOGGED_STORES and empty here.
    expect(ctx.LOGGED_STORES).toContain("goals");
    expect(rows.some((r: any) => r.key === "goals")).toBe(false);
  });
});

describe("the clear button", () => {
  it("does not delete anything until the second confirm", () => {
    const { ctx, byId } = loadApp();
    ctx.wireClearLog();
    const before = ctx.store.get("sessions", []).length;
    expect(before).toBeGreaterThan(0);

    byId["clearLog"].handlers.click();

    // Armed and previewing, nothing deleted.
    expect(ctx.store.get("sessions", []).length).toBe(before);
    expect(byId["clearLogPreview"].innerHTML).toContain("sessions");
    expect(byId["clearLogPreview"].innerHTML).toContain(String(before));
  });

  it("cancel leaves the log intact and closes the preview", () => {
    const { ctx, byId } = loadApp();
    ctx.wireClearLog();
    const before = ctx.store.get("sessions", []).length;
    byId["clearLog"].handlers.click();
    byId["cancelClearLog"].handlers.click();
    expect(ctx.store.get("sessions", []).length).toBe(before);
    expect(byId["clearLogPreview"].innerHTML).toBe("");
  });

  it("the second confirm clears and says how many records went", () => {
    const { ctx, byId, toasts } = loadApp();
    ctx.wireClearLog();
    const total =
      ctx.store.get("sessions", []).length +
      ctx.store.get("weights", []).length +
      ctx.store.get("meals", []).length;
    byId["clearLog"].handlers.click();
    byId["confirmClearLog"].handlers.click();

    expect(ctx.store.get("sessions", null)).toEqual([]);
    expect(toasts.join(" ")).toContain(String(total));
  });
});
