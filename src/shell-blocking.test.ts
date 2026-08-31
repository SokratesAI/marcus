import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/* Nothing on a third-party host may stop this app from becoming interactive.
 *
 * Measured 2026-08-31 in Chromium at 360x697, with fonts.googleapis.com and
 * cdn.jsdelivr.net stalled (connection accepted, no response ever sent): the
 * page still painted its static shell -- header, tab bar, "Today" -- and
 * `typeof switchTab` stayed `undefined` for the whole 45-second budget, so
 * every tap did nothing. That reads as the app hanging, and it is why the
 * report of it arrived as "the Log tab hangs" rather than "the app is dead":
 * no tab worked, and Log was the tab under test.
 *
 * Two separate blocking rules produced it, which is why this checks both
 * element kinds rather than the one that was noticed:
 *   - a classic <script> with no async/defer blocks the parser, so app.js
 *     never runs;
 *   - a stylesheet that applies at parse time blocks the scripts after it,
 *     because a script may read computed style.
 *
 * sw.js bounds every fetch it serves, and that is real -- measured on the same
 * run, a second visit with both hosts stalled was interactive in 208ms. A
 * service worker cannot rescue the visit that installs it, so the first visit
 * has to survive on this markup alone.
 *
 * Inputs are selected by origin, never by whether they happen to be marked
 * non-blocking, so this cannot pass by agreeing with itself.
 */
function tags(kind: "script" | "link"): string[] {
  return HTML.match(new RegExp(`<${kind}\\b[^>]*>`, "gi")) ?? [];
}
const crossOrigin = (tag: string, attr: string) =>
  new RegExp(`${attr}\\s*=\\s*["']https?://`, "i").test(tag);

describe("the app shell cannot be held hostage by a third-party host", () => {
  it("finds the third-party assets it is meant to be judging", () => {
    // A sweep that silently matched nothing would pass every assertion below.
    const found = [
      ...tags("script").filter((t) => crossOrigin(t, "src")),
      ...tags("link").filter((t) => /rel\s*=\s*["']stylesheet["']/i.test(t) && crossOrigin(t, "href")),
    ];
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it("loads every cross-origin script without blocking the parser", () => {
    for (const tag of tags("script").filter((t) => crossOrigin(t, "src"))) {
      expect(/\b(async|defer)\b/i.test(tag), `parser-blocking third-party script: ${tag}`).toBe(true);
    }
  });

  it("loads every cross-origin stylesheet without blocking the scripts after it", () => {
    const stylesheets = tags("link").filter(
      (t) => /rel\s*=\s*["']stylesheet["']/i.test(t) && crossOrigin(t, "href"),
    );
    for (const tag of stylesheets) {
      // Not applied to this medium at parse time, therefore not render-blocking,
      // and switched on once it has actually arrived.
      expect(/media\s*=\s*["']print["']/i.test(tag), `render-blocking third-party stylesheet: ${tag}`).toBe(true);
      expect(/onload\s*=\s*["'][^"']*media\s*=\s*['"]all/i.test(tag), `never switched back on: ${tag}`).toBe(true);
    }
  });

  it("keeps app.js itself same-origin, since that is what sw.js can cache", () => {
    const app = tags("script").find((t) => /src\s*=\s*["']app\.js["']/.test(t));
    expect(app, "app.js script tag not found").toBeTruthy();
    expect(crossOrigin(app!, "src")).toBe(false);
  });
});
