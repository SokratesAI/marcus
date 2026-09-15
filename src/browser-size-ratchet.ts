// The guardrail under Marcus / Codebase health, enforced at merge time.
//
// project-goals.md carries a KPI, marcus-kpi-browser-monolith: "Size of the
// largest hand-written JS file Marcus serves to the page", high 292 KB, and
// it says in so many words "It is a ratchet: it may fall and must never
// rise." Nothing enforced that sentence. Four cycles on the night of
// 2026-09-14/15 added a chat-driven session log, a typed-background card and
// two smaller features, every one of them into public/app.js, and the file
// went 292 KB -> 303 KB with every check green on all four pull requests.
// The KPI is read once a day by a sweep that reports it and merges nothing,
// so the breach was visible about sixteen hours after it was unfixable.
//
// The recorded number in public-size-ratchet.json is the measurement, not a
// budget somebody picked. The check refuses a size that is bigger than it
// (the ratchet) AND a size that is smaller (the record has to follow the file
// down, or it stops meaning anything within a month). Either way the fix is
// one line in that file, which is the point: a diff that makes the browser
// monolith bigger now carries the number going up, in the pull request, where
// I can see it before merging.
//
// Measured the same way the KPI's own instrument measures it -- the largest
// `.js` directly in public/, no recursion, so a vendored bundle under
// public/vendor/ cannot decide the number.

export type FileSize = { name: string; bytes: number };

export type RatchetRecord = {
  largestFile: string;
  largestBytes: number;
};

export type Verdict =
  | { ok: true; file: string; bytes: number }
  | { ok: false; reason: "grew" | "shrank" | "moved"; message: string };

export function largestJs(files: FileSize[]): FileSize | null {
  const js = files.filter((f) => f.name.endsWith(".js"));
  if (js.length === 0) return null;
  // Ties broken by name so the verdict is stable across filesystems.
  return js.reduce((a, b) =>
    b.bytes > a.bytes || (b.bytes === a.bytes && b.name < a.name) ? b : a,
  );
}

export function checkRatchet(
  files: FileSize[],
  recorded: RatchetRecord,
): Verdict {
  const biggest = largestJs(files);
  if (biggest === null) {
    return {
      ok: false,
      reason: "shrank",
      message:
        "no .js file in public/ at all -- Marcus serves a front end, so this " +
        "is a broken checkout rather than a zero-kilobyte browser bundle",
    };
  }
  // Bytes as well as kilobytes: one decimal place rounds a
  // one-byte change to the same number on both sides of "up from".
  const kb = (n: number) => `${(n / 1000).toFixed(1)} KB (${n} bytes)`;
  if (biggest.bytes > recorded.largestBytes) {
    return {
      ok: false,
      reason: "grew",
      message:
        `public/${biggest.name} is ${kb(biggest.bytes)}, up from the ` +
        `recorded ${kb(recorded.largestBytes)}. marcus-kpi-browser-monolith ` +
        `is a ratchet: the largest browser file may fall and must never rise. ` +
        `Put the new code in its own module under public/ instead. If the ` +
        `growth is genuinely the right call, raise largestBytes to ` +
        `${biggest.bytes} in public-size-ratchet.json and say why in the PR -- ` +
        `that line is the decision, and it should be hard to miss.`,
    };
  }
  if (biggest.bytes < recorded.largestBytes) {
    return {
      ok: false,
      reason: "shrank",
      message:
        `public/${biggest.name} is ${kb(biggest.bytes)}, down from the ` +
        `recorded ${kb(recorded.largestBytes)} -- good. Lower largestBytes ` +
        `to ${biggest.bytes} in public-size-ratchet.json so the ratchet holds ` +
        `the new ground.`,
    };
  }
  if (biggest.name !== recorded.largestFile) {
    return {
      ok: false,
      reason: "moved",
      message:
        `the largest browser file is public/${biggest.name} now, not ` +
        `public/${recorded.largestFile}. Set largestFile to "${biggest.name}" ` +
        `in public-size-ratchet.json.`,
    };
  }
  return { ok: true, file: biggest.name, bytes: biggest.bytes };
}
