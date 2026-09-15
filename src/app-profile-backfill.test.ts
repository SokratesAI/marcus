import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Issue #157, the half that was still missing. Marcus asks about his background
// when `profile` is empty (app-chat-opener.test.ts) -- and on 2026-09-07 at
// 22:32 he answered that question already, unprompted, in 1,825 characters:
// achilles tendonitis, an Ironman in Hamburg in 2023, 10kg back on after his
// child was born, 30% body fat, a cholesterol warning, and a sprint triathlon
// in Oslo next August. Marcus replied "Skal se om jeg har notert noe om deg fra
// for" and noted nothing. Measured on his live state at 02:13 on 2026-09-15
// (GET /api/state, rev 15): `data` still carries no `profile` key, and the chat
// still carries all 1,825 characters of it.
//
// So the question as it stands asks him to type his history a second time,
// which is the thing he complained about. These pin the card that offers his
// own words back instead.
//
// Same vm harness as app-chat-opener.test.ts: app.js is a classic script, so
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


/** His own message, near enough. Long enough to clear the cut on its own. */
const HIS_BACKGROUND =
  "Bakgrunnen min er at jeg er semi-aktiv. " +
  "Fra jeg var ung trente jeg aldri noe seriost, kanskje 1-2 timer i uken. " +
  "Jeg er mann, fodt i 1994. I 2020 meldte jeg meg inn i lopegruppen SK Vidar og fikk betennelse i akillesen. " +
  "Jeg gikk over til sykling, fant triatlon i 2021 og tok en hel Ironman i Hamburg i 2023. " +
  "Etter det giftet jeg meg og fikk barn, gikk opp 10kg, og na er det pendling og lopevogn. " +
  "Malet er a ta opp igjen triatlon med en sprint i Oslo i august neste ar.";

/** His message plus the reply he got, because `openerHtml` stands down while
 * the thread is still owed an answer -- his own bubble last IS an owed turn. */
const THREAD = [
  { role: "user", text: HIS_BACKGROUND, ts: 4 },
  { role: "marcus", text: "Skal se om jeg har notert noe om deg fra for.", ts: 5 },
];

const seed = (ctx: any, state: Record<string, unknown>) => {
  Object.entries(state).forEach(([k, v]) => ctx.store.set(k, v));
};

describe("the background he already typed", () => {
  it("finds his own long message and leaves his greetings alone", () => {
    const { ctx } = loadApp();
    const found = ctx.backgroundHeAlreadyTyped([
      { role: "marcus", text: "Hey! I'm Marcus, your trainer.", ts: 1 },
      { role: "user", text: "Hello", ts: 2 },
      { role: "user", text: "Alt egentlig", ts: 3 },
      { role: "user", text: HIS_BACKGROUND, ts: 4 },
    ]);
    expect(found).toEqual({ text: HIS_BACKGROUND, ts: 4 });
  });

  // The cut is measured, not chosen: the longest thing he said in that thread
  // other than his background was 192 characters.
  it("does not read a long message from Marcus as something he said", () => {
    const { ctx } = loadApp();
    expect(
      ctx.backgroundHeAlreadyTyped([{ role: "marcus", text: HIS_BACKGROUND, ts: 1 }]),
    ).toBeNull();
    expect(ctx.backgroundHeAlreadyTyped([{ role: "user", text: "x".repeat(192), ts: 1 }])).toBeNull();
    expect(ctx.backgroundHeAlreadyTyped([])).toBeNull();
    expect(ctx.backgroundHeAlreadyTyped(null)).toBeNull();
  });

  it("takes the newest one when he has written his history twice", () => {
    const { ctx } = loadApp();
    const older = HIS_BACKGROUND + " Det var i fjor.";
    const found = ctx.backgroundHeAlreadyTyped([
      { role: "user", text: older, ts: 1 },
      { role: "user", text: HIS_BACKGROUND, ts: 2 },
    ]);
    expect(found.ts).toBe(2);
  });

  it("is done with a message he has already answered either way", () => {
    const { ctx } = loadApp();
    for (const flag of ["backgroundSaved", "backgroundDeclined"]) {
      expect(
        ctx.backgroundHeAlreadyTyped([{ role: "user", text: HIS_BACKGROUND, ts: 1, [flag]: true }]),
      ).toBeNull();
    }
  });
});

describe("the opening question, once he has already answered it", () => {
  it("offers his own words instead of asking him to type them again", () => {
    const { ctx } = loadApp();
    const ask = ctx.openingQuestion({
      profile: "",
      goals: [],
      sessions: [],
      chat: [{ role: "user", text: HIS_BACKGROUND, ts: 4 }],
    });
    expect(ask.key).toBe("profile-typed");
    expect(ask.background).toEqual({ text: HIS_BACKGROUND, ts: 4 });
    // Untouched: a summary here would put a sentence he never wrote into the
    // record of what he said.
    expect(ask.background.text).toBe(HIS_BACKGROUND);
  });

  it("still asks the question when the thread holds nothing to offer", () => {
    const { ctx } = loadApp();
    const ask = ctx.openingQuestion({ profile: "", goals: [], sessions: [], chat: [{ role: "user", text: "Hello", ts: 1 }] });
    expect(ask.key).toBe("profile");
    expect(ask.background).toBeUndefined();
    // And with no chat at all, which is every call site that predates this.
    expect(ctx.openingQuestion({ profile: "", goals: [], sessions: [] }).key).toBe("profile");
  });

  it("is past the profile entirely once something is on record", () => {
    const { ctx } = loadApp();
    const ask = ctx.openingQuestion({
      profile: "Born 1994.",
      goals: [],
      sessions: [],
      chat: [{ role: "user", text: HIS_BACKGROUND, ts: 4 }],
    });
    expect(ask.key).toBe("goals");
  });
});

describe("the card on the thread", () => {
  it("shows him what it is about to remember, and who wrote it", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: THREAD });
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).toContain('data-opener="profile-typed"');
    expect(html).toContain("Ironman i Hamburg i 2023");
    expect(html).toContain("acceptTypedBackground(4)");
    expect(html).toContain("declineTypedBackground(4)");
  });

  it("writes his words into the profile whole when he taps Remember this", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: THREAD });
    ctx.renderChatMessages();
    ctx.acceptTypedBackground(4);
    expect(ctx.profileText()).toBe(HIS_BACKGROUND);
    // And the card retires itself, because the gap it was drawn from is filled.
    ctx.renderChatMessages();
    expect(byId.chatMessages.innerHTML).not.toContain("acceptTypedBackground");
  });

  it("appends rather than replacing what he had typed himself", () => {
    const { ctx } = loadApp();
    seed(ctx, {
      chat: THREAD,
      profile: { text: "Bor pa Skoyen.", updatedAt: 1 },
    });
    ctx.acceptTypedBackground(4);
    expect(ctx.profileText()).toBe("Bor pa Skoyen." + "\n\n" + HIS_BACKGROUND);
  });

  it("saves nothing when he taps Not this, and does not ask again", () => {
    const { ctx, byId } = loadApp();
    seed(ctx, { chat: THREAD });
    ctx.declineTypedBackground(4);
    expect(ctx.profileText()).toBe("");
    ctx.renderChatMessages();
    const html = byId.chatMessages.innerHTML;
    expect(html).not.toContain("acceptTypedBackground");
    // Back to the question, which is the honest state: it still knows nothing
    // about him, and now it has to ask.
    expect(html).toContain('data-opener="profile"');
  });

  // The guards are re-checked at the tap and not only where the card was drawn.
  it("refuses a second tap, a Marcus bubble, and a message that is now too short", () => {
    const { ctx } = loadApp();
    seed(ctx, {
      chat: [
        { role: "user", text: HIS_BACKGROUND, ts: 4 },
        { role: "marcus", text: HIS_BACKGROUND, ts: 5 },
        { role: "user", text: "Hello", ts: 6 },
        { role: "marcus", text: "Hey!", ts: 7 },
      ],
    });
    ctx.acceptTypedBackground(4);
    const once = ctx.profileText();
    ctx.acceptTypedBackground(4);
    expect(ctx.profileText()).toBe(once);
    ctx.acceptTypedBackground(5);
    ctx.acceptTypedBackground(6);
    ctx.acceptTypedBackground(99);
    expect(ctx.profileText()).toBe(once);
  });

  it("does not offer him something the profile already carries", () => {
    const { ctx } = loadApp();
    seed(ctx, {
      chat: THREAD,
      profile: { text: "Intro. " + HIS_BACKGROUND + " Resten.", updatedAt: 1 },
    });
    const before = ctx.profileText();
    ctx.acceptTypedBackground(4);
    expect(ctx.profileText()).toBe(before);
    expect(ctx.store.get("chat", [])[0].backgroundSaved).toBe(true);
  });
});
