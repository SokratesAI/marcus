/**
 * OpenTelemetry tracing for the marcus HTTP server.
 *
 * The collector in `infra` has three producers as of 2026-09-05 -- `agora`,
 * `nova-site` and `agora-persona-runner` -- and marcus is the fourth. It is
 * the one Edvard's phone actually waits on: every `GET /api/state` on the
 * page load and every `PUT /api/state` after a meal is a request with a
 * person at the other end of it.
 *
 * This is deliberately not the auto-instrumentation shape.
 * `@opentelemetry/instrumentation-express` patches Express at require time,
 * and this package is ESM (`"type": "module"`), so making that work means an
 * `--experimental-loader` in the entrypoint and a second way for the process
 * to fail at boot. One middleware and one span per request is the whole of
 * what we want out of it, so the wrapper buys nothing here either.
 *
 * Everything is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and every
 * failure path returns "no tracing" rather than throwing. That is not
 * defensive habit: this module is imported by the process that serves the
 * owner's phone, and a tracing library is never worth an outage of the thing
 * it is watching.
 */

import type { NextFunction, Request, Response } from "express";

/** The collector address. Env rather than a constant, so moving the
 * collector is a manifest change and not a release. */
export const ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";

/** What the service calls itself in Tempo. Env-driven for the same reason. */
export const SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";

/** Used only when the environment does not name the service. Unlike the
 * runner image, this image runs exactly one process, so naming it here is
 * safe -- there is no second entrypoint for a missing env var to file spans
 * under a name that is already taken. */
export const DEFAULT_SERVICE_NAME = "marcus";

/** The span name for a request Express did not match to a route: a 404, or
 * anything `express.static` served. Express hands us a route template for
 * everything it matched (`/api/food/barcode/:code`), and the raw path for
 * everything it did not -- and the raw path of a 404 is whatever the caller
 * typed, which is unbounded. One name for that whole class keeps Tempo's
 * cardinality bounded; the path itself is still on the span as `url.path`,
 * so nothing is lost, it just is not the name. */
export const UNMATCHED_ROUTE = "(unmatched)";

/** Minimal shapes, so this module compiles and is testable without the SDK
 * being the thing under test. They are the parts of the OpenTelemetry API we
 * actually call, not a re-declaration of it. */
export interface SpanLike {
  setAttribute(key: string, value: string | number): unknown;
  updateName(name: string): unknown;
  recordException(exception: Error): unknown;
  end(): unknown;
}

export interface TracerLike {
  /** `options` and `context` are the OpenTelemetry API's own second and third
   * arguments. They are declared `unknown` because this module never builds
   * either one itself -- the context comes back opaque from
   * {@link ParentContextReader.extract} and is handed straight through. */
  startSpan(name: string, options?: unknown, context?: unknown): SpanLike;
}

/**
 * Reads the caller's trace off an incoming request's headers.
 *
 * Marcus is called by instrumented services as well as by a browser --
 * `tools.marcus_capacity` in `agora-persona-runner` reads `/api/state` every
 * cycle, and since runner#780 every outgoing JSON call from that repo carries
 * a `traceparent`. Without this, each of those arrives here and opens a brand
 * new root trace, so one action lands in Tempo as two unrelated traces with
 * nothing joining them.
 */
export interface ParentContextReader {
  /** An opaque context to start the span in, or null when the request carries
   * no usable trace. Null is the answer for a browser, which is most traffic
   * here, and it is a normal answer rather than a failure. */
  extract(headers: unknown): unknown | null;
}

export interface TracingLogger {
  info(msg: string): unknown;
}

interface ProviderLike {
  forceFlush(): Promise<void>;
}

// The provider built by the most recent successful initTracing, so a caller
// can flush without reaching into the global API. Null means tracing is off.
let _provider: ProviderLike | null = null;

// The reader built alongside that provider. Null means tracing is off, and
// therefore that every span is a root span anyway.
let _parent: ParentContextReader | null = null;

/** Export whatever the batch processor is still holding. A no-op when
 * tracing is off, and it never throws -- a flush is a courtesy, not a
 * correctness requirement. */
export async function forceFlush(): Promise<void> {
  if (_provider === null) return;
  try {
    await _provider.forceFlush();
  } catch {
    // A collector that is down must not turn a flush into a crash.
  }
}

/** The reader for the most recent successful initTracing, exposed the same
 * way {@link forceFlush} exposes the provider: the entrypoint needs it to
 * build the middleware, and reaching into the global API for it is what
 * `provider.register()`'s second-call behaviour already made unsafe once. */
export function parentContext(): ParentContextReader | null {
  return _parent;
}

/** The OTLP/HTTP traces path. `OTEL_EXPORTER_OTLP_ENDPOINT` names the base
 * and the signal path is appended to it -- that appending is the exporter's
 * behaviour when it reads the variable itself, and this reproduces it for
 * the explicit `url` form, which takes the full path and appends nothing. */
export function tracesUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/traces`;
}

export function endpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env[ENDPOINT_ENV] ?? "").trim();
}

export function serviceName(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = DEFAULT_SERVICE_NAME,
): string {
  return (env[SERVICE_NAME_ENV] ?? "").trim() || fallback;
}

/**
 * Build the tracer, or return null and say why in the log.
 *
 * Never throws. A missing endpoint, a missing package and a broken SDK all
 * come back as null, because the alternative is that marcus fails to start
 * over its own telemetry.
 */
export async function initTracing(
  env: NodeJS.ProcessEnv = process.env,
  logger: TracingLogger = console,
): Promise<TracerLike | null> {
  if (!endpoint(env)) {
    logger.info(`otel: tracing off, ${ENDPOINT_ENV} is not set`);
    _parent = null;
    return null;
  }
  try {
    const [api, sdk, exporterModule, resources] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
    const name = serviceName(env);
    const provider = new sdk.NodeTracerProvider({
      resource: resources.resourceFromAttributes({ "service.name": name }),
      // The URL is passed explicitly rather than left to the exporter's own
      // reading of OTEL_EXPORTER_OTLP_ENDPOINT. The exporter reads the real
      // `process.env` and nothing else, so with `env` injected it silently
      // fell back to its localhost default while the log line above happily
      // named the endpoint it had been given -- measured against a fake
      // collector, which got nothing and saw a connection to :4318 instead.
      // One source of truth, and the log now describes what was built.
      spanProcessors: [
        new sdk.BatchSpanProcessor(
          new exporterModule.OTLPTraceExporter({ url: tracesUrl(endpoint(env)) }),
        ),
      ],
    });
    // `register()` installs the global context manager and propagator, which
    // is what a future child span would need. The tracer handed back comes
    // off the provider that was just built rather than off the global,
    // because the global refuses a second registration -- so on the second
    // call `api.trace.getTracer` returns a tracer belonging to the FIRST
    // provider, and its spans go wherever that one was pointed. Production
    // calls this once; the export test calls it twice, and that is how the
    // difference showed up.
    provider.register();
    _provider = provider as unknown as ProviderLike;
    // `register()` is what installs the global W3C propagator, so this has to
    // be built after it and not before.
    _parent = {
      extract(headers: unknown): unknown | null {
        try {
          const ctx = api.propagation.extract(
            api.context.active(),
            (headers ?? {}) as Record<string, string>,
          );
          // One check, not two. An all-zero trace id is invalid per W3C and I
          // had written a second guard for it -- mutating that guard away left
          // all 28 tests green, because the API's own propagator refuses such a
          // header and hands back no span context at all. A guard whose removal
          // nothing can detect is guarding nothing.
          if (!api.trace.getSpanContext(ctx)?.traceId) return null;
          return ctx;
        } catch {
          // Same rule as everywhere else in this module: a header this loop
          // cannot parse must cost a join, never a request.
          return null;
        }
      },
    };
    logger.info(`otel: tracing on, ${name} -> ${endpoint(env)}`);
    return provider.getTracer(name) as unknown as TracerLike;
  } catch (err) {
    logger.info(`otel: tracing off, could not build the tracer (${String(err)})`);
    _parent = null;
    return null;
  }
}

/**
 * The route template Express matched, or {@link UNMATCHED_ROUTE}.
 *
 * `req.route` is only populated once Express has picked a handler, which is
 * why the span is named on `finish` rather than on the way in.
 */
export function routeName(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  return typeof route?.path === "string" && route.path ? route.path : UNMATCHED_ROUTE;
}

/**
 * One span per HTTP request. A pass-through when `tracer` is null, which is
 * every test run and every local run, because neither sets the endpoint.
 *
 * When `parent` reads a trace off the request, the span is opened inside it,
 * so a call made by another instrumented service lands in Tempo under that
 * caller's trace instead of starting a second one.
 */
export function tracingMiddleware(
  tracer: TracerLike | null,
  parent: ParentContextReader | null = null,
) {
  return function trace(req: Request, res: Response, next: NextFunction): void {
    if (tracer === null) {
      next();
      return;
    }
    const method = req.method;
    const rawPath = (req.originalUrl ?? req.url ?? "/").split("?", 1)[0] || "/";
    // Its own try, and deliberately not the one below: a reader that throws
    // must cost the join and nothing else. Folding it into the startSpan guard
    // would drop the span entirely and lose the request from Tempo, which is
    // strictly worse than the root span we would have had before this existed.
    let parentCtx: unknown = null;
    try {
      parentCtx = parent?.extract(req.headers) ?? null;
    } catch {
      parentCtx = null;
    }
    let span: SpanLike;
    try {
      // `startSpan(name)` and `startSpan(name, undefined, undefined)` are the
      // same call to the API, but not to a test double that counts arguments,
      // so the no-parent path stays byte-identical to what it was.
      span = parentCtx === null ? tracer.startSpan(method) : tracer.startSpan(method, undefined, parentCtx);
    } catch {
      next();
      return;
    }
    try {
      span.setAttribute("http.request.method", method);
      span.setAttribute("url.path", rawPath);
    } catch {
      // Same reason as the guard around startSpan above: a span that will
      // not take an attribute must not take the request down with it.
    }
    let ended = false;
    const close = (completed: boolean) => () => {
      if (ended) return;
      ended = true;
      try {
        span.updateName(`${method} ${routeName(req)}`);
        if (completed) {
          span.setAttribute("http.response.status_code", res.statusCode);
        } else {
          // Deliberately no status code. `res.statusCode` is 200 from the
          // moment the response object exists and only changes when a
          // handler sets it, so a socket that died mid-handler would
          // otherwise be filed as a successful 200 -- indistinguishable in
          // Tempo from a request that worked, which is precisely the one
          // question this span would be opened to answer.
          span.setAttribute("http.request.aborted", "true");
        }
      } catch {
        // These run inside a `finish`/`close` listener, and an exception out
        // of an EventEmitter listener is fatal to the process by default.
        // A tracing library is never worth an outage of the thing it is
        // watching, and that has to hold here as well as in initTracing.
      }
      try {
        span.end();
      } catch {
        // Same reason.
      }
    };
    // `close` as well as `finish`, because a phone that walks out of wifi
    // mid-request aborts the socket and `finish` never fires -- and a span
    // that is never ended is a span the exporter never sends. Whichever
    // fires first wins, and only `finish` means a response was actually sent.
    res.on("finish", close(true));
    res.on("close", close(false));
    next();
  };
}
