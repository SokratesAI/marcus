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
    expect(out.goals).toEqual([{ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }]);
  });

  // "Improve overall health and fitness" is half of what idea #209 asks for and
  // it has no race day. An empty targetDate is the ongoing goal, not a failure.
  it("carries an ongoing goal through with no date", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal('Noted.\n```goal\n{"text": "Get my cholesterol down", "targetDate": ""}\n```');
    expect(out.goals).toEqual([{ text: "Get my cholesterol down", targetDate: "" }]);
  });

  // The failure to avoid is a card offering to save something he never said.
  it("returns no goal for an ordinary reply", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachGoal("Squats. Go.")).toEqual({ text: "Squats. Go.", goals: [] });
  });

  it("returns no goal when the block is not JSON, and still hides it", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal("Noted.\n```goal\nOlympic triathlon\n```");
    expect(out.goals).toEqual([]);
    expect(out.text).toBe("Noted.");
    expect(out.text).not.toContain("```");
  });

  it("returns no goal when the block carries no text", () => {
    const { ctx } = loadApp();
    expect(ctx.parseCoachGoal('ok\n```goal\n{"targetDate": "2027-08-14"}\n```').goals).toEqual([]);
  });

  // A model that adds fields of its own must not have them reach the store:
  // ids and milestones are minted by validateGoal and nowhere else.
  it("carries only the two fields, never an id or milestones", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(
      'ok\n```goal\n{"text": "Race", "targetDate": "2027-08-14", "id": "abc", "milestones": [{"done": true}]}\n```',
    );
    expect(out.goals).toEqual([{ text: "Race", targetDate: "2027-08-14" }]);
  });

  it("leaves a fenced block that is not a goal block alone", () => {
    const { ctx } = loadApp();
    const reply = "Here:\n```js\nconsole.log(1)\n```";
    expect(ctx.parseCoachGoal(reply)).toEqual({ text: reply, goals: [] });
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
    expect(out.goals).toEqual([{ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }]);
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
    expect(out.goals).toEqual([]);
    expect(out.text).toBe("Already on it.");
  });

  // A reply that was nothing but the block would otherwise be an empty bubble.
  it("says something when the reply was only the block", async () => {
    const { ctx } = loadApp({ fetch: coachReturning(BLOCK) });
    const out = await ctx.askMarcus("Oslo Tri next August");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.goals).toHaveLength(1);
  });

  // The rule-based fallback has no idea what was said to it, so it must never
  // come back with a goal to save.
  it("proposes nothing on the fallback path", async () => {
    const { ctx } = loadApp({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const out = await ctx.askMarcus("what is my plan today?");
    expect(out.offline).toBe(true);
    expect(out.goals).toBeUndefined();
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
    expect(html).toContain("acceptCoachGoal(1000, 0)");
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

  // A target date in the past drops the date, not the goal -- the same answer
  // `parseCoachGoal` gives a date the model invented, now given at the tap as
  // well, so the two halves of the flow cannot disagree. This test asserted a
  // toast and an empty store until cycle 1486; that was the last place where
  // the button in front of him could refuse what the card had offered.
  it("drops a target date in the past and still saves the goal", () => {
    const { ctx, toasts, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Race", targetDate: "2020-01-01" });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("2020-01-01 is not a date I can use");
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toHaveLength(1);
    expect(ctx.store.get("goals", [])[0].targetDate).toBe("");
    expect(toasts).toContain("Goal set.");
  });

  // A stored proposal ages against the goals list the same way it ages against
  // the calendar. `askMarcus` asks "does he already have this?" once, when the
  // reply lands; the card lives in the chat for as long as he scrolls back to
  // it, and he can add the same goal on the Plan tab in between.
  it("offers no button for a goal he has added since the card was drawn", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.store.set("goals", [
      { id: "g1", text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14", created: "2026-09-01", milestones: [] },
    ]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Already a goal.");
    expect(byId.chatMessages.innerHTML).not.toContain("Set goal");
  });

  it("writes no second copy of a goal he already has, and says so", () => {
    const { ctx, toasts } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.store.set("goals", [
      { id: "g1", text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14", created: "2026-09-01", milestones: [] },
    ]);
    ctx.acceptCoachGoal(1000);
    const goals = ctx.store.get("goals", []);
    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("g1");
    expect(toasts).toContain("You already have that goal.");
    expect(toasts).not.toContain("Goal set.");
  });

  // Same identity rule as `goalAlreadySet` everywhere else: the text is the
  // goal and the date is not, because moving a race day is what the edit form
  // on the Plan tab is for.
  it("counts the same goal on a different day as one he already has", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.store.set("goals", [
      { id: "g1", text: "  olympic triathlon at oslo tri ", targetDate: "2027-06-01", created: "2026-09-01", milestones: [] },
    ]);
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toHaveLength(1);
  });

  // The guard must not fire on a goal that only looks similar, or a real
  // second race becomes unsavable from the chat with no way to say why.
  it("still saves a goal whose text is not one he has", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    withProposal(ctx, { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" });
    ctx.store.set("goals", [
      { id: "g1", text: "Sprint triathlon at Oslo Tri", targetDate: "2027-06-01", created: "2026-09-01", milestones: [] },
    ]);
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])).toHaveLength(2);
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
    expect(marcus.goalProposals).toEqual([{
      text: "Olympic triathlon at Oslo Tri",
      targetDate: "2027-08-14",
    }]);
    expect(marcus.ts).toBeTruthy();
  });

  it("leaves an ordinary reply with no proposal key at all", async () => {
    const { ctx, byId } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: "Squats. Go." }) }),
    });
    await submit(ctx, byId, "what today?");
    const msgs = ctx.store.get("chat", []);
    expect(msgs[msgs.length - 1]).not.toHaveProperty("goalProposals");
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
    expect(out.goals).toEqual([]);
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
    expect(out.goals).toEqual([{ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }]);
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
    ).goals[0] ?? null;
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

// A proposal that was fine when it arrived and is not fine on the day he taps
// it. The card is drawn from the stored message, deliberately, so it outlives
// the reply that produced it -- and Edvard goes days without opening the app.
// A race on Monday, proposed on Friday, read on Tuesday: `validateGoal` refuses
// a date behind him, so the card drew a target in the past and the button only
// ever toasted. That is the same dead button cycle 1485 fixed at parse time,
// reintroduced by nothing but the calendar moving.
describe("a proposed date that goes stale before he answers", () => {
  // The block arrived on 09-12 naming 09-14, which was a real future date then.
  const PROPOSED = { text: "Sprint triathlon at Sognsvann", targetDate: "2026-09-14" };

  function withStaleProposal(now: Date) {
    const app = loadApp({ now });
    app.ctx.store.set("chat", [
      { role: "marcus", text: "Two days out.", ts: 1000, goalProposal: PROPOSED },
    ]);
    return app;
  }

  it("still saves the goal when he taps days later, as an ongoing one", () => {
    const { ctx, toasts } = withStaleProposal(new Date("2026-09-16T07:00:00"));
    ctx.acceptCoachGoal(1000);
    const goals = ctx.store.get("goals", []);
    expect(goals).toHaveLength(1);
    expect(goals[0].text).toBe("Sprint triathlon at Sognsvann");
    expect(goals[0].targetDate).toBe("");
    expect(goals[0].milestones).toEqual([]);
    expect(toasts).toContain("Goal set.");
    expect(ctx.store.get("chat", [])[0].goalSaved).toBe(true);
  });

  it("says on the card, before he taps, that the date has gone", () => {
    const { ctx, byId } = withStaleProposal(new Date("2026-09-16T07:00:00"));
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("2026-09-14 is not a date I can use");
    expect(html).toContain("Plan tab");
    expect(html).not.toContain("Target ");
  });

  it("leaves the date alone while it is still ahead of him", () => {
    const { ctx, byId } = withStaleProposal(new Date("2026-09-13T07:00:00"));
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Target ");
    ctx.acceptCoachGoal(1000);
    expect(ctx.store.get("goals", [])[0].targetDate).toBe("2026-09-14");
  });

  // Re-asking must not resurrect a date parseCoachGoal already threw out.
  it("keeps an already-dropped date dropped", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-16T07:00:00") });
    const out = ctx.resolveGoalProposal(
      { text: "Olympic triathlon at Oslo Tri", targetDate: "", unusableDate: "next summer" },
      "2026-09-16",
    );
    expect(out).toEqual({
      text: "Olympic triathlon at Oslo Tri",
      targetDate: "",
      unusableDate: "next summer",
    });
  });

  it("has nothing to resolve for a proposal with no text", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-16T07:00:00") });
    expect(ctx.resolveGoalProposal(null, "2026-09-16")).toBeNull();
    expect(ctx.resolveGoalProposal({ text: "  ", targetDate: "2027-01-01" }, "2026-09-16")).toBeNull();
  });
});

// Idea #209 asks for "one or more goals", and on 2026-09-07 Edvard stated three
// things in one message: a sprint triathlon, an Olympic at Oslo Tri next August,
// and his doctor's cholesterol note. A single-match parser took the first block
// and left the rest of them in the bubble as raw JSON, so the two failures these
// drive are both real: a goal he stated silently dropped, and the thing the
// stripper exists to prevent happening to the ones after the first.
const SECOND_BLOCK = '```goal\n{"text": "Get my cholesterol down", "targetDate": ""}\n```';

describe("more than one goal in one reply", () => {
  it("returns every goal and leaves no block in the bubble", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(`Both of those are real goals.\n\n${BLOCK}\n${SECOND_BLOCK}`);
    expect(out.text).toBe("Both of those are real goals.");
    expect(out.text).not.toContain("```");
    expect(out.text).not.toContain("cholesterol");
    expect(out.goals).toEqual([
      { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
      { text: "Get my cholesterol down", targetDate: "" },
    ]);
  });

  // The blocks are judged one at a time: a model that writes the first one badly
  // must not take the second goal down with it.
  it("keeps a good second block when the first one is not JSON", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(`Noted.\n\n\`\`\`goal\nOlympic triathlon\n\`\`\`\n${SECOND_BLOCK}`);
    expect(out.goals).toEqual([{ text: "Get my cholesterol down", targetDate: "" }]);
    expect(out.text).toBe("Noted.");
    expect(out.text).not.toContain("```");
  });

  it("collapses two blocks for the same goal into one card", () => {
    const { ctx } = loadApp();
    const out = ctx.parseCoachGoal(`Yes.\n\n${BLOCK}\n${BLOCK}`);
    expect(out.goals).toHaveLength(1);
  });

  it("draws a card per goal, each with its own index", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    ctx.store.set("chat", [{
      role: "marcus",
      text: "Both of those are real goals.",
      ts: 1000,
      goalProposals: [
        { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
        { text: "Get my cholesterol down", targetDate: "" },
      ],
    }]);
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("Olympic triathlon at Oslo Tri");
    expect(html).toContain("Get my cholesterol down");
    expect(html).toContain("acceptCoachGoal(1000, 0)");
    expect(html).toContain("acceptCoachGoal(1000, 1)");
    expect(html).toContain("declineCoachGoal(1000, 1)");
  });

  // The separating case for per-proposal answers: taking the second goal must
  // save that one and leave the first still offered. A message-level flag saved
  // whichever goal was first and closed the card on the other.
  it("saves only the goal he tapped and leaves the other answerable", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    ctx.store.set("chat", [{
      role: "marcus",
      text: "Both.",
      ts: 1000,
      goalProposals: [
        { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
        { text: "Get my cholesterol down", targetDate: "" },
      ],
    }]);
    ctx.acceptCoachGoal(1000, 1);
    const goals = ctx.store.get("goals", []);
    expect(goals.map((g: any) => g.text)).toEqual(["Get my cholesterol down"]);
    const stored = ctx.store.get("chat", [])[0];
    expect(stored.goalProposals[1].saved).toBe(true);
    expect(stored.goalProposals[0].saved).toBeUndefined();
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("acceptCoachGoal(1000, 0)");
  });

  it("answers a proposal exactly once", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-12T22:00:00") });
    ctx.store.set("chat", [{
      role: "marcus",
      text: "Both.",
      ts: 1000,
      goalProposals: [
        { text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" },
        { text: "Get my cholesterol down", targetDate: "" },
      ],
    }]);
    ctx.acceptCoachGoal(1000, 0);
    ctx.acceptCoachGoal(1000, 0);
    expect(ctx.store.get("goals", [])).toHaveLength(1);
    ctx.declineCoachGoal(1000, 0);
    expect(ctx.store.get("chat", [])[0].goalProposals[0].declined).toBeUndefined();
  });

  // What goes up to the coach so it stops re-raising a card he said no to. Only
  // the one he declined, never the one sitting beside it unanswered.
  it("reports only the declined proposal to the coach", () => {
    const { ctx } = loadApp();
    const chat = [{
      role: "marcus",
      text: "Both.",
      ts: 1000,
      goalProposals: [
        { text: " Olympic triathlon at Oslo Tri ", targetDate: "2027-08-14", declined: true },
        { text: "Get my cholesterol down", targetDate: "" },
      ],
    }];
    expect(ctx.declinedGoalTexts(chat)).toEqual(["Olympic triathlon at Oslo Tri"]);
    expect(ctx.goalDeclinedBefore({ text: "olympic triathlon at OSLO tri" }, chat)).toBe(true);
    expect(ctx.goalDeclinedBefore({ text: "Get my cholesterol down" }, chat)).toBe(false);
  });

  it("drops only the goal he already has and keeps the other", async () => {
    const { ctx } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: `Both.\n\n${BLOCK}\n${SECOND_BLOCK}` }) }),
    });
    ctx.store.set("goals", [
      { id: "1", text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14", milestones: [] },
    ]);
    const out = await ctx.askMarcus("what am I training for?");
    expect(out.goals).toEqual([{ text: "Get my cholesterol down", targetDate: "" }]);
  });

  it("says so in the plural when the reply was nothing but two blocks", async () => {
    const { ctx } = loadApp({
      fetch: async () => ({ ok: true, json: async () => ({ reply: `${BLOCK}\n${SECOND_BLOCK}` }) }),
    });
    const out = await ctx.askMarcus("Oslo Tri next August, and my cholesterol");
    expect(out.text).toContain("them as your goals");
  });
});
