import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkRatchet,
  largestJs,
  type FileSize,
  type RatchetRecord,
} from "./browser-size-ratchet.js";

const RECORD: RatchetRecord & { kpiCeilingKB: number } = JSON.parse(
  readFileSync(new URL("../public-size-ratchet.json", import.meta.url), "utf8"),
);

function publicJsSizes(): FileSize[] {
  const dir = new URL("../public/", import.meta.url).pathname;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}

describe("the largest browser file is a ratchet", () => {
  it("matches the recorded measurement exactly", () => {
    const verdict = checkRatchet(publicJsSizes(), RECORD);
    expect(verdict.ok ? "" : verdict.message).toBe("");
    expect(verdict.ok).toBe(true);
  });
});

// The check above is green today and would be green against a version of
// checkRatchet that returned ok unconditionally, so these are what prove it
// bites. One shrunk fixture per direction.
describe("checkRatchet", () => {
  const recorded: RatchetRecord = { largestFile: "app.js", largestBytes: 1000 };

  it("refuses a file that grew by a single byte", () => {
    const v = checkRatchet([{ name: "app.js", bytes: 1001 }], recorded);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("grew");
    expect(v.ok === false && v.message).toContain("must never rise");
    // The message has to carry the exact number to type, or the fix is a
    // second measurement the reader takes by hand.
    expect(v.ok === false && v.message).toContain("1001");
  });

  it("refuses a file that shrank, so the record follows it down", () => {
    const v = checkRatchet([{ name: "app.js", bytes: 900 }], recorded);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("shrank");
    expect(v.ok === false && v.message).toContain("900");
  });

  it("passes when the size is unchanged", () => {
    const v = checkRatchet([{ name: "app.js", bytes: 1000 }], recorded);
    expect(v.ok).toBe(true);
  });

  it("catches new code moved into a fresh file that becomes the biggest", () => {
    // The obvious way round a per-file ceiling: leave app.js alone and put
    // the new subsystem in public/app-extra.js. The measure is the largest
    // file, so this is refused.
    const v = checkRatchet(
      [
        { name: "app.js", bytes: 1000 },
        { name: "app-extra.js", bytes: 1200 },
      ],
      recorded,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("grew");
    expect(v.ok === false && v.message).toContain("app-extra.js");
  });

  it("names the file when the biggest one changes identity at the same size", () => {
    const v = checkRatchet([{ name: "app-core.js", bytes: 1000 }], recorded);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("moved");
  });

  it("does not count a non-.js file, however big", () => {
    const v = checkRatchet(
      [
        { name: "app.js", bytes: 1000 },
        { name: "style.css", bytes: 99999 },
        { name: "icon.png", bytes: 500000 },
      ],
      recorded,
    );
    expect(v.ok).toBe(true);
  });

  it("refuses an empty public/ rather than reporting zero kilobytes", () => {
    // A zero here would say Marcus has no front end, which is a broken
    // checkout, not a ratchet that was met.
    const v = checkRatchet([{ name: "style.css", bytes: 10 }], recorded);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.message).toContain("broken checkout");
  });

  it("largestJs breaks a tie by name so the verdict is stable", () => {
    const files = [
      { name: "b.js", bytes: 10 },
      { name: "a.js", bytes: 10 },
    ];
    expect(largestJs(files)?.name).toBe("a.js");
    expect(largestJs([...files].reverse())?.name).toBe("a.js");
  });
});

describe("the recorded number and the KPI", () => {
  it("records the file the KPI names and the ceiling it declared", () => {
    expect(RECORD.largestFile).toBe("app.js");
    expect(RECORD.kpiCeilingKB).toBe(292);
  });
});
