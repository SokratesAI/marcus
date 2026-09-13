// Idea #206 asks for a real LLM-backed Marcus, "same interaction pattern as
// chatting with Nova, different character". So this reuses the machinery that
// already answers Nova rather than inventing a second one: Agora's
// `POST /conversations/:id/ask`, which invokes the persona runner once and
// returns the reply synchronously. No polling, no second message store.
//
// Two constraints shape everything below.
//
// The hard one is Edvard's rule that production never spends the metered
// Anthropic API. The conversation this points at is pinned to a `claude-cli:`
// model -- the same models through the flat subscription -- and `askCoach`
// refuses to send anything to a conversation whose model is metered, so the
// rule is enforced here rather than remembered. That check needs the model,
// which is why this reads the conversation before it asks.
//
// The soft one is that Marcus's chat history lives in the browser, not in
// Agora. `/ask` does not persist the message it is given, so the whole context
// -- his training data and the recent turns -- is assembled per request and
// sent as one block. The conversation is a persona holder, nothing more.

import { phasePosition, type DraftGoal } from "./goal-phase.js";

export interface CoachConfig {
  baseUrl: string;
  conversationId: string;
}

/** Read from the environment so a redeploy can repoint it without a build. */
export function coachConfig(env: NodeJS.ProcessEnv): CoachConfig | null {
  const baseUrl = env.AGORA_BASE_URL;
  const conversationId = env.MARCUS_COACH_CONVERSATION_ID;
  if (!baseUrl || !conversationId) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), conversationId };
}

export interface ChatTurn {
  role: string;
  text: string;
}

/** Everything the coach is allowed to see. Deliberately the shape the app
 * already stores, so nothing has to be kept in step by hand. */
export interface CoachContext {
  plan?: unknown;
  sessions?: unknown[];
  weights?: unknown[];
  meals?: unknown[];
  goals?: unknown[];
  /** Free text Edvard wrote about himself: age, history, injuries, how active
   * he is. Stored by the app under `profile` and synced like the rest, so it
   * follows him to another phone the way his chat history does not. */
  profile?: unknown;
  /** Not part of the store. The texts of goals the coach proposed and Edvard
   * turned down, which nothing else in this prompt can carry -- see
   * `declinedGoals()` below. */
  declinedGoals?: unknown[];
  /** Not part of the store either. The texts of facts about him the coach
   * proposed and Edvard turned down -- the same problem as `declinedGoals`,
   * for the same reason: the block is stripped before the bubble is stored, so
   * nothing else in this prompt carries the refusal. */
  declinedFacts?: unknown[];
}

// A cap with a danger behind it rather than a tidiness one: the whole context
// is re-sent on every turn, so an unbounded history is a bill and a latency
// cost that grows with use. Twelve turns is roughly a full conversation on a
// phone screen and the app's own chat sheet holds far more.
export const MAX_HISTORY_TURNS = 12;

// What the window drops is only ever HIS half. Marcus's own replies are
// re-derivable from the training data and the plan; a sentence of Edvard's is
// not stored anywhere else, so once it scrolls past turn twelve the coach has
// no way back to it -- he tells it about his doctor's cholesterol note on
// Monday and by Friday it has never heard of it. The browser already posts the
// whole chat (public/app.js `askMarcus`), so nothing new has to be stored to
// fix this: his older messages are simply carried forward on their own.
//
// The cap here has the same danger behind it as the one above and not a
// tidiness one: this block is re-sent on every turn, so an unbounded one is a
// bill that grows with use. 4,000 characters is roughly a thousand tokens --
// a fraction of the training-data JSON already sent above it -- and about
// forty phone-typed messages.
export const MAX_EARLIER_CHARS = 4000;

/** Edvard's own messages from before the recent window, oldest first.
 *
 * When the budget binds it keeps the NEWEST that fit and stops at the first
 * one too big, rather than skipping it and reaching further back: a
 * contiguous run of what he said is readable, a set with holes in it invites
 * the model to join two statements that were never next to each other. The
 * count of what did not fit is returned rather than swallowed, because the
 * model reading "3 older messages are not shown" knows the conversation goes
 * back further, and a silently truncated list tells it the opposite. */
export function earlierInHisWords(
  history: ChatTurn[],
  budget: number = MAX_EARLIER_CHARS,
): { lines: string[]; dropped: number } {
  const older = history
    .slice(0, Math.max(0, history.length - MAX_HISTORY_TURNS))
    .filter((t) => t && t.role !== "marcus" && typeof t.text === "string" && t.text.trim() !== "");
  const lines: string[] = [];
  let used = 0;
  for (let i = older.length - 1; i >= 0; i -= 1) {
    const line = older[i].text.trim();
    if (used + line.length > budget) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  return { lines, dropped: older.length - lines.length };
}

/** Today's date in Edvard's own timezone, as `YYYY-MM-DD`.
 *
 * The server runs in UTC and he does not, so a bare `toISOString().slice(0, 10)`
 * is his yesterday for the first two hours of every day (one in summer). The
 * app is single-user and he is in Oslo, so this is a fact about the one person
 * using it rather than a guess. It is only ever the fallback: the phone sends
 * its own date, and that is the clock that is actually his. */
export function osloDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the shape everything else here uses.
  return now.toLocaleDateString("en-CA", { timeZone: "Europe/Oslo" });
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday of a calendar date, computed only from its three numbers.
 *
 * `new Date("2026-09-07T00:00")` is midnight in whatever timezone the process
 * happens to be in, so on a server west of UTC it is the Sunday, not the
 * Monday. There is no timezone in a calendar date to get wrong, so this does
 * not involve one: `Date.UTC` plus `getUTCDay` gives the same answer wherever
 * this runs. */
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `YYYY-MM-DD` and a date that really exists. A client that sends something
 * else gets the fallback rather than a prompt that says `TODAY 2026-13-45`.
 *
 * The round trip is the entire check, and a shape regex in front of it would
 * be dead code: `toISOString()` emits exactly `YYYY-MM-DD`, so anything that
 * is not already in that shape fails the comparison even when it parses. */
function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The phase each dated goal is in today, as sentences the app computed.
 *
 * The goals go into TRAINING DATA as raw JSON, milestone dates and all, so the
 * only way the coach could answer "what should this week look like?" was to
 * work out from four dates which phase today falls in and how far through it
 * is. That is arithmetic against a clock, which is the one thing the TODAY
 * block above exists because the model got wrong. The drafted week has never
 * had to do it -- `phasePosition` hands it the same sentence -- and the chat,
 * which is where Edvard actually asks, did not.
 *
 * Same function, not a second copy: the drafted week and the chat must never
 * disagree about which week of which phase this is. A goal with no target date
 * has no phases and contributes no line, and a goal whose target day has passed
 * returns null, so a finished race does not get described as current.
 */
function goalStandings(goals: unknown[], todayISO: string): string {
  return (Array.isArray(goals) ? goals : [])
    .map((goal) => {
      if (!goal || typeof goal !== "object") return null;
      const position = phasePosition(goal as DraftGoal, todayISO);
      if (!position) return null;
      const text = String((goal as { text?: unknown }).text ?? "").trim();
      return text ? `${text}: ${position}` : position;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** The goals he was offered and said no to.
 *
 * Nothing else in this prompt can carry a decline. The ```goal block is
 * stripped out of the reply before the app stores the bubble, so the coach's
 * own history does not show that it proposed anything, and a decline is a tap
 * rather than a message, so Edvard's half does not show it either -- while the
 * sentence of his that produced the block is still inside the history window.
 * So the model re-proposes the same goal on the next turn, every turn, and he
 * gets the same card again until the statement scrolls out of the window.
 *
 * The app drops a repeat proposal at the call site regardless, so this is not
 * what stops the second card; what it stops is the reply around it -- "I have
 * written that down for you to confirm" with nothing under it to confirm. */
function declinedGoals(texts: unknown[]): string {
  return (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .map((t) => `- ${t}`)
    .join("\n");
}

// A cap with a danger behind it rather than a tidiness one, same as the two
// above: this block is re-sent on every turn. 2,000 characters is a long
// paragraph about a person and about five hundred tokens; what it protects
// against is a box somebody pastes a document into.
export const MAX_PROFILE_CHARS = 2000;

/** What Edvard has written about himself, trimmed and capped.
 *
 * Anything that is not a non-empty string comes back as `""` -- the caller
 * decides whether to print a section at all, so an empty profile adds no
 * heading rather than a heading with nothing under it. Over-long text is cut
 * at the cap and the cut is stated in the prompt rather than hidden, because a
 * model reading half a sentence with no warning will finish it itself. */
export function aboutHim(profile: unknown, budget: number = MAX_PROFILE_CHARS): { text: string; truncated: boolean } {
  if (typeof profile !== "string") return { text: "", truncated: false };
  const trimmed = profile.trim();
  if (trimmed === "") return { text: "", truncated: false };
  if (trimmed.length <= budget) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, budget).trimEnd(), truncated: true };
}

/** The prompt is built here and not in the browser, so what reaches the model
 * is decided in one place and is testable.
 *
 * `today` is the phone's own local date. Without it the model was reading the
 * newest rows in the training data as current, because nothing in the prompt
 * said otherwise: on 2026-09-08 the coach answered "you put up 3,691kg of
 * volume this week" about a week whose last session was eight days old. The
 * data was right and there was no clock to judge it against, so the block
 * below is one date and one sentence telling the model to use it. */
export function buildPrompt(
  message: string,
  context: CoachContext,
  history: ChatTurn[],
  today?: string,
): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const day = validDate(today) ? today : osloDate();
  const weekday = WEEKDAYS[weekdayIndex(day)];
  const parts = [
    "TODAY",
    `${day} (${weekday}). Read every date in the training data against this one. Do not describe a session, a week or a weight as current unless its date says it is -- if the most recent session is older than this week, say how long ago it was.`,
    "TRAINING DATA (Edvard's own records, as stored by the app)",
    JSON.stringify(
      {
        plan: context.plan ?? null,
        sessions: context.sessions ?? [],
        weights: context.weights ?? [],
        meals: context.meals ?? [],
        goals: context.goals ?? [],
      },
      null,
      1,
    ),
  ];
  // Above the goal standings and the history on purpose: this is who he is,
  // and everything below it is what he has been doing.
  const about = aboutHim(context.profile);
  if (about.text) {
    parts.push(
      "ABOUT EDVARD",
      [
        "What he has told the app about himself. Treat it as established fact he does not have to repeat, and do not ask him for anything it already answers.",
        about.truncated ? "It is longer than this and has been cut off here." : "",
      ]
        .filter(Boolean)
        .join(" "),
      about.text,
    );
  }
  const standing = goalStandings(context.goals ?? [], day);
  if (standing) parts.push("WHERE EACH GOAL STANDS TODAY", standing);
  const earlier = earlierInHisWords(history);
  if (earlier.lines.length || earlier.dropped) {
    parts.push(
      "EARLIER, IN HIS OWN WORDS",
      [
        "Things Edvard said earlier in this same conversation, oldest first, before the recent turns below. Your own replies to them are not shown.",
        earlier.dropped
          ? `${earlier.dropped} older message(s) of his are older still and are not shown at all, so this conversation reaches back further than what you can see.`
          : "",
        "Treat these as things he has already told you: do not ask him again for something he has said here, and do not describe any of it as new.",
      ]
        .filter(Boolean)
        .join(" "),
      ...(earlier.lines.length ? [earlier.lines.map((l) => `Edvard: ${l}`).join("\n")] : []),
    );
  }
  if (recent.length) {
    parts.push(
      "EARLIER IN THIS CONVERSATION",
      recent.map((t) => `${t.role === "marcus" ? "Marcus" : "Edvard"}: ${t.text}`).join("\n"),
    );
  }
  parts.push(GOAL_INSTRUCTION);
  parts.push(profileInstruction(Boolean(about.text)));
  const declined = declinedGoals(context.declinedGoals ?? []);
  if (declined) {
    parts.push(
      "GOALS HE HAS ALREADY TURNED DOWN",
      "He was shown a card for each of these and chose not to save it. Do not write a goal block for any of them again, and do not tell him you have written one down, unless he asks you in this message to set it up.",
      declined,
    );
  }
  // Same list shape as the goals above -- `declinedGoals` is a bullet list and
  // nothing about it is goal-specific, so a second formatter here would be a
  // second thing to keep in step.
  const refused = declinedGoals(context.declinedFacts ?? []);
  if (refused) {
    parts.push(
      "THINGS ABOUT HIM HE HAS ALREADY TURNED DOWN",
      "He was shown a card for each of these and chose not to have it noted. Do not write a profile block for any of them again, and do not treat them as established fact.",
      refused,
    );
  }
  parts.push("MESSAGE FROM EDVARD", message);
  return parts.join("\n\n");
}

/** The one thing the coach is allowed to write back into the app.
 *
 * Idea #209 asks for a goal stated in natural language to become a real goal
 * record. On 2026-09-07 Edvard did exactly that in the chat -- a sprint and
 * maybe an Olympic triathlon at Oslo Tri next August, the rides and runs he is
 * doing now, his doctor's cholesterol note -- and nothing turned any of it into
 * a `goals` record, because the only way to write one was a form on the Plan
 * tab. His synced state still has no `goals` key at all. A coach you have to
 * leave in order to write down what you just told him is not a coach.
 *
 * The block is a proposal, never a write. The app strips it out of the reply,
 * shows a card, and stores nothing until he taps Set goal -- the same contract
 * the drafted week already has ("nothing changes until you accept it"). So the
 * worst a wrong block can do is put a card on the screen that he declines.
 *
 * It is asked for in a fenced block rather than as loose JSON because a fence
 * is the one shape a model reliably closes, and because an unfenced object in
 * a paragraph cannot be stripped back out without guessing where it starts. */
export const GOAL_INSTRUCTION = [
  "WRITING A GOAL DOWN",
  'If Edvard states something he is training for -- a race, an event, a date, or an ongoing aim like getting his cholesterol down -- end your reply with a block in exactly this shape, after your normal answer:',
  '```goal',
  '{"text": "Olympic triathlon at Oslo Tri", "targetDate": "2027-08-14"}',
  "```",
  'Rules: `text` is his goal in his own words, short enough to read on a card. `targetDate` is `YYYY-MM-DD` if he named a day or a month you can pin to one, and `""` if there is no date -- an ongoing goal is a real goal and must not be given an invented date. One block per goal he actually stated, in the order he said them -- if he named a race and an ongoing aim in the same message, write both, because he should not have to say the second one again to get a card for it. Do not write a block for a goal already in TRAINING DATA above, and do not write one because you think he should have a goal -- only when he has actually told you one in this conversation. He has to confirm each one before anything is saved, so do not claim in your reply that you have saved anything; say you have written them down for him to confirm.',
].join("\n");

/** The other half of the profile record (issue #157).
 *
 * `ABOUT EDVARD` above is read-only from the model's side: he had to open the
 * Plan tab and retype into a box what he had just typed into the chat. This
 * asks for the same confirm-card contract the goal block has -- the model
 * proposes, he taps, the app writes. Nothing here saves anything.
 *
 * The fence is `profile` rather than `fact` because it names the record it
 * lands in, and the shape is deliberately the goal block's so one stripper
 * pattern covers both. */
export function profileInstruction(hasAbout: boolean): string {
  return [
    "NOTING SOMETHING ABOUT HIM",
    "If Edvard tells you something lasting about himself -- his age, his training background, how active he is, an illness or injury and how it left him, something a coach would want to know months from now -- end your reply with a block in exactly this shape:",
    "```profile",
    '{"text": "Born 1994. Semi-active. Had covid in 2020 and his endurance never fully came back."}',
    "```",
    [
      "Rules: `text` is the fact in plain words, a sentence or two, written about him in the third person so it reads as a note.",
      "One block per reply, for the single most useful thing he just told you.",
      // Only when that section was actually printed. Pointing a model at a
      // heading that is not in its prompt is how it starts inventing what was
      // under it -- and an empty profile is exactly the state where every fact
      // he says is worth a card, so a rule telling it not to repeat one is
      // worse than useless there.
      hasAbout ? "Do not write a block for anything already in ABOUT EDVARD above." : "",
      "Do not write one for how a single session went or how he feels today -- that is training data, not who he is.",
      "He has to confirm it before anything is saved, so do not claim you have saved it; say you have noted it down for him to confirm.",
      "This block and any goal blocks can all appear in one reply, the goal blocks first.",
    ]
      .filter(Boolean)
      .join(" "),
  ].join("\n");
}

// The Claude CLI writes `**1 tool use**` into a turn's text where a tool call
// happened, and that marker reaches this function verbatim: `/ask` hands back
// whatever the turn produced. It is a UI artefact of the transcript, never
// something the coach meant to say, so a reader gets a sentence that stops
// mid-thought followed by a bolded number.
//
// This is not hypothetical. Edvard's own chat log on the server ends, on
// 2026-09-07T20:32Z, with exactly that: he had just typed several paragraphs
// of his training background, and the whole answer he got was "Skal se om jeg
// har notert noe om deg fra før, så jeg ikke overskriver det jeg allerede
// vet." followed by `**1 tool use**`. He has not opened the app since. The
// cause was fixed a day later on the Agora side (the Ask turn was told about
// tools it was not granted, so the model called one and the call reached
// nothing), which is why this strips rather than diagnoses: the marker means a
// tool call went nowhere, and there is nothing useful to show the reader
// either way.
//
// Deliberately narrow. It matches only a line that is the whole marker, so a
// reply that happens to discuss tool use in a sentence is untouched.
const TOOL_USE_MARKER = /^\s*\*\*\d+ tool uses?\*\*\s*$/;

export function stripToolUseMarkers(reply: string): string {
  return reply
    .split("\n")
    .filter((line) => !TOOL_USE_MARKER.test(line))
    .join("\n")
    .trim();
}

export type CoachResult =
  | { status: "ok"; reply: string }
  | { status: "unconfigured" }
  /** The conversation is pinned to a metered model. Refused, never sent. */
  | { status: "metered"; model: string }
  | { status: "upstream"; detail: string };

/** How many extra times a structured answer is asked for when what came back
 * did not parse. One: the second sample costs him another 13 seconds and takes
 * a one-in-six failure to about one in thirty-six, and a third would make him
 * wait forty seconds for a button that was probably never going to work. */
export const SHAPE_RESAMPLES = 1;

/** The budget for the second attempt at the conversation-model read, when the
 * first one threw. Three seconds: 30 live reads of Agora's active listing on
 * 2026-09-13 ran 0.17s to 0.88s, so this is over three times the slowest one
 * and the retry is invisible on any request that was going to work. */
export const READ_RETRY_TIMEOUT_MS = 3_000;

/** `askCoach` for the two routes that need a shape back rather than a sentence
 * -- the drafted week and a goal's phases. It asks again when the reply does
 * not parse, and hands back the last parse either way, so each caller's own
 * refusal message is unchanged.
 *
 * Measured live on 2026-09-13, before this existed: six identical
 * `POST /api/plan-draft` calls against the running pod returned five weeks and
 * one `the coach did not answer with JSON`. Identical body every time, so that
 * is the model sampling differently rather than a prompt that cannot work --
 * and no wording fixes a one-in-six. Asking twice does.
 *
 * Only a parse failure is resampled. An `upstream` result may be a timeout he
 * has already waited out once, and `metered` or `unconfigured` answer the same
 * way however often they are asked. */
export async function askCoachShaped<P extends { ok: boolean }>(
  message: string,
  context: CoachContext,
  history: ChatTurn[],
  deps: Parameters<typeof askCoach>[3],
  parse: (reply: string) => P,
): Promise<{ status: "parsed"; parsed: P } | Exclude<CoachResult, { status: "ok" }>> {
  let parsed: P | null = null;
  for (let attempt = 0; attempt <= SHAPE_RESAMPLES; attempt += 1) {
    const result = await askCoach(message, context, history, deps);
    if (result.status !== "ok") {
      // A resample that could not reach the coach says nothing about the answer
      // he already has. Report that one rather than a connection problem only
      // the retry hit.
      if (parsed) return { status: "parsed", parsed };
      return result;
    }
    parsed = parse(result.reply);
    if (parsed.ok) break;
  }
  // The loop body runs at least once and every path out of it either returns or
  // assigns, so this is never the initial null.
  return { status: "parsed", parsed: parsed as P };
}

export async function askCoach(
  message: string,
  context: CoachContext,
  history: ChatTurn[],
  deps: {
    /** The phone's own local date, `YYYY-MM-DD`. Anything else falls back to
     * Oslo's date on this server. */
    today?: string;
    config: CoachConfig | null;
    fetch: typeof globalThis.fetch;
    /** Separate from `timeoutMs` on purpose: the listing read is a cheap JSON
     * fetch and the ask is a model call behind a queue. */
    readTimeoutMs?: number;
    timeoutMs?: number;
  },
): Promise<CoachResult> {
  const { config } = deps;
  if (!config) return { status: "unconfigured" };

  // Agora has no `GET /conversations/<id>` -- measured live, it answers 404 --
  // so the model is read off the listing, which carries it per row. `?active=true`
  // is the filtered listing (53 rows rather than 1,083); an archived coach
  // conversation is absent from it, which is the right answer here anyway,
  // because a conversation somebody archived should stop answering.
  //
  // This read is a preflight, not the work, and until 2026-09-13 a single
  // stall in it threw away the whole request: the marcus pod logged
  // `The operation was aborted due to timeout` once on 09-13 and Edvard got a
  // 502 after ten seconds without the coach ever being asked. The listing is
  // not slow -- 30 live calls that afternoon ran 0.17s to 0.88s, so the 10s
  // budget is eleven times the slowest one and only expires when Agora itself
  // hiccups. So it is asked a second time, on a shorter budget, and only when
  // the first attempt *threw*: an HTTP status and an absent row are answers,
  // and asking again does not change either.
  let model: unknown;
  const readModel = async (timeoutMs: number): Promise<CoachResult | { status: "read"; model: unknown }> => {
    const res = await deps.fetch(`${config.baseUrl}/conversations?active=true`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: "upstream", detail: `conversation read returned ${res.status}` };
    const body = (await res.json()) as { conversations?: unknown } | unknown[];
    const rows = Array.isArray(body) ? body : Array.isArray(body?.conversations) ? body.conversations : [];
    const row = (rows as { id?: unknown; model?: unknown }[]).find(
      (c) => c?.id === config.conversationId,
    );
    if (!row) return { status: "upstream", detail: "conversation not in the active listing" };
    return { status: "read", model: row.model };
  };
  try {
    let read: Awaited<ReturnType<typeof readModel>>;
    try {
      read = await readModel(deps.readTimeoutMs ?? 10_000);
    } catch (first) {
      // The retry deliberately gets its own, shorter budget rather than the
      // full one again. If the first attempt burned ten seconds Agora is
      // stalled, and three seconds is still three times the slowest read
      // measured -- so a transient stall costs him 13s instead of the draft,
      // and a genuinely dead Agora costs him 3s more than it used to.
      try {
        read = await readModel(READ_RETRY_TIMEOUT_MS);
      } catch {
        // The first failure is the representative one and the one he waited
        // out; the retry's is a second symptom of the same stall.
        throw first;
      }
    }
    if (read.status !== "read") return read;
    model = read.model;
  } catch (err) {
    return { status: "upstream", detail: String((err as Error)?.message ?? err) };
  }

  // A conversation with no model at all falls back to Agora's default, which
  // this cannot see, so it is refused for the same reason a metered one is:
  // the point of the check is that nothing unpriced reaches the runner.
  if (typeof model !== "string" || !model.startsWith("claude-cli:")) {
    return { status: "metered", model: typeof model === "string" ? model : "unset" };
  }

  try {
    const res = await deps.fetch(`${config.baseUrl}/conversations/${config.conversationId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildPrompt(message, context, history, deps.today) }),
      // A coach turn is a model call behind a queue, so this is generous on
      // purpose; the client falls back to the built-in reply if it expires.
      signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
    });
    if (!res.ok) return { status: "upstream", detail: `ask returned ${res.status}` };
    const body = (await res.json()) as { reply?: unknown };
    if (typeof body.reply !== "string" || body.reply.trim().length === 0) {
      return { status: "upstream", detail: "ask returned no reply" };
    }
    // A turn that was nothing but a tool call leaves nothing once the marker
    // is gone. That is the same outcome as no reply at all, and saying so lets
    // /api/chat answer 502 and the page fall back to its own built-in reply --
    // which is a real sentence -- instead of storing a blank coach message.
    const reply = stripToolUseMarkers(body.reply);
    if (reply.length === 0) {
      return { status: "upstream", detail: "ask returned only a tool-use marker" };
    }
    return { status: "ok", reply };
  } catch (err) {
    return { status: "upstream", detail: String((err as Error)?.message ?? err) };
  }
}
