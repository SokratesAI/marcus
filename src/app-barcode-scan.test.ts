import { APP_SOURCE } from "./app-source.js";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect, vi, afterEach } from "vitest";

type Answer = { status: number; body?: unknown; throws?: boolean; badJson?: boolean };

// Same vm harness as app-nutrition.test.ts, plus a fetch this test controls.
// The context deliberately has no real `fetch`: every call the app makes here
// has to come back from `answer`, so a test that passed by reaching the network
// is not possible.
function loadApp(answer?: Answer): { ctx: any; toasts: string[]; byId: Record<string, any>; asked: string[] } {
  const toasts: string[] = [];
  const stored: Record<string, string> = {};
  const asked: string[] = [];

  const makeNode = (): any => {
    const node: any = {
      value: "",
      textContent: "",
      innerHTML: "",
      disabled: false,
      hidden: false,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      content: { firstElementChild: { cloneNode: () => makeNode() } },
      appendChild() {},
      remove() {},
      addEventListener(name: string, fn: any) {
        (node.handlers ??= {})[name] = fn;
      },
      querySelector: () => makeNode(),
      querySelectorAll: () => [],
      getContext: () => ({}),
      handlers: {} as Record<string, any>,
    };
    return node;
  };

  const byId: Record<string, any> = {};
  const document: any = {
    body: makeNode(),
    getElementById: (id: string) => (byId[id] ??= makeNode()),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };

  const ctx: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
    Math, JSON, Number, String, Array, Object, Date, RegExp,
    document,
    navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
    fetch: async (url: string) => {
      asked.push(url);
      if (!answer) throw new Error("no answer configured");
      if (answer.throws) throw new TypeError("Failed to fetch");
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        json: async () => {
          if (answer.badJson) throw new SyntaxError("Unexpected token <");
          return answer.body;
        },
      };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const toastNode = document.getElementById("toast");
  Object.defineProperty(toastNode, "textContent", {
    get: () => "",
    set: (v: string) => toasts.push(v),
  });

  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.store = store;" +
      "\n;globalThis.FOODS = FOODS;" +
      "\n;Object.defineProperty(globalThis, 'foodPick', { get: () => foodPick });",
    ctx,
  );
  // Boot asks the server for the state copy (issue #153). That request is real
  // and is asserted in app-servercopy.test.ts; here it is noise in front of the
  // one call each test below is about, so the log starts after boot.
  asked.length = 0;
  return { ctx, toasts, byId, asked };
}

// --- an encoder, written here on purpose -------------------------------------
// The decoder in app-core.js must not be tested against a table it also owns,
// so this builds the bars from the published EAN-13 bit patterns instead of
// from the app's run-width table. If the app's table is wrong, these two
// disagree and the test fails -- which is the whole point of not sharing them.
const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const R = L.map(b => b.split("").map(c => (c === "0" ? "1" : "0")).join(""));
// G is the reverse of R, not the reverse of L -- getting that wrong builds a
// symbol whose bars merge into each other and decodes as nothing at all.
const G = R.map(b => b.split("").reverse().join(""));
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGGLGL","LGLGGL"];

function checkDigit(twelve: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** The 95 modules of an EAN-13 symbol, as a string of '0' (space) and '1' (bar). */
function modules(code: string): string {
  const parity = PARITY[Number(code[0])];
  let bits = "101";
  for (let i = 0; i < 6; i++) bits += (parity[i] === "L" ? L : G)[Number(code[1 + i])];
  bits += "01010";
  for (let i = 0; i < 6; i++) bits += R[Number(code[7 + i])];
  return bits + "101";
}

/**
 * One row of luminance, as a camera would hand it over: a quiet zone either
 * side, `scale` pixels per module, and a bar darker than a space.
 */
function row(code: string, opts: { scale?: number; quiet?: number; dark?: number; light?: number } = {}): number[] {
  const scale = opts.scale ?? 3;
  const quiet = opts.quiet ?? 10;
  const dark = opts.dark ?? 30;
  const light = opts.light ?? 220;
  const out: number[] = new Array(quiet).fill(light);
  for (const bit of modules(code)) for (let i = 0; i < scale; i++) out.push(bit === "1" ? dark : light);
  for (let i = 0; i < quiet; i++) out.push(light);
  return out;
}

const KVIKKLUNSJ = "7038010009457"; // the placeholder in the barcode field
const codes = [KVIKKLUNSJ, "5901234123457", "4006381333931", "0012345678905"];

describe("decodeEan13Row", () => {
  it("reads back every EAN-13 it is given", () => {
    const { decodeEan13Row } = loadApp().ctx;
    for (const code of codes) expect(decodeEan13Row(row(code))).toBe(code);
  });

  it("reads a packet held upside down", () => {
    const { decodeEan13Row } = loadApp().ctx;
    expect(decodeEan13Row(row(KVIKKLUNSJ).reverse())).toBe(KVIKKLUNSJ);
  });

  it("reads the same code at one pixel per module and at eight", () => {
    const { decodeEan13Row } = loadApp().ctx;
    expect(decodeEan13Row(row(KVIKKLUNSJ, { scale: 1 }))).toBe(KVIKKLUNSJ);
    expect(decodeEan13Row(row(KVIKKLUNSJ, { scale: 8 }))).toBe(KVIKKLUNSJ);
  });

  it("reads a dim frame, because the threshold comes from the row itself", () => {
    const { decodeEan13Row } = loadApp().ctx;
    expect(decodeEan13Row(row(KVIKKLUNSJ, { dark: 90, light: 140 }))).toBe(KVIKKLUNSJ);
  });

  it("finds the code when the row starts on something else entirely", () => {
    const { decodeEan13Row } = loadApp().ctx;
    // A hand, a shadow and the edge of the packet before the quiet zone.
    const noise = [40, 40, 40, 200, 200, 90, 90, 90, 90, 210, 210, 210, 40, 40, 210];
    expect(decodeEan13Row([...noise, ...row(KVIKKLUNSJ)])).toBe(KVIKKLUNSJ);
  });

  it("refuses a code whose check digit does not add up", () => {
    const { decodeEan13Row } = loadApp().ctx;
    // A real symbol, but one digit re-encoded so the printed check digit is
    // wrong -- which is exactly what a misread frame produces.
    const broken = KVIKKLUNSJ.slice(0, 11) + (Number(KVIKKLUNSJ[11]) === 9 ? "0" : "9") + KVIKKLUNSJ[12];
    expect(broken).not.toBe(KVIKKLUNSJ);
    expect(decodeEan13Row(row(broken))).toBeNull();
  });

  it("refuses a frame with no contrast in it", () => {
    const { decodeEan13Row } = loadApp().ctx;
    expect(decodeEan13Row(new Array(400).fill(200))).toBeNull();
    expect(decodeEan13Row(new Array(400).fill(0))).toBeNull();
  });

  it("refuses a row too short to hold a symbol, and an empty one", () => {
    const { decodeEan13Row } = loadApp().ctx;
    expect(decodeEan13Row(row(KVIKKLUNSJ).slice(0, 59))).toBeNull();
    expect(decodeEan13Row([])).toBeNull();
    expect(decodeEan13Row(null)).toBeNull();
  });

  it("refuses stripes that are not a barcode", () => {
    const { decodeEan13Row } = loadApp().ctx;
    const stripes: number[] = [];
    for (let i = 0; i < 200; i++) stripes.push(i % 6 < 3 ? 30 : 220);
    expect(decodeEan13Row(stripes)).toBeNull();
  });

  it("refuses a symbol whose centre guard is the wrong width", () => {
    const { decodeEan13Row } = loadApp().ctx;
    // Everything else about this symbol is correct and every digit still
    // decodes -- the five centre modules are simply twice as wide as they
    // should be. Only the guard check can tell, which is what makes this the
    // test for it rather than for the digit matcher.
    const bits = modules(KVIKKLUNSJ);
    const stretched = bits.slice(0, 45) + bits.slice(45, 50).split("").map(b => b + b).join("") + bits.slice(50);
    const px: number[] = new Array(10).fill(220);
    for (const bit of stretched) for (let i = 0; i < 3; i++) px.push(bit === "1" ? 30 : 220);
    px.push(...new Array(10).fill(220));
    expect(decodeEan13Row(px)).toBeNull();
    // ...and the same symbol with the guard left alone still reads, so this is
    // about the guard and not about the extra width breaking something else.
    expect(decodeEan13Row(row(KVIKKLUNSJ))).toBe(KVIKKLUNSJ);
  });

  it("refuses a symbol whose end guard is the wrong width", () => {
    const { decodeEan13Row } = loadApp().ctx;
    // Same shape as the centre-guard case, at the other end: all twelve digits
    // decode and the check digit adds up, and the only thing wrong with the
    // symbol is that it does not finish where an EAN-13 finishes.
    const bits = modules(KVIKKLUNSJ);
    const stretched = bits.slice(0, 92) + bits.slice(92).split("").map(b => b + b).join("");
    const px: number[] = new Array(10).fill(220);
    for (const bit of stretched) for (let i = 0; i < 3; i++) px.push(bit === "1" ? 30 : 220);
    px.push(...new Array(10).fill(220));
    expect(decodeEan13Row(px)).toBeNull();
  });

  it("refuses a symbol whose centre guard has been painted over", () => {
    const { decodeEan13Row } = loadApp().ctx;
    const bits = modules(KVIKKLUNSJ).split("");
    for (let i = 45; i < 50; i++) bits[i] = "1"; // the 5 centre-guard modules
    const painted: number[] = new Array(10).fill(220);
    for (const bit of bits) for (let i = 0; i < 3; i++) painted.push(bit === "1" ? 30 : 220);
    painted.push(...new Array(10).fill(220));
    expect(decodeEan13Row(painted)).toBeNull();
  });

  it("hands the lookup a code it accepts", async () => {
    const ctx = loadApp().ctx;
    const code = ctx.decodeEan13Row(row(KVIKKLUNSJ));
    const asked: string[] = [];
    const res = await ctx.lookupBarcodeFood(code, async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, json: async () => ({ food: { name: "Kvikk Lunsj", unit: "100 g", kcal: 520, protein: 6, carbs: 60, fat: 28 } }) };
    });
    expect(asked).toEqual([`/api/food/barcode/${KVIKKLUNSJ}`]);
    expect(res.ok).toBe(true);
  });
});

describe("ean13ChecksumOk", () => {
  it("accepts a real code and rejects every single-digit change to it", () => {
    const { ean13ChecksumOk } = loadApp().ctx;
    expect(ean13ChecksumOk(KVIKKLUNSJ)).toBe(true);
    for (let i = 0; i < 13; i++) {
      for (let d = 0; d < 10; d++) {
        if (String(d) === KVIKKLUNSJ[i]) continue;
        const bad = KVIKKLUNSJ.slice(0, i) + d + KVIKKLUNSJ.slice(i + 1);
        expect(ean13ChecksumOk(bad)).toBe(false);
      }
    }
  });

  it("refuses anything that is not thirteen digits", () => {
    const { ean13ChecksumOk } = loadApp().ctx;
    expect(ean13ChecksumOk("703801000945")).toBe(false);
    expect(ean13ChecksumOk("70380100094570")).toBe(false);
    expect(ean13ChecksumOk("703801000945x")).toBe(false);
    expect(ean13ChecksumOk("")).toBe(false);
  });

  it("agrees with the published check digit for every code this test builds", () => {
    const { ean13ChecksumOk } = loadApp().ctx;
    for (const code of codes) expect(code[12]).toBe(checkDigit(code.slice(0, 12)));
    for (const code of codes) expect(ean13ChecksumOk(code)).toBe(true);
  });
});

describe("decodeEan13Frame", () => {
  // A frame is RGBA, so this paints one row's luminance across every row of a
  // little image and then draws the barcode into one band of it.
  function frame(code: string | null, width: number, height: number, top: number, tall = 30): Uint8ClampedArray {
    const bg = 200;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = bg; data[i * 4 + 1] = bg; data[i * 4 + 2] = bg; data[i * 4 + 3] = 255;
    }
    if (code) {
      // A barcode on a packet is tens of pixels tall in the frame, not one --
      // a one-pixel-tall symbol would be testing the sampling arithmetic rather
      // than anything the camera can hand over.
      const line = row(code, { scale: Math.max(1, Math.floor((width - 20) / 95)) });
      for (let y = top; y < Math.min(height, top + tall); y++) {
        for (let x = 0; x < Math.min(width, line.length); x++) {
          const at = (y * width + x) * 4;
          data[at] = line[x]; data[at + 1] = line[x]; data[at + 2] = line[x];
        }
      }
    }
    return data;
  }

  it("finds a barcode on the centre line of a frame", () => {
    const { decodeEan13Frame } = loadApp().ctx;
    const w = 320, h = 240;
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, w, h, 105), w, h)).toBe(KVIKKLUNSJ);
  });

  it("finds a barcode well off the centre line, because it reads a band", () => {
    const { decodeEan13Frame } = loadApp().ctx;
    const w = 320, h = 240;
    // The band this reads is the middle third, rows 79..160. Both of these sit
    // entirely clear of row 120, so a scanner that read only the centre line
    // would return null for both.
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, w, h, 82), w, h)).toBe(KVIKKLUNSJ);
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, w, h, 128), w, h)).toBe(KVIKKLUNSJ);
    // ...and it does. This is the assertion that makes the one above mean
    // something: the barcode really is off the centre line.
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, w, h, 82), w, h, 1)).toBeNull();
  });

  it("answers null on a frame with no barcode in it", () => {
    const { decodeEan13Frame } = loadApp().ctx;
    const w = 320, h = 240;
    expect(decodeEan13Frame(frame(null, w, h, 105), w, h)).toBeNull();
  });

  it("answers null rather than throwing on a frame that makes no sense", () => {
    const { decodeEan13Frame } = loadApp().ctx;
    expect(decodeEan13Frame(null, 320, 240)).toBeNull();
    expect(decodeEan13Frame(new Uint8ClampedArray(4), 320, 240)).toBeNull();
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, 320, 240, 105), 0, 240)).toBeNull();
    expect(decodeEan13Frame(frame(KVIKKLUNSJ, 320, 240, 105), 320, 0)).toBeNull();
  });
});

// --- the camera plumbing -----------------------------------------------------
// app.js holds no decisions about barcodes, but it does hold one about the
// camera: a stream that is not stopped leaves the light on. These are about
// that, and about the four ways opening a camera fails.

function fakeVideo(): any {
  return { videoWidth: 0, videoHeight: 0, srcObject: null, play() {} };
}

function fakeTrack(): any {
  return { stopped: false, stop() { this.stopped = true; } };
}

function scannerHarness(getUserMedia: any) {
  const app = loadApp();
  const { ctx, byId, toasts } = app;
  const el = (id: string) => ctx.document.getElementById(id);
  const video = Object.assign(el("scanVideo"), fakeVideo());
  const sheet = el("scanSheet");
  const close = el("scanClose");
  el("scanHint");
  sheet.hidden = true;
  const scrim: any = { onclick: null };
  sheet.querySelector = () => scrim;
  ctx.navigator.mediaDevices = getUserMedia ? { getUserMedia } : undefined;
  return { ctx, byId, toasts, video, sheet, close, scrim };
}

afterEach(() => { vi.useRealTimers(); });

describe("readBarcodeFrame", () => {
  it("decodes the frame the canvas hands back", () => {
    const { ctx } = loadApp();
    const w = 320, h = 240;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = 200; data[i * 4 + 1] = 200; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255; }
    const line = row(KVIKKLUNSJ, { scale: 3 });
    for (let y = 100; y < 130; y++) for (let x = 0; x < line.length; x++) {
      const at = (y * w + x) * 4;
      data[at] = line[x]; data[at + 1] = line[x]; data[at + 2] = line[x];
    }
    const canvas: any = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data }) }) };
    expect(ctx.readBarcodeFrame({ videoWidth: w, videoHeight: h }, canvas)).toBe(KVIKKLUNSJ);
    // The canvas is sized to the frame, not left at its default 300x150 --
    // getting that wrong silently scales the bars and decodes nothing.
    expect([canvas.width, canvas.height]).toEqual([w, h]);
  });

  it("answers null before the camera has a frame, without drawing anything", () => {
    const { ctx } = loadApp();
    let drawn = 0;
    const canvas: any = { getContext: () => ({ drawImage() { drawn++; }, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) };
    expect(ctx.readBarcodeFrame({ videoWidth: 0, videoHeight: 0 }, canvas)).toBeNull();
    expect(drawn).toBe(0);
  });

  it("answers null when the canvas refuses to be read", () => {
    const { ctx } = loadApp();
    const canvas: any = {
      getContext: () => ({ drawImage() {}, getImageData() { throw new Error("SecurityError"); } }),
    };
    expect(ctx.readBarcodeFrame({ videoWidth: 320, videoHeight: 240 }, canvas)).toBeNull();
  });
});

describe("openBarcodeScanner", () => {
  it("says so and opens nothing when the browser has no camera API", async () => {
    const { ctx, toasts, sheet } = scannerHarness(null);
    await ctx.openBarcodeScanner(() => { throw new Error("must not be called"); });
    expect(sheet.hidden).toBe(true);
    expect(toasts.join(" ")).toContain("will not open the camera");
  });

  it("says something different for a refused permission than for a broken camera", async () => {
    const denied = scannerHarness(async () => { const e: any = new Error("no"); e.name = "NotAllowedError"; throw e; });
    await denied.ctx.openBarcodeScanner(() => {});
    const broken = scannerHarness(async () => { const e: any = new Error("no"); e.name = "NotReadableError"; throw e; });
    await broken.ctx.openBarcodeScanner(() => {});
    expect(denied.toasts[0]).toContain("permission");
    expect(broken.toasts[0]).not.toContain("permission");
    expect(denied.toasts[0]).not.toBe(broken.toasts[0]);
    expect(denied.sheet.hidden).toBe(true);
    expect(broken.sheet.hidden).toBe(true);
  });

  it("hands the code over once, stops the camera and closes", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    const stream = { getTracks: () => [track] };
    const h = scannerHarness(async () => stream);
    const found: string[] = [];
    // No frame yet on the first ticks, then a readable one.
    let reads = 0;
    h.ctx.readBarcodeFrame = () => (++reads >= 3 ? KVIKKLUNSJ : null);
    await h.ctx.openBarcodeScanner((code: string) => found.push(code));
    expect(h.sheet.hidden).toBe(false);
    expect(h.video.srcObject).toBe(stream);
    vi.advanceTimersByTime(120 * 5);
    expect(found).toEqual([KVIKKLUNSJ]);
    expect(track.stopped).toBe(true);
    expect(h.sheet.hidden).toBe(true);
    expect(h.video.srcObject).toBeNull();
    // The interval is really gone: more time passes and nothing fires again.
    vi.advanceTimersByTime(120 * 20);
    expect(found).toEqual([KVIKKLUNSJ]);
  });

  it("gives up after 25 seconds rather than holding the camera open", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    const h = scannerHarness(async () => ({ getTracks: () => [track] }));
    h.ctx.readBarcodeFrame = () => null;
    await h.ctx.openBarcodeScanner(() => { throw new Error("must not be called"); });
    vi.advanceTimersByTime(24000);
    expect(track.stopped).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(track.stopped).toBe(true);
    expect(h.sheet.hidden).toBe(true);
    expect(h.toasts.join(" ")).toContain("Could not read that barcode");
  });

  it("stops the camera when the close button is pressed", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    const h = scannerHarness(async () => ({ getTracks: () => [track] }));
    h.ctx.readBarcodeFrame = () => null;
    await h.ctx.openBarcodeScanner(() => {});
    expect(typeof h.close.onclick).toBe("function");
    h.close.onclick();
    expect(track.stopped).toBe(true);
    expect(h.sheet.hidden).toBe(true);
  });
});
