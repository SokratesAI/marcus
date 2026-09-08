import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

type Handlers = Record<string, (event: any) => void>;

interface Shown {
  title: string;
  options: Record<string, any>;
}

interface Harness {
  handlers: Handlers;
  shown: Shown[];
  focused: string[];
  opened: string[];
}

/** The worker as Chrome runs it: a registration that can draw a notification
 * and a clients list. The existing sw.test.ts harness deliberately has neither,
 * which is why this file carries its own rather than widening that one. */
function loadServiceWorker(opts: { windows?: string[] } = {}): Harness {
  const handlers: Handlers = {};
  const shown: Shown[] = [];
  const focused: string[] = [];
  const opened: string[] = [];
  const windows = (opts.windows ?? []).map((url) => ({
    url,
    focus: () => {
      focused.push(url);
      return Promise.resolve(url);
    },
  }));
  const self = {
    location: { origin: "https://marcus.example" },
    addEventListener: (name: string, fn: (event: any) => void) => {
      handlers[name] = fn;
    },
    skipWaiting: () => {},
    registration: {
      showNotification: (title: string, options: Record<string, any>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return { url };
      },
    },
  };
  const caches = {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
  };
  const context = vm.createContext({
    self,
    caches,
    fetch: async () => new Response(""),
    Response,
    URL,
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  });
  vm.runInContext(SW_SOURCE, context);
  return { handlers, shown, focused, opened };
}

/** What `event.data` is for a real push: a body with a `.json()` on it. */
const pushData = (payload: unknown) => ({ json: () => payload });

/** Drive a handler and wait on whatever it passed to waitUntil. */
async function fire(handler: (event: any) => void, event: Record<string, any>) {
  let waited: Promise<unknown> = Promise.resolve();
  handler({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p) });
  return waited;
}

describe("the push handler", () => {
  it("is registered at all -- without it Chrome renders nothing", () => {
    const { handlers } = loadServiceWorker();
    expect(typeof handlers.push).toBe("function");
  });

  it("draws the notification the server declared", async () => {
    const { handlers, shown } = loadServiceWorker();
    await fire(
      handlers.push,
      {
        data: pushData({
          web_push: 8030,
          notification: {
            title: "Marcus",
            body: "Reminders are working.",
            navigate: "/",
            tag: "marcus-test",
          },
        }),
      },
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Marcus");
    expect(shown[0].options.body).toBe("Reminders are working.");
    expect(shown[0].options.tag).toBe("marcus-test");
    expect(shown[0].options.data.navigate).toBe("/");
  });

  it("still draws something when the payload is unreadable", async () => {
    const { handlers, shown } = loadServiceWorker();
    await fire(handlers.push, {
      data: {
        json: () => {
          throw new SyntaxError("not JSON");
        },
      },
    });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Marcus");
  });

  it("still draws something when there is no payload at all", async () => {
    const { handlers, shown } = loadServiceWorker();
    await fire(handlers.push, { data: null });
    expect(shown).toHaveLength(1);
    expect(shown[0].options.tag).toBe("marcus");
    expect(shown[0].options.data.navigate).toBe("./");
  });
});

describe("tapping the notification", () => {
  it("focuses an already-open Marcus rather than opening a second one", async () => {
    const { handlers, focused, opened } = loadServiceWorker({
      windows: ["https://marcus.example/"],
    });
    let closed = false;
    await fire(handlers.notificationclick, {
      notification: { close: () => (closed = true), data: { navigate: "/" } },
    });
    expect(closed).toBe(true);
    expect(focused).toEqual(["https://marcus.example/"]);
    expect(opened).toEqual([]);
  });

  it("opens the navigate target when nothing is open", async () => {
    const { handlers, opened } = loadServiceWorker({ windows: [] });
    await fire(handlers.notificationclick, {
      notification: { close: () => {}, data: { navigate: "/plan" } },
    });
    expect(opened).toEqual(["/plan"]);
  });
});
