import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import pino from "pino";
import { StateStore } from "./state-store.js";
import { FoodCache, SearchCache, lookupBarcode, searchFoodsByName } from "./food-lookup.js";
import { askCoach, coachConfig, type CoachConfig } from "./coach.js";
import { draftWeek } from "./plan-draft.js";
import { SubscriptionStore, VapidKeyStore, validateSubscription } from "./push.js";
import { declarativePayload, sendPush, sendToAll } from "./push-send.js";
import {
  initTracing,
  parentContext,
  tracingMiddleware,
  type ParentContextReader,
  type TracerLike,
} from "./tracing.js";

const logger = pino();
const port = Number(process.env.PORT ?? 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The volume the marcus Deployment mounts. Overridable so a test never writes
// to a real one.
export const DEFAULT_DATA_DIR = process.env.MARCUS_DATA_DIR ?? "/data";

// A cap with a danger behind it: this is one 1Gi volume and the body arrives
// from a phone, so an unbounded PUT fills the disk for every later write.
// Marcus's whole store is a few hundred kilobytes of text.
const MAX_BODY = "4mb";

export interface AppOptions {
  /** Both injected only so a test never reaches Open Food Facts and never
   * writes a cache file next to a real state file. Production passes neither. */
  foodCache?: FoodCache;
  searchCache?: SearchCache;
  fetchImpl?: typeof globalThis.fetch;
  /** Null means the coach route answers 503 and the app keeps its built-in
   * replies. Production resolves it from the environment. */
  coach?: CoachConfig | null;
  /** Both injected only so a test never generates a keypair beside a real
   * state file, nor reads the phones actually subscribed. Production passes
   * neither. */
  vapidKeys?: VapidKeyStore;
  subscriptions?: SubscriptionStore;
  /** Passed by the entrypoint after `initTracing`. Null, and therefore a
   * pass-through, everywhere else -- a test must not open a span. */
  tracer?: TracerLike | null;
  /** Also from `initTracing`, via `parentContext()`. Null means every span
   * here starts a new trace, which is what a request from a browser does
   * anyway; a call from another instrumented service continues its trace. */
  parent?: ParentContextReader | null;
}

export function createApp(
  store: StateStore,
  now: () => string = () => new Date().toISOString(),
  options: AppOptions = {},
): Express {
  const app = express();
  const foodCache = options.foodCache ?? new FoodCache(path.dirname(store.filePath));
  const searchCache = options.searchCache ?? new SearchCache(path.dirname(store.filePath));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const coach = options.coach !== undefined ? options.coach : coachConfig(process.env);
  const vapidKeys = options.vapidKeys ?? new VapidKeyStore(path.dirname(store.filePath));
  const subscriptions = options.subscriptions ?? new SubscriptionStore(path.dirname(store.filePath));

  // First, so the span covers the body parser and the static handler as well
  // as the API routes.
  app.use(tracingMiddleware(options.tracer ?? null, options.parent ?? null));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/state", async (_req, res) => {
    try {
      res.status(200).json(await store.read());
    } catch (err) {
      logger.error({ err }, "could not read state");
      res.status(500).json({ error: "could not read the stored state" });
    }
  });

  app.put("/api/state", express.json({ limit: MAX_BODY }), async (req, res) => {
    const body = req.body as { rev?: unknown; data?: unknown } | undefined;
    try {
      const result = await store.put(body?.rev, body?.data, now());
      if (result.ok) {
        res.status(200).json(result.state);
        return;
      }
      // 409 carries the current state on purpose: the client that lost needs
      // to see what it lost to, and a second GET would race the next write.
      res.status(result.reason === "conflict" ? 409 : 400).json({
        error: result.message,
        state: result.state,
      });
    } catch (err) {
      logger.error({ err }, "could not write state");
      res.status(500).json({ error: "could not write the state" });
    }
  });

  // Idea #215: the one place a barcode leaves this cluster. The browser asks
  // us, never Open Food Facts directly, so the rate-limit etiquette and the
  // "what is Edvard eating" question are both decided here rather than per
  // request from a phone.
  app.get("/api/food/barcode/:code", async (req, res) => {
    const code = String(req.params.code);
    const result = await lookupBarcode(code, { cache: foodCache, fetch: fetchImpl });
    if (result.status === "invalid") {
      res.status(400).json({ error: "a barcode is 8 to 14 digits" });
      return;
    }
    if (result.status === "upstream") {
      // 502, not 500: nothing here is broken and the client should offer the
      // hand-typed path rather than a retry loop against someone else's API.
      logger.warn({ code }, "open food facts did not answer");
      res.status(502).json({ error: "the food database did not answer" });
      return;
    }
    if (result.status === "missing") {
      res.status(404).json({ error: "no product with that barcode", code, cached: result.cached });
      return;
    }
    res.status(200).json({ food: result.row, cached: result.cached });
  });

  // Idea #205's remaining half. The barcode route above answers "what is in
  // this packet"; this answers "what is a Grandiosa", which is the question the
  // meal-sentence parser is left holding when a phrase matches nothing in the
  // 31-food table. Same proxy, same reasons, same row shape out -- the browser
  // learns no second format and Open Food Facts sees one identified caller.
  app.get("/api/food/search", async (req, res) => {
    const query = String(req.query.q ?? "");
    const result = await searchFoodsByName(query, { cache: searchCache, fetch: fetchImpl });
    if (result.status === "invalid") {
      res.status(400).json({ error: "a search needs 2 to 60 characters" });
      return;
    }
    if (result.status === "upstream") {
      // 502 rather than 500, and the same call the barcode route makes: nothing
      // here is broken, and the client should offer the hand-typed path instead
      // of retrying against someone else's API.
      logger.warn({ query }, "open food facts search did not answer");
      res.status(502).json({ error: "the food database did not answer" });
      return;
    }
    if (result.status === "missing") {
      res.status(404).json({ error: "nothing matched that", cached: result.cached });
      return;
    }
    res.status(200).json({ foods: result.rows, cached: result.cached });
  });


  // Idea #217, first slice. The browser needs the application server's public
  // key before it can subscribe at all, so this is the first call the phone
  // makes -- and the keypair is minted on this request the first time anyone
  // ever asks, which is why there is no setup step anywhere.
  app.get("/api/push/key", async (_req, res) => {
    try {
      const keys = await vapidKeys.ensure();
      // Only ever the public half. The private key has one reader and it is
      // not over HTTP.
      res.status(200).json({ key: keys.publicKey });
    } catch (err) {
      // Nothing derived from `vapidKeys` is logged here, not even the file
      // path. CodeQL treats every access to that object as a source because
      // it holds a private key, and rather than argue the taint I took the
      // narrow log: there is one key file and its path is DEFAULT_DATA_DIR +
      // "/vapid-keys.json", so the message alone says where to look. `err` is
      // deliberately dropped -- it comes off the same object.
      void err;
      logger.error("could not read or generate the VAPID keypair");
      res.status(500).json({ error: "could not read the push key" });
    }
  });

  app.post("/api/push/subscribe", express.json({ limit: "16kb" }), async (req, res) => {
    const record = validateSubscription(req.body);
    if (record === null) {
      res.status(400).json({ error: "that is not a push subscription" });
      return;
    }
    try {
      const result = await subscriptions.save(record, now());
      if (!result.ok) {
        // 507, not 400: the body was fine and the server is the one that has
        // run out, so the phone should say so rather than retry a fixed body.
        res.status(result.reason === "full" ? 507 : 400).json({ error: result.message });
        return;
      }
      res.status(result.created ? 201 : 200).json({ subscribed: true, count: result.count });
    } catch (err) {
      logger.error({ err }, "could not store the push subscription");
      res.status(500).json({ error: "could not store the subscription" });
    }
  });

  app.delete("/api/push/subscribe", express.json({ limit: "16kb" }), async (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    try {
      const result = await subscriptions.remove(endpoint);
      // 200 either way: a phone that has already forgotten its subscription and
      // one that never had it want the same thing to happen next, which is
      // nothing.
      res.status(200).json({ subscribed: false, removed: result.removed, count: result.count });
    } catch (err) {
      logger.error({ err }, "could not remove the push subscription");
      res.status(500).json({ error: "could not remove the subscription" });
    }
  });

  // Issue: Edvard's card read "on for this device" while the server's list was
  // empty, so the 20:00 job had nobody to send to and the test button answered
  // 404 -- two halves of one state that nothing ever compared. `getSubscription`
  // is the browser's half; this route is the server's, and it is the only way a
  // phone can find out that Marcus has forgotten it before a reminder is due.
  //
  // Same authorisation as `/api/push/test` and for the same reason: the
  // endpoint is a long unguessable URL the browser holds, and a caller who has
  // it can already unsubscribe that device through DELETE. This answers strictly
  // less than that call does. It is POST rather than GET so the endpoint stays
  // out of access logs and referrers.
  //
  // It never returns the list, or a count, or any endpoint it was not given.
  // The question is "do you have this one", and a route that answers anything
  // wider is a route that leaks Edvard's other devices to whoever holds one.
  app.post("/api/push/status", express.json({ limit: "16kb" }), async (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    try {
      const subs = await subscriptions.list();
      res.status(200).json({ known: subs.some((s) => s.endpoint === endpoint) });
    } catch (err) {
      logger.error({ err }, "could not read the push subscriptions");
      // 500 and not `{ known: false }`: an unreadable store is not the same
      // fact as an absent device, and the phone must not re-register itself
      // over a disk error.
      res.status(500).json({ error: "could not read the subscriptions" });
    }
  });

  // Idea #217, second slice: the send itself. This is the route the 20:00
  // CronJob calls; it is not a route a phone calls, which is why it is the one
  // route here that needs a credential.
  //
  // Closed rather than open when `MARCUS_PUSH_TOKEN` is unset. Every other
  // route on this server takes an unauthenticated body from whoever can reach
  // it, and that is a decision about a training log on a private network. This
  // one reaches Edvard's lock screen, so an unconfigured deployment must not be
  // one that anybody who can reach the pod may buzz his phone through.
  // One send at a time, per process. Marcus runs a single replica and that is
  // the whole of the guard it needs; a second replica would need the lock to
  // live beside the subscriptions instead.
  let sendInFlight = false;

  app.post("/api/push/send", express.json({ limit: "16kb" }), async (req, res) => {
    const token = process.env.MARCUS_PUSH_TOKEN;
    if (!token) {
      res.status(503).json({ error: "sending is not configured here" });
      return;
    }
    const offered = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    // Constant time, and length-checked first because timingSafeEqual throws
    // on a length mismatch rather than returning false.
    const ok =
      offered.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(offered, "utf8"), Buffer.from(token, "utf8"));
    if (!ok) {
      res.status(401).json({ error: "not authorised to send" });
      return;
    }
    const { title, body, navigate, tag } = req.body as Record<string, unknown>;
    if (typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (typeof body !== "string" || body.trim().length === 0) {
      res.status(400).json({ error: "body is required" });
      return;
    }
    if (sendInFlight) {
      // 409 and not a queue: a CronJob that times out and retries, or a retry
      // racing the scheduled run, would otherwise buzz his phone twice for one
      // logical reminder. Refusing the second is the behaviour a caller can
      // reason about; silently sending twice is not.
      res.status(409).json({ error: "a send is already in flight" });
      return;
    }
    sendInFlight = true;
    try {
      const payload = declarativePayload({
        title: title.trim(),
        body: body.trim(),
        // A tap has to land somewhere and the declarative format requires it,
        // so a caller that names nothing gets the app's own root rather than a
        // notification the browser refuses to render.
        navigate: typeof navigate === "string" && navigate.length > 0 ? navigate : "/",
        tag: typeof tag === "string" && tag.length > 0 ? tag : undefined,
      });
      // Its own try, with `err` dropped: CodeQL treats every access to
      // `vapidKeys` as a private-key source, and the wider catch below wants
      // to log the error object rather than throw it away.
      let keys;
      try {
        keys = await vapidKeys.ensure();
      } catch (err) {
        void err;
        logger.error("could not read or generate the VAPID keypair");
        res.status(500).json({ error: "could not send the notification" });
        return;
      }
      const result = await sendToAll(
        subscriptions,
        payload,
        keys,
        // RFC 8292 wants a way for the push service operator to reach the
        // sender if it misbehaves. A role address and not Edvard's own: this
        // repo is public, and the default in a public file is the one that
        // gets read by everybody. `MARCUS_PUSH_SUBJECT` overrides it.
        process.env.MARCUS_PUSH_SUBJECT ?? "mailto:nova@sokrates.ai",
        Date.now(),
        fetchImpl,
      );
      // 200 even when every device failed: the request was well formed and the
      // counts are the answer. A caller that wants "did it land" reads `sent`.
      res.status(200).json({ sent: result.sent, failed: result.failed, pruned: result.pruned });
    } catch (err) {
      // Logged whole, unlike the key path above: everything that can throw
      // here -- encryption, the subscription file, the prune -- is something
      // an operator reading a run of silent 500s needs to see, and none of it
      // is derived from the keypair.
      logger.error({ err }, "could not send the push notification");
      res.status(500).json({ error: "could not send the notification" });
    } finally {
      sendInFlight = false;
    }
  });

  // Issue #154, the last piece a phone can reach: proving the chain works
  // without waiting for 20:00.
  //
  // Everything above this line was shipped without Edvard ever tapping "Turn
  // on reminders", and the reason is worth stating rather than guessing at: a
  // tap on that button produces silence for up to a day, and silence is what a
  // broken feature produces too. This route makes the answer immediate.
  //
  // Its authorisation is the endpoint itself and nothing else. `/api/push/send`
  // needs a bearer token because it buzzes every device with text of the
  // caller's choosing; this one sends fixed text to exactly ONE device, and
  // only if that device's full push-service URL is already in the store. That
  // URL is a long unguessable secret the browser holds, so the only caller who
  // can reach a phone here is one that could already unsubscribe it through
  // DELETE /api/push/subscribe. No new capability is handed to anybody.
  //
  // The title and body are written here rather than taken from the request, on
  // purpose: a route that puts caller-supplied text on Edvard's lock screen is
  // a different route with a different threat model, and it already exists
  // behind a token.
  let testInFlight = false;

  app.post("/api/push/test", express.json({ limit: "16kb" }), async (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    if (testInFlight) {
      // Its own flag rather than sharing `sendInFlight`: a test tap at 20:00:00
      // must not make the scheduled reminder report a failure, and a scheduled
      // reminder must not make the button look broken.
      res.status(409).json({ error: "a test is already on its way" });
      return;
    }
    testInFlight = true;
    try {
      const subs = await subscriptions.list();
      const match = subs.find((s) => s.endpoint === endpoint);
      if (!match) {
        // 404 and not 403: from the caller's side these are the same fact, and
        // the useful one is "Marcus has no record of this device", which is
        // exactly what a cleared site data or a pruned endpoint leaves behind.
        res.status(404).json({ error: "this device is not subscribed" });
        return;
      }
      let keys;
      try {
        keys = await vapidKeys.ensure();
      } catch (err) {
        void err;
        logger.error("could not read or generate the VAPID keypair");
        res.status(500).json({ error: "could not send the test" });
        return;
      }
      const payload = declarativePayload({
        title: "Marcus",
        body: "Reminders are working. This is the only test notification you asked for.",
        navigate: "/",
        // A tag, so a second tap replaces the first on the lock screen instead
        // of stacking. The evening reminder uses its own.
        tag: "marcus-test",
      });
      const outcome = await sendPush(
        match,
        payload,
        keys,
        process.env.MARCUS_PUSH_SUBJECT ?? "mailto:nova@sokrates.ai",
        Date.now(),
        fetchImpl,
      );
      if (outcome.gone) {
        // The one moment anything ever learns a phone is gone, same as
        // sendToAll. Pruning here means the button's own failure repairs the
        // list rather than leaving a dead row for the 20:00 job to trip on.
        await subscriptions.remove(endpoint);
        res.status(410).json({ error: "this device's subscription has expired", pruned: true });
        return;
      }
      if (outcome.status < 200 || outcome.status >= 300) {
        // 502: Marcus did its part and the push service refused. The status is
        // reported because it is the only thing that separates "Apple had a bad
        // minute" from "this will never work".
        res.status(502).json({ error: "the push service would not take it", status: outcome.status });
        return;
      }
      res.status(200).json({ sent: true });
    } catch (err) {
      logger.error({ err }, "could not send the test notification");
      res.status(500).json({ error: "could not send the test" });
    } finally {
      testInFlight = false;
    }
  });

  app.post("/api/chat", express.json({ limit: MAX_BODY }), async (req, res) => {
    const { message, context, history, today } = req.body as {
      message?: unknown;
      context?: unknown;
      history?: unknown;
      today?: unknown;
    };
    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const result = await askCoach(
      message.trim(),
      (context ?? {}) as Parameters<typeof askCoach>[1],
      Array.isArray(history) ? (history as Parameters<typeof askCoach>[2]) : [],
      // The phone's clock, not this pod's: the server runs in UTC and the only
      // person using this app does not. `buildPrompt` validates it.
      { config: coach, fetch: fetchImpl, today: typeof today === "string" ? today : undefined },
    );
    if (result.status === "ok") {
      res.status(200).json({ reply: result.reply });
      return;
    }
    if (result.status === "unconfigured") {
      // 503 and not 500: nothing is broken, this deployment simply has no
      // coach wired, and the client's own answer is the right thing to use.
      res.status(503).json({ error: "the coach is not configured here" });
      return;
    }
    if (result.status === "metered") {
      // Refused before anything left this pod. Loud, because a coach pointed
      // at a metered model spends real money on every message Edvard types.
      logger.error({ model: result.model }, "coach conversation is not on a subscription model");
      res.status(503).json({ error: "the coach is not on a subscription model" });
      return;
    }
    logger.warn({ detail: result.detail }, "coach did not answer");
    res.status(502).json({ error: "the coach did not answer" });
  });

  // Idea #187's remaining half. Separate from /api/chat rather than a prompt
  // Edvard types there, because the answer is structured and is refused when
  // it is not -- see plan-draft.ts. It never writes to the store: the response
  // is a proposal the page shows behind an accept gate.
  app.post("/api/plan-draft", express.json({ limit: MAX_BODY }), async (req, res) => {
    const { goal, context } = req.body as { goal?: unknown; context?: unknown };
    const result = await draftWeek(
      (goal ?? null) as Parameters<typeof draftWeek>[0],
      (context ?? {}) as Parameters<typeof draftWeek>[1],
      { config: coach, fetch: fetchImpl },
    );
    if (result.status === "ok") {
      res.status(200).json({ days: result.days, note: result.note });
      return;
    }
    if (result.status === "unconfigured") {
      res.status(503).json({ error: "the coach is not configured here" });
      return;
    }
    if (result.status === "metered") {
      logger.error({ model: result.model }, "coach conversation is not on a subscription model");
      res.status(503).json({ error: "the coach is not on a subscription model" });
      return;
    }
    if (result.status === "unusable") {
      // 502 and not 500: the coach answered, and what it said was not a week.
      // The reason is returned because it is the only thing that tells Edvard
      // whether to press the button again or give up on it.
      logger.warn({ reason: result.reason }, "coach draft was not a week");
      res.status(502).json({ error: `the coach did not draft a week: ${result.reason}` });
      return;
    }
    logger.warn({ detail: result.detail }, "coach did not answer");
    res.status(502).json({ error: "the coach did not answer" });
  });

  app.use(express.static(path.join(__dirname, "..", "public")));
  return app;
}

// Only listen when this file is what node was asked to run -- importing it from
// a test must not bind a port.
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const store = new StateStore(DEFAULT_DATA_DIR);
  // Awaited rather than fired and forgotten: the tracer has to exist before
  // the first request, and a failure inside initTracing already resolves to
  // null rather than rejecting.
  const tracer = await initTracing(process.env, {
    info: (msg: string) => logger.info(msg),
  });
  createApp(store, undefined, { tracer, parent: parentContext() }).listen(port, () => {
    logger.info({ port, state: store.filePath, tracing: tracer !== null }, "service listening");
  });
}
