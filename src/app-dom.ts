import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { APP_FILES, appFile } from "./app-source.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The real index.html, so a test renders into the same shell the phone gets --
// the `#view` main, the bottom nav, and the `<template>` the Log tab clones.
// Reading it rather than hand-writing a stub is what keeps this honest: a test
// that builds its own container cannot notice markup that index.html dropped.
const INDEX_HTML: string = readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8",
);

// Deliberately typed loosely rather than with the DOM lib: tsconfig's `lib` is
// ES2022 only, and adding "DOM" to it would hand the Express server `document`
// and `fetch` as globals across the whole project. A test that reaches into the
// document is asking questions of a runtime object, not of the type checker.
export interface RenderedApp {
  window: any;
  document: any;
  /** The `<main id="view">` every renderer writes into. */
  view: any;
  /** Text of the whole view, with runs of whitespace collapsed. */
  text(): string;
  /** Every `.exercise-line` in the view, as trimmed text. */
  lines(): string[];
  close(): void;
}

/**
 * Load the front end into a real DOM and hand back the rendered `#view`.
 *
 * Every other `app-*.test.ts` evaluates the same source inside `node:vm`
 * against a hand-made object graph whose nodes do nothing -- `innerHTML` is a
 * plain string property there, so an assignment to it is never parsed and the
 * markup is never inspected. That is why 1057 tests could pass over a Home card
 * that dropped a day off the week (marcus#79). This parses the markup, so a
 * test can ask what the screen actually says.
 *
 * `seed` is written into localStorage under the `marcus.` prefix `store.get`
 * reads, before the app runs, because several renderers read the store at
 * module level.
 */
export function renderApp(
  tab: string,
  seed: Record<string, unknown> = {},
  opts: { now?: Date } = {},
): RenderedApp {
  const dom = new JSDOM(INDEX_HTML, {
    runScripts: "outside-only",
    url: "https://marcus.test/",
    pretendToBeVisual: true,
  });
  const win: any = dom.window;

  for (const [key, value] of Object.entries(seed)) {
    win.localStorage.setItem("marcus." + key, JSON.stringify(value));
  }

  // Chart.js loads from a CDN in the browser and the Progress tab checks for it.
  // A stub that records nothing keeps `destroyCharts` honest without drawing.
  win.Chart = function () { return { destroy() {} }; };
  win.fetch = () => Promise.reject(new Error("no network in the render harness"));
  if (opts.now) {
    const fixed = opts.now.getTime();
    const RealDate = win.Date;
    class FixedDate extends RealDate {
      constructor(...args: any[]) {
        super(...((args.length ? args : [fixed]) as []));
      }
      static now() { return fixed; }
    }
    win.Date = FixedDate;
  }

  // Same concatenation order the browser uses; see src/app-source.ts.
  const source = APP_FILES.map(appFile).join("\n");
  win.eval(source);
  win.switchTab(tab);

  const view: any = win.document.getElementById("view");
  return {
    window: win,
    document: win.document,
    view,
    text: () => (view.textContent || "").replace(/\s+/g, " ").trim(),
    lines: () =>
      Array.from(view.querySelectorAll(".exercise-line")).map((n: any) =>
        (n.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    close: () => win.close(),
  };
}
