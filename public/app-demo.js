// ---------- the demo notice, and the cards that clear a store ----------
// Split out of app.js on 2026-09-16, not rewritten: every line below this
// header is the same code, in the same order, that sat under
// `// ---------- the demo data a new browser is filled with ----------`.
//
// Why it is its own file. `marcus-kpi-browser-monolith` is a ratchet on the
// largest hand-written file Marcus serves, and app.js went 292 KB -> 303 KB
// over four cycles on 2026-09-14/15. public-size-ratchet.json stops the next
// kilobyte; it does not undo those eleven. This is the undo.
//
// Why this block rather than another. It is the only 20 KB run in app.js with
// exactly one top-level statement in it, and that statement --
// `onStoreWrite = scheduleServerSync` -- reads a function defined further down
// app.js, so it stays there. Everything moved here is a declaration, which
// means the browser can load this file before app.js and app.js's boot block
// still finds all of it.

// ---------- the demo data a new browser is filled with ----------
// `seed()` fills a browser that has never opened Marcus with sixteen sessions,
// fourteen bodyweights and eighteen meals so the app has something to draw.
// Nothing has ever said so on screen. Edvard told Marcus himself on 2026-09-07
// -- "dataen som er her er bare demo data, ikke noe jeg faktisk har gjort" --
// and on 2026-09-13 he deleted all sixteen sessions by hand, one bin tap at a
// time, between 08:03:16 and 08:03:36. The button that would have taken all
// three stores at once is the last card on the Progress tab, below the charts
// and the reminders and the backup card, and he did not find it.
//
// So the app says it where the data is first shown, on Home, and the offer to
// take it out is on the same card as the sentence that explains what it is.
const DEMO_LABELS = { sessions: 'session', weights: 'bodyweight', meals: 'meal' };

// Is every row in this store one `seedDemoLog` wrote? Recognised by content,
// the same way `planIsDemo` recognises the made-up training week, and for the
// same reason: `DEMO_SEEDED_KEY` is written at seed time, so a browser seeded
// before that key existed carries no claim and the notice can never fire in it.
// Edvard's phone is exactly that browser -- his synced state was seeded on or
// before 2026-08-31 and still held 14 demo bodyweights and 18 demo meals when I
// read it on 2026-09-13, while the key that names them shipped that morning.
//
// Every recogniser here is an all-or-nothing match on the whole store, so one
// row he logged himself makes the store his and takes it out of the notice.
// That is the safe direction: under-claiming leaves demo rows unnamed, which is
// where the app already was; over-claiming would offer to delete his own work.
const DEMO_RECOGNISERS = {
  sessions: (rows) => rows.every(r => {
    const list = r && DEMO_SESSION_EXERCISES[r.day];
    const ex = (r && r.exercises) || [];
    return Array.isArray(list) && ex.length === list.length
      && ex.every((e, i) => e && e.name === list[i] && Array.isArray(e.sets) && e.sets.length === 3);
  }),
  meals: (rows) => rows.every(r => r && DEMO_MEALS.some(([name, cal, p, c, f]) =>
    r.name === name && r.calories === cal && r.protein === p && r.carbs === c && r.fat === f)),
  // A descending run on a two-day grid, starting one step below 84.5. A logged
  // weight lands on today and breaks the grid, the descent, or both.
  weights: (rows) => {
    const first = rows[0];
    if (!first || !(first.kg === DEMO_WEIGHT_START - 0.1 || first.kg === DEMO_WEIGHT_START - 0.2)) return false;
    return rows.every((r, i) => {
      if (!r || typeof r.kg !== 'number' || typeof r.date !== 'string') return false;
      if (!i) return true;
      const prev = rows[i - 1];
      const step = Math.round((prev.kg - r.kg) * 10) / 10;
      const days = Math.round((Date.parse(r.date + 'T00:00:00Z') - Date.parse(prev.date + 'T00:00:00Z')) / 86400000);
      return days === DEMO_WEIGHT_STEP_DAYS && (step === 0.1 || step === 0.2);
    });
  },
};

// The seeded stores that still hold something. A store he has already emptied
// drops out, so the notice goes away on its own once all of them are gone --
// which is what makes this safe to leave standing rather than one-shot.
//
// Two sources, unioned: the claim `seedDemoLog` wrote in this browser, and the
// content check above for a browser that predates it. `demoPlanKept` answers
// both -- "keep it, it is mine now" has to stick, and with recognition by
// content there is no marker left to clear.
function demoSeededSummary() {
  if (store.get(DEMO_PLAN_KEPT_KEY, false)) return [];
  const claimed = store.get(DEMO_SEEDED_KEY, null);
  const keys = Object.keys(DEMO_LABELS).filter(k => {
    if (Array.isArray(claimed) && claimed.includes(k)) return true;
    const rows = store.get(k, []);
    return Array.isArray(rows) && rows.length > 0 && DEMO_RECOGNISERS[k](rows);
  });
  return clearableSummary(keys);
}

// He can answer "it is mine now" about the plan the same way he can about the
// log, and that answer has to stick across reloads -- `planIsDemo` is computed
// rather than stored, so without this the card would come straight back.
const DEMO_PLAN_KEPT_KEY = 'demoPlanKept';

// Answered, either way. `[]` rather than a delete because `store.get` has no
// remove and an empty array is what `demoSeededSummary` already treats as "no
// claim" -- one shape for the absent case instead of two.
//
// Answers for the plan as well as the log, and deliberately so: every caller --
// "keep it, it is mine now", a restored backup file, an adopted server copy --
// is saying the same thing about everything on the screen, and a card that went
// on calling his own training week made-up after he restored it would be the
// notice outliving its own question.
function forgetDemoSeeded() { store.set(DEMO_SEEDED_KEY, []); store.set(DEMO_PLAN_KEPT_KEY, true); }


// Is the training week on screen still the one Marcus made up? The plan is demo
// data as much as the sixteen sessions were, and nothing has ever said so: it is
// not in `demoSeeded` because `seedShell` writes it at load in every browser,
// and it is not in LOGGED_STORES because clearing it would put it back on the
// next boot. Recognised by comparing against the template instead of by a stored
// marker, so it stops being demo the moment he or the coach changes one exercise
// -- there is no writer that has to remember to clear a flag.
function planIsDemo() {
  if (store.get(DEMO_PLAN_KEPT_KEY, false)) return false;
  const plan = store.get('plan', null);
  return !!plan && JSON.stringify(plan) === JSON.stringify(demoPlanTemplate());
}

// Is the week on screen empty? This is the state clearing the demo data leaves
// him in: `emptyPlanTemplate` writes seven Open days with nothing in them, and
// the one button that fills them again -- Draft my week -- lives on the Plan
// tab under the suggestions and the research block. He has twice failed to find
// a button one tab away (the full clear on Progress, Cycles 1493 and 1494), so
// Home has to carry this one.
// Empty means no day holds any work at all. One exercise anywhere makes it his
// week, however thin, and nothing should offer to write over it. A browser with
// no plan is not empty either -- `seedShell` rewrites a missing plan on the next
// boot, so that case never reaches him.
function planIsEmpty() {
  const days = (store.get('plan', null) || {}).days;
  if (!Array.isArray(days) || !days.length) return false;
  return days.every(d => !(d.exercises || []).length && !d.cardio);
}

// Draft my week paints its result on the Plan tab -- `requestDraft` calls
// `renderPlan` directly -- so the tab has to change before the request goes out,
// or the draft card is painted over Home and the busy state never shows.
function draftFromHome() { switchTab('plan'); requestDraft(); }

// Armed, not persisted: a confirm is about the tap that is happening now, so a
// reload should land back on the question rather than on the answer.
let demoClearArmed = false;

function armClearDemo() { demoClearArmed = true; renderHome(); }
function cancelClearDemo() { demoClearArmed = false; renderHome(); }

// "Keep it" is a real answer and has to stick: he is saying the numbers are his
// now, so the notice must not come back on the next render.
function keepDemoData() { demoClearArmed = false; forgetDemoSeeded(); renderHome(); }

function clearDemoData() {
  const keys = demoSeededSummary().map(s => s.key);
  const result = clearTrainingLog(keys);
  // The week goes with the log. Replaced rather than deleted, because Home reads
  // `plan.days` and because `seedShell` rewrites a missing plan on the next boot,
  // which would put the bodybuilding block straight back.
  const planCleared = planIsDemo();
  if (planCleared) store.set('plan', emptyPlanTemplate());
  demoClearArmed = false;
  // Forgotten whether or not every store cleared: the claim has been answered,
  // and a store this browser refused to write is not one a second confirm will
  // get any further with.
  forgetDemoSeeded();
  const total = result.cleared.reduce((n, s) => n + s.count, 0);
  if (result.failed.length) toast('This browser refused to clear some of the demo data.');
  else toast('Cleared. ' + total + ' demo record(s) deleted' + (planCleared ? ', and the made-up week is empty.' : '.'));
  renderHome();
}

// "16 sessions, 14 bodyweights and 18 meals" -- the count is the point, the same
// way it is for the clear button and the restore preview: he confirms against
// what is actually there, never against the word "demo".
function demoNoticeCard(summary, planDemo) {
  const parts = summary.map(s => s.count + ' ' + esc(DEMO_LABELS[s.key] || s.key) + (s.count === 1 ? '' : 's'));
  // The plan is the one piece of demo data that is not a row count, and it is the
  // one drawn largest -- Home's Today card is nothing but this week.
  if (planDemo) parts.push('a training week');
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
  const total = summary.reduce((n, s) => n + s.count, 0);
  return `
    <div class="card">
      <div class="card__title-row"><h2>This is demo data</h2><span class="chip">not yours</span></div>
      <p class="card__note">Marcus filled this browser with ${list} so there was something to show. None of it is a workout you did, and every chart in the app is drawn from it.</p>
      ${demoClearArmed ? `
      <div class="card__note" style="margin-top:10px">Are you sure? This deletes ${total} record(s) from this browser and from the server copy${planDemo ? ' and empties the training week' : ''}, and cannot be undone.</div>
      <button class="btn btn--filled btn--block" style="margin-top:10px" onclick="clearDemoData()">Delete all of it</button>
      <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="cancelClearDemo()">Cancel</button>` : `
      <button class="btn btn--filled btn--block" style="margin-top:12px" onclick="armClearDemo()"><span class="material-icons-round">delete_sweep</span> Clear the demo data</button>
      <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="keepDemoData()">Keep it, it is mine now</button>`}
    </div>`;
}

// Counts what clearing would actually remove, so the confirm step can say it
// out loud -- the same contract as `backupSummary` and for the same reason: the
// user confirms against a count, never against the word "clear".
function clearableSummary(keys) {
  return (keys || LOGGED_STORES).map(k => ({ key: k, count: (store.get(k, []) || []).length }))
    .filter(s => s.count > 0);
}

// Every new browser is seeded with sixteen demo sessions, a run of bodyweights
// and a week of meals, and until now nothing could take them out again. Edvard
// told Marcus so himself on 2026-09-07 -- "dataen som er her er bare demo data,
// ikke noe jeg faktisk har gjort" -- and the app had no answer, so every card
// that reads the log has been drawing his progress out of numbers he never
// lifted.
//
// Deleting record by record is not an answer either: that is 48 rows behind
// three confirm dialogs on a phone.
//
// Tombstones are written for the stores that carry them, so the other phone
// does not merge the cleared records straight back on the next sync. `weights`
// and `measurements` have no id and therefore no tombstone -- `recordDeletion`
// keys on one -- so a second device that still holds them will bring those two
// back. That is a real limit and not a case this can silently pretend to cover.
function clearTrainingLog(keys) {
  const cleared = [];
  const failed = [];
  (keys || LOGGED_STORES).forEach(k => {
    const rows = store.get(k, []);
    if (!Array.isArray(rows) || !rows.length) return;
    rows.forEach(r => recordDeletion(k, r && r.id));
    if (store.set(k, [])) cleared.push({ key: k, count: rows.length });
    else failed.push(k);
  });
  return { cleared, failed };
}

// A restore is destructive, so the file is parsed and described before
// anything is written -- the user confirms against a count of what is in the
// file, not against the word "restore".
let pendingRestore = null;

function renderRestorePreview() {
  const host = document.getElementById('restorePreview');
  if (!host) return;
  if (!pendingRestore) { host.innerHTML = ''; return; }
  const lines = backupSummary(pendingRestore.data)
    .map(s => '<div class="exercise-line"><span>' + esc(s.key) + '</span><span>' + s.count + '</span></div>')
    .join('');
  host.innerHTML = '<div class="card__note" style="margin-top:14px">This will replace what is in the app now. From ' +
    esc(pendingRestore.exportedAt ? pendingRestore.exportedAt.slice(0, 10) : 'an unknown date') + ':</div>' + lines +
    '<button class="btn btn--filled btn--block" id="confirmRestore" style="margin-top:10px">Replace everything</button>' +
    '<button class="btn btn--tonal btn--block" id="cancelRestore" style="margin-top:8px">Cancel</button>';
  document.getElementById('confirmRestore')?.addEventListener('click', () => {
    const result = restoreBackup(pendingRestore);
    pendingRestore = null;
    if (result.failed.length) toast('Restored ' + result.restored.length + ' of ' + (result.restored.length + result.failed.length) + ' -- this browser refused the rest.');
    else toast('Restored. ' + result.restored.length + ' section(s) put back.');
    renderProgress();
  });
  document.getElementById('cancelRestore')?.addEventListener('click', () => { pendingRestore = null; renderRestorePreview(); });
}

function wireBackup() {
  pendingRestore = null;
  document.getElementById('exportData')?.addEventListener('click', () => {
    const payload = buildBackup();
    let url = null;
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = backupFilename(payload.exportedAt);
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Backup saved to your downloads.');
    } catch {
      toast('This browser would not let Marcus save a file.');
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  const picker = document.getElementById('importFile');
  document.getElementById('importData')?.addEventListener('click', () => picker?.click());
  picker?.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseBackup(String(reader.result));
      // The same file has to be pickable twice -- `change` does not fire on an
      // unchanged value, so a user who cancels and retries would get nothing.
      picker.value = '';
      if (!parsed.ok) { toast(parsed.message); return; }
      pendingRestore = parsed;
      renderRestorePreview();
    };
    reader.onerror = () => { picker.value = ''; toast('That file could not be read.'); };
    reader.readAsText(file);
  });
  renderRestorePreview();
  wireClearLog();
  wireSectionClear('weights');
  wireSectionClear('meals');
  wireServerCopy();
}

// Two steps on purpose, and the preview is the first one: clearing is
// irreversible in this browser, so what disappears is counted on screen before
// there is a button that does it.
let clearLogArmed = false;

function renderClearLogPreview() {
  const host = document.getElementById('clearLogPreview');
  if (!host) return;
  if (!clearLogArmed) { host.innerHTML = ''; return; }
  const rows = clearableSummary();
  if (!rows.length) {
    host.innerHTML = '<div class="card__note" style="margin-top:14px">There is nothing logged to clear.</div>';
    return;
  }
  const lines = rows
    .map(s => '<div class="exercise-line"><span>' + esc(s.key) + '</span><span>' + s.count + '</span></div>')
    .join('');
  host.innerHTML = '<div class="card__note" style="margin-top:14px">This deletes the following from this browser and from the server copy:</div>' + lines +
    '<button class="btn btn--filled btn--block" id="confirmClearLog" style="margin-top:10px">Delete all of it</button>' +
    '<button class="btn btn--tonal btn--block" id="cancelClearLog" style="margin-top:8px">Cancel</button>';
  document.getElementById('confirmClearLog')?.addEventListener('click', () => {
    const result = clearTrainingLog();
    clearLogArmed = false;
    const total = result.cleared.reduce((n, s) => n + s.count, 0);
    if (result.failed.length) toast('Cleared ' + total + ' record(s) -- this browser refused ' + result.failed.length + ' section(s).');
    else toast('Cleared. ' + total + ' record(s) deleted.');
    renderClearLogPreview();
    renderProgress();
  });
  document.getElementById('cancelClearLog')?.addEventListener('click', () => { clearLogArmed = false; renderClearLogPreview(); });
}

// The Clear-the-training-log button above takes all three seeded stores at
// once, and it is the last card on this tab -- below the charts, the reminders
// and the backup card. Edvard did not find it. On 2026-09-13 he deleted all
// sixteen demo sessions by hand, one bin tap at a time, between 08:03:16 and
// 08:03:36 (measured off the deletion tombstones in his synced copy), and left
// the fourteen demo bodyweights and eighteen demo meals in place. Those two are
// drawn as charts rather than lists, so there is no row to tap at all: the
// Bodyweight chart and the Daily calories chart on this tab are still plotting
// numbers he never produced.
//
// So the offer goes where the fake numbers are drawn, and it clears one section
// rather than everything. Same two-step as the full clear and as the session
// bin: arm, read the count, then confirm.
const SECTION_LABELS = { weights: 'bodyweight', meals: 'meal' };

// One key at a time, declared beside the other clear state, so arming the
// second section closes the first rather than leaving two live confirms.
let sectionClearArmed = null;

function sectionClearIds(key) {
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  return {
    button: 'clear' + cap,
    preview: 'clear' + cap + 'Preview',
    confirm: 'confirmClear' + cap,
    cancel: 'cancelClear' + cap,
  };
}

function renderSectionClear(key) {
  const ids = sectionClearIds(key);
  const host = document.getElementById(ids.preview);
  if (!host) return;
  if (sectionClearArmed !== key) { host.innerHTML = ''; return; }
  const count = (store.get(key, []) || []).length;
  if (!count) {
    host.innerHTML = '<div class="card__note" style="margin-top:10px">There is nothing here to clear.</div>';
    return;
  }
  host.innerHTML = '<div class="card__note" style="margin-top:10px">Are you sure? This deletes ' + count + ' ' +
    esc(SECTION_LABELS[key] || key) + ' record(s) from this browser and from the server copy, and cannot be undone.</div>' +
    '<button class="btn btn--filled btn--block" id="' + ids.confirm + '" style="margin-top:10px">Delete all of it</button>' +
    '<button class="btn btn--tonal btn--block" id="' + ids.cancel + '" style="margin-top:8px">Keep it</button>';
  document.getElementById(ids.confirm)?.addEventListener('click', () => {
    const result = clearTrainingLog([key]);
    sectionClearArmed = null;
    const total = result.cleared.reduce((n, s) => n + s.count, 0);
    if (result.failed.length) toast('This browser refused to clear the ' + (SECTION_LABELS[key] || key) + ' log.');
    else toast('Cleared. ' + total + ' record(s) deleted.');
    renderProgress();
  });
  document.getElementById(ids.cancel)?.addEventListener('click', () => {
    sectionClearArmed = null;
    renderSectionClear(key);
  });
}

function wireSectionClear(key) {
  // The tab was just rebuilt, so an armed confirm from a previous visit has no
  // button on screen any more -- same reason `renderLog` clears the armed
  // session card on every render.
  sectionClearArmed = null;
  const ids = sectionClearIds(key);
  document.getElementById(ids.button)?.addEventListener('click', () => {
    // One variable holds the armed key, so arming this one disarms the other --
    // but the other section's host still has the old markup painted into it and
    // only its own render clears that, so repaint it here.
    const previous = sectionClearArmed;
    sectionClearArmed = key;
    if (previous && previous !== key) renderSectionClear(previous);
    renderSectionClear(key);
  });
  renderSectionClear(key);
}

function wireClearLog() {
  clearLogArmed = false;
  document.getElementById('clearLog')?.addEventListener('click', () => {
    clearLogArmed = true;
    renderClearLogPreview();
  });
  renderClearLogPreview();
}

