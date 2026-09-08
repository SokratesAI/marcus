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
}

// A cap with a danger behind it rather than a tidiness one: the whole context
// is re-sent on every turn, so an unbounded history is a bill and a latency
// cost that grows with use. Twelve turns is roughly a full conversation on a
// phone screen and the app's own chat sheet holds far more.
export const MAX_HISTORY_TURNS = 12;

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
  if (recent.length) {
    parts.push(
      "EARLIER IN THIS CONVERSATION",
      recent.map((t) => `${t.role === "marcus" ? "Marcus" : "Edvard"}: ${t.text}`).join("\n"),
    );
  }
  parts.push("MESSAGE FROM EDVARD", message);
  return parts.join("\n\n");
}

export type CoachResult =
  | { status: "ok"; reply: string }
  | { status: "unconfigured" }
  /** The conversation is pinned to a metered model. Refused, never sent. */
  | { status: "metered"; model: string }
  | { status: "upstream"; detail: string };

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
  let model: unknown;
  try {
    const res = await deps.fetch(`${config.baseUrl}/conversations?active=true`, {
      signal: AbortSignal.timeout(deps.readTimeoutMs ?? 10_000),
    });
    if (!res.ok) return { status: "upstream", detail: `conversation read returned ${res.status}` };
    const body = (await res.json()) as { conversations?: unknown } | unknown[];
    const rows = Array.isArray(body) ? body : Array.isArray(body?.conversations) ? body.conversations : [];
    const row = (rows as { id?: unknown; model?: unknown }[]).find(
      (c) => c?.id === config.conversationId,
    );
    if (!row) return { status: "upstream", detail: "conversation not in the active listing" };
    model = row.model;
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
    return { status: "ok", reply: body.reply };
  } catch (err) {
    return { status: "upstream", detail: String((err as Error)?.message ?? err) };
  }
}
