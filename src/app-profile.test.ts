import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Issue #157: the coach had nowhere to note who Edvard is. The Plan tab now
// has a box for it, it rides the same sync as everything else, and `askMarcus`
// sends it. Same vm shape as app-goal-ongoing.test.ts.
function loadApp(sent: string[]): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const nodes: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (nodes[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };
  const stored: Record<string, string> = {};
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async (url: string, init: any) => {
      if (String(url).includes("/api/chat")) sent.push(String(init && init.body));
      return { ok: true, json: async () => ({ reply: "ok" }) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.profileText = profileText;globalThis.saveProfile = saveProfile;" +
      "globalThis.askMarcus = askMarcus;globalThis.mergeBackupData = mergeBackupData;" +
      "globalThis.buildBackup = buildBackup;globalThis.store = store;",
    ctx,
  );
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);

describe("what Marcus is told about Edvard", () => {
  it("reads back what he typed, and trims it", () => {
    const app = loadApp([]);
    expect(run(app, "profileText()")).toBe("");
    run(app, "saveProfile('  Born 1994, semi-active.  ', '2026-09-13T06:00:00Z')");
    expect(run(app, "profileText()")).toBe("Born 1994, semi-active.");
    expect(run(app, "store.get('profile').updatedAt")).toBe(Date.parse("2026-09-13T06:00:00Z"));
  });

  it("still reads a profile an older browser stored as a bare string", () => {
    const app = loadApp([]);
    run(app, "store.set('profile', 'plain text from before the stamp')");
    expect(run(app, "profileText()")).toBe("plain text from before the stamp");
  });

  it("goes to the coach with the message, as text and not as the stamped record", async () => {
    const sent: string[] = [];
    const app = loadApp(sent);
    run(app, "saveProfile('Covid in 2020, endurance never came back.', '2026-09-13T06:00:00Z')");
    await run(app, "askMarcus('Hva n?')");
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]);
    expect(body.context.profile).toBe("Covid in 2020, endurance never came back.");
  });

  it("is backed up and synced, so it follows him to another phone", () => {
    const app = loadApp([]);
    run(app, "saveProfile('Born 1994', '2026-09-13T06:00:00Z')");
    const backup: any = run(app, "buildBackup('2026-09-13T07:00:00Z')");
    expect(backup.data.profile.text).toBe("Born 1994");
  });

  it("merges by which phone typed last, not by which one synced last", () => {
    const app = loadApp([]);
    const mine = { profile: { text: "older", updatedAt: 100 } };
    const theirs = { profile: { text: "newer", updatedAt: 200 } };
    expect(run(app, `mergeBackupData(${JSON.stringify(mine)}, ${JSON.stringify(theirs)}).profile.text`)).toBe("newer");
    expect(run(app, `mergeBackupData(${JSON.stringify(theirs)}, ${JSON.stringify(mine)}).profile.text`)).toBe("newer");
    // Only one side has it: that side's text survives either way round.
    expect(run(app, `mergeBackupData(${JSON.stringify(mine)}, {}).profile.text`)).toBe("older");
    expect(run(app, `mergeBackupData({}, ${JSON.stringify(mine)}).profile.text`)).toBe("older");
  });
});
