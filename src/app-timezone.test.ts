import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, "..", "public", "app-core.js");

// Every other test in this repo runs in whatever zone the machine is in, and
// CI's machine is UTC -- the one zone where "the local day" and "the day in
// Greenwich" always agree. So a date bug that only appears off Greenwich is
// invisible to all of them, which is how the app shipped for weeks writing
// yesterday's date onto a session logged after local midnight in Oslo.
//
// This runs app-core.js in a child node process with TZ pinned, which is the
// only way to change the zone a Date reports in.
function inZone(tz: string, expr: string): string {
  const script = `
    const fs = require('node:fs');
    const vm = require('node:vm');
    const mem = new Map();
    const localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    };
    const ctx = vm.createContext({ localStorage, setTimeout, clearTimeout, console });
    vm.runInContext(fs.readFileSync(${JSON.stringify(CORE)}, "utf8"), ctx);
    process.stdout.write(String(vm.runInContext(${JSON.stringify(expr)}, ctx)));
  `;
  return execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
}

// Oslo is two hours ahead of Greenwich in summer, Denver six behind, so the
// two of them catch a date pushed the wrong way in either direction.
const EAST = "Europe/Oslo";
const WEST = "America/Denver";

describe("dates are the local calendar day, in any timezone", () => {
  it("the child process really is in the zone it was given", () => {
    // Without this, every assertion below could be passing because TZ never
    // took effect and the child ran in UTC like everything else.
    expect(inZone(EAST, "new Date(2026, 8, 8, 0, 30).toISOString()")).toBe("2026-09-07T22:30:00.000Z");
    expect(inZone(WEST, "new Date(2026, 8, 8, 23, 30).toISOString()")).toBe("2026-09-09T05:30:00.000Z");
  });

  it("half past midnight in Oslo is today, not yesterday", () => {
    expect(inZone(EAST, "fmtDate(new Date(2026, 8, 8, 0, 30))")).toBe("2026-09-08");
  });

  it("half past eleven at night in Denver is today, not tomorrow", () => {
    expect(inZone(WEST, "fmtDate(new Date(2026, 8, 8, 23, 30))")).toBe("2026-09-08");
  });

  it("a Date built at local midnight keeps its own day", () => {
    // This is the shape the volume chart's week buckets and the goal
    // milestones are built from: `new Date(iso + 'T00:00')`, which is midnight
    // where the reader is, then formatted back to a day.
    expect(inZone(EAST, "fmtDate(new Date('2026-09-08T00:00'))")).toBe("2026-09-08");
    expect(inZone(WEST, "fmtDate(new Date('2026-09-08T00:00'))")).toBe("2026-09-08");
  });

  it("todayStr is the day the reader's own calendar shows", () => {
    // sv-SE renders a local date as YYYY-MM-DD, so this compares two readings
    // of the same instant rather than pinning a date that goes stale.
    for (const tz of [EAST, WEST]) {
      expect(inZone(tz, "todayStr()")).toBe(inZone(tz, "new Date().toLocaleDateString('sv-SE')"));
    }
  });

  it("the last goal milestone lands on the target date", () => {
    expect(inZone(EAST, "buildMilestones('2026-08-31', '2027-07-01').at(-1).date")).toBe("2027-07-01");
    expect(inZone(WEST, "buildMilestones('2026-08-31', '2027-07-01').at(-1).date")).toBe("2027-07-01");
  });
});
