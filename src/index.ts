import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import pino from "pino";
import { StateStore } from "./state-store.js";
import { FoodCache, SearchCache, lookupBarcode, searchFoodsByName } from "./food-lookup.js";
import { askCoach, coachConfig, type CoachConfig } from "./coach.js";
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
