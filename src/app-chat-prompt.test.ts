import { APP_SOURCE, appFile } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209, the reachability half. Seven cycles have hardened what happens
// once a goal card is on screen; none has asked how Edvard gets one. The
// answer is a Home card that says "say it in your own words -- 'Olympic
// triathlon next August' is enough" above a **Tell Marcus** button -- and the
// chat sheet that button opens covers the card, so by the time he can type,
// the sentence telling him what to type is gone and the box asks
// "Message Marcus…". His live state has held no `goals` key since 2026-09-07
// while holding 21 chat messages, so the chat is the route he actually uses.
//
// Same vm harness as app-home-nogoal.test.ts. `focus` is on the stub because
// openChat() calls it and the harness node does not carry one by default.
function loadApp(): any {
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    placeholder: "Message Marcus…",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {}, focus() {},
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
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const run = (app: any, src: string) => vm.runInContext(src, app);
const placeholder = (app: any) => run(app, "document.getElementById('chatInput').placeholder") as string;

describe("the chat composer asks for what the button promised", () => {
  it("asks what he is training for when the goal card opened it", () => {
    const app = loadApp();
    run(app, "openChat('goal')");
    expect(placeholder(app)).toContain("What are you training for?");
    // The example is the part that was being lost behind the sheet, so it has
    // to survive into the box rather than only naming the topic.
    expect(placeholder(app)).toContain("Olympic triathlon next August");
    expect(run(app, "chatSheet.hidden")).toBe(false);
  });

  it("is the plain prompt when the chat FAB opened it", () => {
    const app = loadApp();
    // The FAB is wired as `addEventListener('click', openChat)`, so the first
    // argument at runtime is a click Event, never a topic. A hint keyed off a
    // truthy argument would fire on every FAB tap.
    run(app, "openChat({ type: 'click', target: null })");
    expect(placeholder(app)).toBe("Message Marcus…");
  });

  it("does not leave a hint behind for the next open", () => {
    // Both entry points write the same element, so a hint that is only ever
    // set -- never cleared -- turns one tap on the goal card into a chat box
    // that asks about goals forever.
    const app = loadApp();
    run(app, "openChat('goal')");
    expect(placeholder(app)).toContain("What are you training for?");
    run(app, "closeChat()");
    run(app, "openChat()");
    expect(placeholder(app)).toBe("Message Marcus…");
  });

  it("falls back rather than printing an unknown topic into the box", () => {
    const app = loadApp();
    run(app, "openChat('nutrition')");
    expect(placeholder(app)).toBe("Message Marcus…");
  });

  it("keeps its default equal to the one index.html ships", () => {
    // Two copies of the same string: the attribute the page loads with, and
    // the value openChat() restores. If they drift, the box silently changes
    // wording the first time the sheet is opened.
    const app = loadApp();
    const html = appFile("index.html");
    const attr = /id="chatInput"[^>]*placeholder="([^"]*)"/.exec(html);
    expect(attr).not.toBeNull();
    expect(run(app, "CHAT_PROMPT_DEFAULT")).toBe(attr![1]);
  });

  it("is what both Home goal cards actually call", () => {
    const app = loadApp();
    // No goal at all.
    run(app, `store.set('goals', [])`);
    run(app, "renderHome()");
    expect(run(app, "view.innerHTML")).toContain(`onclick="openChat('goal')"`);
    // And the card for a goal whose day has gone, which asks the same question.
    run(app, `store.set('goals', [{ id: 'a', text: 'Oslo Triathlon', targetDate: '2020-08-14', created: '2020-01-01', milestones: [] }])`);
    run(app, "renderHome()");
    expect(run(app, "view.innerHTML")).toContain(`onclick="openChat('goal')"`);
  });
});
