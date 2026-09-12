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
