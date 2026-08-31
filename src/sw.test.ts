import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect, vi, afterEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

type Handlers = Record<string, (event: any) => void>;

interface Harness {
  handlers: Handlers;
  puts: string[];
}

function loadServiceWorker(opts: {
  fetch: (request: any) => Promise<any>;
  cached?: Record<string, any>;
  putRejects?: boolean;
}): Harness {
  const handlers: Handlers = {};
  const puts: string[] = [];
  const cached = opts.cached ?? {};
  const self = {
    location: { origin: "https://marcus.example" },
    addEventListener: (name: string, fn: (event: any) => void) => {
      handlers[name] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const caches = {
    open: async () => ({
      addAll: async () => {},
      put: async (request: any) => {
        if (opts.putRejects) throw new TypeError("opaque response");
        puts.push(request.url);
      },
    }),
    keys: async () => [],
    delete: async () => true,
    match: async (request: any) => cached[request.url],
  };
  const context = vm.createContext({
    self,
    caches,
    fetch: opts.fetch,
    Response,
    URL,
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  });
  vm.runInContext(SW_SOURCE, context);
  return { handlers, puts };
}

const request = (url: string, method = "GET") => ({ url, method });
const never = () => new Promise<any>(() => {});

/** Drive respondWith and return the promise it was handed. */
function fire(harness: Harness, req: any): Promise<any> | undefined {
  let responded: Promise<any> | undefined;
  harness.handlers.fetch({ request: req, respondWith: (p: Promise<any>) => { responded = p; } });
  return responded;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("service worker fetch strategy", () => {
  it("gives up on a stalled cross-origin asset instead of blocking the page", async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker({ fetch: never });
    const responded = fire(sw, request("https://fonts.googleapis.com/icon?family=Material+Icons+Round"));
    await vi.advanceTimersByTimeAsync(5000);
    const res = await responded!;
    expect(res.status).toBe(504);
  });

  it("does not give up on a cross-origin asset before its own timeout", async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker({ fetch: never });
    const responded = fire(sw, request("https://cdn.jsdelivr.net/npm/chart.js"));
    let settled = false;
    responded!.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
  });

  it("serves the cached shell when a same-origin request stalls", async () => {
    vi.useFakeTimers();
    const url = "https://marcus.example/app.js";
    const sw = loadServiceWorker({ fetch: never, cached: { [url]: new Response("cached app.js") } });
    const responded = fire(sw, request(url));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await (await responded!).text()).toBe("cached app.js");
  });

  it("falls back to cache immediately when the network rejects", async () => {
    const url = "https://marcus.example/styles.css";
    const sw = loadServiceWorker({
      fetch: async () => { throw new TypeError("offline"); },
      cached: { [url]: new Response("cached styles.css") },
    });
    expect(await (await fire(sw, request(url))!).text()).toBe("cached styles.css");
  });

  it("prefers a live network response and stores it", async () => {
    const url = "https://marcus.example/app.js";
    const sw = loadServiceWorker({
      fetch: async () => new Response("fresh app.js"),
      cached: { [url]: new Response("cached app.js") },
    });
    expect(await (await fire(sw, request(url))!).text()).toBe("fresh app.js");
    expect(sw.puts).toEqual([url]);
  });

  it("still returns the response when caching it rejects, as an opaque one does", async () => {
    const sw = loadServiceWorker({
      fetch: async () => new Response("opaque-ish"),
      putRejects: true,
    });
    const res = await fire(sw, request("https://fonts.gstatic.com/s/materialiconsround.woff2"))!;
    expect(await res.text()).toBe("opaque-ish");
  });

  it("leaves non-GET requests alone", () => {
    const sw = loadServiceWorker({ fetch: never });
    expect(fire(sw, request("https://marcus.example/api/thing", "POST"))).toBeUndefined();
  });
});
