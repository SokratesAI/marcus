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

/** The prompt is built here and not in the browser, so what reaches the model
 * is decided in one place and is testable. */
export function buildPrompt(message: string, context: CoachContext, history: ChatTurn[]): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const parts = [
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
  deps: { config: CoachConfig | null; fetch: typeof globalThis.fetch; timeoutMs?: number },
): Promise<CoachResult> {
  const { config } = deps;
  if (!config) return { status: "unconfigured" };

  let model: unknown;
  try {
    const res = await deps.fetch(`${config.baseUrl}/conversations/${config.conversationId}`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { status: "upstream", detail: `conversation read returned ${res.status}` };
    const body = (await res.json()) as { conversation?: { model?: unknown }; model?: unknown };
    model = body.conversation?.model ?? body.model;
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
      body: JSON.stringify({ text: buildPrompt(message, context, history) }),
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
