import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { APP_FILES, appFile } from "./app-source.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = (name: string) => readFileSync(path.join(__dirname, "..", "public", name), "utf8");

// public/app.js is loaded as several ordered classic scripts sharing one global
// scope, so three lists have to agree: APP_FILES (what the tests evaluate),
// index.html's script tags (what the browser runs) and sw.js's SHELL (what the
// installed app has offline). Nothing else checks them against each other --
// the unit tests concatenate APP_FILES and would stay green against an
// index.html that never loads half of it.
describe("the front end's script list", () => {
  const html = pub("index.html");
  const sameOriginScripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>/g)]
    .map((m) => m[1])
    .filter((src) => !/^https?:\/\//.test(src));

  it("is loaded by index.html in the same order the tests evaluate it", () => {
    expect(sameOriginScripts).toEqual([...APP_FILES]);
  });

  it("is cached whole by the service worker", () => {
    const shell = pub("sw.js");
    for (const name of APP_FILES) {
      expect(shell, `${name} missing from the service worker SHELL`).toContain(`'./${name}'`);
    }
  });

  it("runs app-core.js with no DOM at all", () => {
    // The seam this split was made at. app-core.js is the half every unit test
    // calls, and the claim that it is DOM-free is only worth making if nothing
    // in it reaches for `document` or `window` while it is being evaluated --
    // so evaluate it in a context that has neither defined. A top-level
    // `document.getElementById(...)` in this file throws ReferenceError here;
    // one inside a function body, which is where the UI half legitimately
    // starts, does not.
    const store: Record<string, string> = {};
    const ctx: any = vm.createContext({
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
      console,
    });
    expect(() => vm.runInContext(appFile("app-core.js"), ctx)).not.toThrow();
    // and it really did define the pure functions, rather than throwing nothing
    // because it did nothing.
    expect(typeof ctx.validateSession).toBe("function");
    expect(typeof ctx.parseMealSentence).toBe("function");
  });

  it("splits the source rather than duplicating it", () => {
    // A top-level `function foo` declared in two files is a redeclaration the
    // browser tolerates and a reader never notices: the later file silently
    // wins. This is the failure mode of a split done by copy rather than move.
    const names = APP_FILES.map((name: string) =>
      [...appFile(name).matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    );
    const [core, ui] = [new Set(names[0]), names[1]];
    expect(ui.filter((n: string) => core.has(n))).toEqual([]);
  });
});
