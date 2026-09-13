import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Idea #209. The gap these cover is the one the coach itself walks him into.
// He says "Olympic triathlon next summer"; the model cannot turn that into a
// day, so the block carries no targetDate, the goal saves as an ongoing one --
// and the same reply asks him whether he has a race date yet. When he answers,
// the model writes the block again WITH the day, and until now `goalAlreadySet`
// matched on the text alone and askMarcus threw that block away before a card
// was ever drawn. The only route to the date was the edit form on the Plan tab.

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


const DATED = '```goal\n{"text": "Olympic triathlon at Oslo Tri", "targetDate": "2027-08-14"}\n```';
const ONGOING = { id: "g1", text: "Olympic triathlon at Oslo Tri", targetDate: "", created: "2026-09-01", milestones: [] };

describe("goalDateOffer", () => {
  it("names the dateless goal a dated proposal would pin", () => {
    const { ctx } = loadApp();
    // Matched the same way `goalAlreadySet` matches, so "the same goal" still
    // means one thing, and it returns the record itself rather than a boolean.
    const out = ctx.goalDateOffer({ text: " olympic TRIATHLON at oslo tri ", targetDate: "2027-08-14" }, [ONGOING]);
    expect(out).toBe(ONGOING);
  });

  // The whole point of the guard: a race he has already pinned is not re-dated
  // from a chat bubble, because moving it re-cuts every phase.
  it("is null when the goal already has a date", () => {
    const { ctx } = loadApp();
    const dated = Object.assign({}, ONGOING, { targetDate: "2027-08-14" });
    expect(ctx.goalDateOffer({ text: ONGOING.text, targetDate: "2027-09-01" }, [dated])).toBe(null);
  });

  it("is null when the proposal carries no date of its own", () => {
    const { ctx } = loadApp();
    expect(ctx.goalDateOffer({ text: ONGOING.text, targetDate: "" }, [ONGOING])).toBe(null);
  });

  it("is null for a goal he does not have", () => {
    const { ctx } = loadApp();
    expect(ctx.goalDateOffer({ text: "Get my cholesterol down", targetDate: "2027-08-14" }, [ONGOING])).toBe(null);
  });

  // Whitespace-only is not a date. Without this, a goal stored with `" "` reads
  // as dated and the offer never comes.
  it("treats a blank stored date as no date", () => {
    const { ctx } = loadApp();
    const blank = Object.assign({}, ONGOING, { targetDate: "  " });
    expect(ctx.goalDateOffer({ text: ONGOING.text, targetDate: "2027-08-14" }, [blank])).toBe(blank);
  });
});

describe("askMarcus keeps the block that carries the missing date", () => {
  const coachReturning = (reply: string) => async () => ({ ok: true, json: async () => ({ reply }) });

  it("keeps a dated proposal for a goal he has with no date", async () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T12:00:00"), fetch: coachReturning(`August 14th it is.\n\n${DATED}`) });
    ctx.store.set("goals", [ONGOING]);
    const out = await ctx.askMarcus("yes, 14 August 2027");
    expect(out.goals).toEqual([{ text: "Olympic triathlon at Oslo Tri", targetDate: "2027-08-14" }]);
    expect(out.text).toBe("August 14th it is.");
  });

  it("still drops it once that goal has a date", async () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T12:00:00"), fetch: coachReturning(`Already on it.\n\n${DATED}`) });
    ctx.store.set("goals", [Object.assign({}, ONGOING, { targetDate: "2027-08-14" })]);
    expect((await ctx.askMarcus("what am I training for?")).goals).toEqual([]);
  });

  // A decline is still a decline. The date does not reopen a card he closed.
  it("still drops one he turned down before", async () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T12:00:00"), fetch: coachReturning(`Sure.\n\n${DATED}`) });
    ctx.store.set("goals", [ONGOING]);
    ctx.store.set("chat", [
      { role: "marcus", text: "x", ts: 1, goalProposal: { text: ONGOING.text, targetDate: "2027-08-14" }, goalDeclined: true },
    ]);
    expect((await ctx.askMarcus("yes, August")).goals).toEqual([]);
  });
});

describe("the date card", () => {
  function withProposal(ctx: any, proposal: any) {
    ctx.store.set("chat", [{ role: "marcus", text: "August 14th it is.", ts: 1000, goalProposal: proposal }]);
  }

  it("asks to set the date instead of saying he already has the goal", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [ONGOING]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain("Set the date");
    expect(html).toContain("Sat, Aug 14, 2027");
    expect(html).not.toContain("Already a goal.");
  });

  it("still says Already a goal when the goal has its date", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [Object.assign({}, ONGOING, { targetDate: "2027-08-14" })]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Already a goal.");
    expect(byId.chatMessages.innerHTML).not.toContain("Set the date");
  });

  it("pins the date on the goal he already has, keeping its id and created day", () => {
    const { ctx, toasts } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [ONGOING]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000, 0);
    const goals = ctx.store.get("goals", []);
    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("g1");
    expect(goals[0].created).toBe("2026-09-01");
    expect(goals[0].targetDate).toBe("2027-08-14");
    expect(goals[0].milestones.length).toBeGreaterThan(0);
    expect(toasts).toContain("Target date set.");
  });

  // Cut from the day the goal was SET, not from this morning -- the date
  // arrived late, the training behind him did not restart.
  it("cuts the phases from the day the goal was created", () => {
    const { ctx } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [ONGOING]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000, 0);
    const fresh = ctx.buildMilestones("2026-09-01", "2027-08-14");
    expect(ctx.store.get("goals", [])[0].milestones.map((m: any) => m.date)).toEqual(fresh.map((m: any) => m.date));
  });

  it("answers the card once, so a second tap changes nothing", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [ONGOING]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.acceptCoachGoal(1000, 0);
    ctx.acceptCoachGoal(1000, 0);
    expect(ctx.store.get("goals", [])).toHaveLength(1);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("Set the date");
  });

  // He set the day himself on the Plan tab while the card sat in the chat.
  it("offers nothing once he has dated the goal another way", () => {
    const { ctx, byId } = loadApp({ now: new Date("2026-09-13T12:00:00") });
    ctx.store.set("goals", [ONGOING]);
    withProposal(ctx, { text: ONGOING.text, targetDate: "2027-08-14" });
    ctx.store.set("goals", [Object.assign({}, ONGOING, { targetDate: "2027-06-01" })]);
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).toContain("Already a goal.");
    expect(ctx.store.get("goals", [])[0].targetDate).toBe("2027-06-01");
  });
});
