import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  DEFAULT_SERVICE_NAME,
  ENDPOINT_ENV,
  SERVICE_NAME_ENV,
  UNMATCHED_ROUTE,
  endpoint,
  initTracing,
  routeName,
  serviceName,
  tracingMiddleware,
  type SpanLike,
  type TracerLike,
} from "./tracing.js";

interface Recorded {
  name: string;
  attributes: Record<string, string | number>;
  ended: boolean;
}

/** A tracer that records instead of exporting, so a test can assert what
 * would have been sent without an SDK or a collector in the way. */
function fakeTracer(): { tracer: TracerLike; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const tracer: TracerLike = {
    startSpan(name: string): SpanLike {
      const recorded: Recorded = { name, attributes: {}, ended: false };
      spans.push(recorded);
      return {
        setAttribute(key, value) {
          recorded.attributes[key] = value;
        },
        updateName(next) {
          recorded.name = next;
        },
        recordException() {},
        end() {
          recorded.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

function appWith(tracer: TracerLike | null) {
  const app = express();
  app.use(tracingMiddleware(tracer));
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/api/food/barcode/:code", (_req, res) => {
    res.status(404).json({ error: "no" });
  });
  return app;
}

describe("environment", () => {
  it("reads the endpoint and trims it", () => {
    expect(endpoint({ [ENDPOINT_ENV]: "  http://collector:4318 " })).toBe("http://collector:4318");
    expect(endpoint({})).toBe("");
  });

  it("lets the environment override the service name", () => {
    expect(serviceName({})).toBe(DEFAULT_SERVICE_NAME);
    expect(serviceName({ [SERVICE_NAME_ENV]: "marcus-canary" })).toBe("marcus-canary");
    // An env var set to whitespace is the same as unset, not a nameless service.
    expect(serviceName({ [SERVICE_NAME_ENV]: "   " })).toBe(DEFAULT_SERVICE_NAME);
  });
});

describe("initTracing", () => {
  it("is off, and says so, when no endpoint is configured", async () => {
    const lines: string[] = [];
    const tracer = await initTracing({}, { info: (m) => lines.push(m) });
    expect(tracer).toBeNull();
    expect(lines).toEqual([`otel: tracing off, ${ENDPOINT_ENV} is not set`]);
  });

  it("builds a real tracer when the endpoint is set", async () => {
    const lines: string[] = [];
    const tracer = await initTracing(
      { [ENDPOINT_ENV]: "http://127.0.0.1:4318", [SERVICE_NAME_ENV]: "marcus-test" },
      { info: (m) => lines.push(m) },
    );
    // Nothing is exported here -- the exporter batches and this process ends
    // before it flushes. What is being pinned is that the import graph and the
    // provider construction actually work in this package's ESM/Node build,
    // which is the half that fails silently in production.
    expect(tracer).not.toBeNull();
    expect(lines[0]).toBe("otel: tracing on, marcus-test -> http://127.0.0.1:4318");
  });
});

describe("routeName", () => {
  it("prefers the route template Express matched", () => {
    expect(routeName({ route: { path: "/api/food/barcode/:code" } } as never)).toBe(
      "/api/food/barcode/:code",
    );
  });

  it("collapses anything Express did not match", () => {
    expect(routeName({} as never)).toBe(UNMATCHED_ROUTE);
    expect(routeName({ route: {} } as never)).toBe(UNMATCHED_ROUTE);
  });
});

describe("tracingMiddleware", () => {
  it("serves the request unchanged when tracing is off", async () => {
    const res = await request(appWith(null)).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("records one finished span per request, named after the route", async () => {
    const { tracer, spans } = fakeTracer();
    const res = await request(appWith(tracer)).get("/healthz");
    expect(res.status).toBe(200);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /healthz");
    expect(spans[0].ended).toBe(true);
    expect(spans[0].attributes["http.request.method"]).toBe("GET");
    expect(spans[0].attributes["url.path"]).toBe("/healthz");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
  });

  it("names a parameterised route by its template, not by the value", async () => {
    const { tracer, spans } = fakeTracer();
    await request(appWith(tracer)).get("/api/food/barcode/7038010013805");
    await request(appWith(tracer)).get("/api/food/barcode/5000112637922");
    // Two different barcodes must not be two span names -- that is one series
    // per product in Tempo, which is the cost this collapse exists to avoid.
    expect(spans.map((s) => s.name)).toEqual([
      "GET /api/food/barcode/:code",
      "GET /api/food/barcode/:code",
    ]);
    // The value is still on the span, just not in its name.
    expect(spans[0].attributes["url.path"]).toBe("/api/food/barcode/7038010013805");
    expect(spans[0].attributes["http.response.status_code"]).toBe(404);
  });

  it("gives every unmatched path one name", async () => {
    const { tracer, spans } = fakeTracer();
    await request(appWith(tracer)).get("/wp-admin/setup-config.php");
    await request(appWith(tracer)).get("/.env");
    expect(spans.map((s) => s.name)).toEqual([`GET ${UNMATCHED_ROUTE}`, `GET ${UNMATCHED_ROUTE}`]);
    expect(spans[0].attributes["url.path"]).toBe("/wp-admin/setup-config.php");
  });

  it("keeps the query string out of the span, name and attribute alike", async () => {
    const { tracer, spans } = fakeTracer();
    await request(appWith(tracer)).get("/healthz?token=secret&n=3");
    expect(spans[0].name).toBe("GET /healthz");
    expect(spans[0].attributes["url.path"]).toBe("/healthz");
  });

  it("ends the span exactly once when both close and finish fire", () => {
    const { tracer, spans } = fakeTracer();
    let ends = 0;
    const counting: TracerLike = {
      startSpan(name) {
        const span = tracer.startSpan(name);
        return {
          ...span,
          setAttribute: (k, v) => span.setAttribute(k, v),
          updateName: (n) => span.updateName(n),
          recordException: (e) => span.recordException(e),
          end: () => {
            ends += 1;
            span.end();
          },
        };
      },
    };
    const listeners: Record<string, Array<() => void>> = {};
    const res = {
      statusCode: 200,
      on(event: string, fn: () => void) {
        (listeners[event] ??= []).push(fn);
      },
    };
    tracingMiddleware(counting)(
      { method: "GET", originalUrl: "/healthz" } as never,
      res as never,
      () => {},
    );
    listeners["finish"].forEach((fn) => fn());
    listeners["close"].forEach((fn) => fn());
    expect(ends).toBe(1);
    expect(spans).toHaveLength(1);
  });

  it("serves the request even if the tracer throws on startSpan", async () => {
    const broken: TracerLike = {
      startSpan() {
        throw new Error("exporter is in pieces");
      },
    };
    const res = await request(appWith(broken)).get("/healthz");
    expect(res.status).toBe(200);
  });
});
