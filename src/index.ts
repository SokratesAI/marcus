import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import pino from "pino";
import { StateStore } from "./state-store.js";
import { FoodCache, lookupBarcode } from "./food-lookup.js";

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
  /** Injected so a test never reaches Open Food Facts, and so the route can be
   * built without a cache at all when the deployment has no volume for one. */
  foodCache?: FoodCache;
  fetchImpl?: typeof globalThis.fetch;
}

export function createApp(
  store: StateStore,
  now: () => string = () => new Date().toISOString(),
  options: AppOptions = {},
): Express {
  const app = express();
  const foodCache = options.foodCache ?? new FoodCache(path.dirname(store.filePath));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

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

  app.use(express.static(path.join(__dirname, "..", "public")));
  return app;
}

// Only listen when this file is what node was asked to run -- importing it from
// a test must not bind a port.
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const store = new StateStore(DEFAULT_DATA_DIR);
  createApp(store).listen(port, () => {
    logger.info({ port, state: store.filePath }, "service listening");
  });
}
