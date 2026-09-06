import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import pino from "pino";
import { StateStore } from "./state-store.js";
import { FoodCache, SearchCache, lookupBarcode, searchFoodsByName } from "./food-lookup.js";
import { askCoach, coachConfig, type CoachConfig } from "./coach.js";
import { SubscriptionStore, VapidKeyStore, validateSubscription } from "./push.js";
import { declarativePayload, sendToAll } from "./push-send.js";
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

  // Idea #217, second slice: the send itself. This is the route the 20:00
  // CronJob calls; it is not a route a phone calls, which is why it is the one
  // route here that needs a credential.
  //
  // Closed rather than open when `MARCUS_PUSH_TOKEN` is unset. Every other
  // route on this server takes an unauthenticated body from whoever can reach
  // it, and that is a decision about a training log on a private network. This
  // one reaches Edvard's lock screen, so an unconfigured deployment must not be
  // one that anybody who can reach the pod may buzz his phone through.
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
      const keys = await vapidKeys.ensure();
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
      void err;
      logger.error("could not send the push notification");
      res.status(500).json({ error: "could not send the notification" });
    }
  });

  app.post("/api/chat", express.json({ limit: MAX_BODY }), async (req, res) => {
    const { message, context, history } = req.body as {
      message?: unknown;
      context?: unknown;
      history?: unknown;
    };
    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const result = await askCoach(
      message.trim(),
      (context ?? {}) as Parameters<typeof askCoach>[1],
      Array.isArray(history) ? (history as Parameters<typeof askCoach>[2]) : [],
      { config: coach, fetch: fetchImpl },
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
