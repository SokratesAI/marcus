import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const HTML = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const SVG = readFileSync(path.join(PUBLIC, "icon.svg"), "utf8");
const PNG = readFileSync(path.join(PUBLIC, "apple-touch-icon.png"));

/* The home-screen tile, and the two iOS rules that a passing browser test cannot see.
 *
 * Until 2026-09-01 index.html declared `<link rel="apple-touch-icon" href="icon.svg">`.
 * iOS has never accepted SVG for that link, and when it cannot use the declared icon
 * it installs a screenshot of the page taken at install time instead. Every check this
 * repo has passes that: the manifest is valid, the markup parses, headless Chromium
 * renders the page fine. Nothing about it is observable from a browser, which is
 * exactly why it survived -- the only instrument is Edvard's own home screen.
 *
 * So this asserts the two properties the PNG has to have, against the file itself
 * rather than against a claim in a comment:
 *
 *  - 180x180, the size iOS asks for.
 *  - Opaque, square-cornered pixels in every corner. iOS applies its own rounded mask
 *    and composites alpha onto black, so a rounded, transparent-cornered PNG -- which
 *    is what you get by rasterizing icon.svg unmodified, rx="40" and all -- puts four
 *    black wedges around the tile.
 *
 * And it ties the PNG back to its source, because a checked-in raster with no build
 * step goes stale silently: the corner colour has to equal the fill on icon.svg's
 * background rect. Recolour the icon and this fails, naming the regeneration.
 */

function chunks(buf: Buffer): Map<string, Buffer[]> {
  const out = new Map<string, Buffer[]>();
  let at = 8; // past the PNG signature
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    out.set(type, [...(out.get(type) ?? []), data]);
    at += 12 + len; // length + type + data + crc
    if (type === "IEND") break;
  }
  return out;
}

/** Undo the per-scanline filter and return rows of RGBA bytes. */
function pixels(buf: Buffer): { width: number; height: number; rows: Buffer[] } {
  const parts = chunks(buf);
  const ihdr = parts.get("IHDR")![0];
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  expect(depth, "8-bit channels").toBe(8);
  expect([2, 6], "truecolour, with or without alpha").toContain(colour);
  const bpp = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts.get("IDAT")!));
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    rows.push(line);
    prev = line;
  }
  const out = rows.map((line) => {
    if (bpp === 4) return line;
    const rgba = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) {
      line.copy(rgba, x * 4, x * 3, x * 3 + 3);
      rgba[x * 4 + 3] = 0xff;
    }
    return rgba;
  });
  return { width, height, rows: out };
}

function hex(rows: Buffer[], x: number, y: number): string {
  const r = rows[y];
  return `#${r.subarray(x * 4, x * 4 + 3).toString("hex").toUpperCase()}`;
}

describe("the iOS home-screen icon", () => {
  it("is linked as a PNG, never as an SVG", () => {
    const link = HTML.match(/<link[^>]*rel="apple-touch-icon"[^>]*>/)?.[0];
    expect(link, "index.html declares an apple-touch-icon").toBeTruthy();
    expect(link).toContain('href="apple-touch-icon.png"');
    expect(link, "iOS has never rendered an SVG apple-touch-icon").not.toContain(".svg");
  });

  it("is a real PNG at the 180x180 iOS asks for", () => {
    expect(PNG.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const { width, height } = pixels(PNG);
    expect({ width, height }).toEqual({ width: 180, height: 180 });
  });

  it("is opaque and square-cornered, because iOS masks it itself", () => {
    const { width, height, rows } = pixels(PNG);
    const corners = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of corners) {
      expect(rows[y][x * 4 + 3], `alpha at ${x},${y} -- iOS composites alpha onto black`).toBe(255);
    }
  });

  it("still carries icon.svg's background colour, so a recolour cannot leave it stale", () => {
    const fill = SVG.match(/<rect width="192" height="192"[^>]*fill="(#[0-9A-Fa-f]{6})"/)?.[1];
    expect(fill, "icon.svg has a background rect with a fill").toBeTruthy();
    const { rows } = pixels(PNG);
    expect(hex(rows, 0, 0), "regenerate apple-touch-icon.png from icon.svg").toBe(fill!.toUpperCase());
  });

  it("is precached by the service worker alongside the rest of the shell", () => {
    const sw = readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
    expect(sw).toContain("'./apple-touch-icon.png'");
  });
});
