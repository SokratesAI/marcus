import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Issue #157: the coach could already propose a GOAL and have Edvard confirm
// it, but it could not propose a FACT about him -- so the profile record built
// the cycle before was one he could only fill in by opening the Plan tab and
// retyping what he had just said in the chat. This drives the four halves: the
// parser, askMarcus dropping a fact he already has, the card, and the append
// that must never overwrite what he typed himself.
//
// Same vm harness as app-goal-fromchat.test.ts: app.js is a classic script, so
// its top-level declarations land on the context and the tests call them.
function loadApp(opts: { now?: Date; fetch?: any } = {}): {
  ctx: any;
  toasts: string[];
  byId: Record<string, any>;
} {
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
    console,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Date: opts.now
      ? new Proxy(Date, {
          construct(target, args: any[]) {
            return args.length
              ? new (target as any)(...args)
              : new (target as any)(opts.now!.getTime());
          },
        })
      : Date,
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

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  vm.runInContext(APP_SOURCE + "\n;globalThis.store = store;", ctx);
  return { ctx, toasts, byId };
}


const BLOCK = '```profile\n{"text": "Born 1994. Semi-active."}\n```';
const GOAL_BLOCK = '```goal\n{"text": "Olympic triathlon at Oslo Tri", "targetDate": "2027-08-14"}\n```';

describe("parseCoachFact", () => {
  it("takes the block out of the reply and returns the fact", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachFact(`Got it.\n\n${BLOCK}`);
    expect(out.text).toBe("Got it.");
    expect(out.fact).toEqual({ text: "Born 1994. Semi-active." });
  });

  it("returns no fact for an ordinary reply", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachFact("Squats. Go.")).toEqual({ text: "Squats. Go.", fact: null });
  });

  // The failure to avoid is a card offering to remember something he never
  // said -- and he must never read raw JSON either way.
  it("returns no fact when the block is not JSON, and still hides it", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachFact("Noted.\n```profile\nborn 1994\n```");
    expect(out.fact).toBeNull();
    expect(out.text).toBe("Noted.");
    expect(out.text).not.toContain("```");
  });

  it("returns no fact when the block carries no text", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachFact('ok\n```profile\n{"note": "born 1994"}\n```').fact).toBeNull();
  });

  // The record is one free-text field. A model that names a field of its own
  // must not have it reach the store.
  it("carries only the text through", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachFact('ok\n```profile\n{"text": "Born 1994.", "age": 32, "confidence": 0.9}\n```');
    expect(out.fact).toEqual({ text: "Born 1994." });
  });
});

describe("factAlreadyKnown", () => {
  it("finds a sentence already sitting inside the paragraph he typed", () => {
    const { ctx } = loadApp();
    const profile = "I am semi-active.\nBorn 1994. Had covid in 2020.";
    expect(ctx.factAlreadyKnown({ text: "born 1994" }, profile)).toBe(true);
  });

  it("ignores a differing full stop and line break", () => {
    const { ctx } = loadApp();
    expect(ctx.factAlreadyKnown({ text: "Born  1994." }, "born\n1994")).toBe(true);
  });

  it("is false for a fact the profile does not carry", () => {
    const { ctx } = loadApp();
    expect(ctx.factAlreadyKnown({ text: "Had covid in 2020" }, "Born 1994.")).toBe(false);
  });

  it("is false against an empty profile", () => {
    const { ctx } = loadApp();
    expect(ctx.factAlreadyKnown({ text: "Born 1994" }, "")).toBe(false);
  });
});

// The one that matters most: the profile is a single free-text record and he
// writes it himself on the Plan tab. A card that SET it rather than added to
// it would wipe a paragraph of his for a tap he thought added a line.
describe("appendFact", () => {
  it("keeps what he already wrote and adds below it", () => {
    const { ctx } = loadApp();
    expect(ctx.appendFact("I am semi-active.", "Born 1994.")).toBe("I am semi-active.\n\nBorn 1994.");
  });

  it("is just the fact when the profile is empty", () => {
    const { ctx } = loadApp();
    expect(ctx.appendFact("", "Born 1994.")).toBe("Born 1994.");
  });

  it("leaves the profile alone for an empty fact", () => {
    const { ctx } = loadApp();
    expect(ctx.appendFact("I am semi-active.", "   ")).toBe("I am semi-active.");
  });
});

describe("askMarcus and the profile block", () => {
  function loadWithReply(reply: string) {
    return loadApp({ fetch: async () => ({ ok: true, json: async () => ({ reply }) }) });
  }

  it("strips the block and hands back the fact", async () => {
    const { ctx } = loadWithReply(`Good to know.\n\n${BLOCK}`);
    const out = await ctx.askMarcus("I was born in 1994 and I am semi-active");
    expect(out.text).toBe("Good to know.");
    expect(out.fact).toEqual({ text: "Born 1994. Semi-active." });
  });

  // One reply can carry both, and each block has to come out whether or not
  // the other one was there.
  it("takes a goal block and a profile block out of one reply", async () => {
    const { ctx } = loadWithReply(`August works.\n\n${GOAL_BLOCK}\n${BLOCK}`);
    const out = await ctx.askMarcus("born 1994, doing Oslo Tri next August");
    expect(out.text).toBe("August works.");
    expect(out.goal).toEqual({ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    expect(out.fact).toEqual({ text: "Born 1994. Semi-active." });
  });

  it("drops a fact the profile already carries", async () => {
    const { ctx } = loadWithReply(`Right.\n\n${BLOCK}`);
    ctx.saveProfile("Born 1994. Semi-active.");
    expect((await ctx.askMarcus("tell me about me")).fact).toBeNull();
  });

  it("drops a fact he has already turned down", async () => {
    const { ctx } = loadWithReply(`Right.\n\n${BLOCK}`);
    ctx.store.set("chat", [
      { role: "marcus", text: "Right.", ts: 900, factProposal: { text: "Born 1994. Semi-active." }, factDeclined: true },
    ]);
    expect((await ctx.askMarcus("again")).fact).toBeNull();
  });

  // A reply that was nothing but the block would otherwise be an empty bubble
  // with a card under it.
  it("writes a sentence when the reply was only the block", async () => {
    const { ctx } = loadWithReply(BLOCK);
    const out = await ctx.askMarcus("born 1994");
    expect(out.text).toBe("Noted — confirm it below and I will remember it.");
  });
});

describe("the fact card", () => {
  function withFact(ctx: any, fact: any, extra: Record<string, unknown> = {}) {
    ctx.store.set("chat", [
      Object.assign({ role: "marcus", text: "Good to know.", ts: 1000, factProposal: fact }, extra),
    ]);
  }

  it("draws the fact and both buttons", () => {
    const { ctx, byId } = loadApp();
    withFact(ctx, { text: "Born 1994. Semi-active." });
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("Born 1994. Semi-active.");
    expect(html).toContain("Remember this");
    expect(html).toContain("acceptCoachFact(1000)");
    expect(html).toContain("declineCoachFact(1000)");
  });

  it("draws no card on an ordinary bubble", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("chat", [{ role: "marcus", text: "Squats. Go.", ts: 1000 }]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("Remember this");
  });

  // The card is drawn from the stored message on purpose, so it outlives the
  // reply -- and he can type the same sentence into the Plan tab in the
  // meantime. Then the button could only toast.
  it("says so instead of offering a fact the profile gained since", () => {
    const { ctx, byId } = loadApp();
    withFact(ctx, { text: "Born 1994. Semi-active." });
    ctx.saveProfile("Born 1994. Semi-active.");
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Already noted about you.");
    expect(byId.chatMessages.innerHTML).not.toContain("Remember this");
  });

  it("adds the fact to the profile when he takes it", () => {
    const { ctx, toasts } = loadApp();
    withFact(ctx, { text: "Born 1994. Semi-active." });
    ctx.saveProfile("Had covid in 2020.");
    ctx.acceptCoachFact(1000);
    expect(ctx.profileText()).toBe("Had covid in 2020.\n\nBorn 1994. Semi-active.");
    expect(ctx.store.get("chat", [])[0].factSaved).toBe(true);
    expect(toasts).toContain("Noted.");
  });

  // The belt to the card's brace: another tab of the same browser can add the
  // same sentence between the draw and the tap.
  it("refuses and says so when the profile gained the fact between draw and tap", () => {
    const { ctx, toasts } = loadApp();
    withFact(ctx, { text: "Born 1994." });
    ctx.saveProfile("Born 1994.");
    ctx.acceptCoachFact(1000);
    expect(ctx.profileText()).toBe("Born 1994.");
    expect(toasts).toContain("I already have that noted.");
  });

  it("is offered exactly once", () => {
    const { ctx } = loadApp();
    withFact(ctx, { text: "Born 1994." });
    ctx.acceptCoachFact(1000);
    ctx.acceptCoachFact(1000);
    expect(ctx.profileText()).toBe("Born 1994.");
  });

  it("saves nothing when he turns it down, and says so", () => {
    const { ctx, byId } = loadApp();
    withFact(ctx, { text: "Born 1994." });
    ctx.declineCoachFact(1000);
    expect(ctx.profileText()).toBe("");
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Not saved.");
  });

  // Separate flags from the goal card's on purpose: one reply can carry both
  // blocks, and answering one must not silently answer the other.
  it("leaves a goal card on the same bubble still answerable", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    ctx.store.set("chat", [{
      role: "marcus",
      text: "August works.",
      ts: 1000,
      goalProposal: { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
      factProposal: { text: "Born 1994." },
    }]);
    ctx.acceptCoachFact(1000);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("acceptCoachGoal(1000)");
    expect(ctx.store.get("goals", [])).toEqual([]);
  });

  it("does nothing for a timestamp that is not in the chat", () => {
    const { ctx } = loadApp();
    withFact(ctx, { text: "Born 1994." });
    ctx.acceptCoachFact(999);
    expect(ctx.profileText()).toBe("");
  });
});

// The submit handler is the only thing that carries the proposal from the
// reply onto the stored message, and nothing above drives it -- the same line
// the goal block needed its own test for.
describe("the chat form stores the fact on the bubble", () => {
  async function submit(ctx: any, byId: any, text: string) {
    ctx.document.getElementById("chatInput").value = text;
    byId.chatForm.handlers.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("puts the fact on the marcus message, ready for the card", async () => {
    const { ctx, byId } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: `Good to know.\n\n${BLOCK}` }) }),
    });
    await submit(ctx, byId, "I was born in 1994");
    const msgs = ctx.store.get("chat", []);
    const marcus = msgs[msgs.length - 1];
    expect(marcus.text).toBe("Good to know.");
    expect(marcus.factProposal).toEqual({ text: "Born 1994. Semi-active." });
  });

  it("leaves an ordinary reply with no fact key at all", async () => {
    const { ctx, byId } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: "Squats. Go." }) }),
    });
    await submit(ctx, byId, "what today?");
    expect(ctx.store.get("chat", []).slice(-1)[0]).not.toHaveProperty("factProposal");
  });
});

// The coach has no way to know he declined -- the block is stripped before the
// bubble is stored and a decline is a tap, not a message. Without this it
// writes the same block every turn for as long as the sentence that produced
// it stays in the window.
describe("declined facts go up with the context", () => {
  it("sends the texts he turned down", async () => {
    let sent: any = null;
    const { ctx } = loadApp({
      fetch: async (_url: string, opts: any) => {
        sent = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ reply: "ok" }) };
      },
    });
    ctx.store.set("chat", [
      { role: "marcus", text: "x", ts: 900, factProposal: { text: "Born 1994." }, factDeclined: true },
      { role: "marcus", text: "y", ts: 901, factProposal: { text: "Vegetarian." } },
    ]);
    await ctx.askMarcus("hi");
    expect(sent.context.declinedFacts).toEqual(["Born 1994."]);
  });
});

// `factSaved` is what makes the card an answered card rather than a lookup
// against the profile as it stands. He can take a fact and then edit that
// sentence back out of the About you box -- deliberately, because he decided
// it was wrong -- and a card that only asked "is this in the profile" would
// come back offering to add it again.
describe("a fact he took and then deleted from the box", () => {
  it("stays answered instead of being offered a second time", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("chat", [
      { role: "marcus", text: "Good to know.", ts: 1000, factProposal: { text: "Born 1994." } },
    ]);
    ctx.acceptCoachFact(1000);
    expect(ctx.profileText()).toBe("Born 1994.");
    // He opens the Plan tab and clears it.
    ctx.saveProfile("");
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Added to what I know about you.");
    expect(byId.chatMessages.innerHTML).not.toContain("Remember this");
  });
});
