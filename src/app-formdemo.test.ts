import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { appFile } from "./app-source.js";
import { renderApp } from "./app-dom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORM_DIR = path.join(__dirname, "..", "public", "form");

function loadCore(): any {
  const ctx: any = { console, Math, JSON, Number, String, Array, Object, Date, RegExp, navigator: {} };
  const mem: Record<string, string> = {};
  ctx.localStorage = { getItem: (k: string) => (k in mem ? mem[k] : null), setItem: (k: string, v: string) => { mem[k] = v; } };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    appFile("app-core.js") + "\n;globalThis.FORM_GUIDE = FORM_GUIDE;\n;globalThis.formDemoFrames = formDemoFrames;",
    ctx,
  );
  return ctx;
}

describe("form demo drawings (idea #193)", () => {
  const app = loadCore();
  const withDemo = app.FORM_GUIDE.filter((e: any) => e.demo);

  it("points every demo at two frames that are really on disk", () => {
    const files = new Set(readdirSync(FORM_DIR));
    expect(withDemo.length).toBe(10);
    for (const e of withDemo) {
      const frames = app.formDemoFrames(e);
      expect(frames).toEqual([`./form/${e.demo}-1.png`, `./form/${e.demo}-2.png`]);
      for (const f of frames) expect(files.has(f.replace("./form/", "")), `${e.name}: ${f}`).toBe(true);
    }
  });

  it("ships no drawing that no lift uses", () => {
    const used = new Set(withDemo.flatMap((e: any) => app.formDemoFrames(e).map((f: string) => f.replace("./form/", ""))));
    expect(readdirSync(FORM_DIR).filter((f) => !used.has(f))).toEqual([]);
  });

  it("returns no frames for a lift without a matching drawing, or for nothing", () => {
    const bench = app.FORM_GUIDE.find((e: any) => e.name === "Barbell Bench Press");
    expect(app.formDemoFrames(bench)).toEqual([]);
    expect(app.formDemoFrames(null)).toEqual([]);
  });

  it("credits the drawings under their licence in the sheet", () => {
    const html = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    expect(html).toContain("Everkinetic</a>, CC BY-SA 4.0");
  });
});

describe("form sheet shows the drawing in a real DOM", () => {
  it("shows a lift's drawing, and hides it for a lift or a word with none", () => {
    const app = renderApp("plan");
    const doc = app.document;
    const demo = doc.getElementById("termDemo");
    const click = (el: any) => el.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));

    const squat = doc.querySelector('[data-form="Back Squat"]');
    expect(squat, "the Plan tab's exercise library lists Back Squat").not.toBeNull();
    click(squat);
    expect(doc.getElementById("termSheet").hidden).toBe(false);
    expect(demo.hidden).toBe(false);
    const imgs = demo.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("./form/back-squat-1.png");
    expect(imgs[1].getAttribute("src")).toBe("./form/back-squat-2.png");
    expect(imgs[0].alt).toContain("Back Squat");

    click(doc.querySelector('[data-form="Barbell Bench Press"]'));
    expect(doc.getElementById("termTitle").textContent).toBe("Barbell Bench Press");
    expect(demo.hidden).toBe(true);

    click(squat);
    expect(demo.hidden).toBe(false);
    const word = doc.createElement("button");
    word.dataset.term = "RPE";
    doc.body.appendChild(word);
    click(word);
    expect(demo.hidden).toBe(true);
    app.close();
  });
});
