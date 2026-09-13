import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209: the coach can now end a reply with a ```goal block and the app
// turns it into a card Edvard confirms. These drive the three halves
// separately -- the parser, askMarcus stripping the block off the reply, and
// the card reaching the screen and writing a real goal record.
//
// Same vm harness as app-coachchat.test.ts: app.js is a classic script, so its
// top-level declarations land on the context and the tests call them.
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

const BLOCK = '```goal\n{"text": "Olympic triathlon at Oslo Tri", "targetDate": "2027-08-14"}\n```';

describe("parseCoachGoal", () => {
  it("takes the block out of the reply and returns the goal", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(`Great — August is realistic from here.\n\n${BLOCK}`);
    expect(out.text).toBe("Great — August is realistic from here.");
    expect(out.goal).toEqual({ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
  });

  // "Improve overall health and fitness" is half of what idea #209 asks for and
  // it has no race day. An empty targetDate is the ongoing goal, not a failure.
  it("carries an ongoing goal through with no date", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal('Noted.\n```goal\n{"text": "Get my cholesterol down", "targetDate": ""}\n```');
    expect(out.goal).toEqual({ text: "Get my cholesterol down", targetDate: "" });
  });

  // The failure to avoid is a card offering to save something he never said.
  it("returns no goal for an ordinary reply", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachGoal("Squats. Go.")).toEqual({ text: "Squats. Go.", goal: null });
  });

  it("returns no goal when the block is not JSON, and still hides it", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal("Noted.\n```goal\nOlympic triathlon\n```");
    expect(out.goal).toBeNull();
    expect(out.text).toBe("Noted.");
    expect(out.text).not.toContain("```");
  });

  it("returns no goal when the block carries no text", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachGoal('ok\n```goal\n{"targetDate": "2027-08-14"}\n```').goal).toBeNull();
  });

  // A model that adds fields of its own must not have them reach the store:
  // ids and milestones are minted by validateGoal and nowhere else.
  it("carries only the two fields, never an id or milestones", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(
      'ok\n```goal\n{"text": "Race", "targetDate": "2027-08-14", "id": "abc", "milestones": [{"done": true}]}\n```',
    );
    expect(out.goal).toEqual({ text: "Race", targetDate: "2027-08-14" });
  });

  it("leaves a fenced block that is not a goal block alone", () => {
    const { ctx } = loadApp();
    const reply = "Here:\n```js\nconsole.log(1)\n```";
    expect(ctx.parseCoachGoal(reply)).toEqual({ text: reply, goal: null });
  });
});

describe("goalAlreadySet", () => {
  it("matches on the text regardless of case and spacing", () => {
    const { ctx } = loadApp();
    const existing = [{ id: "1", text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }];
    expect(ctx.goalAlreadySet({ text: "  olympic TRIATHLON at oslo tri " }, existing)).toBe(true);
  });

  it("does not match a different goal", () => {
    const { ctx } = loadApp();
    expect(ctx.goalAlreadySet({ text: "Get my cholesterol down" }, [{ text: "Race" }])).toBe(false);
  });

  it("is false against an empty store", () => {
    const { ctx } = loadApp();
    expect(ctx.goalAlreadySet({ text: "Race" }, [])).toBe(false);
  });
});

// A decline is a tap, and nothing the model can see records it -- so without
// these it re-proposes the same goal on the very next turn, forever.
describe("declinedGoalTexts and goalDeclinedBefore", () => {
  const declinedChat = [
    { role: "user", text: "maybe Oslo Tri", ts: 1 },
    {
      role: "marcus",
      text: "Written down.",
      ts: 2,
      goalProposal: { text: " Olympic triathlon at Oslo Tri ", targetDate: "2027-08-14" },
      goalDeclined: true,
    },
  ];

  it("collects the text of every proposal he turned down", () => {
    const { ctx } = loadApp();
    expect(ctx.declinedGoalTexts(declinedChat)).toEqual(["Olympic triathlon at Oslo Tri"]);
  });

  it("ignores a proposal he saved and one still waiting on him", () => {
    const { ctx } = loadApp();
    expect(
      ctx.declinedGoalTexts([
        { role: "marcus", text: "a", ts: 1, goalProposal: { text: "Saved one" }, goalSaved: true },
        { role: "marcus", text: "b", ts: 2, goalProposal: { text: "Open one" } },
        { role: "user", text: "c", ts: 3 },
      ]),
    ).toEqual([]);
  });

  it("matches a re-proposal on case and spacing, like goalAlreadySet", () => {
    const { ctx } = loadApp();
    expect(ctx.goalDeclinedBefore({ text: "olympic triathlon at OSLO tri" }, declinedChat)).toBe(true);
  });

  it("does not match a different goal, or an empty log", () => {
    const { ctx } = loadApp();
    expect(ctx.goalDeclinedBefore({ text: "Get my cholesterol down" }, declinedChat)).toBe(false);
    expect(ctx.goalDeclinedBefore({ text: "Race" }, [])).toBe(false);
  });
});

describe("askMarcus and the goal block", () => {
  const coachReturning = (reply: string) => async () => ({ ok: true, json: async () => ({ reply }) });

  it("returns the stripped reply and the proposal", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(`August is realistic.\n\n${BLOCK}`) });
    const out = await ctx.askMarcus("I want to do Oslo Tri next August");
    expect(out.text).toBe("August is realistic.");
    expect(out.offline).toBe(false);
    expect(out.goal).toEqual({ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
  });

  it("never shows the raw block in the bubble", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(`Yes.\n\n${BLOCK}`) });
    const out = await ctx.askMarcus("hi");
    expect(out.text).not.toContain("```");
    expect(out.text).not.toContain("targetDate");
  });

  it("drops a proposal for a goal he already has, and keeps the reply", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(`Already on it.\n\n${BLOCK}`) });
    ctx.store.set("goals", [
      { id: "1", text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14", milestones: [] },
    ]);
    const out = await ctx.askMarcus("what am I training for?");
    expect(out.goal).toBeNull();
    expect(out.text).toBe("Already on it.");
  });

  // A reply that was nothing but the block would otherwise be an empty bubble.
  it("says something when the reply was only the block", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(BLOCK) });
    const out = await ctx.askMarcus("Oslo Tri next August");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.goal).not.toBeNull();
  });

  // The rule-based fallback has no idea what was said to it, so it must never
  // come back with a goal to save.
  it("proposes nothing on the fallback path", async () => {
    const { ctx } = loadApp({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const out = await ctx.askMarcus("what is my plan today?");
    expect(out.offline).toBe(true);
    expect(out.goal).toBeUndefined();
  });
});

describe("the confirm card", () => {
  function withProposal(ctx: any, proposal: any, extra: Record<string, unknown> = {}) {
    ctx.store.set("chat", [
      Object.assign({ role: "marcus", text: "August is realistic.", ts: 1000, goalProposal: proposal }, extra),
    ]);
  }

  it("draws the goal and both buttons", () => {
    const { ctx, byId } = loadApp();
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("Olympic triathlon at Oslo Tri");
    expect(html).toContain("Set goal");
    expect(html).toContain("Not this");
    expect(html).toContain("acceptCoachGoal(1000)");
  });

  it("says an ongoing goal has no target date", () => {
    const { ctx, byId } = loadApp();
    withProposal(ctx, { text: "Get my cholesterol down", targetDate: "" });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("an ongoing goal");
  });

  it("draws no card on an ordinary bubble", () => {
    const { ctx, byId } = loadApp();
    ctx.store.set("chat", [{ role: "marcus", text: "Squats. Go.", ts: 1000 }]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("Set goal");
  });

  it("writes a real goal record when he takes it, with phases cut from his dates", () => {
    const { ctx, toasts } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000);
    const goals = ctx.store.get("goals", []);
    expect(goals).toHaveLength(1);
    expect(goals[0].text).toBe("Olympic triathlon at Oslo Tri");
    expect(goals[0].targetDate).toBe("2027-08-14");
    expect(goals[0].id).toBeTruthy();
    expect(goals[0].milestones.length).toBeGreaterThan(0);
    expect(toasts).toContain("Goal set.");
  });

  it("stores an ongoing goal with no phases", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Get my cholesterol down", targetDate: "" });
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])[0].milestones).toEqual([]);
  });

  // Offered once. Tapping the same card twice on a slow phone must not write
  // the goal twice.
  it("saves once however many times the button is tapped", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Race", targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000);
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toHaveLength(1);
  });

  it("replaces the buttons with what he chose, and keeps that after a redraw", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Race", targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Saved as a goal.");
    expect(byId.chatMessages.innerHTML).not.toContain("Set goal");
  });

  it("declining saves nothing and closes the card", () => {
    const { ctx, byId } = loadApp();
    withProposal(ctx, { text: "Race", targetDate: "2027-08-14" });
    ctx.declineCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toEqual([]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Not saved.");
    expect(byId.chatMessages.innerHTML).not.toContain("Set goal");
  });

  it("a declined proposal cannot then be accepted", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Race", targetDate: "2027-08-14" });
    ctx.declineCoachGoal(1000);
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toEqual([]);
  });

  // A date the model invented in the past is refused by the same validator the
  // form uses, and he is told why rather than getting a silent no-op.
  it("refuses a target date in the past and says so", () => {
    const { ctx, toasts } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Race", targetDate: "2020-01-01" });
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toEqual([]);
    expect(toasts.join(" ")).toContain("future");
  });

  it("does nothing for a timestamp that is not in the chat", () => {
    const { ctx } = loadApp();
    withProposal(ctx, { text: "Race", targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(999);
    expect(ctx.store.get("goals", [])).toEqual([]);
  });
});

// The submit handler is the only thing that carries the proposal from the
// reply onto the stored message, and nothing above drives it -- deleting that
// one line left every test here green. So this goes through the form.
describe("the chat form stores the proposal on the bubble", () => {
  async function submit(ctx: any, byId: any, text: string) {
    // byId is filled on demand, and the app only asks for #chatInput inside
    // the handler -- so the node has to be minted here before it is set.
    ctx.document.getElementById("chatInput").value = text;
    byId.chatForm.handlers.submit({ preventDefault() {} });
    // askMarcus is awaited inside the handler; two microtask drains is enough
    // for the stubbed fetch, which resolves immediately.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("puts the goal on the marcus message, ready for the card", async () => {
    const { ctx, byId } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: `August works.\n\n${BLOCK}` }) }),
    });
    await submit(ctx, byId, "I want to do Oslo Tri next August");
    const msgs = ctx.store.get("chat", []);
    const marcus = msgs[msgs.length - 1];
    expect(marcus.role).toBe("marcus");
    expect(marcus.text).toBe("August works.");
    expect(marcus.goalProposal).toEqual({
      text: "Olympic triathlon at Oslo Tri",
      targetDate: "2027-08-14",
    });
    expect(marcus.ts).toBeTruthy();
  });

  it("leaves an ordinary reply with no proposal key at all", async () => {
    const { ctx, byId } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: "Squats. Go." }) }),
    });
    await submit(ctx, byId, "what today?");
    const msgs = ctx.store.get("chat", []);
    expect(msgs[msgs.length - 1]).not.toHaveProperty("goalProposal");
  });
});

describe("askMarcus and a goal he already turned down", () => {
  const coachReturning = (reply: string) => async () => ({ ok: true, json: async () => ({ reply }) });

  it("drops a re-proposal of a goal he declined, and keeps the reply", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(`Still worth doing.\n\n${BLOCK}`) });
    ctx.store.set("chat", [
      {
        role: "marcus",
        text: "Written down.",
        ts: 2,
        goalProposal: { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
        goalDeclined: true,
      },
    ]);
    const out = await ctx.askMarcus("tell me about triathlon");
    expect(out.goal).toBeNull();
    expect(out.text).toBe("Still worth doing.");
  });

  it("still shows a proposal he has not answered yet", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(`Right.\n\n${BLOCK}`) });
    ctx.store.set("chat", [
      {
        role: "marcus",
        text: "Written down.",
        ts: 2,
        goalProposal: { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
      },
    ]);
    const out = await ctx.askMarcus("tell me about triathlon");
    expect(out.goal).toEqual({ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
  });

  it("sends the declined texts up to the coach as context", async () => {
    let sent: any = null;
    const { ctx } = loadApp({
      fetch: async (_url: string, init: any) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ reply: "ok" }) };
      },
    });
    ctx.store.set("chat", [
      {
        role: "marcus",
        text: "Written down.",
        ts: 2,
        goalProposal: { text: "Olympic triathlon at Oslo Tri" },
        goalDeclined: true,
      },
    ]);
    await ctx.askMarcus("hi");
    expect(sent.context.declinedGoals).toEqual(["Olympic triathlon at Oslo Tri"]);
  });
});

// A date the coach writes that the app cannot use. `acceptCoachGoal` runs the
// proposal through `validateGoal`, so before this the card drew a Set goal
// button that could only ever toast: the date was refused, nothing was saved,
// and the goal he had just stated in the chat had no way into the store at all.
// The model is asked for `YYYY-MM-DD` and does not always comply, and it reasons
// from a training cutoff months behind today -- "Oslo Tri next August" pinned to
// the August already behind him is the ordinary case here.
describe("a proposed date the app cannot use", () => {
  const NOW = new Date("2026-09-13T06:00:00");

  function proposalFrom(date: string, now: Date = NOW) {
    const { ctx } = loadApp({ now });
    return ctx.parseCoachGoal(
      `Noted.\n\`\`\`goal\n{"text": "Olympic triathlon at Oslo Tri", "targetDate": "${date}"}\n\`\`\``,
    ).goal;
  }

  it("drops a date already behind him and keeps the goal", () => {
    expect(proposalFrom("2026-08-14")).toEqual({
      text: "Olympic triathlon at Oslo Tri",
      targetDate: "",
      unusableDate: "2026-08-14",
    });
  });

  it("drops today, which validateGoal refuses as not in the future", () => {
    expect(proposalFrom("2026-09-13")?.unusableDate).toBe("2026-09-13");
  });

  it("drops a date that is not a real day", () => {
    expect(proposalFrom("2027-02-31")?.unusableDate).toBe("2027-02-31");
  });

  it("drops natural language the model left unpinned", () => {
    expect(proposalFrom("next summer")?.unusableDate).toBe("next summer");
  });

  it("leaves a usable future date alone and marks nothing", () => {
    const goal = proposalFrom("2027-08-14");
    expect(goal).toEqual({ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    expect(goal.unusableDate).toBeUndefined();
  });

  // The point of the whole change: the button works now.
  it("saves a real ongoing goal when he taps Set goal", () => {
    const { ctx, toasts } = loadApp({ now: NOW });
    ctx.store.set("chat", [
      {
        role: "marcus",
        text: "August is realistic.",
        ts: 1000,
        goalProposal: { text: "Olympic triathlon at Oslo Tri", targetDate: "", unusableDate: "2026-08-14" },
      },
    ]);
    ctx.acceptCoachGoal(1000);
    const goals = ctx.store.get("goals", []);
    expect(goals).toHaveLength(1);
    expect(goals[0].text).toBe("Olympic triathlon at Oslo Tri");
    expect(goals[0].targetDate).toBe("");
    expect(goals[0].milestones).toEqual([]);
    expect(toasts).toContain("Goal set.");
    expect(ctx.store.get("chat", [])[0].goalSaved).toBe(true);
  });

  // Not a silent downgrade: he is told which date was dropped, so an ongoing
  // goal he never stated cannot arrive looking like one he did.
  it("says on the card which date was dropped and where to put the day", () => {
    const { ctx, byId } = loadApp({ now: NOW });
    ctx.store.set("chat", [
      {
        role: "marcus",
        text: "August is realistic.",
        ts: 1000,
        goalProposal: { text: "Olympic triathlon at Oslo Tri", targetDate: "", unusableDate: "2026-08-14" },
      },
    ]);
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("2026-08-14 is not a date I can use");
    expect(html).toContain("Plan tab");
    expect(html).toContain("Set goal");
  });
});

// The form on the Plan tab and the card in the chat now ask one function
// whether a date is real, so they cannot come to disagree about it.
describe("goalDateProblem", () => {
  it("passes an empty date, because an ongoing goal is a real goal", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T06:00:00") });
    expect(ctx.goalDateProblem("")).toBe("");
    expect(ctx.goalDateProblem(null)).toBe("");
  });

  it("gives validateGoal its refusal message verbatim", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T06:00:00") });
    for (const date of ["2026-09-13", "2027-02-31", "next summer", "2099-01-01"]) {
      const problem = ctx.goalDateProblem(date);
      expect(problem).not.toBe("");
      expect(ctx.validateGoal("Olympic triathlon", date).message).toBe(problem);
    }
  });
});
