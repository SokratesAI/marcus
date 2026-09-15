import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #208: his synced state carries 21 chat messages and zero sessions. The
// coach could already propose a goal and a fact about him; it could not propose
// the one record the whole app reasons from. These drive the four halves
// separately -- the parser, askMarcus stripping the block off the reply, the
// card, and the tap that writes a real session.
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
const TODAY = new Date("2026-09-15T09:00:00");
const BLOCK = '```session\n{"date": "2026-09-15", "exercises": [{"name": "Knebøy", "sets": 5, "reps": 5, "weight": 100, "rpe": 8}]}\n```';

describe("parseCoachSession", () => {
  it("takes the block out of the reply and returns the session", () => {
    const { ctx } = loadApp({ now: TODAY });
    const out = ctx.parseCoachSession(`Sterkt økt.\n\n${BLOCK}`, "2026-09-15");
    expect(out.text).toBe("Sterkt økt.");
    expect(out.session).toEqual({
      date: "2026-09-15",
      kind: "strength",
      exercises: [{ name: "Knebøy", sets: [
        { reps: 5, weight: 100 }, { reps: 5, weight: 100 }, { reps: 5, weight: 100 },
        { reps: 5, weight: 100 }, { reps: 5, weight: 100 },
      ], rpe: 8 }],
    });
  });

  // The failure to avoid is a card offering to log training he never did.
  it("returns no session for an ordinary reply", () => {
    const { ctx } = loadApp({ now: TODAY });
    expect(ctx.parseCoachSession("Squats. Go.", "2026-09-15")).toEqual({ text: "Squats. Go.", session: null });
  });

  it("returns no session when the block is not JSON, and still hides it", () => {
    const { ctx } = loadApp({ now: TODAY });
    const out = ctx.parseCoachSession("Notert.\n```session\n5x5 knebøy\n```", "2026-09-15");
    expect(out.session).toBeNull();
    expect(out.text).toBe("Notert.");
    expect(out.text).not.toContain("```");
  });

  // A day that has not happened is not a log, it is a plan. This is the one
  // end a goal's date validation has the other way round.
  it("refuses a session dated in the future", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = BLOCK.replace("2026-09-15", "2026-09-16");
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session).toBeNull();
  });

  // A model reasoning from a training cutoff months behind today writes last
  // year's date, and a session filed then is behind the end of every window
  // this app draws.
  it("refuses a session dated far in the past", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = BLOCK.replace("2026-09-15", "2025-09-15");
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session).toBeNull();
  });

  it("refuses a date that is not a real day", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = BLOCK.replace("2026-09-15", "2026-02-31");
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session).toBeNull();
  });

  // validateSession is the Log tab's own save check. A block it would refuse
  // must not become a card, or the button could only ever toast.
  it("refuses a row the store would refuse", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = '```session\n{"date": "2026-09-15", "exercises": [{"name": "Knebøy", "sets": 5, "reps": "", "weight": 100}]}\n```';
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session).toBeNull();
  });

  it("refuses a block with no exercises", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = '```session\n{"date": "2026-09-15", "exercises": []}\n```';
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session).toBeNull();
  });

  // A model that adds fields of its own must not have them reach the store:
  // the id is minted where the record is built and nowhere else.
  it("carries only the fields a session record has", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = '```session\n{"id": "hacked", "date": "2026-09-15", "kind": "cardio", "exercises": [{"name": "Knebøy", "sets": 1, "reps": 5, "weight": 60}]}\n```';
    const s = ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session;
    expect(s.id).toBeUndefined();
    expect(s.kind).toBe("strength");
    expect(Object.keys(s).sort()).toEqual(["date", "exercises", "kind"]);
  });

  it("keeps a note when the block carries one", () => {
    const { ctx } = loadApp({ now: TODAY });
    const block = '```session\n{"date": "2026-09-15", "note": "tungt", "exercises": [{"name": "Knebøy", "sets": 1, "reps": 5, "weight": 60}]}\n```';
    expect(ctx.parseCoachSession(`ok\n${block}`, "2026-09-15").session.note).toBe("tungt");
  });
});

describe("sessionAlreadyLogged", () => {
  const proposal = { date: "2026-09-15", exercises: [{ name: "Knebøy" }, { name: "Benkpress" }] };

  it("matches the same day and the same exercises in any order", () => {
    const { ctx } = loadApp({ now: TODAY });
    expect(ctx.sessionAlreadyLogged(proposal, [
      { date: "2026-09-15", exercises: [{ name: "benkpress" }, { name: "KNEBØY" }] },
    ])).toBe(true);
  });

  it("does not match the same exercises on another day", () => {
    const { ctx } = loadApp({ now: TODAY });
    expect(ctx.sessionAlreadyLogged(proposal, [
      { date: "2026-09-14", exercises: [{ name: "Knebøy" }, { name: "Benkpress" }] },
    ])).toBe(false);
  });

  it("does not match a different workout on the same day", () => {
    const { ctx } = loadApp({ now: TODAY });
    expect(ctx.sessionAlreadyLogged(proposal, [
      { date: "2026-09-15", exercises: [{ name: "Markløft" }] },
    ])).toBe(false);
  });
});

describe("askMarcus and the session block", () => {
  function loadWithReply(reply: string) {
    return loadApp({ now: TODAY, fetch: async () => ({ ok: true, json: async () => ({ reply }) }) });
  }

  it("strips the block and hands back the session", async () => {
    const { ctx } = loadWithReply(`Sterkt.\n\n${BLOCK}`);
    const out = await ctx.askMarcus("tok 5x5 knebøy på 100 kg i dag");
    expect(out.text).toBe("Sterkt.");
    expect(out.session.date).toBe("2026-09-15");
  });

  // One reply can carry all three, and each block has to come out whether or
  // not the others were there.
  it("takes a goal block, a profile block and a session block out of one reply", async () => {
    const goal = '```goal\n{"text": "Olympic triathlon at Oslo Tri", "targetDate": "2027-08-14"}\n```';
    const profile = '```profile\n{"text": "Born 1994. Semi-active."}\n```';
    const { ctx } = loadWithReply(`August works.\n\n${goal}\n${profile}\n${BLOCK}`);
    const out = await ctx.askMarcus("alt på en gang");
    expect(out.text).toBe("August works.");
    expect(out.goals).toEqual([{ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }]);
    expect(out.fact).toEqual({ text: "Born 1994. Semi-active." });
    expect(out.session.date).toBe("2026-09-15");
  });

  it("drops a session already in the log", async () => {
    const { ctx } = loadWithReply(`Sterkt.\n\n${BLOCK}`);
    ctx.store.set("sessions", [{ id: "a", date: "2026-09-15", exercises: [{ name: "Knebøy" }] }]);
    expect((await ctx.askMarcus("igjen")).session).toBeNull();
  });

  it("drops a session he has already turned down", async () => {
    const { ctx } = loadWithReply(`Sterkt.\n\n${BLOCK}`);
    ctx.store.set("chat", [{
      role: "marcus", text: "Sterkt.", ts: 900, sessionDeclined: true,
      sessionProposal: { date: "2026-09-15", exercises: [{ name: "Knebøy" }] },
    }]);
    expect((await ctx.askMarcus("igjen")).session).toBeNull();
  });

  // A reply that was nothing but the block would otherwise be an empty bubble
  // with a card under it.
  it("writes a sentence when the reply was only the block", async () => {
    const { ctx } = loadWithReply(BLOCK);
    expect((await ctx.askMarcus("5x5 knebøy")).text).toBe("Written down — confirm it below and I will log it.");
  });

  // The client suppresses the card for one he refused, so the model has to be
  // told or it leaves him a sentence with nothing under it to tap.
  it("sends what he turned down to the coach", async () => {
    let sent: any = null;
    const { ctx } = loadApp({
      now: TODAY,
      fetch: async (_url: string, init: any) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ reply: "ok" }) };
      },
    });
    ctx.store.set("chat", [{
      role: "marcus", text: "Sterkt.", ts: 900, sessionDeclined: true,
      sessionProposal: { date: "2026-09-15", exercises: [{ name: "Knebøy", sets: [{ reps: 5, weight: 100 }] }] },
    }]);
    await ctx.askMarcus("hei");
    expect(sent.context.declinedSessions).toEqual(["1×5 Knebøy at 100 kg (2026-09-15)"]);
  });
});

describe("the session card", () => {
  function withSession(ctx: any, session: any, extra: Record<string, unknown> = {}) {
    // A fresh load seeds the demo log, so the counts below are about what the
    // tap wrote and not about what the app shipped with.
    ctx.store.set("sessions", []);
    ctx.store.set("chat", [
      Object.assign({ role: "marcus", text: "Sterkt.", ts: 1000, sessionProposal: session }, extra),
    ]);
  }
  const PROPOSAL = {
    date: "2026-09-15",
    kind: "strength",
    exercises: [{ name: "Knebøy", sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] }],
  };

  it("draws what it heard and both buttons", () => {
    const { ctx, byId } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("2×5 Knebøy at 100 kg");
    expect(html).toContain("Log it");
    expect(html).toContain("acceptCoachSession(1000)");
    expect(html).toContain("declineCoachSession(1000)");
  });

  it("draws no card on an ordinary bubble", () => {
    const { ctx, byId } = loadApp({ now: TODAY });
    ctx.store.set("chat", [{ role: "marcus", text: "Squats. Go.", ts: 1000 }]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("Log it");
  });

  // The card is drawn from the stored message on purpose, so it outlives the
  // reply -- and he can log the same session on the Log tab in between.
  it("says so instead of offering a session the log gained since", () => {
    const { ctx, byId } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.store.set("sessions", [{ id: "a", date: "2026-09-15", exercises: [{ name: "Knebøy" }] }]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Already in your log.");
    expect(byId.chatMessages.innerHTML).not.toContain("Log it");
  });

  // The proposal ages while he is away: a date inside the window when it was
  // offered can be outside it by the time he opens the app. Drawing a button
  // that can only toast is the dead-button shape this repo has paid for.
  it("draws no button once the calendar has carried the day out of range", () => {
    const { ctx, byId } = loadApp({ now: TODAY });
    withSession(ctx, Object.assign({}, PROPOSAL, { date: "2026-01-01" }));
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("acceptCoachSession");
    expect(byId.chatMessages.innerHTML).toContain("Too old to log now");
  });

  it("writes a real session when he taps Log it", () => {
    const { ctx, toasts } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.acceptCoachSession(1000);
    const sessions = ctx.store.get("sessions", []);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].date).toBe("2026-09-15");
    expect(sessions[0].kind).toBe("strength");
    expect(sessions[0].exercises[0].sets).toHaveLength(2);
    expect(typeof sessions[0].id).toBe("string");
    expect(ctx.store.get("chat", [])[0].sessionSaved).toBe(true);
    expect(toasts).toContain("Logged.");
  });

  // The belt to the card's brace: another tab of the same browser can log the
  // same session between the draw and the tap.
  it("refuses and says so when the log gained the session between draw and tap", () => {
    const { ctx, toasts } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.store.set("sessions", [{ id: "a", date: "2026-09-15", exercises: [{ name: "Knebøy" }] }]);
    ctx.acceptCoachSession(1000);
    expect(ctx.store.get("sessions", [])).toHaveLength(1);
    expect(toasts).toContain("That one is already in your log.");
  });

  it("refuses at the tap when the day has gone out of range", () => {
    const { ctx, toasts } = loadApp({ now: TODAY });
    withSession(ctx, Object.assign({}, PROPOSAL, { date: "2026-01-01" }));
    ctx.acceptCoachSession(1000);
    expect(ctx.store.get("sessions", [])).toHaveLength(0);
    expect(toasts).toContain("That day is outside what I can log now — add it on the Log tab.");
  });

  it("is logged exactly once", () => {
    const { ctx } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.acceptCoachSession(1000);
    ctx.acceptCoachSession(1000);
    expect(ctx.store.get("sessions", [])).toHaveLength(1);
  });

  it("logs nothing when he turns it down, and says so", () => {
    const { ctx, byId } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL);
    ctx.declineCoachSession(1000);
    expect(ctx.store.get("sessions", [])).toHaveLength(0);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Not logged.");
  });

  // Answering one block must not silently answer another.
  it("leaves a fact on the same bubble unanswered", () => {
    const { ctx } = loadApp({ now: TODAY });
    withSession(ctx, PROPOSAL, { factProposal: { text: "Born 1994." } });
    ctx.acceptCoachSession(1000);
    const m = ctx.store.get("chat", [])[0];
    expect(m.sessionSaved).toBe(true);
    expect(m.factSaved).toBeUndefined();
    expect(m.factDeclined).toBeUndefined();
  });
});
