import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The browser loads these as ordered classic scripts sharing one global scope,
// so a test that evaluates them has to concatenate them in exactly this order.
// This list is the single place the layout of the front end is written down:
// index.html's script tags and sw.js's SHELL are checked against it by
// src/app-split.test.ts, so moving code between the files cannot silently ship
// a page that loads only half of itself.
export const APP_FILES = ["app-core.js", "app.js"] as const;

export function appFile(name: string): string {
  return readFileSync(path.join(__dirname, "..", "public", name), "utf8");
}

// Every app-*.test.ts loads this instead of reading one file, which is what
// makes the split above invisible to them.
export const APP_SOURCE: string = APP_FILES.map(appFile).join("\n");
