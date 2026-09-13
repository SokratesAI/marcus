import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209, the half that makes any of it reach him. The 20:00 job composes a
// real message every evening and sends it to nobody: no device has ever
// subscribed, and the only place to subscribe is a card at the bottom of the
// Progress tab, under two charts. Home is the tab the app opens on, so this is
// the same gate the goal prompt was behind before cycle 1512 -- the offer lives
// on a tab he does not go to.
//
// Same vm harness as app-home-nogoal.test.ts: app.js is a classic script, so its
// top-level declarations live in the realm and a second script run in the same
// context can read and assign them, even though they are not on the context
// object itself.
function loadApp(overrides: Record<string, any> = {}): any {
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
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    // app.js registers the service worker off a `load` listener on window.
    // A browser with `navigator.serviceWorker` takes that branch, and the base
    // harness never did.
    addEventListener() {},
  };
  Object.assign(ctx, overrides);
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.nodes = nodes;
  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

const loadAppWith = (overrides: Record<string, any>) => loadApp(overrides);

const run = (app: any, src: string) => vm.runInContext(src, app);
const homeWith = (app: any, state: string) => {
  run(app, `reminderState = { state: ${JSON.stringify(state)} }`);
  run(app, "renderHome()");
  return run(app, "view.innerHTML") as string;
};

describe("Home offers the evening reminder", () => {
  it("asks on a browser that could receive them and has not subscribed", () => {
    const app = loadApp();
    const html = homeWith(app, "off");
    expect(html).toContain("Marcus cannot reach you");
    expect(html).toContain("Turn on reminders");
    // The button has to be the one that actually subscribes, not a jump to the
    // tab the offer exists to save him finding.
    expect(html).toContain('onclick="enableRemindersFromHome()"');
  });

  it("says nothing once this device is subscribed", () => {
    const app = loadApp();
    expect(homeWith(app, "on")).not.toContain("Marcus cannot reach you");
  });

  it("says nothing before the first read has come back", () => {
    // 'unknown' is the state at boot, for the fraction of a second before
    // serviceWorker.ready resolves. Drawing the card then and pulling it away
    // is worse than drawing it a moment late.
    const app = loadApp();
    expect(homeWith(app, "unknown")).not.toContain("Marcus cannot reach you");
  });

  it("says nothing when the button could not work", () => {
    // A Safari tab on iOS has no PushManager, and a denied permission can never
    // be re-requested from script. Both need an explanation rather than a
    // button, and the Progress card is where that explanation already is.
    const app = loadApp();
    expect(homeWith(app, "unsupported")).not.toContain("Marcus cannot reach you");
    expect(homeWith(app, "blocked")).not.toContain("Marcus cannot reach you");
  });

  it("reads the live state rather than the last thing a tap tried to do", () => {
    // Home and the Progress card are drawn from one variable, and only
    // renderReminders writes it. Turning them on from Progress must therefore
    // take the offer off Home without Home being told anything.
    const app = loadApp();
    expect(homeWith(app, "off")).toContain("Marcus cannot reach you");
    run(app, "renderReminders({ state: 'on' })");
    run(app, "renderHome()");
    expect(run(app, "view.innerHTML") as string).not.toContain("Marcus cannot reach you");
  });

  it("keeps the rest of Home intact", () => {
    // The card is inserted mid-template. A stray backtick would silently eat
    // everything after it, and the nutrition section is what comes next.
    const app = loadApp();
    const html = homeWith(app, "off");
    expect(html).toContain("Today's nutrition");
    expect(html).toContain("kcal logged");
  });
});

describe("homeOffersReminders", () => {
  it("is a definite no, not the absence of a yes", () => {
    const app = loadApp();
    const ask = (s: unknown) => run(app, `homeOffersReminders(${JSON.stringify(s)})`);
    expect(ask({ state: "off" })).toBe(true);
    expect(ask({ state: "on" })).toBe(false);
    expect(ask({ state: "unknown" })).toBe(false);
    expect(ask({ state: "unsupported" })).toBe(false);
    expect(ask({ state: "blocked" })).toBe(false);
    expect(ask(null)).toBe(false);
    expect(ask({})).toBe(false);
  });
});

describe("the state is read at boot, not only when Progress is drawn", () => {
  it("puts the offer on Home in a push-capable browser nobody has subscribed", async () => {
    const statusCalls: string[] = [];
    const ctx = loadAppWith({
      navigator: {
        serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) },
      },
      PushManager: function () {},
      Notification: { permission: "default" },
      fetch: async (url: string) => { statusCalls.push(url); return { ok: true, json: async () => ({}) }; },
    });
    // Boot fires the read without awaiting it; drain the microtasks it queued.
    await new Promise((r) => setTimeout(r, 0));
    expect(run(ctx, "reminderState.state")).toBe("off");
    // Read straight off the page with no render call of our own: boot painted
    // Home while the state was still 'unknown', so the card being there now is
    // the repaint as well as the read.
    expect(run(ctx, "view.innerHTML") as string).toContain("Marcus cannot reach you");
    // No subscription, so it never got as far as asking the server whether
    // this device is on its list. (Boot's own /api/state read is in here too.)
    expect(statusCalls).not.toContain("/api/push/status");
  });

  it("does not offer when that same browser is already subscribed and known", async () => {
    const ctx = loadAppWith({
      navigator: {
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => ({
                endpoint: "https://push.example/abc",
                toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }),
              }),
            },
          }),
        },
      },
      PushManager: function () {},
      Notification: { permission: "granted" },
      fetch: async () => ({ ok: true, json: async () => ({ known: true }) }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(run(ctx, "reminderState.state")).toBe("on");
    expect(run(ctx, "view.innerHTML") as string).not.toContain("Marcus cannot reach you");
  });

  it("repaints Home only when Home is the tab being shown", () => {
    // The Progress card reads the same state, and drawing it runs the read
    // again. Repainting whatever tab is open would put Home's markup on top of
    // Progress; going through switchTab instead would re-enter renderProgress
    // and never terminate.
    const app = loadApp();
    run(app, "switchTab('progress')");
    run(app, "renderReminders({ state: 'off' })");
    run(app, "redrawHomeReminders()");
    const html = run(app, "view.innerHTML") as string;
    expect(html).toContain("Evening reminder");
    expect(html).not.toContain("Marcus cannot reach you");
  });
});
