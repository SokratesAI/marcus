import { APP_SOURCE } from "./app-source.js";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same small harness as app-servercopy.test.ts: everything under test is a
// `function` declaration, so it lands on the context's global object on its
// own, and every one of them takes its browser objects as an argument rather
// than reaching for a global -- which is the whole reason they can be tested
// without a DOM at all.
function loadApp(): any {
  const node: any = {
    value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    content: { firstElementChild: { cloneNode: () => node }, cloneNode: () => node },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => node, querySelectorAll: () => [], getContext: () => ({}),
  };
  const stored: Record<string, string> = {};
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isNaN,
    Uint8Array, Error, Promise, atob,
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
  vm.runInContext(APP_SOURCE, ctx);
  return ctx;
}

// A browser's `atob` throws on the base64url alphabet -- `-` and `_` are not in
// base64 -- and Node's Buffer decoder quietly accepts both. Standing in the
// permissive one makes a missing url-to-standard conversion pass every test,
// which is exactly the bug it would be hiding, so this stub is as strict as
// the real thing.
function atob(input: string): string {
  if (/[^A-Za-z0-9+/=]/.test(input)) throw new Error("InvalidCharacterError");
  return Buffer.from(input, "base64").toString("binary");
}

const res = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// A real uncompressed P-256 point: 0x04 then two 32-byte coordinates, in the
// base64url form `/api/push/key` serves.
const REAL_KEY = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString("base64url");

function fakeSubscription(over: Record<string, unknown> = {}) {
  const calls = { unsubscribed: 0 };
  const sub: any = {
    calls,
    toJSON: () => ({
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: "x".repeat(87), auth: "y".repeat(22) },
    }),
    async unsubscribe() { calls.unsubscribed += 1; return true; },
    ...over,
  };
  return sub;
}

function fakeRegistration(sub: any, opts: { existing?: any; subscribeThrows?: boolean } = {}) {
  const seen: any[] = [];
  return {
    seen,
    pushManager: {
      async getSubscription() { return opts.existing ?? null; },
      async subscribe(options: any) {
        if (opts.subscribeThrows) throw new Error("denied");
        seen.push(options);
        return sub;
      },
    },
  };
}

describe("pushSupported", () => {
  it("is false in a Safari tab on iOS, where the service worker exists and push does not", () => {
    const app = loadApp();
    expect(app.pushSupported({ serviceWorker: {} }, {})).toBe(false);
  });

  it("is true only when all three capabilities are present", () => {
    const app = loadApp();
    expect(app.pushSupported({ serviceWorker: {} }, { PushManager: {}, Notification: {} })).toBe(true);
    expect(app.pushSupported({}, { PushManager: {}, Notification: {} })).toBe(false);
    expect(app.pushSupported({ serviceWorker: {} }, { PushManager: {} })).toBe(false);
  });
});

describe("describeReminders", () => {
  it("tells an iPhone user what to actually do when push is unsupported", () => {
    expect(loadApp().describeReminders({ state: "unsupported" })).toMatch(/Home Screen/);
  });

  it("says a blocked permission cannot be asked for again from here", () => {
    // The failure this line exists for: a user tapping the button forever
    // because nothing said the phone had already answered no.
    const out = loadApp().describeReminders({ state: "blocked" });
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/Settings/);
  });

  it("separates on, off and not-yet-checked", () => {
    const app = loadApp();
    expect(app.describeReminders({ state: "on" })).toMatch(/on for this device/);
    expect(app.describeReminders({ state: "off" })).toMatch(/will not send/);
    expect(app.describeReminders({ state: "unknown" })).toMatch(/checking/);
    expect(app.describeReminders(null)).toMatch(/checking/);
  });
});

describe("applicationServerKey", () => {
  it("decodes the base64url the server serves into 65 raw bytes starting 0x04", () => {
    const bytes = loadApp().applicationServerKey(REAL_KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(bytes[64]).toBe(7);
  });

  it("handles the base64url alphabet, which atob alone does not", () => {
    // Bytes chosen so the standard-alphabet encoding contains both + and /,
    // which is exactly the pair base64url replaces. A conversion that forgot
    // this passes every test built on a key that happens to avoid them.
    const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 251) % 256))]);
    const standard = raw.toString("base64");
    expect(standard).toMatch(/[+/]/);
    const bytes = loadApp().applicationServerKey(raw.toString("base64url"));
    expect(Buffer.from(bytes).equals(raw)).toBe(true);
  });

  it("refuses a key that is not a P-256 point rather than handing it to subscribe()", () => {
    const app = loadApp();
    expect(() => app.applicationServerKey("")).toThrow(/missing/);
    expect(() => app.applicationServerKey(Buffer.alloc(65, 1).toString("base64url"))).toThrow(/P-256/);
    expect(() => app.applicationServerKey(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32)]).toString("base64url"))).toThrow(/P-256/);
  });
});

describe("subscriptionBody", () => {
  it("builds exactly what the server's validateSubscription accepts", () => {
    const body = loadApp().subscriptionBody(fakeSubscription());
    expect(body).toEqual({
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: "x".repeat(87), auth: "y".repeat(22) },
    });
  });

  it("returns null rather than a half-record when the keys are missing", () => {
    const app = loadApp();
    expect(app.subscriptionBody(fakeSubscription({ toJSON: () => ({ endpoint: "https://a/b" }) }))).toBe(null);
    expect(app.subscriptionBody(fakeSubscription({ toJSON: () => ({ keys: { p256dh: "a", auth: "b" } }) }))).toBe(null);
    expect(app.subscriptionBody({})).toBe(null);
  });
});

describe("enableReminders", () => {
  it("asks for permission before it touches the network", async () => {
    // On iOS the prompt is only allowed while the tap is still the current user
    // activation, and an awaited fetch spends it -- so fetching the key first
    // makes the prompt never appear on the one platform this feature is for.
    const order: string[] = [];
    const sub = fakeSubscription();
    const app = loadApp();
    const out = await app.enableReminders({
      notification: { permission: "default", async requestPermission() { order.push("permission"); return "granted"; } },
      registration: fakeRegistration(sub),
      fetchFn: async (url: string) => { order.push(`fetch ${url}`); return url === "/api/push/key" ? res(200, { key: REAL_KEY }) : res(201, {}); },
    });
    expect(out.ok).toBe(true);
    expect(out.state).toBe("on");
    expect(order[0]).toBe("permission");
  });

  it("subscribes with userVisibleOnly and the decoded key", async () => {
    const sub = fakeSubscription();
    const reg = fakeRegistration(sub);
    const app = loadApp();
    await app.enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: reg,
      fetchFn: async (url: string) => (url === "/api/push/key" ? res(200, { key: REAL_KEY }) : res(201, {})),
    });
    expect(reg.seen[0].userVisibleOnly).toBe(true);
    expect(reg.seen[0].applicationServerKey.length).toBe(65);
  });

  it("posts the subscription to the server", async () => {
    const posted: any[] = [];
    const app = loadApp();
    await app.enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: fakeRegistration(fakeSubscription()),
      fetchFn: async (url: string, init?: any) => {
        if (url === "/api/push/key") return res(200, { key: REAL_KEY });
        posted.push({ url, init });
        return res(201, {});
      },
    });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/push/subscribe");
    expect(posted[0].init.method).toBe("POST");
    expect(JSON.parse(posted[0].init.body).endpoint).toBe("https://web.push.apple.com/abc");
  });

  it("reports a denied permission as blocked, not as a plain failure", async () => {
    const app = loadApp();
    const out = await app.enableReminders({
      notification: { async requestPermission() { return "denied"; } },
      registration: fakeRegistration(fakeSubscription()),
      fetchFn: async () => { throw new Error("must not be called"); },
    });
    expect(out.state).toBe("blocked");
    expect(out.ok).toBe(false);
  });

  it("does not subscribe at all when permission is dismissed", async () => {
    const reg = fakeRegistration(fakeSubscription());
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "default"; } },
      registration: reg,
      fetchFn: async () => { throw new Error("must not be called"); },
    });
    expect(out.state).toBe("off");
    expect(reg.seen).toHaveLength(0);
  });

  it("unsubscribes again when the server refuses to store the device", async () => {
    // Otherwise the browser is subscribed to a push service Marcus has no
    // record of: the button reads "on", nothing will ever be sent to it, and
    // neither side says so.
    const sub = fakeSubscription();
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: fakeRegistration(sub),
      fetchFn: async (url: string) => (url === "/api/push/key" ? res(200, { key: REAL_KEY }) : res(400, {})),
    });
    expect(out.ok).toBe(false);
    expect(out.state).toBe("off");
    expect(sub.calls.unsubscribed).toBe(1);
  });

  it("unsubscribes again when the server cannot be reached at all", async () => {
    const sub = fakeSubscription();
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: fakeRegistration(sub),
      fetchFn: async (url: string) => {
        if (url === "/api/push/key") return res(200, { key: REAL_KEY });
        throw new Error("offline");
      },
    });
    expect(out.state).toBe("off");
    expect(sub.calls.unsubscribed).toBe(1);
  });

  it("says the list is full when the server answers 507", async () => {
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: fakeRegistration(fakeSubscription()),
      fetchFn: async (url: string) => (url === "/api/push/key" ? res(200, { key: REAL_KEY }) : res(507, {})),
    });
    expect(out.message).toMatch(/as many devices/);
  });

  it("does not subscribe when the key does not arrive", async () => {
    const reg = fakeRegistration(fakeSubscription());
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: reg,
      fetchFn: async () => res(500, {}),
    });
    expect(out.state).toBe("off");
    expect(out.message).toMatch(/Nothing has changed/);
    expect(reg.seen).toHaveLength(0);
  });

  it("stays off when the browser itself refuses to subscribe", async () => {
    const out = await loadApp().enableReminders({
      notification: { async requestPermission() { return "granted"; } },
      registration: fakeRegistration(fakeSubscription(), { subscribeThrows: true }),
      fetchFn: async () => res(200, { key: REAL_KEY }),
    });
    expect(out.ok).toBe(false);
    expect(out.state).toBe("off");
  });
});

describe("disableReminders", () => {
  it("tells the server before it throws away the endpoint", async () => {
    // This browser holds the only copy of the endpoint. Unsubscribing first and
    // then failing to reach the server leaves a row nothing can ever name.
    const order: string[] = [];
    const sub = fakeSubscription({
      async unsubscribe() { order.push("unsubscribe"); return true; },
    });
    const out = await loadApp().disableReminders({
      registration: fakeRegistration(sub, { existing: sub }),
      fetchFn: async (url: string, init?: any) => { order.push(`${init.method} ${url}`); return res(200, {}); },
    });
    expect(order).toEqual(["DELETE /api/push/subscribe", "unsubscribe"]);
    expect(out.state).toBe("off");
  });

  it("still unsubscribes when the server cannot be reached", async () => {
    // A push service that keeps buzzing a phone the user just turned off is
    // worse than a stale row on the server.
    const sub = fakeSubscription();
    const out = await loadApp().disableReminders({
      registration: fakeRegistration(sub, { existing: sub }),
      fetchFn: async () => { throw new Error("offline"); },
    });
    expect(sub.calls.unsubscribed).toBe(1);
    expect(out.ok).toBe(true);
  });

  it("is a no-op when this browser was never subscribed", async () => {
    let called = false;
    const out = await loadApp().disableReminders({
      registration: fakeRegistration(fakeSubscription()),
      fetchFn: async () => { called = true; return res(200, {}); },
    });
    expect(called).toBe(false);
    expect(out.state).toBe("off");
  });
});

describe("readReminderState", () => {
  it("reports blocked from the permission alone, without asking the push manager", async () => {
    let asked = false;
    const out = await loadApp().readReminderState({
      notification: { permission: "denied" },
      registration: { pushManager: { async getSubscription() { asked = true; return null; } } },
    });
    expect(out.state).toBe("blocked");
    expect(asked).toBe(false);
  });

  it("separates a granted permission with no subscription from a live one", async () => {
    const app = loadApp();
    const sub = fakeSubscription();
    expect((await app.readReminderState({
      notification: { permission: "granted" },
      registration: fakeRegistration(sub, { existing: sub }),
    })).state).toBe("on");
    // Cleared site data leaves the permission granted and the subscription gone.
    expect((await app.readReminderState({
      notification: { permission: "granted" },
      registration: fakeRegistration(sub),
    })).state).toBe("off");
  });

  it("is unsupported when there is nothing to ask", async () => {
    expect((await loadApp().readReminderState({})).state).toBe("unsupported");
  });
});

// Edvard's report, 2026-09-08: the card said "on for this device" and the
// server's list was empty, so the 20:00 job had nobody to send to and the test
// button answered 404. `getSubscription` alone could never have caught that --
// the browser's answer was correct and it was not the whole state.
describe("readReminderState against the server's own list", () => {
  const granted = { permission: "granted" };

  function deps(sub: any, fetchFn: any) {
    return { notification: granted, registration: fakeRegistration(sub, { existing: sub }), fetchFn };
  }

  it("asks the server about this endpoint, by endpoint and not by count", async () => {
    const sub = fakeSubscription();
    const seen: any[] = [];
    await loadApp().readReminderState(deps(sub, async (url: string, init?: any) => {
      seen.push({ url, init });
      return res(200, { known: true });
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/push/status");
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(seen[0].init.body).endpoint).toBe("https://web.push.apple.com/abc");
  });

  it("re-registers this device when the server has no record of it, and reads on again", async () => {
    const sub = fakeSubscription();
    const urls: string[] = [];
    const out = await loadApp().readReminderState(deps(sub, async (url: string, init?: any) => {
      urls.push(url);
      if (url === "/api/push/status") return res(200, { known: false });
      return res(201, { subscribed: true });
    }));
    expect(urls).toEqual(["/api/push/status", "/api/push/subscribe"]);
    // The whole record goes back, not just the endpoint -- the server cannot
    // encrypt to a device whose keys it does not hold.
    expect(out.state).toBe("on");
  });

  it("posts the keys back, not just the endpoint, when it repairs", async () => {
    const sub = fakeSubscription();
    let body: any = null;
    await loadApp().readReminderState(deps(sub, async (url: string, init?: any) => {
      if (url === "/api/push/status") return res(200, { known: false });
      body = JSON.parse(init.body);
      return res(201, {});
    }));
    expect(body.endpoint).toBe("https://web.push.apple.com/abc");
    expect(body.keys.p256dh).toBe("x".repeat(87));
    expect(body.keys.auth).toBe("y".repeat(22));
  });

  it("reads off when the repair itself is refused", async () => {
    // Nothing will ever be delivered to this phone, so "on" would be the same
    // lie the card was already telling.
    const sub = fakeSubscription();
    const out = await loadApp().readReminderState(deps(sub, async (url: string) =>
      url === "/api/push/status" ? res(200, { known: false }) : res(507, { error: "full" })));
    expect(out.state).toBe("off");
  });

  it("reads off when the repair cannot be sent at all", async () => {
    const sub = fakeSubscription();
    const out = await loadApp().readReminderState(deps(sub, async (url: string) => {
      if (url === "/api/push/status") return res(200, { known: false });
      throw new Error("offline mid-repair");
    }));
    expect(out.state).toBe("off");
  });

  it("stays on when the server cannot be reached, and does not try to repair", async () => {
    // An offline app-open says nothing about this subscription. Flipping the
    // card to off there is the same defect pointing the other way.
    const sub = fakeSubscription();
    const urls: string[] = [];
    const out = await loadApp().readReminderState(deps(sub, async (url: string) => {
      urls.push(url);
      throw new Error("offline");
    }));
    expect(out.state).toBe("on");
    expect(urls).toEqual(["/api/push/status"]);
  });

  it("stays on when the store is unreadable, rather than re-registering over a 500", async () => {
    const sub = fakeSubscription();
    const urls: string[] = [];
    const out = await loadApp().readReminderState(deps(sub, async (url: string) => {
      urls.push(url);
      return res(500, { error: "could not read the subscriptions" });
    }));
    expect(out.state).toBe("on");
    expect(urls).toEqual(["/api/push/status"]);
  });

  it("never asks the server when this browser has no subscription to ask about", async () => {
    const urls: string[] = [];
    const out = await loadApp().readReminderState({
      notification: granted,
      registration: fakeRegistration(fakeSubscription()),
      fetchFn: async (url: string) => { urls.push(url); return res(200, { known: false }); },
    });
    expect(out.state).toBe("off");
    expect(urls).toEqual([]);
  });
});

describe("the reminders card", () => {
  it("is in the markup the Progress tab renders, with the status line and the button", () => {
    expect(APP_SOURCE).toMatch(/id="reminderStatus"/);
    expect(APP_SOURCE).toMatch(/id="toggleReminders"/);
    // Without this call the card draws and nothing is ever attached to it,
    // which is the failure the whole browser half exists to end.
    expect(APP_SOURCE).toMatch(/wireReminders\(\);/);
  });
});

// Issue #154: the button that proves the chain, rather than waiting for 20:00.
describe("sendTestReminder", () => {
  const deps = (sub: any, fetchFn: any) => ({ registration: fakeRegistration(null, { existing: sub }), fetchFn });

  it("asks the server to buzz this device, naming its own endpoint", async () => {
    const app = loadApp();
    const seen: any[] = [];
    const fetchFn = async (url: string, init: any) => { seen.push({ url, init }); return res(200, { sent: true }); };
    const out = await app.sendTestReminder(deps(fakeSubscription(), fetchFn));
    expect(out.ok).toBe(true);
    expect(out.state).toBe("on");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/push/test");
    expect(JSON.parse(seen[0].init.body)).toEqual({ endpoint: "https://web.push.apple.com/abc" });
  });

  it("says so and asks nothing when this device is not subscribed", async () => {
    const app = loadApp();
    let asked = 0;
    const fetchFn = async () => { asked += 1; return res(200, {}); };
    const out = await app.sendTestReminder(deps(null, fetchFn));
    expect(out.ok).toBe(false);
    expect(out.state).toBe("off");
    expect(out.message).toMatch(/not subscribed/);
    expect(asked).toBe(0);
  });

  it("turns the card off when the push service has retired this subscription", async () => {
    // 410 is the one failure that changes what this device is. The card has to
    // stop reading "on", or the next tap tries the same dead endpoint forever.
    const app = loadApp();
    const out = await app.sendTestReminder(deps(fakeSubscription(), async () => res(410, {})));
    expect(out.ok).toBe(false);
    expect(out.state).toBe("off");
    expect(out.message).toMatch(/expired/);
  });

  it("turns the card off when Marcus has no record of this device", async () => {
    const app = loadApp();
    const out = await app.sendTestReminder(deps(fakeSubscription(), async () => res(404, {})));
    expect(out.state).toBe("off");
  });

  it("leaves the card on when only the send failed", async () => {
    // A push service having a bad minute, or a second tap while the first is
    // still going. Reminders are still on and the card must not claim
    // otherwise.
    const app = loadApp();
    for (const status of [409, 502, 500]) {
      const out = await app.sendTestReminder(deps(fakeSubscription(), async () => res(status, {})));
      expect(out.ok).toBe(false);
      expect(out.state).toBe("on");
    }
  });

  it("leaves the card on when the server could not be reached at all", async () => {
    const app = loadApp();
    const out = await app.sendTestReminder(deps(fakeSubscription(), async () => { throw new Error("offline"); }));
    expect(out.ok).toBe(false);
    expect(out.state).toBe("on");
  });

  it("never unsubscribes this device, whatever the answer was", async () => {
    // enableReminders rolls back by unsubscribing; this must not, or a failed
    // test would turn off the reminders it was sent to check.
    const app = loadApp();
    for (const status of [200, 404, 410, 502]) {
      const sub = fakeSubscription();
      await app.sendTestReminder(deps(sub, async () => res(status, {})));
      expect(sub.calls.unsubscribed).toBe(0);
    }
  });
});

describe("renderReminders and the test button", () => {
  it("offers the test only when reminders are actually on", () => {
    const app = loadApp();
    const btn: any = { hidden: false, disabled: false, innerHTML: "" };
    const toggle: any = { hidden: false, disabled: false, innerHTML: "" };
    app.document.getElementById = (id: string) => (id === "testReminder" ? btn : toggle);
    app.renderReminders({ state: "on" });
    expect(btn.hidden).toBe(false);
    for (const state of ["off", "blocked", "unsupported", "unknown"]) {
      app.renderReminders({ state });
      expect(btn.hidden).toBe(true);
    }
  });
});
