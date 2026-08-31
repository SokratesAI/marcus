import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const INDEX_SOURCE = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const CSS_SOURCE = readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

// The same shape app-validation.test.ts uses: app.js is a classic script, so its
// top-level function declarations land on the vm context and the tests call them
// directly. navigator stays `{}` so the boot block's registration never runs --
// what is under test is the two functions it would call, driven by hand.
function loadApp(): any {
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
  const stored: Record<string, string> = {};
  const document: any = {
    body: makeNode(),
    getElementById(id: string) {
      return (byId[id] ??= makeNode());
    },
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, Date, JSON, Number, String, Array,
    Object, Promise, document, navigator: {},
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

function stubSw(controller: unknown) {
  const handlers: Record<string, () => void> = {};
  return {
    controller,
    addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; },
    fire: (name: string) => handlers[name]?.(),
    has: (name: string) => name in handlers,
  };
}

describe("watchForUpdate", () => {
  it("announces an update when a new worker takes over a page that already had one", () => {
    const ctx = loadApp();
    const sw = stubSw({ scriptURL: "sw.js" });
    let announced = 0;
    ctx.watchForUpdate(sw, () => { announced += 1; });
    sw.fire("controllerchange");
    expect(announced).toBe(1);
  });

  it("stays quiet on a first visit, where the very first worker claims the page", () => {
    const ctx = loadApp();
    const sw = stubSw(null);
    let announced = 0;
    ctx.watchForUpdate(sw, () => { announced += 1; });
    sw.fire("controllerchange");
    expect(announced).toBe(0);
  });

  it("announces every later takeover in a session that started with no controller", () => {
    const ctx = loadApp();
    const sw = stubSw(null);
    let announced = 0;
    ctx.watchForUpdate(sw, () => { announced += 1; });
    sw.fire("controllerchange"); // the very first worker claiming the page
    sw.fire("controllerchange"); // a real deploy, same sitting
    sw.fire("controllerchange");
    expect(announced).toBe(2);
  });

  it("does nothing at all when the browser has no service worker support", () => {
    const ctx = loadApp();
    let announced = 0;
    const bump = () => { announced += 1; };
    expect(() => ctx.watchForUpdate(undefined, bump)).not.toThrow();
    expect(() => ctx.watchForUpdate({}, bump)).not.toThrow();
    expect(() => ctx.watchForUpdate({ controller: {} }, bump)).not.toThrow();
    expect(announced).toBe(0);
  });
});

describe("recheckOnVisible", () => {
  const fakeDoc = () => {
    const handlers: Record<string, () => void> = {};
    return {
      visibilityState: "hidden",
      addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; },
      fire: (name: string) => handlers[name]?.(),
    };
  };

  it("asks the browser to re-check sw.js each time the app comes to the foreground", () => {
    const ctx = loadApp();
    const doc = fakeDoc();
    let updates = 0;
    ctx.recheckOnVisible(doc, { update: () => { updates += 1; return Promise.resolve(); } });
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    doc.fire("visibilitychange");
    expect(updates).toBe(2);
  });

  it("does not re-check when the app is going into the background", () => {
    const ctx = loadApp();
    const doc = fakeDoc();
    let updates = 0;
    ctx.recheckOnVisible(doc, { update: () => { updates += 1; return Promise.resolve(); } });
    doc.fire("visibilitychange");
    expect(updates).toBe(0);
  });

  it("survives a registration whose update() throws or rejects", () => {
    const ctx = loadApp();
    const doc = fakeDoc();
    doc.visibilityState = "visible";
    ctx.recheckOnVisible(doc, { update: () => { throw new Error("no"); } });
    expect(() => doc.fire("visibilitychange")).not.toThrow();

    const doc2 = fakeDoc();
    doc2.visibilityState = "visible";
    ctx.recheckOnVisible(doc2, { update: () => Promise.reject(new Error("no")) });
    expect(() => doc2.fire("visibilitychange")).not.toThrow();
  });
});

describe("the banner itself", () => {
  it("is hidden until showUpdateBanner reveals it", () => {
    const ctx = loadApp();
    const host = ctx.document.getElementById("updateBanner");
    host.hidden = true;
    ctx.showUpdateBanner();
    expect(host.hidden).toBe(false);
  });

  it("ships in the page with a reload control, hidden by default", () => {
    expect(INDEX_SOURCE).toContain('id="updateBanner"');
    expect(INDEX_SOURCE).toMatch(/id="updateBanner"[^>]*\shidden>/);
    expect(INDEX_SOURCE).toContain('id="updateReload"');
    expect(CSS_SOURCE).toContain(".update-banner[hidden]{display:none;}");
  });
});
