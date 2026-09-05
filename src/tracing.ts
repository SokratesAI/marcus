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
  startSpan(name: string): SpanLike;
}

export interface TracingLogger {
  info(msg: string): unknown;
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
      // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself and appends
      // /v1/traces to it; passing the endpoint again here would give one
      // variable two behaviours.
      spanProcessors: [new sdk.BatchSpanProcessor(new exporterModule.OTLPTraceExporter())],
    });
    provider.register();
    logger.info(`otel: tracing on, ${name} -> ${endpoint(env)}`);
    return api.trace.getTracer(name) as unknown as TracerLike;
  } catch (err) {
    logger.info(`otel: tracing off, could not build the tracer (${String(err)})`);
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
 */
export function tracingMiddleware(tracer: TracerLike | null) {
  return function trace(req: Request, res: Response, next: NextFunction): void {
    if (tracer === null) {
      next();
      return;
    }
    const method = req.method;
    const rawPath = (req.originalUrl ?? req.url ?? "/").split("?", 1)[0] || "/";
    let span: SpanLike;
    try {
      span = tracer.startSpan(method);
    } catch {
      next();
      return;
    }
    span.setAttribute("http.request.method", method);
    span.setAttribute("url.path", rawPath);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      try {
        span.updateName(`${method} ${routeName(req)}`);
        span.setAttribute("http.response.status_code", res.statusCode);
      } finally {
        span.end();
      }
    };
    // `close` as well as `finish`, because a phone that walks out of wifi
    // mid-request aborts the socket and `finish` never fires -- and a span
    // that is never ended is a span the exporter never sends.
    res.on("finish", finish);
    res.on("close", finish);
    next();
  };
}
