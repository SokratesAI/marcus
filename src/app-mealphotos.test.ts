import { APP_SOURCE } from "./app-source.js";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

// Same vm shape as app-photos.test.ts: everything under test takes plain values
// and returns plain values, so no DOM node is touched.
function loadApp(): any {
  const stored: Record<string, string> = {};
  const makeNode = (): any => ({
    value: "", textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => makeNode(), querySelectorAll: () => [], getContext: () => ({}),
  });
  const document: any = {
    body: makeNode(),
    getElementById: () => makeNode(),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener() {},
  };
  const ctx: any = {
    console, setTimeout, clearTimeout, Math, JSON, Number, String, Array, Object, Date, isFinite, RegExp,
    document, navigator: {},
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
    Chart: function () { return { destroy() {} }; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    APP_SOURCE +
      "\n;globalThis.PHOTO_BUDGET_BYTES = PHOTO_BUDGET_BYTES;" +
      "\n;globalThis.PHOTO_MAX_BYTES = PHOTO_MAX_BYTES;" +
      "\n;globalThis.MEAL_PHOTO_MAX_BYTES = MEAL_PHOTO_MAX_BYTES;" +
      "\n;globalThis.MEAL_PHOTO_MAX_EDGE = MEAL_PHOTO_MAX_EDGE;",
    ctx
  );
  return ctx;
}

// A data URL whose decoded payload is exactly `bytes` long. `bytes` must be a
// multiple of 3 so the base64 carries no padding, which keeps the arithmetic in
// the test as simple as the arithmetic in `photoBytes`.
function jpegOf(bytes: number): string {
  return "data:image/jpeg;base64," + "A".repeat((bytes / 3) * 4);
}

function meal(id: string, extra: Record<string, unknown> = {}): any {
  return { id, date: "2026-09-07", time: "12:00", name: "Chicken and rice", calories: 600, ...extra };
}

describe("a photo on the meal you logged", () => {
  it("accepts a photo on a meal that is in the log", () => {
    const app = loadApp();
    const out = app.validateMealPhoto("m1", jpegOf(9000), [meal("m1")], []);
    expect(out.ok).toBe(true);
    expect(out.id).toBe("m1");
    expect(out.bytes).toBe(9000);
  });

  it("refuses a photo for a meal that is not in the log any more", () => {
    const app = loadApp();
    const out = app.validateMealPhoto("gone", jpegOf(9000), [meal("m1")], []);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not in your log/);
  });

  it("refuses something that is not an image", () => {
    const app = loadApp();
    const out = app.validateMealPhoto("m1", "data:text/plain;base64,QUJD", [meal("m1")], []);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not an image/);
  });

  it("refuses one photo bigger than the per-meal-photo limit", () => {
    const app = loadApp();
    const tooBig = app.MEAL_PHOTO_MAX_BYTES + 3 - ((app.MEAL_PHOTO_MAX_BYTES + 3) % 3);
    const out = app.validateMealPhoto("m1", jpegOf(tooBig), [meal("m1")], []);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/limit for a meal photo/);
  });

  it("gives a meal photo a tighter per-photo limit than a progress photo", () => {
    const app = loadApp();
    expect(app.MEAL_PHOTO_MAX_BYTES).toBeLessThan(app.PHOTO_MAX_BYTES);
    expect(app.MEAL_PHOTO_MAX_EDGE).toBeLessThan(720);
  });

  // The whole point of the feature's design: one budget across both stores.
  // Two independent 2MB budgets add up to a state document the server refuses,
  // and then it is every save that fails, not the photo.
  it("spends from the same budget the progress photos spend from", () => {
    const app = loadApp();
    const nearlyFull = app.PHOTO_BUDGET_BYTES - 3000;
    const photos = [{ id: "p1", date: "2026-09-01", pose: "front", dataUrl: jpegOf(3000), bytes: nearlyFull }];
    const out = app.validateMealPhoto("m1", jpegOf(9000), [meal("m1")], photos);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/No room/);
  });

  it("makes a progress photo see what the meal photos have already spent", () => {
    const app = loadApp();
    const meals = [meal("m1", { photo: jpegOf(3000), photoBytes: app.PHOTO_BUDGET_BYTES - 3000 })];
    const out = app.validatePhoto("front", jpegOf(9000), [], "2026-09-07", meals);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/No room/);
  });

  it("still lets a progress photo through when the meals hold nothing", () => {
    const app = loadApp();
    const out = app.validatePhoto("front", jpegOf(9000), [], "2026-09-07", [meal("m1")]);
    expect(out.ok).toBe(true);
  });

  // Without this a retake near the ceiling is refused while the room it needs
  // is sitting in the record it is about to overwrite.
  it("does not charge a replacement photo twice", () => {
    const app = loadApp();
    const spent = app.PHOTO_BUDGET_BYTES - 3000;
    const meals = [meal("m1", { photo: jpegOf(3000), photoBytes: spent })];
    const out = app.validateMealPhoto("m1", jpegOf(9000), meals, []);
    expect(out.ok).toBe(true);
    expect(out.bytes).toBe(9000);
  });

  it("counts an older meal photo that was stored without a byte count", () => {
    const app = loadApp();
    const meals = [meal("m1", { photo: jpegOf(9000) })];
    expect(app.mealPhotoTotalBytes(meals)).toBe(9000);
  });

  it("counts nothing for a meal with no photo", () => {
    const app = loadApp();
    expect(app.mealPhotoTotalBytes([meal("m1"), meal("m2")])).toBe(0);
    expect(app.mealPhotoTotalBytes(null)).toBe(0);
  });

  it("adds both stores together", () => {
    const app = loadApp();
    const photos = [{ id: "p1", date: "2026-09-01", pose: "front", dataUrl: jpegOf(3000), bytes: 3000 }];
    const meals = [meal("m1", { photo: jpegOf(9000), photoBytes: 9000 })];
    expect(app.storedPhotoBytes(photos, meals)).toBe(12000);
  });

  it("attaches the photo to the named meal and leaves the others alone", () => {
    const app = loadApp();
    const meals = [meal("m1"), meal("m2")];
    const out = app.attachMealPhoto(meals, { id: "m2", dataUrl: jpegOf(9000), bytes: 9000 });
    expect(out[0].photo).toBeUndefined();
    expect(out[1].photo).toBe(jpegOf(9000));
    expect(out[1].photoBytes).toBe(9000);
    expect(out[1].calories).toBe(600);
  });

  it("replaces a meal's photo rather than keeping two", () => {
    const app = loadApp();
    const meals = [meal("m1", { photo: jpegOf(3000), photoBytes: 3000 })];
    const out = app.attachMealPhoto(meals, { id: "m1", dataUrl: jpegOf(9000), bytes: 9000 });
    expect(out).toHaveLength(1);
    expect(out[0].photoBytes).toBe(9000);
    expect(app.mealPhotoTotalBytes(out)).toBe(9000);
  });

  // Leaving photoBytes behind would keep charging the budget for a photo that
  // is not there, and nothing on screen would say why the next one was refused.
  it("removes the byte count along with the photo", () => {
    const app = loadApp();
    const meals = [meal("m1", { photo: jpegOf(9000), photoBytes: 9000 }), meal("m2")];
    const out = app.detachMealPhoto(meals, "m1");
    expect("photo" in out[0]).toBe(false);
    expect("photoBytes" in out[0]).toBe(false);
    expect(app.mealPhotoTotalBytes(out)).toBe(0);
    expect(out[0].name).toBe("Chicken and rice");
    expect(out[1]).toEqual(meals[1]);
  });

  it("does nothing when the meal it is asked to clear has no photo", () => {
    const app = loadApp();
    const meals = [meal("m1")];
    expect(app.detachMealPhoto(meals, "m1")).toEqual(meals);
    expect(app.detachMealPhoto(meals, "nope")).toEqual(meals);
  });
});
