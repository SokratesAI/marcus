import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Issue #157. Edvard, in the chat on 2026-09-07 and still the last thing he
// said to Marcus about what it is for: "Du er ikke ment til å være en reaktiv
// kommentator, men en proaktiv trener. Om du hadde hyret inn en pt, hva hadde
// du forventet?" Marcus answered with the list itself and the first item on it
// was "Spurt om bakgrunn først" -- a coach you trusted would have asked about
// your background rather than waiting for you to log something. The opening
// bubble a new browser gets says the opposite in one sentence: "Ask me about
// today's session, your plan, or how your progress looks."
//
// Measured on his live state the morning of 2026-09-13 (GET /api/state, rev
// 14): `data` carries chat, deletions, meals, plan, sessions and weights, and
// no `profile` key and no `goals` key at all -- so the first question this
// picks is the one his record is actually missing.
//
// Same vm harness as app-chat-unanswered.test.ts: app.js is a classic script,
// so its top-level declarations land on the context and the tests call them.
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

/** The bubble from his own thread, so a test about the two cards not stacking
 * is about the state he is actually in. */
const CUT_OFF =
  "Skal se om jeg har notert noe om deg fra før, så jeg ikke overskriver det jeg allerede vet.\n\n**1 tool use**";

const FULL = {
  profile: "Born 1994. Semi-active.",
  goals: [{ id: "g1", text: "Oslo Tri" }],
  sessions: [{ id: "s1", date: "2026-09-12" }],
};

describe("openingQuestion", () => {
  it("asks about his background first when nothing about him is on record", () => {
    const { ctx } = loadApp();
    const out = ctx.openingQuestion({ profile: "", goals: [], sessions: [] });
    expect(out.key).toBe("profile");
    expect(out.text).toContain("who I am training");
  });

  // Ordered, not a set: with a profile already there, asking for it again is
  // the box on the other tab he has already filled in.
  it("moves on to what he is training for once he has a profile", () => {
    const { ctx } = loadApp();
    expect(ctx.openingQuestion({ ...FULL, goals: [], sessions: [] }).key).toBe("goals");
  });

  it("asks what he has actually done only once the first two are answered", () => {
    const { ctx } = loadApp();
    expect(ctx.openingQuestion({ ...FULL, sessions: [] }).key).toBe("sessions");
  });

  it("has nothing to open with when the record is complete", () => {
    const { ctx } = loadApp();
    expect(ctx.openingQuestion(FULL)).toBeNull();
  });

  // The stores are absent rather than empty on a browser that never had them,
  // and his live state is exactly that: no `profile` key, no `goals` key.
  it("reads a missing store and a blank one as the same gap", () => {
    const { ctx } = loadApp();
    expect(ctx.openingQuestion({}).key).toBe("profile");
    expect(ctx.openingQuestion(null).key).toBe("profile");
    expect(ctx.openingQuestion({ profile: "   ", goals: [], sessions: [] }).key).toBe("profile");
  });
});

describe("the opening question on the chat thread", () => {
  const seed = (ctx: any, state: Record<string, unknown>) => {
    Object.entries(state).forEach(([k, v]) => ctx.store.set(k, v));
  };

  it("is drawn under the thread with the question and a way in", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: [{ role: "marcus", text: "Hey!", ts: 1 }] });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("who I am training");
    expect(byId.chatMessages.innerHTML).toContain('data-opener="profile"');
    expect(byId.chatMessages.innerHTML).toContain("Answer that");
  });

  // It vanishes on its own, like every other card in this thread: nothing
  // records that it was shown, so the only thing that can retire it is the gap
  // being filled.
  it("is gone once he has said who he is and what he is training for", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: [{ role: "marcus", text: "Hey!", ts: 1 }], ...FULL });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("data-opener");
  });

  // Both cards are Marcus asking him for something. Two at the foot of one
  // thread is a form, which is the thing he will not fill in.
  it("stands down while the thread is still owed an answer", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, {
      chat: [
        { role: "user", text: "Bakgrunnen min er at jeg er semi-aktiv.", ts: 1 },
        { role: "marcus", text: CUT_OFF, ts: 2 },
      ],
    });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Ask again");
    expect(byId.chatMessages.innerHTML).not.toContain("data-opener");
  });

  // The answer is on its way; asking him again mid-turn reads as the app not
  // having heard him. What holds it back is not a flag of its own -- a turn in
  // flight IS a thread owed an answer, so the unanswered check above covers the
  // whole of it. This drives a real request rather than asserting the seam,
  // because the seam is the thing that could move.
  it("stands down while a coach turn is in flight", async () => {
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
    seed(ctx, { chat: [{ role: "marcus", text: "Hey!", ts: 1 }] });
    ctx.document.getElementById("chatInput").value = "Hei";
    ctx.document.getElementById("chatForm").handlers.submit({ preventDefault() {} });
    expect(byId.chatMessages.innerHTML).not.toContain("data-opener");

    // And back again once the turn is over, because the gap is still there.
    release(null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(byId.chatMessages.innerHTML).toContain("data-opener");
  });

  // The question is Marcus's; the answer has to be his own words, because the
  // profile and goal blocks downstream are the coach reading what he wrote.
  it("puts the cursor in the box and does not type for him", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: [{ role: "marcus", text: "Hey!", ts: 1 }] });
    ctx.renderChatMessages();
    const input = ctx.document.getElementById("chatInput");
    let focused = 0;
    input.focus = () => { focused += 1; };
    ctx.answerOpeningQuestion();
    expect(focused).toBe(1);
    expect(input.value).toBe("");
  });
});
