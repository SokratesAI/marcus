import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// A chat thread that ends without an answer. Edvard's own thread on the server
// has been in exactly that state since 2026-09-07 22:32 Oslo: he typed 1,825
// characters of his training background and the whole reply was a preamble
// followed by `**1 tool use**`, which is the Claude CLI's marker for a turn
// that was cut off at a tool call. Nothing in the app noticed, so six days
// later the question is still unanswered and the only recovery was to type it
// all again.
//
// Same vm harness as app-goal-fromchat.test.ts: app.js is a classic script, so
// its top-level declarations land on the context and the tests call them.
function loadApp(opts: { fetch?: any } = {}): {
  ctx: any;
  byId: Record<string, any>;
} {
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
    console,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Date,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () {
      return { destroy() {} };
    },
    fetch: opts.fetch,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;", ctx);
  return { ctx, byId };
}

/** The bubble he is actually looking at, copied out of the live server state. */
const CUT_OFF =
  "Skal se om jeg har notert noe om deg fra før, så jeg ikke overskriver det jeg allerede vet.\n\n**1 tool use**";

describe("unansweredChatTurn", () => {
  it("finds his question when the coach was cut off at a tool call", () => {
    const { ctx } = loadApp();
    const out = ctx.unansweredChatTurn([
      { role: "user", text: "Bakgrunnen min er at jeg er semi-aktiv.", ts: 1 },
      { role: "marcus", text: CUT_OFF, ts: 2 },
    ]);
    expect(out).toEqual({ text: "Bakgrunnen min er at jeg er semi-aktiv.", reason: "cut off" });
  });

  it("finds his question when no reply came back at all", () => {
    const { ctx } = loadApp();
    const out = ctx.unansweredChatTurn([
      { role: "marcus", text: "Hey!", ts: 1 },
      { role: "user", text: "What should I do today?", ts: 2 },
    ]);
    expect(out).toEqual({ text: "What should I do today?", reason: "lost" });
  });

  // The whole point of the card is that it vanishes on its own. A thread that
  // was answered must not offer to ask again, or he gets a permanent button.
  it("is null once a real answer follows", () => {
    const { ctx } = loadApp();
    expect(
      ctx.unansweredChatTurn([
        { role: "user", text: "Hvordan går det?", ts: 1 },
        { role: "marcus", text: CUT_OFF, ts: 2 },
        { role: "marcus", text: "Her er planen din for i dag.", ts: 3 },
      ]),
    ).toBeNull();
  });

  it("is null for an empty thread", () => {
    const { ctx } = loadApp();
    expect(ctx.unansweredChatTurn([])).toBeNull();
    expect(ctx.unansweredChatTurn(null)).toBeNull();
  });

  // A cut-off bubble with nothing of his above it is not a question anyone can
  // re-ask. Offering to would re-send the coach's own words.
  it("is null when a cut-off bubble opens the thread", () => {
    const { ctx } = loadApp();
    expect(ctx.unansweredChatTurn([{ role: "marcus", text: CUT_OFF, ts: 1 }])).toBeNull();
  });

  // Narrow on purpose, the same way the server-side strip is: a reply that
  // discusses tool use in a sentence is a real answer.
  it("does not treat a sentence mentioning tool use as a cut-off turn", () => {
    const { ctx } = loadApp();
    expect(
      ctx.unansweredChatTurn([
        { role: "user", text: "Did you look it up?", ts: 1 },
        { role: "marcus", text: "Yes — that took **1 tool use** and here is what I found.", ts: 2 },
      ]),
    ).toBeNull();
  });
});

describe("chatBubbleText", () => {
  it("takes the marker off a stored bubble and leaves the sentence", () => {
    const { ctx } = loadApp();
    expect(ctx.chatBubbleText({ text: CUT_OFF })).toBe(
      "Skal se om jeg har notert noe om deg fra før, så jeg ikke overskriver det jeg allerede vet.",
    );
  });

  it("leaves an ordinary bubble exactly as it was", () => {
    const { ctx } = loadApp();
    expect(ctx.chatBubbleText({ text: "Bench is up 10kg.\n\nKeep going." })).toBe(
      "Bench is up 10kg.\n\nKeep going.",
    );
  });
});

describe("the card on screen", () => {
  it("draws Ask again under a cut-off thread and not under an answered one", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("chat", [
      { role: "user", text: "Bakgrunnen min er at jeg er semi-aktiv.", ts: 1 },
      { role: "marcus", text: CUT_OFF, ts: 2 },
    ]);
    ctx.renderChatMessages();
    const cut = byId["chatMessages"].innerHTML;
    expect(cut).toContain("Ask again");
    expect(cut).toContain("cut off partway");
    // The marker is a transcript artefact and must not reach the screen.
    expect(cut).not.toContain("tool use");

    ctx.store.set("chat", [
      { role: "user", text: "Hvordan går det?", ts: 1 },
      { role: "marcus", text: "Bra! Her er planen din.", ts: 2 },
    ]);
    ctx.renderChatMessages();
    expect(byId["chatMessages"].innerHTML).not.toContain("Ask again");
  });
});

describe("retryUnansweredTurn", () => {
  it("re-sends his question, stores the answer, and writes his message only once", async () => {
    const sent: any[] = [];
    const { ctx, byId } = loadApp({
      fetch: async (_url: string, init: any) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ reply: "Takk — her er planen for neste august." }) };
      },
    });
    const history = [
      { role: "user", text: "Bakgrunnen min er at jeg er semi-aktiv.", ts: 1 },
      { role: "marcus", text: CUT_OFF, ts: 2 },
    ];
    ctx.store.set("chat", history);

    await ctx.retryUnansweredTurn();
    // `retryUnansweredTurn` is fire-and-forget; wait for the fetch chain.
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("Bakgrunnen min er at jeg er semi-aktiv.");

    const chat = ctx.store.get("chat", []);
    // Three, not four: his question is already in the thread and a retry that
    // re-stored it would read as him having repeated himself.
    expect(chat).toHaveLength(3);
    expect(chat.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(chat[2]).toMatchObject({ role: "marcus", text: "Takk — her er planen for neste august." });
    expect(byId["chatMessages"].innerHTML).not.toContain("Ask again");
  });

  it("does nothing when the thread was already answered", async () => {
    const sent: any[] = [];
    const { ctx } = loadApp({
      fetch: async (_url: string, init: any) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ reply: "hei" }) };
      },
    });
    ctx.store.set("chat", [
      { role: "user", text: "Hei", ts: 1 },
      { role: "marcus", text: "Hei igjen!", ts: 2 },
    ]);
    await ctx.retryUnansweredTurn();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
    expect(ctx.store.get("chat", [])).toHaveLength(2);
  });
});

// The card must not flash while a normal turn is out. The submit handler stores
// his message and repaints BEFORE the reply lands, so a naive "last bubble is
// his" card tells him the message never arrived for the whole time the coach is
// thinking -- which is the opposite of true and reads worse than silence.
describe("while a turn is in flight", () => {
  it("does not offer to ask again about the message he just sent", async () => {
    let release: (v: any) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    const { ctx, byId } = loadApp({
      fetch: async () => {
        await pending;
        return { ok: true, json: async () => ({ reply: "Her er svaret." }) };
      },
    });
    ctx.document.getElementById("chatInput").value = "Hva bør jeg gjøre i dag?";
    ctx.document.getElementById("chatForm").handlers.submit({ preventDefault() {} });

    // His bubble is on screen and the request is still out.
    expect(byId["chatMessages"].innerHTML).toContain("Hva bør jeg gjøre i dag?");
    expect(byId["chatMessages"].innerHTML).not.toContain("Ask again");

    release(null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(byId["chatMessages"].innerHTML).toContain("Her er svaret.");
    expect(byId["chatMessages"].innerHTML).not.toContain("Ask again");
  });
});
