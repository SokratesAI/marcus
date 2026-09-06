import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm harness as app-mealsentence.test.ts: app.js is a classic script, so
// its top-level declarations land on the context and the tests call them.
// `fetch` is injected here because askMarcus is the one function in app.js that
// reaches the network, and the point of these tests is what it does when that
// call does not come back.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Same shape as app-validation.test.ts: app.js is a classic script, so its
// top-level declarations land on the vm context and the tests call them by hand.
// `byId` is returned as well because the food picker renders into #foodPicked
// and then reads #foodAmount back, and this stub does not parse HTML — a test
// that drives the picker has to set that input's value itself.
function loadApp(opts: { now?: Date; fetch?: any } = {}): { ctx: any; toasts: string[]; byId: Record<string, any>; stored: Record<string, string> } {
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
    fetch: opts.fetch,
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
      "\n;Object.defineProperty(globalThis, 'recentMealCache', { get: () => recentMealCache });" +
      // `mealParse` is lexical too, and these tests drive the add/drop handlers
      // that read and write it, so it needs a setter as well as a getter.
      "\n;Object.defineProperty(globalThis, 'mealParse', { get: () => mealParse, set: (v) => { mealParse = v; } });",
    ctx,
  );
  return { ctx, toasts, byId, stored };
}


const CHAT = [
  { role: "user", text: "hey" },
  { role: "marcus", text: "hey yourself" },
  { role: "user", text: "what should I do today?" },
];

function seed(ctx: any) {
  ctx.store.set("chat", CHAT);
  ctx.store.set("sessions", [{ date: "2026-09-04", kind: "strength" }]);
}

describe("askMarcus", () => {
  it("sends the training data and the earlier turns, but not the message twice", async () => {
    let sent: any;
    const { ctx } = loadApp({
      fetch: async (_url: string, init: any) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ reply: "Squats. Go." }) };
      },
    });
    seed(ctx);
    expect(await ctx.askMarcus("what should I do today?")).toBe("Squats. Go.");
    expect(sent.message).toBe("what should I do today?");
    expect(sent.context.sessions).toEqual([{ date: "2026-09-04", kind: "strength" }]);
    expect(sent.history).toEqual([
      { role: "user", text: "hey" },
      { role: "marcus", text: "hey yourself" },
    ]);
  });

  it("falls back to the built-in reply when the coach is not configured", async () => {
    const { ctx } = loadApp({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    seed(ctx);
    const reply = await ctx.askMarcus("what is my plan today?");
    expect(reply).toBe(ctx.marcusReply("what is my plan today?"));
  });

  it("falls back when the network throws, which is the phone being offline", async () => {
    const { ctx } = loadApp({
      fetch: async () => {
        throw new Error("Failed to fetch");
      },
    });
    seed(ctx);
    const reply = await ctx.askMarcus("what is my plan today?");
    expect(reply).toBe(ctx.marcusReply("what is my plan today?"));
  });

  it("falls back on a 200 carrying an empty reply rather than showing a blank bubble", async () => {
    const { ctx } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: "   " }) }),
    });
    seed(ctx);
    const reply = await ctx.askMarcus("what is my plan today?");
    expect(reply).toBe(ctx.marcusReply("what is my plan today?"));
  });

  it("reaches nothing at all when fetch is absent, and still answers", async () => {
    const { ctx } = loadApp();
    seed(ctx);
    const reply = await ctx.askMarcus("what is my plan today?");
    expect(reply).toBe(ctx.marcusReply("what is my plan today?"));
  });
});
