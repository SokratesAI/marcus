// The pure half of the app: the store, validation, the food tables, the
// sentence parsers, goals and plans. Nothing in this file touches the DOM, so
// it is the half every unit test actually calls. It is a classic script and
// shares one global scope with app.js, which loads after it -- see
// src/app-source.ts for the ordered list every consumer reads.
// ---------- storage helpers ----------
// Set once the server-copy code below is defined. It is a hook rather than a
// direct call because `store` is the first thing in this file and the sync code
// needs the backup helpers, which are near the bottom.
let onStoreWrite = null;
const store = {
  // Anything localStorage refused stays here so the app keeps working for the
  // rest of the session instead of rendering against an empty store. It is
  // deliberately not a cache: a successful write drops the copy, so
  // localStorage stays the single source of truth whenever it is available.
  _unsaved: Object.create(null),
  get(key, fallback) {
    if (key in this._unsaved) return this._unsaved[key];
    try { const v = localStorage.getItem('marcus.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, val) {
    try {
      localStorage.setItem('marcus.' + key, JSON.stringify(val));
      delete this._unsaved[key];
      if (onStoreWrite) onStoreWrite(key);
      return true;
    } catch (err) {
      this._unsaved[key] = val;
      const full = err && (err.name === 'QuotaExceededError' || err.code === 22);
      toast(full ? 'Storage is full, so that was not saved. Delete some old entries.'
                 : 'This browser is blocking storage, so nothing will be kept after you close the app.');
      return false;
    }
  }
};
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// Local calendar date, never UTC. `toISOString` reports the day in Greenwich,
// so for a phone in Oslo every local midnight-to-02:00 instant -- and every
// Date built at local midnight, which is how the week buckets and the goal
// milestones are built -- came back as the day before. The whole suite passed
// because CI runs in UTC, where the two agree.
const fmtDate = (d) => {
  const t = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};
const todayStr = () => fmtDate(new Date());
const niceDate = (iso) => new Date(iso + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// ---------- one source of truth for "what day is it" ----------
function planDayName(date) { return DAY_NAMES[(date || new Date()).getDay()]; }

// ---------- input validation ----------
// Bounds are deliberately wide: they exist to catch a typo, not to argue with a
// strong person or a big meal. Anything inside them is the user's business.
const BOUNDS = {
  sets: { min: 1, max: 50, label: 'Sets', unit: '' },
  reps: { min: 1, max: 500, label: 'Reps', unit: '' },
  weight: { min: 0, max: 1000, label: 'Weight', unit: 'kg' },
  calories: { min: 1, max: 10000, label: 'Calories', unit: 'kcal' },
  bodyweight: { min: 20, max: 400, label: 'Weight', unit: 'kg' },
  circumference: { min: 10, max: 300, label: 'Measurement', unit: 'cm' },
  bodyfat: { min: 1, max: 70, label: 'Body fat', unit: '%' },
  grams: { min: 1, max: 5000, label: 'Amount', unit: 'g' },
  servings: { min: 0.25, max: 50, label: 'How many', unit: '' },
  minutes: { min: 1, max: 1440, label: 'Duration', unit: 'min' },
  distance: { min: 0.1, max: 500, label: 'Distance', unit: 'km' }
};

// A session is either strength (exercises, sets, kilograms) or cardio (one
// activity, a duration, sometimes a distance). Sessions written before this
// existed carry no `kind` at all, so absent means strength -- that keeps every
// stored session readable without a migration.
const CARDIO_ACTIVITIES = ['Run', 'Bike', 'Swim', 'Row', 'Ski', 'Walk', 'Other'];
function sessionKind(session) { return session && session.kind === 'cardio' ? 'cardio' : 'strength'; }

function checkNumber(raw, kind) {
  const b = BOUNDS[kind];
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, message: `${b.label} is required.` };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: `${b.label} must be a number.` };
  if (value < b.min || value > b.max) {
    return { ok: false, message: `${b.label} must be between ${b.min} and ${b.max}${b.unit ? ' ' + b.unit : ''}.` };
  }
  return { ok: true, value };
}

// RPE -- rate of perceived exertion, 1 to 10 -- is the one box on the row that
// is optional, because a set is a complete record of what was lifted without
// it. Blank means "not recorded" and is left off the exercise entirely rather
// than stored as 0: a 0 would read as "no effort at all" to anything that
// averages these, and there is no way to tell it back from a real answer.
function checkRpe(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: true };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: 'RPE must be a number.' };
  if (value < 1 || value > 10) return { ok: false, message: 'RPE must be between 1 and 10.' };
  return { ok: true, value: Math.round(value) };
}

// The name is what says "I did this one". The Log tab prefills a row per planned
// exercise, so clearing the name is how you skip one, and a nameless row is
// skipped rather than rejected -- it cannot produce a bad number either way.
// A row you did name has to be complete: that is where the silent garbage came
// from, a blank reps box saved as 1 rep at 0 kg.
function validateExerciseRow(row) {
  const name = String(row.name == null ? '' : row.name).trim();
  if (!name) return { ok: true, skip: true };
  const parsed = {};
  for (const kind of ['sets', 'reps', 'weight']) {
    const r = checkNumber(row[kind], kind);
    if (!r.ok) return { ok: false, message: `${name}: ${r.message}` };
    parsed[kind] = r.value;
  }
  const rpe = checkRpe(row.rpe);
  if (!rpe.ok) return { ok: false, message: `${name}: ${rpe.message}` };
  const setCount = Math.round(parsed.sets);
  const reps = Math.round(parsed.reps);
  const exercise = { name, sets: Array.from({ length: setCount }, () => ({ reps, weight: parsed.weight })) };
  if (rpe.value != null) exercise.rpe = rpe.value;
  return { ok: true, exercise };
}

function validateSession(rows) {
  const exercises = [];
  for (const row of rows) {
    const r = validateExerciseRow(row);
    if (!r.ok) return r;
    if (r.exercise) exercises.push(r.exercise);
  }
  if (!exercises.length) return { ok: false, message: 'Fill in at least one exercise before saving.' };
  return { ok: true, exercises };
}

// A warm-up ramp is percentages of the working weight, and it is convention
// rather than a finding: no paper in TRAINING_REFERENCES measures a ramp, so
// this carries no citation -- the same rule `deload`, `move` and `rest` are
// held to further down.
const WARMUP_STEPS = [
  { share: 0.4, reps: 5 },
  { share: 0.6, reps: 3 },
  { share: 0.8, reps: 2 },
];
// Plates come in 2.5 kg pairs, so a step that asks for 43.2 kg is a number
// nobody can load.
const WARMUP_INCREMENT = 2.5;

function roundToIncrement(value, increment) {
  return Math.round(value / increment) * increment;
}

// One working weight in, the sets to do before it out. Two kinds of step are
// dropped rather than shown: one that rounds to nothing, and one that rounds up
// to a weight an earlier step already covers. Both happen on light working
// weights, and printing them would put the same set on the screen twice.
function warmupRamp(rawWeight) {
  const weight = Number(rawWeight);
  // Only the non-number case needs a guard here. Zero and a negative weight
  // fall out of the step loop on their own -- every step of them lands at or
  // below zero and is dropped -- and a second check for them would be a line
  // no test could ever fail on.
  if (!Number.isFinite(weight)) return [];
  const out = [];
  WARMUP_STEPS.forEach(function (step) {
    const load = roundToIncrement(weight * step.share, WARMUP_INCREMENT);
    if (load <= 0) return;
    if (load >= weight) return;
    if (out.length && load <= out[out.length - 1].weight) return;
    out.push({ weight: load, reps: step.reps });
  });
  return out;
}

// The sentence is separate from the numbers so a caller can have one without
// the other, and so "nothing to show" has exactly one spelling -- the empty
// string, which the Log tab hides on. A ramp with no steps is a legal state
// and it is what every bodyweight row produces.
function warmupLabel(rawWeight) {
  const ramp = warmupRamp(rawWeight);
  if (!ramp.length) return '';
  return 'Warm-up: ' + ramp.map(function (s) {
    return String(s.weight) + ' kg \u00d7 ' + s.reps;
  }).join(', ');
}

// Loading the bar (idea #187). The warm-up ramp above hands you 60 kg and 90 kg
// and then says nothing about how to get there, which is the arithmetic you
// actually do standing at the rack between sets.
//
// Barbell lifts are an explicit list for the same reason the form guide is: a
// lift Marcus does not know gets no line at all, rather than a guessed bar
// weight. "Bar 20 kg" under a dumbbell press is worse than saying nothing.
const BAR_KG = 20;
const BARBELL_LIFTS = [
  { name: 'Barbell Bench Press', aka: ['Bench Press', 'Flat Bench Press'] },
  { name: 'Incline Bench Press' },
  { name: 'Overhead Press', aka: ['Shoulder Press', 'Military Press'] },
  { name: 'Deadlift', aka: ['Conventional Deadlift'] },
  { name: 'Romanian Deadlift', aka: ['RDL'] },
  { name: 'Back Squat', aka: ['Squat', 'Barbell Squat'] },
  { name: 'Front Squat' },
  { name: 'Barbell Row', aka: ['Bent-over Row', 'Bent Over Row'] },
  { name: 'Barbell Curl' },
];

// One pair of each of these is what the gym has. Nothing here models how MANY
// of each are on the rack -- that is an inventory nobody has entered, and a
// wrong count would refuse a load that is sitting right there.
const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];

// Same flatten-every-spelling shape as `formGuideEntries`, and matched exactly
// on `exerciseKey` for the same reason: "Front Squat" and "Back Squat" are
// different lifts and a fuzzy matcher would put the wrong bar under one of them.
function barbellLiftKeys() {
  const out = [];
  BARBELL_LIFTS.forEach(function (e) {
    [e.name].concat(e.aka || []).forEach(function (word) { out.push(exerciseKey(word)); });
  });
  return out;
}

function isBarbellLift(name) {
  const key = exerciseKey(name);
  if (!key) return false;
  return barbellLiftKeys().indexOf(key) !== -1;
}

// Biggest plate first, which is how a bar is actually loaded -- the 25s go on
// innermost. That is not the same as the fewest plates and no claim is made
// that it is; it is the order that produces a bar you can look at and check.
//
// The arithmetic is done in hundredths of a kilo as integers. Every plate here
// is an exact binary fraction so plain floats would survive them, but a weight
// typed as 61.1 is not, and float dust in the remainder reads on the phone as
// "0.09999999999 kg short".
function plateLoad(rawTotal) {
  const total = Number(rawTotal);
  if (!Number.isFinite(total)) return null;
  // At or below the bar there is nothing to load. A bodyweight row is 0 kg and
  // lands here, which is the right answer for it too.
  if (total <= BAR_KG) return null;
  let left = Math.round((total - BAR_KG) * 50);
  const perSide = [];
  PLATES.forEach(function (plate) {
    const unit = plate * 100;
    const count = Math.floor(left / unit);
    if (count <= 0) return;
    perSide.push({ kg: plate, count: count });
    left -= count * unit;
  });
  const loadedSide = perSide.reduce(function (sum, p) { return sum + p.kg * p.count; }, 0);
  return { bar: BAR_KG, perSide: perSide, loaded: BAR_KG + loadedSide * 2, short: left / 100 };
}

// The sentence is separate from the numbers, same as `warmupLabel`, and "nothing
// to show" has exactly one spelling: the empty string, which the Log tab hides
// on.
//
// A weight the plates cannot reach is reported as the closest weight they can,
// rather than silently rounded to it. 61 kg is not a lie the app should tell.
function plateLoadLabel(name, rawTotal) {
  if (!isBarbellLift(name)) return '';
  const load = plateLoad(rawTotal);
  if (!load) return '';
  const parts = load.perSide.map(function (p) {
    return p.count > 1 ? String(p.kg) + ' \u00d7 ' + p.count : String(p.kg);
  });
  const head = parts.length
    ? 'Bar ' + load.bar + ' kg + ' + parts.join(', ') + ' per side'
    : 'Bar ' + load.bar + ' kg alone';
  if (load.short === 0) return head;
  return head + ' = ' + load.loaded + ' kg, the closest you can load';
}

// How long to rest between sets (idea #187). The warm-up ramp and the plate
// load both speak to the set you are about to do; nothing in Marcus has ever
// said anything about the gap between them, which is the part of a session you
// actually spend the most time in.
//
// Rest is read off the rep count and nothing else. That is the one input the
// row already carries that maps onto a rest length in the training literature:
// a heavy triple and a set of fifteen are different systems recovering, and the
// weight on the bar does not separate them -- 100 kg for 3 and 100 kg for 12
// are the same number and opposite sessions. RPE is deliberately not read here.
// It would be a second opinion on the same question, it is optional on the row,
// and I have no measurement that says what a point of RPE is worth in seconds.
const REST_BANDS = [
  { maxReps: 5, seconds: 180 },
  { maxReps: 12, seconds: 90 }
];
const REST_LONG_SET_SECONDS = 60;

function restSeconds(rawReps) {
  const reps = Number(rawReps);
  // An empty box, a word, or a rep count below one is not a set, so there is
  // nothing to rest between. Zero is the one spelling of "say nothing", the
  // same as the empty string is for every label on this row.
  if (!Number.isFinite(reps) || reps < 1) return 0;
  // A fractional rep count is reachable -- the reps box is a number input and
  // "5.5" is a valid one -- and it falls into the band above it rather than
  // being rejected. Half a rep does not change how long you need, and refusing
  // to answer would be a stricter opinion about the box than the box has.
  for (let i = 0; i < REST_BANDS.length; i++) {
    if (reps <= REST_BANDS[i].maxReps) return REST_BANDS[i].seconds;
  }
  return REST_LONG_SET_SECONDS;
}

// The sentence is separate from the number, same as `warmupLabel` and
// `plateLoadLabel`, so the Log row can hide on the empty string and a caller
// that wants seconds is not parsing prose to get them.
function restSecondsLabel(seconds) {
  if (!seconds) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return String(rest) + ' s';
  if (!rest) return String(minutes) + ' min';
  return String(minutes) + ' min ' + String(rest) + ' s';
}

function restLabel(rawReps) {
  const seconds = restSeconds(rawReps);
  if (!seconds) return '';
  return 'Rest ' + restSecondsLabel(seconds) + ' between sets';
}

// The plan is a template: it carries an exercise, its sets and its reps, and it
// never carries a weight. The weight only ever exists in what was actually
// lifted, so a Log row for an exercise done a hundred times still opens with an
// empty kg box -- the one number progressive overload is entirely about. These
// three read it back out of the session history.
//
// Names are matched case- and space-insensitively and nothing cleverer: "Back
// Squat" and "back squat" are the same lift, "Front Squat" is not, and a
// fuzzier matcher would silently show the wrong number on a row that looks
// right.
function exerciseKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
}

// asOfISO is inclusive on purpose. Logging a second session on a day you have
// already trained should see the first one, and backfilling last Tuesday should
// not be told about a heavier Thursday that had not happened yet.
function lastPerformance(sessions, name, asOfISO) {
  const key = exerciseKey(name);
  if (!key) return null;
  let best = null;
  (sessions || []).forEach(function (session, index) {
    if (!session || sessionKind(session) !== 'strength' || !session.date) return;
    if (asOfISO && session.date > asOfISO) return;
    (session.exercises || []).forEach(function (ex) {
      if (!ex || exerciseKey(ex.name) !== key) return;
      // A set with no weight recorded cannot answer "what do I load the bar
      // with", so an exercise made only of those is skipped rather than shown
      // as 0 kg -- 0 kg is a real answer here and means bodyweight.
      const sets = (ex.sets || []).filter(function (s) { return s && typeof s.weight === 'number' && Number.isFinite(s.weight); });
      if (!sets.length) return;
      const top = sets.reduce(function (a, b) { return b.weight > a.weight ? b : a; });
      const candidate = {
        date: session.date,
        name: ex.name,
        weight: top.weight,
        reps: top.reps,
        sets: sets.length,
        rpe: ex.rpe == null ? null : ex.rpe,
      };
      // Two sessions on the same date are ordered by the order they were
      // logged, which is the order they sit in the array.
      if (!best || candidate.date > best.date || (candidate.date === best.date && index >= best.index)) {
        best = candidate;
        best.index = index;
      }
    });
  });
  if (best) delete best.index;
  return best;
}

function lastPerformanceLabel(last) {
  if (!last) return '';
  const load = last.weight === 0 ? 'bodyweight' : String(last.weight) + ' kg';
  const parts = ['Last time ' + load + ' \u00d7 ' + last.reps];
  if (last.sets > 1) parts[0] += ' \u00d7 ' + last.sets;
  if (last.rpe != null) parts.push('RPE ' + last.rpe);
  return parts.join(', ') + ' \u00b7 ' + niceDate(last.date);
}

// The smallest load change this app will ever propose. It is not a preference:
// PLATES bottoms out at 1.25 kg and a barbell takes one of those on each side,
// so 2.5 kg is the smallest jump the equipment in `plateLoad` can actually
// make. Dumbbell pairs and machine stacks step about the same, so there is one
// number here rather than a per-lift table I would have had to invent.
const PROGRESSION_STEP_KG = 2.5;

// Days between `asOfISO` and the newest session logged on or before it, or
// null when nothing has been logged yet. `trainingLoad` answers the same
// question for today only, and the Log tab can be backdated -- backfilling
// last Tuesday must not be told about a layoff that had not started by then --
// so this reads the one number out of the same log, as of the row's own date.
//
// Every kind of session counts, cardio included: a week with three runs in it
// is not a week off, and asking this question per lift would answer "you have
// not squatted in eight days" on a normal upper/lower split.
function daysSinceSession(sessions, asOfISO) {
  const as = asOfISO || todayStr();
  let newest = null;
  (sessions || []).forEach(function (s) {
    if (!s || !s.date || s.date > as) return;
    if (!newest || s.date > newest) newest = s.date;
  });
  if (!newest) return null;
  return Math.max(0, daysBetween(newest, as));
}

// Double progression: hold the weight until you hit the rep target at that
// weight, then add the smallest jump the bar can make. `lastPerformance` above
// says what you did; this is the only thing in the app that proposes a number
// you have not lifted yet.
//
// `targetReps` is the reps box on the row in front of you, not last session's
// reps. The plan is what says how many you are supposed to get, so the same
// history gives a different answer on a row asking for 5 and a row asking for
// 12 -- which is the point, because that box is where a phase change shows up.
//
// Three answers, and two of them are not "add 2.5 kg":
//
//   - Short of the target reps: stay at the weight. That is the whole of double
//     progression and it is the common case, not an edge.
//   - RPE 10 last time: stay, even if the reps were there. RPE 10 is defined as
//     nothing left in reserve, so adding load on top of it is not a suggestion
//     any coach makes. That single value is the only thing read off the RPE box
//     here -- reading 7 against 8 would be a graded opinion I have no
//     measurement for, the same reason the rest line ignores RPE entirely.
//   - A bodyweight lift logs 0 kg and has no bar to add to, so it progresses in
//     reps instead. That falls out of the same weight comparison rather than
//     out of a lift-type list.
//
// Returns null rather than a guess when there is no history, no rep target, or
// a rep count that was never recorded -- an empty row proposes nothing.
function nextTarget(last, targetReps, layoffDays) {
  if (!last) return null;
  const weight = last.weight;
  const did = last.reps;
  const target = Number(targetReps);
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
  if (typeof did !== 'number' || !Number.isFinite(did)) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  // A layoff is checked before all three of the answers below, for the same
  // reason `loadVerdict` checks `resting` before either ratio band: it is a
  // fact about what was logged rather than an inference from the last set.
  // This function's own contract is that it is the only thing in the app that
  // proposes a number you have not lifted yet -- so after a week of nothing it
  // proposes no new number at all, which is what a coach says on the first
  // session back. `layoffDays` is null unless the caller measured one; the
  // threshold is the fatigue window and it lives beside that window in app.js
  // rather than being spelled a second time here.
  if (typeof layoffDays === 'number' && Number.isFinite(layoffDays) && layoffDays > 0) {
    return { kind: 'hold', weight: weight, reps: target, reason: 'layoff', days: layoffDays };
  }
  if (did < target) return { kind: 'hold', weight: weight, reps: target, reason: 'short' };
  if (last.rpe === 10) return { kind: 'hold', weight: weight, reps: target, reason: 'rpe' };
  if (weight === 0) return { kind: 'reps', weight: 0, reps: did + 1, reason: 'bodyweight' };
  return { kind: 'add', weight: weight + PROGRESSION_STEP_KG, reps: target, reason: 'earned' };
}

function nextTargetLabel(next) {
  if (!next) return '';
  const load = next.weight === 0 ? 'bodyweight' : String(next.weight) + ' kg';
  if (next.kind === 'add') return 'Next: ' + load + ' \u00d7 ' + next.reps;
  if (next.kind === 'reps') return 'Next: bodyweight \u00d7 ' + next.reps;
  if (next.reason === 'layoff') return 'Next: stay at ' + load + ' \u00d7 ' + next.reps + ', first session back after ' + next.days + ' days';
  if (next.reason === 'rpe') return 'Next: stay at ' + load + ' \u00d7 ' + next.reps + ', RPE 10 last time';
  return 'Next: stay at ' + load + ', aim for ' + next.reps;
}

// The heaviest set you have ever logged for a lift, one row per lift. `Last
// time` above answers "what do I load the bar with today"; this answers "what
// is the most I have ever done", which is the number that makes a session feel
// like it counted and the one nothing in this app ever said out loud.
//
// One rule, no special cases: heaviest weight wins, and among sets at the same
// weight the one with the most reps wins. That rule is what makes a bodyweight
// lift work without a second metric bolted on -- every Pull-Up set is 0 kg, so
// the tiebreak is doing all the deciding and the best is the set with the most
// reps, which is the right answer for that lift and falls out of the same
// comparison rather than out of an `if`. A third tie goes to the earliest date,
// because the day you first did it is the day you set it, not the day you
// matched it.
function bestSetIsBetter(candidate, best) {
  if (!best) return true;
  if (candidate.weight !== best.weight) return candidate.weight > best.weight;
  if (candidate.reps !== best.reps) return candidate.reps > best.reps;
  return candidate.date < best.date;
}

// How long a best set keeps the `new` chip beside it. One day, so it covers
// the session you just logged and the morning after it -- the same reading
// `trainingStreak` makes when it lets a run start yesterday, because a day you
// have not finished is not a day that has passed. Beyond that the set is still
// your best and the card still prints its date; it just stops being news.
const PB_NEW_DAYS = 1;

function personalBests(sessions, todayISO) {
  // Keyed on a typed exercise name, so a lift called `constructor` or
  // `__proto__` would otherwise read as an already-seen entry off
  // Object.prototype and take its comparison against a function.
  const bests = Object.create(null);
  let latestSessionDate = '';
  (sessions || []).forEach(function (session) {
    if (!session || sessionKind(session) !== 'strength' || !session.date) return;
    let counted = false;
    (session.exercises || []).forEach(function (ex) {
      if (!ex) return;
      const key = exerciseKey(ex.name);
      if (!key) return;
      (ex.sets || []).forEach(function (s) {
        // A set with no weight and no reps is not a set that happened. 0 kg is
        // a real weight and means bodyweight, so only a missing number is
        // skipped -- the same call `lastPerformance` makes one function up.
        if (!s || typeof s.weight !== 'number' || !Number.isFinite(s.weight)) return;
        if (typeof s.reps !== 'number' || !Number.isFinite(s.reps) || s.reps <= 0) return;
        counted = true;
        const candidate = { name: ex.name, weight: s.weight, reps: s.reps, date: session.date };
        if (bestSetIsBetter(candidate, bests[key])) bests[key] = candidate;
      });
    });
    if (counted && session.date > latestSessionDate) latestSessionDate = session.date;
  });
  const rows = Object.keys(bests).map(function (k) { return bests[k]; });
  // A best set on the newest day you trained is one you have just done -- but
  // only if that day was recent. The newest logged session is the newest one
  // whether it was last night or three weeks ago, so reading it as "just done"
  // made this chip say `new` next to three of Edvard's lifts eight days after
  // he last trained. Same shape as `loadVerdict` answering `resting` and
  // `nextTarget` holding the weight after a layoff: the age of the log is a
  // fact about the log, not something to infer from its last row.
  const asOf = todayISO || todayStr();
  const fresh = latestSessionDate !== '' && daysBetween(latestSessionDate, asOf) <= PB_NEW_DAYS;
  rows.forEach(function (r) { r.isNew = fresh && r.date === latestSessionDate; });
  // Newest first so a best set tonight is at the top, then alphabetical so the
  // long tail below it does not reshuffle every time anything is logged.
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function personalBestLabel(best) {
  if (!best) return '';
  const load = best.weight === 0 ? 'bodyweight' : String(best.weight) + ' kg';
  return load + ' × ' + best.reps;
}

// Which lifts have stopped moving. `personalBests` above answers "what is the
// most I have ever done"; this answers the question that actually decides
// whether the programme is working -- "which of these has not got better in a
// while" -- and nothing in this app said it. The Log row's `nextTarget` already
// tells you to hold the weight until you hit the rep target, so one held
// session is the system working and two is ordinary. Three sessions in a row
// with no improvement at all is the point where holding has stopped being a
// plan, and that is a judgement about this app's own progression rule rather
// than a citation -- there is no study that puts the number at three.
const STALL_SESSIONS = 3;

// A stall is counted in sessions, so it never expires on its own: three held
// sessions in June still read as "stuck" in September, on a lift that has not
// been trained since. That is advice about a lift the programme no longer
// contains, and it is the same failure the Personal bests chip and the weight
// tile each had -- a card that knows what happened and not when. So a lift goes
// *dormant* once the gap since its last session is more than twice the gap that
// lift normally runs at, the same scale `bodyweightChange` uses and for the same
// reason: a fixed number of days is wrong for a lift trained twice a week and
// wrong again for one trained every six. The row is kept and labelled rather
// than dropped -- the fact is still true, it is just no longer about now -- and
// only the live ones are counted in the chip, because the chip is what asks him
// to change something.
const STALL_DORMANT_GAP_FACTOR = 2;

// Improvement is `bestSetIsBetter`, unchanged and not re-spelled here. That is
// the whole reason a bodyweight lift works: every Pull-Up set is 0 kg, so the
// weight comparison ties forever and a set of 9 where the best was 8 counts as
// getting better, which is the right answer and needs no second rule. A
// separate "did the weight go up" test would report every calisthenic lift as
// permanently stuck.
function stalledLifts(sessions, todayISO) {
  // Keyed on a typed exercise name -- a lift called `constructor` must not read
  // as an already-seen entry off Object.prototype, the same guard personalBests
  // and the plan proposals carry.
  const seen = Object.create(null);
  // A store is a merged document from two phones and is not ordered; "sessions
  // since you last improved" is meaningless read out of order, so this sorts
  // rather than trusting the array. Sort is stable, so two sessions on one date
  // keep the order they were logged in.
  const ordered = (sessions || [])
    .filter(function (s) { return s && sessionKind(s) === 'strength' && s.date; })
    .slice()
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  ordered.forEach(function (session) {
    (session.exercises || []).forEach(function (ex) {
      if (!ex) return;
      const key = exerciseKey(ex.name);
      if (!key) return;
      let sessionBest = null;
      (ex.sets || []).forEach(function (s) {
        // Same admission rule as personalBests: 0 kg is a real weight and means
        // bodyweight, so only a missing number is skipped.
        if (!s || typeof s.weight !== 'number' || !Number.isFinite(s.weight)) return;
        if (typeof s.reps !== 'number' || !Number.isFinite(s.reps) || s.reps <= 0) return;
        const candidate = { name: ex.name, weight: s.weight, reps: s.reps, date: session.date };
        if (bestSetIsBetter(candidate, sessionBest)) sessionBest = candidate;
      });
      // An exercise row with no usable set is not a session for that lift. It is
      // a row someone typed a name into and left, and counting it would report a
      // stall that never happened.
      if (!sessionBest) return;
      const entry = seen[key] || (seen[key] = { name: ex.name, best: null, since: 0, total: 0, dates: [] });
      entry.total += 1;
      // Every session date for this lift, already in date order because
      // `ordered` is sorted -- the cadence below is this lift's own, not the
      // log's, so a weekly squat and a twice-weekly press age differently.
      entry.dates.push(session.date);
      // The name shown is the most recent spelling, since exerciseKey folds case
      // and spacing and the user is looking at what they last typed.
      entry.name = ex.name;
      if (bestSetIsBetter(sessionBest, entry.best)) {
        entry.best = sessionBest;
        entry.since = 0;
      } else {
        entry.since += 1;
      }
    });
  });
  const keys = Object.keys(seen);
  const stalled = keys
    .map(function (k) { return seen[k]; })
    .filter(function (e) { return e.since >= STALL_SESSIONS; })
    .map(function (e) {
      const lastISO = e.dates[e.dates.length - 1];
      // `todayISO` is optional so a caller with no clock still gets the stall
      // count; what it cannot get is dormancy, and null says so rather than
      // defaulting to "still training this".
      const daysSinceLast = todayISO ? Math.max(0, daysBetween(lastISO, todayISO)) : null;
      const typicalGap = medianGapDays(e.dates);
      const dormant = daysSinceLast !== null && typicalGap !== null
        && daysSinceLast > typicalGap * STALL_DORMANT_GAP_FACTOR;
      return { name: e.name, sessions: e.since, best: e.best, sessionsLogged: e.total,
               lastISO: lastISO, daysSinceLast: daysSinceLast, typicalGap: typicalGap,
               dormant: dormant };
    });
  // Live stalls first: a lift still in the programme is the one to change
  // something about this week. Longest stuck under that, alphabetical under
  // that so the tail does not reshuffle on every log.
  stalled.sort(function (a, b) {
    if (a.dormant !== b.dormant) return a.dormant ? 1 : -1;
    if (a.sessions !== b.sessions) return b.sessions - a.sessions;
    return a.name.localeCompare(b.name);
  });
  const active = stalled.filter(function (e) { return !e.dormant; }).length;
  return { stalled: stalled, active: active, watched: keys.length,
           threshold: STALL_SESSIONS };
}

// The number the Home card calls "day streak": consecutive days on which
// anything was logged, ending today or yesterday, with the days the plan
// prescribes as rest stepped over rather than counted as a break. It lives here
// rather than in app.js because it has now been wrong in three ways nothing
// could see, and none of them is visible without a test.
//
// It counted *sessions*, not days. A lift and a run on the same evening are two
// entries with one date, and the app supports exactly that (`kind: 'cardio'`
// beside `kind: 'strength'`), so one day of training read as a two-day streak.
//
// And it measured the newest session against the current instant rather than
// against today's date. `now - yesterdayT00:00` is 1.8 days at 19:00 and 0.4 at
// 09:00, so with a session logged yesterday and none yet today the same data
// showed a streak in the morning and zero in the evening. Both ends are dates
// now, so the answer does not depend on when the app is opened.
//
// The third one is the plan. A streak measured in calendar days punishes you
// for following your own programme: with Wednesday and Sunday written into the
// plan as rest, a perfect week resets the counter twice, and over Edvard's
// first 36 days the tile could never read higher than 2 while he was training
// five days a week. A rest day the plan asked for is not a missed day, so it
// neither counts nor ends the run -- the same shape as `loadVerdict` answering
// `resting` before either ratio band, because it is a fact about the plan
// rather than an inference from the log. A planned *training* day with nothing
// logged still ends it; that is the whole point of the number.
//
// The plan is the current one applied backwards, which is what `planReview`
// already does when it counts how often a day was trained. There is no plan
// history to read, and inventing one to make this number exact would be a
// bigger lie than the approximation.
//
// With no plan passed, no day is a rest day and the answer is the calendar-day
// one, unchanged.
//
// The run is allowed to start yesterday, which is deliberate and is what the
// old `diff <= 1` was reaching for: not having trained yet today is not a
// broken streak, it is a day that has not finished.
function planRestDayNames(plan) {
  const rest = new Set();
  ((plan && plan.days) || []).forEach(function (d) {
    if (!d || !d.day) return;
    if (!(d.exercises || []).length && !d.cardio) rest.add(d.day);
  });
  return rest;
}

// UTC throughout, like `weekdayOf`: stepping a local-midnight Date back by
// 86400000 ms lands on 23:00 of the previous day across a DST boundary, which
// in Oslo would silently drop or repeat a day twice a year.
function shiftISODate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function trainingStreak(sessions, todayISO, plan) {
  const today = todayISO || todayStr();
  // A date later than today comes from a phone whose clock ran ahead -- the
  // store is merged from two of them -- and must neither extend the run nor
  // end it, so it is dropped before the run is walked.
  const trained = new Set(
    (sessions || []).map(s => s && s.date).filter(d => d && d <= today)
  );
  if (!trained.size) return 0;
  // Walking day by day needs a floor, or a plan of nothing but rest days would
  // walk backwards forever. Nothing before the first session can extend a run.
  const oldest = Array.from(trained).sort()[0];
  const rest = planRestDayNames(plan);
  let count = trained.has(today) ? 1 : 0;
  let cursor = shiftISODate(today, -1);
  while (cursor >= oldest) {
    if (trained.has(cursor)) count++;
    else if (!rest.has(DAY_NAMES[new Date(cursor + 'T00:00:00Z').getUTCDay()])) break;
    cursor = shiftISODate(cursor, -1);
  }
  return count;
}

// Home's Today card said exactly the same thing whether or not the session had
// already been logged: it listed the plan and offered "Log this session".
// Nutrition on the same screen already answers "what have I eaten today";
// training did not, so the one screen the app opens on could not tell you
// whether today was done.
//
// A set counts here on the same rule weeklyMuscleSets uses -- a finite,
// positive rep count -- so this number and the one on Progress can never
// disagree. A session logged with no completed set is still a real session and
// says so in words rather than as "0 lifts / 0 sets": a zero there reads as
// nothing logged, which is the exact thing this card exists to distinguish.
function todayLogged(sessions, todayISO) {
  const today = todayISO || todayStr();
  const mine = (sessions || []).filter(function (s) { return s && s.date === today; });
  if (!mine.length) return null;
  const strength = mine.filter(function (s) { return sessionKind(s) === 'strength'; });
  const cardio = mine.filter(function (s) { return sessionKind(s) === 'cardio'; });
  let lifts = 0;
  let sets = 0;
  strength.forEach(function (s) {
    (s.exercises || []).forEach(function (ex) {
      if (!ex || !exerciseKey(ex.name)) return;
      const hard = (ex.sets || []).filter(function (st) {
        return st && typeof st.reps === 'number' && Number.isFinite(st.reps) && st.reps > 0;
      }).length;
      if (!hard) return;
      lifts++;
      sets += hard;
    });
  });
  const minutes = cardio.reduce(function (sum, s) {
    const m = s.minutes;
    return sum + (typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 0);
  }, 0);
  // Two treadmill runs read as one activity; a run and a swim read as "cardio",
  // because naming only the first of them would be a wrong label rather than a
  // vaguer one.
  const activities = Array.from(new Set(cardio
    .map(function (s) { return String(s.activity == null ? '' : s.activity).trim(); })
    .filter(Boolean)));
  const parts = [];
  if (strength.length) {
    parts.push(sets
      ? lifts + (lifts === 1 ? ' lift \u00b7 ' : ' lifts \u00b7 ') + sets + (sets === 1 ? ' set' : ' sets')
      : 'strength session logged');
  }
  if (cardio.length) {
    const what = activities.length === 1 ? activities[0] : 'cardio';
    parts.push(minutes ? minutes + ' min ' + what : what + ' logged');
  }
  return { count: mine.length, lifts: lifts, sets: sets, cardioMinutes: minutes, label: parts.join(' \u00b7 ') };
}

// Distance is optional on purpose: a pool swim, a spin class and a treadmill
// walk are all real sessions with no kilometres attached, and demanding one
// would push the user to invent a number. Duration is what every cardio
// session has, so that is the required field.
function validateCardio(rawActivity, rawMinutes, rawDistance) {
  const activity = String(rawActivity == null ? '' : rawActivity).trim();
  if (!activity) return { ok: false, message: 'Pick what you did.' };
  const m = checkNumber(rawMinutes, 'minutes');
  if (!m.ok) return { ok: false, message: m.message };
  const distText = String(rawDistance == null ? '' : rawDistance).trim();
  let distance = null;
  if (distText) {
    const d = checkNumber(distText, 'distance');
    if (!d.ok) return { ok: false, message: d.message };
    distance = d.value;
  }
  return { ok: true, cardio: { activity, minutes: m.value, distance } };
}

// Pace is minutes per kilometre, written the way a watch writes it. It needs
// both numbers, so a session with no distance has no pace rather than a zero.
function paceLabel(minutes, distance) {
  if (!(minutes > 0) || !(distance > 0)) return null;
  const seconds = Math.round((minutes / distance) * 60);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} /km`;
}

function cardioSummary(session) {
  const parts = [`${session.minutes} min`];
  if (session.distance > 0) parts.push(`${session.distance} km`);
  const pace = paceLabel(session.minutes, session.distance);
  if (pace) parts.push(pace);
  return parts.join(' \u00b7 ');
}

function validateMeal(name, rawCalories) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return { ok: false, message: 'Give the meal a name.' };
  const r = checkNumber(rawCalories, 'calories');
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, meal: { name: trimmed, calories: r.value } };
}

// ---------- food library ----------
// Typing a calorie number for every meal means guessing one, so the number in
// the app is only as good as the guess. This is the smallest thing that removes
// the guess without a model or a network call: a short table of foods Edvard
// actually eats, with the amount doing the arithmetic. It is deliberately not a
// nutrition database -- a real one is thousands of rows and belongs behind an
// API (idea #205). Anything not in here still goes in by hand, which is why the
// free-text path below is kept rather than replaced.
//
// `unit: 'g'` rows carry values per 100 g. `unit: 'each'` rows carry values per
// one of the thing. Sources are the standard published values for the raw or
// cooked form named; they are round numbers on purpose, because a meal logged
// to one decimal is false precision.
const FOODS = [
  { name: 'Chicken breast, cooked', unit: 'g', kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
  { name: 'Salmon, cooked', unit: 'g', kcal: 208, protein: 20, carbs: 0, fat: 13 },
  { name: 'Beef mince, 5% fat, cooked', unit: 'g', kcal: 176, protein: 26, carbs: 0, fat: 8 },
  { name: 'Cod, cooked', unit: 'g', kcal: 105, protein: 23, carbs: 0, fat: 1 },
  { name: 'Tuna, canned in water', unit: 'g', kcal: 116, protein: 26, carbs: 0, fat: 1 },
  { name: 'Egg', unit: 'each', kcal: 78, protein: 6.3, carbs: 0.6, fat: 5.3 },
  { name: 'Greek yoghurt, 2%', unit: 'g', kcal: 73, protein: 10, carbs: 4, fat: 2 },
  { name: 'Cottage cheese', unit: 'g', kcal: 98, protein: 11, carbs: 3.4, fat: 4.3 },
  { name: 'Milk, semi-skimmed', unit: 'g', kcal: 50, protein: 3.4, carbs: 4.8, fat: 1.8 },
  { name: 'Whey protein powder', unit: 'g', kcal: 400, protein: 80, carbs: 8, fat: 6 },
  { name: 'Rice, cooked', unit: 'g', kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 },
  { name: 'Pasta, cooked', unit: 'g', kcal: 158, protein: 5.8, carbs: 31, fat: 0.9 },
  { name: 'Potato, boiled', unit: 'g', kcal: 87, protein: 2, carbs: 20, fat: 0.1 },
  { name: 'Sweet potato, baked', unit: 'g', kcal: 90, protein: 2, carbs: 21, fat: 0.2 },
  { name: 'Oats, dry', unit: 'g', kcal: 379, protein: 13, carbs: 67, fat: 7 },
  { name: 'Bread, wholemeal slice', unit: 'each', kcal: 82, protein: 4, carbs: 14, fat: 1.1 },
  { name: 'Crispbread (knekkebrod)', unit: 'each', kcal: 35, protein: 1, carbs: 7, fat: 0.3 },
  { name: 'Banana', unit: 'each', kcal: 105, protein: 1.3, carbs: 27, fat: 0.4 },
  { name: 'Apple', unit: 'each', kcal: 95, protein: 0.5, carbs: 25, fat: 0.3 },
  { name: 'Blueberries', unit: 'g', kcal: 57, protein: 0.7, carbs: 14, fat: 0.3 },
  { name: 'Broccoli, cooked', unit: 'g', kcal: 35, protein: 2.4, carbs: 7, fat: 0.4 },
  { name: 'Mixed salad', unit: 'g', kcal: 17, protein: 1.4, carbs: 3, fat: 0.2 },
  { name: 'Avocado', unit: 'each', kcal: 240, protein: 3, carbs: 13, fat: 22 },
  { name: 'Almonds', unit: 'g', kcal: 579, protein: 21, carbs: 22, fat: 50 },
  { name: 'Peanut butter', unit: 'g', kcal: 588, protein: 25, carbs: 20, fat: 50 },
  { name: 'Olive oil', unit: 'g', kcal: 884, protein: 0, carbs: 0, fat: 100 },
  { name: 'Cheese, brown (brunost)', unit: 'g', kcal: 466, protein: 9, carbs: 41, fat: 30 },
  { name: 'Cheese, yellow', unit: 'g', kcal: 371, protein: 25, carbs: 1.3, fat: 30 },
  { name: 'Beans, kidney, cooked', unit: 'g', kcal: 127, protein: 8.7, carbs: 23, fat: 0.5 },
  { name: 'Protein bar', unit: 'each', kcal: 200, protein: 20, carbs: 20, fat: 6 }
];

// A name-start match is what someone typing "ch" is after; a mid-word match is
// a fallback, not a peer, so the two are ranked rather than merged.
function searchFoods(query, limit) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  FOODS.forEach((food, index) => {
    const name = food.name.toLowerCase();
    if (name.startsWith(q)) starts.push({ food, index });
    else if (name.includes(q)) contains.push({ food, index });
  });
  return starts.concat(contains).slice(0, limit == null ? 6 : limit);
}

// Values are per 100 g for a weighed food and per one of the thing otherwise,
// so the scale factor is the only difference between the two kinds.
function portionFrom(food, rawAmount) {
  const kind = food.unit === 'g' ? 'grams' : 'servings';
  const r = checkNumber(rawAmount, kind);
  if (!r.ok) return r;
  const factor = food.unit === 'g' ? r.value / 100 : r.value;
  const round1 = (n) => Math.round(n * 10) / 10;
  const amountText = food.unit === 'g' ? `${r.value} g` : `${r.value}x`;
  return {
    ok: true,
    meal: {
      name: `${food.name} (${amountText})`,
      calories: Math.round(food.kcal * factor),
      protein: round1(food.protein * factor),
      carbs: round1(food.carbs * factor),
      fat: round1(food.fat * factor)
    }
  };
}


// --- A barcode, looked up ----------------------------------------------------
// Idea #204. The 31-food table above is the food I could think of; a barcode is
// the food that is actually in the cupboard. The server proxies Open Food Facts
// (idea #215) and this is the browser half of that route -- the only thing on
// this tab that leaves the page.
//
// The four answers the route can give are kept apart on purpose. "Nobody has
// entered that barcode" and "the database did not answer" both mean no food
// came back and mean opposite things to the person holding the packet: the
// first is worth typing in by hand, the second is worth trying again in a
// minute. Collapsing them into one "it did not work" is what makes an app feel
// broken.
const BARCODE_DIGITS = /^[0-9]{8,14}$/;

async function lookupBarcodeFood(code, fetchImpl) {
  const trimmed = String(code == null ? '' : code).replace(/[\s-]/g, '');
  if (!BARCODE_DIGITS.test(trimmed)) return { ok: false, message: 'A barcode is 8 to 14 digits.' };
  const get = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!get) return { ok: false, message: 'No connection \u2014 type the food in yourself below.' };
  let res;
  try {
    res = await get(`/api/food/barcode/${trimmed}`);
  } catch (err) {
    return { ok: false, message: 'No connection \u2014 type the food in yourself below.' };
  }
  // No branch for the route's own 400: the digit check above is the same rule
  // the server applies, so a code that gets past it here cannot be rejected
  // there. A special case for that would be untestable and would go stale
  // silently if the two ever disagreed -- the generic failure below covers it.
  if (res.status === 404) return { ok: false, message: 'Nobody has entered that barcode yet \u2014 type it in yourself below.' };
  if (!res.ok) return { ok: false, message: 'The food database did not answer \u2014 try again, or type it in yourself.' };
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, message: 'The food database did not answer \u2014 try again, or type it in yourself.' };
  }
  const food = body && body.food;
  // A row with no name or no calorie number is not a food, however well the
  // request went. Pricing a meal off it writes a 0 kcal entry into the log.
  if (!food || !food.name || typeof food.kcal !== 'number') {
    return { ok: false, message: 'That barcode has no nutrition on it yet \u2014 type it in yourself below.' };
  }
  return { ok: true, food, cached: Boolean(body.cached) };
}

// --- A barcode, read off the camera -----------------------------------------
// The other half of idea #204. The lookup above needs thirteen digits, and
// until now the only way to get them in was to read them off the packet and
// type them. The obvious mechanism -- BarcodeDetector -- does not exist in
// WebKit, so on an iPhone there is nothing to call. The alternatives were
// shipping a decoder library (about a megabyte of wasm, cached forever by the
// service worker, for one field on one tab) or writing the one symbology that
// is actually on food: EAN-13. This is that.
//
// UPC-A is not a separate case: it is EAN-13 with a leading zero, and Open
// Food Facts wants the thirteen-digit form, so a 12-digit American packet
// comes back here as '0' + its digits and looks up correctly. EAN-8 (the short
// code on small packets) is deliberately NOT decoded -- it is a different
// module layout, and a decoder that half-reads it would return digits that
// pass no checksum.
//
// The input is one row of luminance samples straight off a canvas. Everything
// here is pure, which is the point: the camera is the untestable part, so the
// camera holds no logic.

// Widths of the four runs of each digit, in modules, for the L (odd) set.
// The G set is the same list reversed, and the R set is the same list read
// starting on a bar instead of a space -- so one table is all three.
const EAN_DIGIT_RUNS = [
  [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
  [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
];

// Which of the six left digits are G-coded, indexed by the first digit. This
// is the whole reason EAN-13 holds thirteen digits in twelve digits' worth of
// bars: the thirteenth is carried by the parity pattern, not by any bar.
const EAN_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGGLGL', 'LGLGGL',
];

// ZXing's tolerances, and they are not arbitrary: a camera frame stretches the
// wide runs and eats the narrow ones, so an exact match never happens. Any one
// run may be 0.7 modules out and the average across the four may be 0.48.
const RUN_MAX_INDIVIDUAL_VARIANCE = 0.7;
const RUN_MAX_AVG_VARIANCE = 0.48;

// Returns { digit, set } for four run widths, or null if nothing fits. `set` is
// 'L' or 'G' on the left half; the right half only ever answers 'L' because the
// R patterns share their widths with L.
function matchEanDigit(runs, allowG) {
  const total = runs[0] + runs[1] + runs[2] + runs[3];
  if (total <= 0) return null;
  const unit = total / 7;
  let best = null;
  for (let d = 0; d < 10; d++) {
    for (const set of allowG ? ['L', 'G'] : ['L']) {
      const pattern = set === 'G' ? EAN_DIGIT_RUNS[d].slice().reverse() : EAN_DIGIT_RUNS[d];
      let sum = 0;
      let ok = true;
      for (let i = 0; i < 4; i++) {
        const variance = Math.abs(runs[i] / unit - pattern[i]);
        if (variance > RUN_MAX_INDIVIDUAL_VARIANCE) { ok = false; break; }
        sum += variance;
      }
      if (!ok) continue;
      const avg = sum / 4;
      if (avg > RUN_MAX_AVG_VARIANCE) continue;
      if (!best || avg < best.avg) best = { digit: d, set, avg };
    }
  }
  return best ? { digit: best.digit, set: best.set } : null;
}

// The last digit is a check digit over the first twelve. It is the only reason
// a misread is a refusal rather than a wrong food: three bars misjudged gives
// a code that fails this, and the scanner keeps looking at the next frame
// instead of logging somebody else's dinner.
function ean13ChecksumOk(digits) {
  if (!/^[0-9]{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

// One row of samples -> alternating run lengths, plus the colour the first run
// is. Anything below the midpoint of the row's own range is a bar, so a dim
// frame and a bright one are read the same way and no absolute brightness is
// assumed anywhere. There is deliberately no minimum-contrast gate: a flat row
// has one run in it, which no guard matches, so the structure below already
// refuses it and a threshold would be a second rule saying the same thing --
// one I could not have written a failing test for.
function runsFromRow(row) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < row.length; i++) {
    if (row[i] < min) min = row[i];
    if (row[i] > max) max = row[i];
  }
  const mid = (min + max) / 2;
  const runs = [];
  let dark = row[0] < mid;
  const firstDark = dark;
  let len = 0;
  for (let i = 0; i < row.length; i++) {
    const isDark = row[i] < mid;
    if (isDark === dark) { len++; continue; }
    runs.push(len);
    dark = isDark;
    len = 1;
  }
  runs.push(len);
  return { runs, firstDark };
}

// A guard is a run of single modules -- three of them at each end, five in the
// middle. We only know what "one module" is from the guard itself, so the test
// is that they are all within half of their own average; nothing here trusts a
// pixel size handed in from outside.
// `unit` is the module width the start guard measured, and the later guards are
// checked against it as well as against themselves. Without it the test is
// scale-free, and five modules of double width -- which is what a printing
// fault or a badly stitched frame looks like -- passes while every digit around
// it still decodes. The tolerance is wide because a packet held at an angle
// really is narrower on one side than the other.
function looksLikeGuard(runs, start, count, unit) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const run = runs[start + i];
    if (!(run > 0)) return false;
    sum += run;
  }
  const avg = sum / count;
  if (avg < 0.75) return false;
  for (let i = 0; i < count; i++) {
    if (Math.abs(runs[start + i] - avg) > avg * 0.5) return false;
  }
  if (unit && (avg > unit * 1.5 || avg < unit * 0.6)) return false;
  return true;
}

// Decodes from a run list whose run at `start` is the first bar of the start
// guard. 59 runs: 3 guard, 24 left, 5 centre guard, 24 right, 3 end guard.
function decodeEanRuns(runs, start) {
  if (start + 59 > runs.length) return null;
  // 3 guard + 24 left + 5 centre guard + 24 right + 3 guard = 59 runs.
  if (!looksLikeGuard(runs, start, 3)) return null;
  const unit = (runs[start] + runs[start + 1] + runs[start + 2]) / 3;
  if (!looksLikeGuard(runs, start + 27, 5, unit)) return null;
  if (!looksLikeGuard(runs, start + 56, 3, unit)) return null;

  let parity = '';
  let digits = '';
  for (let d = 0; d < 6; d++) {
    const at = start + 3 + d * 4;
    const hit = matchEanDigit(runs.slice(at, at + 4), true);
    if (!hit) return null;
    parity += hit.set;
    digits += String(hit.digit);
  }
  const first = EAN_PARITY.indexOf(parity);
  if (first < 0) return null;
  for (let d = 0; d < 6; d++) {
    const at = start + 32 + d * 4;
    const hit = matchEanDigit(runs.slice(at, at + 4), false);
    if (!hit) return null;
    digits += String(hit.digit);
  }
  const code = String(first) + digits;
  return ean13ChecksumOk(code) ? code : null;
}

// The one call the camera makes. `row` is luminance for a single horizontal
// line across the frame; the answer is a thirteen-digit string or null. A
// packet held upside down puts the guard on the right and the digits backwards,
// which is one reversed pass rather than a second decoder.
function decodeEan13Row(row) {
  if (!row || row.length < 60) return null;
  const forward = Array.from(row);
  for (const line of [forward, forward.slice().reverse()]) {
    const { runs, firstDark } = runsFromRow(line);
    // The guard is a bar, so it can only start on an odd index when the row
    // opens on a bar of its own -- the quiet zone before the code.
    for (let i = firstDark ? 0 : 1; i + 59 <= runs.length; i += 2) {
      const code = decodeEanRuns(runs, i);
      if (code) return code;
    }
  }
  return null;
}

// How many rows of a frame to try. A barcode held at a slight angle crosses
// some rows and misses others, and a thumb over the middle of the packet kills
// exactly the row a single-line scanner would have read -- so this walks a band
// down the middle of the frame rather than reading the centre line and giving
// up. Eleven rows over about a third of the frame costs well under a
// millisecond per frame in this decoder and is what makes it work handheld.
const SCAN_ROWS = 11;
const SCAN_BAND = 0.34;

// A frame off the camera -> a barcode or null. `data` is RGBA, straight out of
// getImageData. Luminance is the plain Rec. 601 weighting; a barcode is black
// on white, so nothing here needs colour.
function decodeEan13Frame(data, width, height, rowCount) {
  if (!data || !(width > 0) || !(height > 0)) return null;
  if (data.length < width * height * 4) return null;
  const rows = rowCount || SCAN_ROWS;
  const band = Math.max(1, Math.round(height * SCAN_BAND));
  const top = Math.round((height - band) / 2);
  const row = new Array(width);
  for (let n = 0; n < rows; n++) {
    const y = rows === 1 ? top + (band >> 1) : top + Math.round((band - 1) * (n / (rows - 1)));
    if (y < 0 || y >= height) continue;
    let at = y * width * 4;
    for (let x = 0; x < width; x++, at += 4) {
      row[x] = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    }
    const code = decodeEan13Row(row);
    if (code) return code;
  }
  return null;
}

// --- A phrase, looked up by name --------------------------------------------
// Idea #205. The sentence parser below hands back the phrases it could not
// place, and until now the only thing to do with one was type the food in by
// hand. This asks the same proxy the barcode path uses, by name instead of by
// number, so "pizza Grandiosa" reaches the database that has one.
//
// The four answers are kept apart for the same reason as the barcode path:
// "nothing matched" and "the database did not answer" mean opposite things to
// the person holding the plate.
async function lookUpFoodByName(query, fetchImpl) {
  const trimmed = String(query == null ? '' : query).trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 60) return { ok: false, message: 'Type 2 to 60 characters to look up.' };
  const get = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!get) return { ok: false, message: 'No connection \u2014 type the food in yourself below.' };
  let res;
  try {
    res = await get(`/api/food/search?q=${encodeURIComponent(trimmed)}`);
  } catch (err) {
    return { ok: false, message: 'No connection \u2014 type the food in yourself below.' };
  }
  if (res.status === 404) return { ok: false, message: `Nothing matched \u201c${trimmed}\u201d \u2014 type it in yourself below.` };
  if (!res.ok) return { ok: false, message: 'The food database did not answer \u2014 try again, or type it in yourself.' };
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, message: 'The food database did not answer \u2014 try again, or type it in yourself.' };
  }
  const foods = (body && Array.isArray(body.foods) ? body.foods : [])
    // A row with no name or no calorie number is not a food however well the
    // request went; pricing a meal off it writes a 0 kcal entry into the log.
    .filter((f) => f && f.name && typeof f.kcal === 'number');
  if (!foods.length) return { ok: false, message: `Nothing matched \u201c${trimmed}\u201d \u2014 type it in yourself below.` };
  return { ok: true, foods, cached: Boolean(body.cached) };
}

// --- Reading a meal sentence ------------------------------------------------
// "two eggs and a slice of wholemeal bread" is how a person describes dinner,
// and the picker above makes them do it one food at a time. This turns the
// sentence into picks against the same FOODS table. There is no model here and
// there is not meant to be one: it splits on the joins, reads a leading
// quantity, and matches what is left against the table. Anything it cannot
// place comes back named, so the reply is "I got three of these four" rather
// than a silent partial log.
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5
};

// Words that carry neither a food nor an amount. They are dropped rather than
// matched, because "of" appears in no food name and would fail every phrase.
const FILLER_WORDS = ['a', 'an', 'of', 'with', 'the', 'some', 'my', 'plus', 'served', 'and'];

// Counting words for a food the table prices per item: "a slice of bread" and
// "1 bread" are the same log line, so the word is consumed and the number kept.
const COUNT_UNITS = ['slice', 'slices', 'piece', 'pieces', 'item', 'items',
  'serving', 'servings', 'scoop', 'scoops', 'x'];

function normaliseFoodWords(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && FILLER_WORDS.indexOf(w) === -1)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

// Every word the person typed has to land somewhere in the food's name. That is
// what keeps "pizza Grandiosa" unmatched instead of quietly logging pizza-ish
// calories: "grandiosa" is in no name, so the phrase fails rather than degrades.
function matchFood(text) {
  const q = normaliseFoodWords(text);
  if (!q.length) return null;
  let best = null;
  FOODS.forEach((food, index) => {
    const words = normaliseFoodWords(food.name);
    const landed = q.every((w) => words.some((fw) => fw === w || (w.length >= 3 && fw.startsWith(w))));
    if (!landed) return;
    // Shorter names win: "Egg" beats nothing else, but "Cheese, yellow" should
    // not beat "Cheese, brown (brunost)" on a bare "cheese" by table order.
    const score = -words.length;
    if (!best || score > best.score) best = { food, index, score };
  });
  return best;
}

// One phrase, e.g. "150 g chicken" or "two eggs". Returns null when nothing in
// the table matches; the caller reports that phrase back rather than dropping it.
function parseMealPhrase(phrase) {
  let rest = String(phrase == null ? '' : phrase).trim().toLowerCase();
  if (!rest) return null;

  let quantity = null;
  let grams = null;
  const digits = rest.match(/^(\d+(?:[.,]\d+)?)\s*/);
  if (digits) {
    quantity = parseFloat(digits[1].replace(',', '.'));
    rest = rest.slice(digits[0].length);
  } else {
    const word = rest.match(/^([a-z]+)\s+/);
    if (word && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word[1])) {
      quantity = NUMBER_WORDS[word[1]];
      rest = rest.slice(word[0].length);
    }
  }

  const weight = rest.match(/^(kgs?|kilos?|kilograms?|grams?|gram|gr|g)\b\s*/);
  if (weight && quantity != null) {
    grams = /^k/.test(weight[1]) ? quantity * 1000 : quantity;
    rest = rest.slice(weight[0].length);
  } else if (weight) {
    rest = rest.slice(weight[0].length);
  }

  const count = rest.match(/^([a-z]+)\b\s*/);
  if (count && COUNT_UNITS.indexOf(count[1]) !== -1) rest = rest.slice(count[0].length);

  const hit = matchFood(rest);
  if (!hit) return null;

  if (hit.food.unit === 'g') {
    // A number with no unit in front of a weighed food is not grams and is not a
    // count either -- "2 rice" says nothing -- so the amount stays unknown and
    // the UI asks for it. Inventing a serving size here would be a made-up number
    // written into the log as a measurement.
    return { food: hit.food, index: hit.index, unit: 'g', amount: grams, assumed: false, phrase: String(phrase).trim() };
  }
  return {
    food: hit.food,
    index: hit.index,
    unit: 'each',
    amount: quantity == null ? 1 : quantity,
    assumed: quantity == null,
    phrase: String(phrase).trim()
  };
}

// The whole sentence. A leading "dinner:" is a label, not a food, so it is cut
// before the split; the joins are commas, "and", "+" and "&".
function parseMealSentence(text) {
  const raw = String(text == null ? '' : text).trim();
  let label = '';
  let body = raw;
  const colon = raw.indexOf(':');
  if (colon > 0 && colon < 20) {
    label = raw.slice(0, colon).trim();
    body = raw.slice(colon + 1);
  }
  const phrases = body
    .split(/\s*(?:,|\band\b|\+|&)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const items = [];
  const unmatched = [];
  phrases.forEach((p) => {
    const item = parseMealPhrase(p);
    if (item) items.push(item);
    else unmatched.push(p);
  });
  return { label, items, unmatched };
}

// The foods someone actually eats are a much better list than any table I can
// ship, and the app already has them: they are in the log. Most recent first,
// one row per name, so re-logging yesterday's breakfast is one tap.
function recentMeals(meals, limit) {
  const sorted = (meals || []).slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const seen = Object.create(null);
  const out = [];
  for (const m of sorted) {
    const key = String(m.name).toLowerCase();
    if (key in seen) continue;
    seen[key] = true;
    out.push({ name: m.name, calories: m.calories, protein: m.protein || 0, carbs: m.carbs || 0, fat: m.fat || 0 });
    if (out.length >= (limit == null ? 6 : limit)) break;
  }
  return out;
}

function macroTotals(meals) {
  const round1 = (n) => Math.round(n * 10) / 10;
  return (meals || []).reduce((t, m) => ({
    calories: t.calories + (m.calories || 0),
    protein: round1(t.protein + (m.protein || 0)),
    carbs: round1(t.carbs + (m.carbs || 0)),
    fat: round1(t.fat + (m.fat || 0))
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function validateBodyweight(rawKg) {
  const r = checkNumber(rawKg, 'bodyweight');
  return r.ok ? { ok: true, kg: r.value } : r;
}

// ---------- body measurements ----------
// The scale is one number and it moves for reasons that have nothing to do with
// training -- water, a big meal, the time of day. A waist that came down while
// the scale did not is the thing the scale cannot say, which is why idea #195
// asks for these separately rather than as a second weight series.
//
// Each site names its own unit, because body fat is a percentage and everything
// else is a circumference, and one shared bound would have to be wide enough for
// both and would therefore catch neither typo.
const MEASUREMENT_SITES = [
  { key: 'waist', label: 'Waist', unit: 'cm', bound: 'circumference' },
  { key: 'chest', label: 'Chest', unit: 'cm', bound: 'circumference' },
  { key: 'hips', label: 'Hips', unit: 'cm', bound: 'circumference' },
  { key: 'thigh', label: 'Thigh', unit: 'cm', bound: 'circumference' },
  { key: 'arm', label: 'Upper arm', unit: 'cm', bound: 'circumference' },
  { key: 'neck', label: 'Neck', unit: 'cm', bound: 'circumference' },
  { key: 'bodyfat', label: 'Body fat', unit: '%', bound: 'bodyfat' }
];

function measurementSite(key) {
  return MEASUREMENT_SITES.find(s => s.key === key) || null;
}

// A measurement is a site, a date and a number. The site has to be one this app
// knows, because a free-text site would make two spellings of "waist" two
// different series and neither would show a trend.
function validateMeasurement(rawSite, rawValue) {
  const site = measurementSite(String(rawSite == null ? '' : rawSite).trim());
  if (!site) return { ok: false, message: 'Pick what you measured.' };
  const r = checkNumber(rawValue, site.bound);
  if (!r.ok) return r;
  // A tape measure reads to the millimetre and a caliper chart to a tenth of a
  // percent; anything finer than that is noise being stored as signal.
  return { ok: true, site: site.key, value: Math.round(r.value * 10) / 10 };
}

// One record per site per day, and a second reading on the same day replaces the
// first rather than being appended. That is not tidiness: `MERGE_KEYS` identifies
// a measurement by (date, site), so two records sharing both would collide when
// two phones merge and one of them would disappear with nothing saying so.
function upsertMeasurement(records, entry) {
  const out = (Array.isArray(records) ? records : []).filter(
    r => !(r && r.date === entry.date && r.site === entry.site)
  );
  out.push(entry);
  return out;
}

// Oldest first, so a chart reads left to right and `measurementTrend` can take
// the ends of the array rather than sorting again.
function measurementSeries(records, siteKey) {
  return (Array.isArray(records) ? records : [])
    .filter(r => r && r.site === siteKey && typeof r.value === 'number' && r.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// A Chart.js category axis puts one slot on the x-axis per point it is given,
// so two weigh-ins a week apart and two a day apart are drawn the same distance
// apart. Every line on the Progress tab was built that way, which made its
// slope a function of how often he logged rather than of what changed -- and
// what changed is the only thing those charts exist to show. `dailySeries`
// returns one slot per calendar day between the first reading and the last, so
// horizontal distance is time again.
//
// A day with no reading is `null`, never `0`. A zero is a claim that he weighed
// nothing, or ate nothing, on a day he simply did not open the app. Chart.js
// draws a line straight across a null when `spanGaps` is on, which is the
// honest picture: the value between two readings is unknown, and now the gap is
// at least the right width.
//
// Two readings on one day is the user correcting himself, so the later one in
// the sorted order wins rather than both being plotted.
function dailySeries(points) {
  const clean = (Array.isArray(points) ? points : [])
    .filter(p => p && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.value === 'number' && isFinite(p.value))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!clean.length) return { labels: [], values: [] };
  const byDate = {};
  clean.forEach(p => { byDate[p.date] = p.value; });
  const last = clean[clean.length - 1].date;
  const labels = [];
  const values = [];
  // Walking a real Date by one day leaves month lengths, leap years and the
  // spring-forward Sunday to the calendar instead of to arithmetic here.
  const cursor = new Date(clean[0].date + 'T00:00');
  for (;;) {
    const iso = fmtDate(cursor);
    labels.push(iso);
    values.push(Object.prototype.hasOwnProperty.call(byDate, iso) ? byDate[iso] : null);
    if (iso >= last) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return { labels, values };
}

// What a single reading cannot tell you is whether it is going the right way, so
// the change since the first one is reported beside the latest. One reading is a
// starting point and gets a null change rather than a zero -- a zero would read
// as "no movement", which is a claim this has no data for.
function measurementTrend(records, siteKey) {
  const series = measurementSeries(records, siteKey);
  if (!series.length) return null;
  const first = series[0];
  const last = series[series.length - 1];
  return {
    latest: last.value,
    date: last.date,
    count: series.length,
    change: series.length > 1 ? Math.round((last.value - first.value) * 10) / 10 : null,
    since: series.length > 1 ? first.date : null
  };
}

// ---------- progress photos ----------
// Idea #202. A scale and a tape both compress a body into one number, and the
// change a photo shows is the one neither of them can: the same pose, the same
// light, eight weeks apart.
//
// The photos live in the same state document as everything else, on purpose.
// Marcus syncs by PUTting that whole document, so a photo kept anywhere else
// would need its own sync, its own conflict rule and its own place in the
// backup, none of which exist. The cost of that choice is a ceiling I can point
// at rather than a preference: the server refuses a body over 4MB (`MAX_BODY`
// in src/index.ts), and an unbounded photo list does not degrade gracefully
// against that -- it makes *every* save fail, and the save that fails is the one
// carrying the session just logged. So the budget below is what keeps the
// training log writable, and it sits well under the server's limit because the
// photos share the document with everything else in it.
const PHOTO_BUDGET_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_BYTES = 320 * 1024;
// The strip shows these a few centimetres wide on a phone. 720px on the long
// edge is what the browser downscales to before storing, so the bytes above are
// a budget the app can actually keep rather than one a modern camera blows
// through on the first photo.
const PHOTO_MAX_EDGE = 720;

const PHOTO_POSES = [
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
  { key: 'back', label: 'Back' }
];

function photoPose(key) {
  return PHOTO_POSES.find(p => p.key === key) || null;
}

// The cost of a photo is the decoded image, not the data URL string: base64 is
// four characters per three bytes, so measuring the string overstates every
// photo by a third and the budget would refuse a set that fits.
function photoBytes(dataUrl) {
  const s = typeof dataUrl === 'string' ? dataUrl : '';
  const comma = s.indexOf(',');
  if (comma === -1) return 0;
  const b64 = s.slice(comma + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function photoTotalBytes(records) {
  return (Array.isArray(records) ? records : []).reduce(
    (n, r) => n + (r && typeof r.bytes === 'number' ? r.bytes : photoBytes(r && r.dataUrl)),
    0
  );
}

function photoSizeLabel(bytes) {
  const n = typeof bytes === 'number' && isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

// A photo replaces the one already taken for the same pose on the same day, so
// the record it is about to overwrite must not count against the budget --
// otherwise a retake near the ceiling is refused while the room it needs is
// sitting in the record being replaced.
function validatePhoto(rawPose, dataUrl, records, dateISO, meals) {
  const pose = photoPose(String(rawPose == null ? '' : rawPose).trim());
  if (!pose) return { ok: false, message: 'Pick which pose this is.' };
  const s = typeof dataUrl === 'string' ? dataUrl : '';
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return { ok: false, message: 'That file is not an image Marcus can store.' };
  }
  const bytes = photoBytes(s);
  if (bytes <= 0) return { ok: false, message: 'That file is not an image Marcus can store.' };
  if (bytes > PHOTO_MAX_BYTES) {
    return {
      ok: false,
      message: `That photo is ${photoSizeLabel(bytes)}, over the ${photoSizeLabel(PHOTO_MAX_BYTES)} limit for one photo.`
    };
  }
  const date = dateISO || todayStr();
  const rows = Array.isArray(records) ? records : [];
  const replaced = rows.filter(r => r && r.date === date && r.pose === pose.key);
  // The budget is shared with the photos hanging off meals, so what is already
  // spent is both stores minus the record this one replaces.
  const used = photoTotalBytes(rows) - photoTotalBytes(replaced) + mealPhotoTotalBytes(meals);
  if (used + bytes > PHOTO_BUDGET_BYTES) {
    return {
      ok: false,
      message: `No room: that would take photos to ${photoSizeLabel(used + bytes)} of ${photoSizeLabel(PHOTO_BUDGET_BYTES)}. Delete an older one first.`
    };
  }
  return { ok: true, pose: pose.key, dataUrl: s, bytes, date };
}

// One record per pose per day, second photo of the day replaces the first --
// the same rule as a measurement, and for the same reason: `MERGE_KEYS`
// identifies a photo by (date, pose), so two records sharing both would collide
// in a two-phone merge and one would vanish with nothing saying so.
function upsertPhoto(records, entry) {
  const out = (Array.isArray(records) ? records : []).filter(
    r => !(r && r.date === entry.date && r.pose === entry.pose)
  );
  out.push(entry);
  return out;
}

// Oldest first, so the strip reads left to right like the charts above it.
function photoSeries(records, poseKey) {
  return (Array.isArray(records) ? records : [])
    .filter(r => r && r.pose === poseKey && typeof r.dataUrl === 'string' && r.dataUrl && r.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// What the first and last photo of a pose are separated by, because the gap is
// the whole point of keeping them. One photo is a starting point rather than a
// comparison and reports a null span, never 0 days -- a zero would read as "no
// time has passed", which is a different claim.
function photoSpan(records, poseKey) {
  const series = photoSeries(records, poseKey);
  if (!series.length) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (series.length === 1) return { count: 1, days: null, first: first.date, last: first.date };
  const ms = new Date(last.date + 'T00:00').getTime() - new Date(first.date + 'T00:00').getTime();
  return { count: series.length, days: Math.round(ms / 86400000), first: first.date, last: last.date };
}

// ---------- a photo on the meal you logged (idea #72) ----------
// The photo is stored ON the meal record rather than in a `mealPhotos` array of
// its own. That is `MERGE_KEYS` again: a meal is identified by `id`, so a photo
// carried on the meal merges with the meal it belongs to and can never outlive
// it -- delete the meal on one phone and an array on the other would keep an
// orphan photo spending budget with nothing on screen pointing at it.
//
// It spends from `PHOTO_BUDGET_BYTES`, the same 2MB the progress photos spend
// from, and that is the decision worth stating rather than a detail. Two
// independent 2MB budgets add up to a state document the server refuses
// (`MAX_BODY` is 4MB), and when that happens it is not the photo that fails --
// it is every save after it, including the one carrying the session just
// logged. One budget across both stores is what keeps that impossible.
const MEAL_PHOTO_MAX_BYTES = 160 * 1024;
// Half the long edge of a progress photo. A meal photo is a reminder of what
// was on the plate at thumbnail size, not something to compare month to month,
// so it gets a smaller share of a budget it does not own alone.
const MEAL_PHOTO_MAX_EDGE = 480;

function mealPhotoBytes(meal) {
  if (!meal) return 0;
  if (typeof meal.photoBytes === 'number' && meal.photoBytes > 0) return meal.photoBytes;
  return photoBytes(meal.photo);
}

function mealPhotoTotalBytes(meals) {
  return (Array.isArray(meals) ? meals : []).reduce((n, m) => n + mealPhotoBytes(m), 0);
}

// Every photo in the document, wherever it lives. Both validators spend from
// this, so neither can fill the document on its own.
function storedPhotoBytes(photos, meals) {
  return photoTotalBytes(photos) + mealPhotoTotalBytes(meals);
}

function validateMealPhoto(mealId, dataUrl, meals, photos) {
  const rows = Array.isArray(meals) ? meals : [];
  const meal = rows.find(m => m && String(m.id) === String(mealId));
  if (!meal) return { ok: false, message: 'That meal is not in your log any more.' };
  const s = typeof dataUrl === 'string' ? dataUrl : '';
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return { ok: false, message: 'That file is not an image Marcus can store.' };
  }
  const bytes = photoBytes(s);
  if (bytes <= 0) return { ok: false, message: 'That file is not an image Marcus can store.' };
  if (bytes > MEAL_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      message: `That photo is ${photoSizeLabel(bytes)}, over the ${photoSizeLabel(MEAL_PHOTO_MAX_BYTES)} limit for a meal photo.`
    };
  }
  // A meal that already has a photo is replacing it, so its own bytes are not
  // spent twice -- the same rule a retaken progress photo gets.
  const used = storedPhotoBytes(photos, rows) - mealPhotoBytes(meal);
  if (used + bytes > PHOTO_BUDGET_BYTES) {
    return {
      ok: false,
      message: `No room: that would take photos to ${photoSizeLabel(used + bytes)} of ${photoSizeLabel(PHOTO_BUDGET_BYTES)}. Delete an older one first.`
    };
  }
  return { ok: true, id: meal.id, dataUrl: s, bytes };
}

// One photo per meal, and the second one replaces the first. Every other meal
// is returned untouched by identity, so a re-render cannot mistake an unrelated
// meal for a changed one.
function attachMealPhoto(meals, entry) {
  return (Array.isArray(meals) ? meals : []).map(m =>
    m && entry && String(m.id) === String(entry.id)
      ? Object.assign({}, m, { photo: entry.dataUrl, photoBytes: entry.bytes })
      : m
  );
}

// Removing the photo has to remove the byte count with it. Leaving `photoBytes`
// behind would keep charging the budget for a photo that is no longer there,
// and nothing on screen would say why the next one was refused.
function detachMealPhoto(meals, mealId) {
  return (Array.isArray(meals) ? meals : []).map(m => {
    if (!m || String(m.id) !== String(mealId)) return m;
    const out = Object.assign({}, m);
    delete out.photo;
    delete out.photoBytes;
    return out;
  });
}

// ---------- goals ----------
// A goal is Edvard's own sentence plus a date. Marcus does not interpret the
// sentence yet -- turning "Olympic triathlon next summer" into actual sessions
// needs a model and is filed separately. What it can do with no model at all is
// honest arithmetic: split the time you actually have into the four phases every
// endurance and strength block uses, so a goal arrives with dated checkpoints
// instead of one far-off day you cannot steer by.
const GOAL_MAX_CHARS = 200;
const GOAL_MAX_DAYS = 3653; // ten years -- a mistyped 2226 should not become a plan

function daysBetween(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T00:00') - new Date(fromISO + 'T00:00')) / 86400000);
}

const GOAL_PHASES = [
  { label: 'Base',  share: 0.40, note: 'Build the foundation — volume over intensity.' },
  { label: 'Build', share: 0.35, note: 'Add intensity while the volume holds.' },
  { label: 'Peak',  share: 0.17, note: 'Sharpen — the hardest quality work of the block.' },
  { label: 'Taper', share: 0.08, note: 'Cut volume, keep intensity, arrive fresh.' }
];

// ---------- training-science references (idea #214) ----------
// Edvard asked for recent Norwegian endurance-science research behind the plan
// proposals. Marcus has no model behind it, so these are written down rather
// than generated -- a citation an app invents is worse than no citation at all.
//
// Each entry says what the paper actually measured, and nothing more. The
// proposals on the Plan tab compute their numbers from Edvard's own log, and a
// paper is attached to one only where its finding speaks to the same quantity;
// where none does, the proposal carries no reference and the card says so.
// That boundary is the point of this table. Every identifier here was checked
// against the publisher rather than recalled.
const TRAINING_REFERENCES = [
  {
    id: 'seiler2006',
    title: 'Quantifying training intensity distribution in elite endurance athletes: is there evidence for an "optimal" distribution?',
    authors: 'Seiler & Kjerland',
    year: 2006,
    venue: 'Scandinavian Journal of Medicine & Science in Sports 16(1):49-56',
    url: 'https://doi.org/10.1111/j.1600-0838.2004.00418.x',
    finding: 'Measured what well-trained Norwegian junior cross-country skiers actually did over a season: about three quarters of their sessions sat below the first ventilatory threshold, with the rest hard and very little in between. It describes a distribution rather than prescribing one.',
  },
  {
    id: 'norwegian2024',
    title: 'Training session models in endurance sports: a Norwegian perspective on best practice recommendations',
    authors: 'Sandbakk and colleagues',
    year: 2024,
    venue: 'Sports Medicine (PMC11560996)',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11560996/',
    finding: 'Asked successful Norwegian endurance coaches how they build a session at each intensity, and compared the models across Olympic endurance sports. It is about the shape of a session and where it sits in a season.',
  },
  {
    id: 'zones2025',
    title: 'Contextualizing the Norwegian standardized intensity zone framework in an international sample of endurance practitioners',
    authors: 'Seiler, Viken & Mentzoni',
    year: 2025,
    venue: 'Scientific Reports (doi:10.1038/s41598-025-17023-z)',
    url: 'https://doi.org/10.1038/s41598-025-17023-z',
    finding: 'Set the Norwegian five-zone intensity framework against how endurance practitioners elsewhere actually label and use intensity zones.',
  },
];

// Which reference belongs to which proposal, and -- just as important -- how
// far it goes. `stretch` is the sentence that stops the citation being read as
// "the paper says do this": Marcus's arithmetic is Marcus's, and the paper is
// context for the direction, not the source of the number.
const PROPOSAL_REFERENCES = {
  phase: [{
    id: 'norwegian2024',
    stretch: 'The Base/Build/Peak/Taper multipliers Marcus resizes your week by are its own arithmetic, not this paper\u2019s numbers. What the paper supports is the idea that the shape of a week should change with where you are in a season.',
  }],
  build: [{
    id: 'seiler2006',
    stretch: 'The 0.8 fatigue-to-fitness line is Marcus\u2019s own reading of your log. What this paper supports is the direction: when the load is light, the pattern that produced these athletes was more volume rather than more intensity.',
  }],
};

// Proposals with no honest reference: `deload`, `move`, `rest` and `drop`. The 1.5
// acute-to-chronic line the deload fires on comes from injury-risk workload
// research, not from any of the endurance papers above, and `move`/`rest` are
// about whether you keep the week you wrote -- adherence, not physiology, and
// `drop` is the same question asked about one lift on a day you do keep.
// Attaching a Norwegian endurance paper to any of the three would be the exact
// invented citation this table exists to avoid.
function referenceById(id) {
  return TRAINING_REFERENCES.filter(function (r) { return r.id === id; })[0] || null;
}

// One proposal in, the references behind it out, each already joined to its
// paper so a caller never has to look one up. Unknown or uncited kinds return
// an empty list rather than throwing -- an absent citation is a legal state
// here and is the common one.
function referencesFor(kind) {
  const pins = (PROPOSAL_REFERENCES[kind] || []);
  const out = [];
  pins.forEach(function (pin) {
    const ref = referenceById(pin.id);
    if (ref) out.push({ ref: ref, stretch: pin.stretch });
  });
  return out;
}

// ---------- the glossary: explain a word where it is used (idea #197) ----------
// Edvard wants to understand his own training, and the app keeps using words it
// never defines. This is not an article list: an entry earns its place only by
// being a term Marcus already puts on the screen, and it is read where that word
// appears rather than on a page you have to go and find.
//
// Three boundaries, all deliberate and all tested. A term the app already
// explains in the sentence it uses it in gets no entry -- the Fitness/Fatigue
// card spells itself out, and the four goal phases each carry their own note --
// because a tappable word that repeats the line above it is noise. And nothing
// here is a training recommendation: each entry says what the word means and
// where in Marcus the number behind it comes from, which is a fact about this
// app, not advice about a body.
//
// The third boundary is the one I got wrong first, and it is why its test is
// written against live strings rather than against the source. `deload` and
// `acute:chronic` had entries here and both looked obviously right: the app is
// full of both words. It is full of them in `kind === 'deload'` and in a comment
// about the acute:chronic literature -- the chip a reader actually sees says
// "ease off", and the ratio is never named on screen at all. A grep over the
// source passes for a word only my own comments say, so the test instead asks
// linkGlossary to produce a button out of text the app really renders.
const GLOSSARY = [
  {
    term: 'RPE',
    aka: ['rate of perceived exertion'],
    title: 'RPE — rate of perceived exertion',
    body: 'How hard a set felt, on a scale of 1 to 10, where 10 is a set you could not have added a rep to. It is the one training signal that needs no watch and no maths: you type the number you felt. Marcus stores it beside the reps and the weight, and leaves it off entirely if you skip the box, because a blank is not a zero.'
  },
  {
    term: 'hypertrophy',
    title: 'Hypertrophy',
    body: 'Training for muscle size rather than for a single maximum lift: moderate weights, more reps, more total sets, shorter rests. It is the block Marcus assumes on the strength days of a plan unless the goal you wrote says otherwise.'
  },
  {
    term: 'taper',
    aka: ['tapering'],
    title: 'Taper',
    body: 'The last stretch before the day you are aiming at, where the volume drops but the intensity does not, so you arrive rested without going stale. It is the shortest of the four phases Marcus splits a goal into for exactly that reason.'
  },
  {
    term: 'ventilatory threshold',
    title: 'Ventilatory threshold',
    body: 'The effort at which your breathing steps up out of proportion to the pace — roughly the top of easy. It is how endurance research draws the line between the easy work that fills most of a week and the hard work that fills the rest, and it is why "easy" in a plan means slower than it feels like it should.'
  }
];

// ---------- how to do the lift (idea #193) ----------
// The glossary above answers "what does this word mean". This answers the other
// question you have standing at the rack: "am I doing this right". It is the
// "how" half of idea #193; the video/GIF half is not here, because a
// demonstration is somebody else's footage and its licence is a decision Edvard
// makes, not one a cycle makes for him.
//
// Two boundaries, and the second is the one that decides whether this ever
// shows up. The entries cover the eighteen lifts the seeded plan actually names
// -- not a general exercise encyclopedia, because a library nobody's plan
// reaches is a library nobody opens. And matching is `exerciseKey`, the same
// case- and space-insensitive exact match the last-weight prefill uses, with
// explicit `aka` spellings rather than a fuzzy matcher: showing bench-press
// cues on a row that says something else is worse than showing nothing.
const FORM_GUIDE = [
  { name: 'Barbell Bench Press', aka: ['Bench Press', 'Flat Bench Press'], group: 'Chest',
    setup: 'Eyes under the bar, shoulder blades pulled back and down into the bench, feet flat and driving into the floor. Grip a little wider than shoulders.',
    execution: 'Unrack, bring the bar down under control to the lower chest, touch, then press back up and slightly towards your face. Wrists stacked over elbows the whole way.',
    mistakes: ['Flaring the elbows straight out to the sides — keep them at roughly 45 degrees to the ribs.', 'Bouncing the bar off the chest instead of touching it.', 'Losing the arch and letting the shoulders roll forward at the bottom.'] },
  { name: 'Incline Bench Press', group: 'Chest',
    setup: 'Bench at 30 degrees, not 45 — the steeper it gets the more it becomes an overhead press. Same shoulder blades, same foot drive.',
    execution: 'Lower to just below the collarbone, touch, press back over the upper chest.',
    mistakes: ['Setting the bench too steep and turning it into a shoulder day.', 'Letting the bar drift down to the sternum as if it were a flat bench.'] },
  { name: 'Incline Dumbbell Press', group: 'Chest',
    setup: 'Bench at 30 degrees. Kick the dumbbells up into position with your knees rather than curling them into place.',
    execution: 'Lower until the dumbbells are level with the chest, elbows under the wrists, then press up and slightly together without clanging them at the top.',
    mistakes: ['Going so deep the shoulder takes over from the chest.', 'Pressing in an arc so far in that the dumbbells collide and the last inch does nothing.'] },
  { name: 'Overhead Press', aka: ['Shoulder Press', 'Military Press'], group: 'Shoulders',
    setup: 'Bar on the front of the shoulders, grip just outside the shoulders, ribs down and glutes tight so the press does not become a standing back bend.',
    execution: 'Press straight up, moving your head back out of the way and then forward under the bar as it passes. Finish with the bar over the middle of your feet.',
    mistakes: ['Leaning back to clear the chin instead of moving the head.', 'Stopping short of a locked-out overhead position.'] },
  { name: 'Deadlift', aka: ['Conventional Deadlift'], group: 'Back',
    setup: 'Bar over the middle of the foot, shins close, hips higher than the knees, chest up, lats pulling the bar into the legs.',
    execution: 'Push the floor away and let the bar drag up the legs. Hips and shoulders rise together; lock out by standing tall, not by leaning back.',
    mistakes: ['Letting the hips shoot up first so it becomes a stiff-legged pull.', 'Rounding the lower back — stop the set when position goes, not when the reps run out.', 'Jerking the bar off the floor instead of taking the slack out first.'] },
  { name: 'Romanian Deadlift', aka: ['RDL'], group: 'Legs',
    setup: 'Start standing with the bar already in your hands, knees softly bent and then kept at that angle throughout.',
    execution: 'Push the hips back and let the bar slide down the thighs until you feel a strong stretch in the hamstrings — usually somewhere around the knee — then drive the hips forward.',
    mistakes: ['Turning it into a squat by bending the knees more as you descend.', 'Chasing depth past where the hamstrings stop and the lower back starts.'] },
  { name: 'Back Squat', aka: ['Squat', 'Barbell Squat'], group: 'Legs',
    setup: 'Bar on the upper back, not the neck. Feet about shoulder-width, toes slightly out, whole foot planted.',
    execution: 'Break at the hips and knees together, sit down between your feet to at least parallel, then drive up with the chest staying where it was.',
    mistakes: ['Knees collapsing inward on the way up.', 'Heels lifting — that is usually ankle mobility, not effort.', 'Cutting depth as the weight climbs, so the sets stop comparing to each other.'] },
  { name: 'Front Squat', group: 'Legs',
    setup: 'Bar across the front of the shoulders resting on the delts, elbows lifted so the upper arms are near parallel to the floor. Feet about shoulder-width, toes slightly out.',
    execution: 'Sit straight down with the torso as upright as you can hold it, to at least parallel, then drive up while keeping the elbows high — the rack position is what fails first, not the legs.',
    mistakes: ['Elbows dropping on the way up, which pitches the bar forward off the shoulders.', 'Gripping the bar in the palms instead of letting it sit on the shoulders with the fingers only steadying it.', 'Treating the back squat weight as the starting point — a front squat is normally well below it.'] },
  { name: 'Leg Press', group: 'Legs',
    setup: 'Feet mid-platform, shoulder-width, hips and lower back flat against the pad.',
    execution: 'Lower until the knees reach roughly 90 degrees, then press back without snapping the knees straight at the top.',
    mistakes: ['Going so deep the pelvis lifts off the pad and the lower back rounds.', 'Locking the knees out hard at the top.'] },
  { name: 'Calf Raise', group: 'Legs',
    setup: 'Balls of the feet on the edge of the step or platform, heels free to drop below.',
    execution: 'Drop the heels for a full stretch, pause, then push all the way up onto the toes and pause there too. Slow at both ends.',
    mistakes: ['Bouncing through short reps that use the tendon rather than the muscle.'] },
  { name: 'Pull-ups', aka: ['Pull-up', 'Chin-ups', 'Chin-up'], group: 'Back',
    setup: 'Grip a little outside the shoulders, hang with the shoulders pulled down out of the ears rather than dead.',
    execution: 'Lead with the elbows down to the ribs, chest towards the bar, chin over it, then lower all the way to straight arms.',
    mistakes: ['Kipping with the legs when the reps get hard.', 'Stopping halfway down, which quietly halves the range.'] },
  { name: 'Lat Pulldown', group: 'Back',
    setup: 'Thighs locked under the pad, slight lean back that you then hold constant.',
    execution: 'Pull the bar to the upper chest by driving the elbows down, hold for a beat, and let it rise under control.',
    mistakes: ['Rocking the torso to move the weight.', 'Pulling behind the neck.'] },
  { name: 'Barbell Row', aka: ['Bent-over Row', 'Bent Over Row'], group: 'Back',
    setup: 'Hinge until the torso is around 45 degrees or lower, back flat, bar hanging under the shoulders.',
    execution: 'Row to the lower ribs, elbows past the torso, then lower fully without letting the chest drop.',
    mistakes: ['Standing up a little on every rep so the torso angle drifts.', 'Shrugging the weight up with the traps instead of rowing it.'] },
  { name: 'Face Pull', group: 'Back',
    setup: 'Rope at roughly face height, arms straight, a step back so there is tension before the first rep.',
    execution: 'Pull the rope towards your face with the hands finishing beside your ears and the elbows high. Squeeze, then return slowly.',
    mistakes: ['Loading it heavy enough that it becomes a row.', 'Letting the elbows drop below the wrists.'] },
  { name: 'Lateral Raise', group: 'Shoulders',
    setup: 'Dumbbells at your sides, small bend in the elbows, torso still.',
    execution: 'Raise out to the sides to roughly shoulder height, leading with the elbows, then lower slower than you lifted.',
    mistakes: ['Swinging the weight up with the hips.', 'Going far above shoulder height, where the traps take over.'] },
  { name: 'Barbell Curl', group: 'Arms',
    setup: 'Shoulder-width grip, elbows tucked at the ribs, ribs down.',
    execution: 'Curl by bending the elbow only, squeeze at the top, then lower all the way to straight.',
    mistakes: ['Swinging the bar up with the lower back.', 'Letting the elbows travel forward so the front delts take the work.'] },
  { name: 'Triceps Pushdown', aka: ['Tricep Pushdown', 'Cable Pushdown'], group: 'Arms',
    setup: 'Elbows pinned at your sides, small forward lean, shoulders down.',
    execution: 'Straighten the arms against the cable, pause at lockout, then let the forearms rise back to 90 degrees only.',
    mistakes: ['Letting the elbows drift forward and away from the ribs.', 'Leaning your bodyweight onto the bar when it gets heavy.'] },
  { name: 'Kettlebell Swing', group: 'Legs',
    setup: 'Bell about a foot in front of you, hinge and hike it back between the legs like a rugby pass.',
    execution: 'Snap the hips forward hard and let the bell float to chest height. It is a hinge, not a squat, and not a front raise.',
    mistakes: ['Squatting the bell up instead of hinging.', 'Lifting the bell with the arms rather than letting the hips throw it.', 'Letting the bell swing below the knees on the backswing.'] },
  { name: 'Rowing Erg', aka: ['Row Erg', 'Rowing Machine', 'Erg'], group: null,
    setup: 'Straps over the widest part of the foot, damper somewhere around 3–5 rather than at 10.',
    execution: 'Legs, then body, then arms on the drive; arms, then body, then legs on the recovery. Roughly one second out, two seconds back.',
    mistakes: ['Opening the back before the legs have finished pushing.', 'Yanking with the arms early, which is where sore elbows come from.'] }
];

// Same shape as `glossaryEntries`: every spelling of an entry, flattened, so
// lookup and the "is there a guide for this" test read the same table.
function formGuideEntries() {
  const out = [];
  FORM_GUIDE.forEach(function (e) {
    [e.name].concat(e.aka || []).forEach(function (word) { out.push({ key: exerciseKey(word), entry: e }); });
  });
  return out;
}

// A typed exercise name in, its guide out, or null. Exact on `exerciseKey`
// deliberately -- see the note above the table.
function formGuide(name) {
  const key = exerciseKey(name);
  if (!key) return null;
  const hit = formGuideEntries().filter(function (e) { return e.key === key; })[0];
  return hit ? hit.entry : null;
}

// ---------- weekly balance: hard sets per muscle group (idea #187) ----------
// `weeklyVolumes` on the Progress tab already answers "how much did I lift" in
// kilograms, and kilograms cannot answer "is my week balanced": one set of back
// squats outweighs a whole session of lateral raises, so a chest-only week and a
// legs-only week of the same tonnage read identically. The unit the training
// literature actually programmes with is the HARD SET, counted per muscle group
// per week, and that is what this counts. Sets, never kilograms, never reps.
//
// The group lives on the FORM_GUIDE entry rather than in a second name table.
// This app already has two tables of lift names -- BARBELL_LIFTS and FORM_GUIDE
// -- and a third one keyed by hand would drift from both the first time a lift
// is renamed. Adding a field means the `aka` spellings and the exact-match rule
// are inherited rather than re-stated.
//
// Two assignments are judgement calls and are written down rather than left in
// the table to be guessed at. The conventional Deadlift counts as Back: it is
// limited by the back and the grip, and it is programmed on pull days. The
// Romanian Deadlift counts as Legs, because it is a hamstring exercise done at
// a weight the back is not the limit of. Kettlebell Swing is Legs for the same
// hip-hinge reason.
const MUSCLE_GROUPS = ['Chest', 'Back', 'Shoulders', 'Legs', 'Arms'];

// The commonly cited effective range for growth is roughly 10 to 20 hard sets
// per muscle per week. It is a rule of thumb from group averages and not a
// promise about one person, so the card says so and the bands are deliberately
// coarse: below 10 is `low`, 10 to 20 is `on target`, above 20 is `high`. A
// group with no sets at all is `none`, which is a different sentence from `low`
// -- "you did four sets of arms" and "you did no arms" want different answers.
const MUSCLE_SETS_MIN = 10;
const MUSCLE_SETS_MAX = 20;

function muscleGroupFor(name) {
  const entry = formGuide(name);
  return entry && entry.group ? entry.group : null;
}

function muscleSetVerdict(sets) {
  if (sets === 0) return 'none';
  if (sets < MUSCLE_SETS_MIN) return 'low';
  if (sets > MUSCLE_SETS_MAX) return 'high';
  return 'on target';
}

// A trailing window ending on `todayISO` inclusive, not the calendar week that
// `weeklyVolumes` buckets by. Monday-to-Sunday is the right axis for a chart of
// history and the wrong one for a question asked on a Wednesday evening, where
// "the last seven days" is what decides whether tonight needs to be a pull day.
//
// A set counts when it has a finite rep count above zero. Weight is deliberately
// not required: a pull-up is stored at 0 kg and a set of them is a set. A set
// with no reps did not happen.
//
// Every group is returned, including the ones at zero -- the empty row is the
// finding. A lift no group can be found for is reported by name in `unmatched`
// rather than dropped, because "your back is untrained" computed off a table
// that has never heard of the lift you actually do is worse than saying nothing.
function weeklyMuscleSets(sessions, todayISO, days) {
  const window = days || 7;
  const today = todayISO || todayStr();
  const first = new Date(new Date(today + 'T00:00:00Z').getTime() - (window - 1) * 86400000)
    .toISOString().slice(0, 10);
  const counts = Object.create(null);
  MUSCLE_GROUPS.forEach(function (g) { counts[g] = 0; });
  const unmatched = Object.create(null);
  (sessions || []).forEach(function (session) {
    if (!session || sessionKind(session) !== 'strength' || !session.date) return;
    if (session.date < first || session.date > today) return;
    (session.exercises || []).forEach(function (ex) {
      if (!ex || !exerciseKey(ex.name)) return;
      const hard = (ex.sets || []).filter(function (st) {
        return st && typeof st.reps === 'number' && Number.isFinite(st.reps) && st.reps > 0;
      }).length;
      if (!hard) return;
      const group = muscleGroupFor(ex.name);
      if (!group) { unmatched[exerciseKey(ex.name)] = ex.name; return; }
      counts[group] += hard;
    });
  });
  return {
    from: first,
    to: today,
    days: window,
    groups: MUSCLE_GROUPS.map(function (g) {
      return { group: g, sets: counts[g], verdict: muscleSetVerdict(counts[g]) };
    }),
    unmatched: Object.keys(unmatched).sort().map(function (k) { return unmatched[k]; }),
  };
}

// The eighteen guides above are reachable from exactly one place: a Log row
// whose name box already matches one of them. So the lift you have never tried
// is precisely the lift you cannot look up, and idea #193 asked for a library
// rather than a lookup. This is the browse side of it -- every guide, grouped
// the way the weekly-balance card already groups them.
//
// Groups keep MUSCLE_GROUPS order rather than sorting alphabetically, because
// the balance card prints those five words in that order and two lists of the
// same words in two different orders read as two different things. A group
// MUSCLE_GROUPS has never heard of is kept and sorted after them rather than
// dropped -- a guide that renders nowhere is worse than a heading nobody
// expected, and it is the failure this whole function exists to end.
function formGuideLibrary() {
  const byGroup = Object.create(null);
  FORM_GUIDE.forEach(function (e) {
    const group = e.group || 'Other';
    if (!byGroup[group]) byGroup[group] = [];
    byGroup[group].push(e);
  });
  const extra = Object.keys(byGroup).filter(function (g) {
    return MUSCLE_GROUPS.indexOf(g) === -1;
  }).sort();
  return MUSCLE_GROUPS.concat(extra).filter(function (g) {
    return !!byGroup[g];
  }).map(function (g) {
    return {
      group: g,
      lifts: byGroup[g].slice().sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      }).map(function (e) {
        return { name: e.name, aka: (e.aka || []).slice() };
      }),
    };
  });
}

// The sheet renders one block of text rather than markup, because it reuses the
// glossary's sheet and that sets `textContent`. Blank lines separate the three
// parts and the stylesheet keeps them.
function formGuideBody(entry) {
  if (!entry) return '';
  const parts = ['Set up\n' + entry.setup, 'Do it\n' + entry.execution];
  const mistakes = entry.mistakes || [];
  if (mistakes.length) {
    parts.push('Common mistakes\n' + mistakes.map(function (m) { return '• ' + m; }).join('\n'));
  }
  return parts.join('\n\n');
}

// Longest first, so a shorter entry that happens to start inside a longer one
// cannot half-match it, and every spelling of an entry lands on the same entry.
function glossaryEntries() {
  const out = [];
  GLOSSARY.forEach(function (e) {
    [e.term].concat(e.aka || []).forEach(function (word) { out.push({ word: word, entry: e }); });
  });
  out.sort(function (a, b) { return b.word.length - a.word.length; });
  return out;
}

// One word in, its entry out. Case-insensitive because the app writes `RPE` and
// `Deload` and `deload` in different places, and an explainer that depends on
// capitalisation is one that silently stops appearing.
function glossaryTerm(word) {
  const needle = String(word == null ? '' : word).trim().toLowerCase();
  if (!needle) return null;
  const hit = glossaryEntries().filter(function (e) { return e.word.toLowerCase() === needle; })[0];
  return hit ? hit.entry : null;
}

// Plain text in, escaped HTML out, with the first mention of each term wrapped
// in a button that opens its explainer. It escapes rather than expecting escaped
// input on purpose: this replaces an `esc()` call at every site that uses it, so
// the safe thing has to be the thing you get by default.
//
// First mention only, and one per entry -- a paragraph that says "taper" three
// times should not become three buttons, and `rate of perceived exertion` after
// `RPE` is the same idea a second time.
function linkGlossary(text) {
  const raw = String(text == null ? '' : text);
  const used = Object.create(null);
  const spans = [];
  glossaryEntries().forEach(function (candidate) {
    if (used[candidate.entry.term]) return;
    const at = findTerm(raw, candidate.word);
    if (at < 0) return;
    if (overlapsAny(spans, at, at + candidate.word.length)) return;
    used[candidate.entry.term] = true;
    spans.push({ start: at, end: at + candidate.word.length, entry: candidate.entry });
  });
  spans.sort(function (a, b) { return a.start - b.start; });
  let out = '';
  let cursor = 0;
  spans.forEach(function (s) {
    out += esc(raw.slice(cursor, s.start));
    out += '<button type="button" class="term" data-term="' + esc(s.entry.term) +
           '" aria-label="What ' + esc(s.entry.term) + ' means">' + esc(raw.slice(s.start, s.end)) + '</button>';
    cursor = s.end;
  });
  return out + esc(raw.slice(cursor));
}

// A term only matches as a whole word, so `taper` never fires inside `tapered`
// and `RPE` never fires inside a longer token. A term may hold a space or a
// hyphen, which is why this is a scan rather than one regex over a joined list.
function findTerm(text, word) {
  const lower = text.toLowerCase();
  const needle = word.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at === 0 ? '' : lower[at - 1];
    const after = lower[at + needle.length] || '';
    if (!isWordChar(before) && !isWordChar(after)) return at;
    from = at + 1;
  }
}

function isWordChar(ch) { return !!ch && /[a-z0-9]/.test(ch); }

function overlapsAny(spans, start, end) {
  return spans.some(function (s) { return start < s.end && s.start < end; });
}

// Phase ends are cumulative shares of the whole window rather than per-phase
// lengths added up, so the last one lands exactly on the target date instead of
// four roundings away from it.
function buildMilestones(startISO, targetISO) {
  const span = daysBetween(startISO, targetISO);
  if (!Number.isFinite(span) || span < 1) return [];
  if (span < 28) {
    return [{ id: uid(), label: 'Build', note: 'Too short to periodise — one straight run at it.', date: targetISO, done: false }];
  }
  const start = new Date(startISO + 'T00:00');
  let cumulative = 0;
  return GOAL_PHASES.map((phase, i) => {
    cumulative += phase.share;
    const offset = i === GOAL_PHASES.length - 1 ? span : Math.round(span * cumulative);
    const end = new Date(start);
    end.setDate(end.getDate() + offset);
    return { id: uid(), label: phase.label, note: phase.note, date: fmtDate(end), done: false };
  });
}

function validateGoal(rawText, rawDate, todayISO) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) return { ok: false, message: 'Say what you are training for.' };
  if (text.length > GOAL_MAX_CHARS) return { ok: false, message: `Keep the goal under ${GOAL_MAX_CHARS} characters.` };
  const today = todayISO || todayStr();
  const date = String(rawDate == null ? '' : rawDate).trim();
  if (!date) return { ok: false, message: 'Give it a target date — that is what the phases are cut from.' };
  // A date input cannot produce this, but a paste can -- and `2027-02-31` does
  // not throw, it rolls forward to 3 March. Comparing the parsed components back
  // against what was typed is what catches the roll.
  const [y, mo, d] = date.split('-').map(Number);
  const parsed = new Date(date + 'T00:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime())
      || parsed.getFullYear() !== y || parsed.getMonth() + 1 !== mo || parsed.getDate() !== d) {
    return { ok: false, message: 'That target date is not a real date.' };
  }
  const span = daysBetween(today, date);
  if (span < 1) return { ok: false, message: 'The target date has to be in the future.' };
  if (span > GOAL_MAX_DAYS) return { ok: false, message: 'That target is more than ten years out — check the year.' };
  return { ok: true, goal: { id: uid(), text, targetDate: date, created: today, milestones: buildMilestones(today, date) } };
}

// ---------- endurance work inside the written week ----------
// You could always LOG a swim; the plan could never ASK for one. Every day in a
// plan was a list of exercises with sets and reps, so a week for an endurance
// goal -- the triathlon in the placeholder text -- could not be written down at
// all. That is the half of "the plan is fixed seed data" that resizing sets was
// never going to reach, and it needs no model: the user says which day, which
// activity and how long.
//
// A cardio session contributes zero sets, exactly as a logged one already does,
// so every piece of set arithmetic in this file is untouched by it. What does
// change is what counts as a training day -- see `isTrainingDay`.
function validatePlanCardio(rawActivity, rawMinutes) {
  const activity = String(rawActivity == null ? '' : rawActivity).trim();
  if (CARDIO_ACTIVITIES.indexOf(activity) === -1) return { ok: false, message: 'Pick one of the activities in the list.' };
  const minutes = checkNumber(rawMinutes, 'minutes');
  if (!minutes.ok) return { ok: false, message: minutes.message };
  // checkNumber only bounds the value. A plan is read at a glance, so `45.5 min`
  // on a card is noise rather than precision.
  if (!Number.isInteger(minutes.value)) return { ok: false, message: 'Duration must be a whole number of minutes.' };
  return { ok: true, cardio: { activity, minutes: minutes.value } };
}

// Pure: a plan in, a new plan out. `null` clears that day's cardio.
function withPlanCardio(plan, dayName, cardio) {
  const next = JSON.parse(JSON.stringify(plan || {}));
  const day = (next.days || []).find(d => d.day === dayName);
  if (!day) return next;
  if (cardio) {
    day.cardio = { activity: cardio.activity, minutes: cardio.minutes };
    // A rest day that now has a swim on it is not a rest day, and the focus is
    // what the card says out loud. A day that already has a lifting focus keeps
    // it -- the cardio is the second line, not a rename.
    if (day.focus === 'Rest') day.focus = cardio.activity;
  } else {
    delete day.cardio;
    if (!(day.exercises || []).length) day.focus = 'Rest';
  }
  return next;
}

// Sorted by how soon they are, so "next up" is always the first one.
// The Home tile's bodyweight number, with the window it was measured over.
// The tile sits between "sessions this wk" and "day streak", so an unlabelled
// number reads as this week's when it is actually the whole history -- the
// coach's own reply already says "over your logged history" and the tile did
// not. The extremes are picked by date rather than by array position: a weigh-in
// is pushed in the order it was typed, so one entered out of order would put the
// wrong reading at weights[0]. Fewer than two readings on two different days is
// no change at all rather than a change of zero, so it answers null and the
// caller shows a dash.
// A reading is stale once the gap since the last weigh-in is more than twice
// the gap this log normally runs at. There is no fixed number of days here on
// purpose: the same three-day gap is nothing for someone who weighs weekly and
// a full stop for someone who weighs every morning, so the log's own median gap
// is the scale. Edvard's log is a weigh-in every 2 days, so it goes stale after
// 4 -- and on 2026-09-08 it had been 9, while the tile still read "-2.1kg
// weight change over 26 days" as if that were the current trend.
const BW_STALE_GAP_FACTOR = 2;

function medianGapDays(sortedISO) {
  const gaps = [];
  for (let i = 1; i < sortedISO.length; i++) gaps.push(daysBetween(sortedISO[i - 1], sortedISO[i]));
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  // Two readings typed on the same day are a gap of 0, and a cadence of 0 would
  // call every reading stale the day after it was taken. A day is the shortest
  // cadence the date field can express, so that is the floor.
  return Math.max(1, median);
}

function bodyweightChange(weights, todayISO) {
  const dated = (weights || []).filter(w => w && w.date && typeof w.kg === 'number');
  if (dated.length < 2) return null;
  const sorted = dated.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first.date === last.date) return null;
  const days = Math.round(
    (Date.parse(last.date + 'T00:00:00Z') - Date.parse(first.date + 'T00:00:00Z')) / 86400000
  );
  // `todayISO` is optional so a caller that has no clock still gets the delta
  // and the span; what it cannot get is the staleness, and null says so rather
  // than defaulting to "fresh".
  const today = todayISO || null;
  const daysSinceLast = today ? Math.max(0, daysBetween(last.date, today)) : null;
  const typicalGap = medianGapDays(sorted.map(w => w.date));
  const stale = daysSinceLast !== null && typicalGap !== null
    && daysSinceLast > typicalGap * BW_STALE_GAP_FACTOR;
  return { delta: last.kg - first.kg, fromISO: first.date, toISO: last.date, days,
           daysSinceLast, typicalGap, stale };
}

// Same number as a label, so the tile and any sentence about it cannot drift.
// A stale reading names when it stopped instead of the span it covers: the span
// is the less useful of the two facts once the number is no longer about now,
// and the tile has room for one.
function bodyweightChangeLabel(change) {
  if (!change) return 'weight change';
  if (change.stale) {
    return `weight change, last weighed ${change.daysSinceLast} day${change.daysSinceLast === 1 ? '' : 's'} ago`;
  }
  return `weight change over ${change.days} day${change.days === 1 ? '' : 's'}`;
}

function goalsSorted() {
  return store.get('goals', []).slice().sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}

// The goals a drafted week should serve: every one whose day has not passed,
// nearest first. The draft used to send goalsSorted()[0], which is one goal
// only, and it is a goal already behind him once its target date has gone.
function draftGoals(todayISO) {
  const today = todayISO || todayStr();
  return goalsSorted().filter(g => g.targetDate >= today);
}

function goalCountdown(targetISO, todayISO) {
  const days = daysBetween(todayISO || todayStr(), targetISO);
  if (days < 0) return 'target date passed';
  if (days === 0) return 'today';
  if (days === 1) return '1 day to go';
  if (days < 70) return `${days} days to go`;
  return `${Math.round(days / 7)} weeks to go`;
}

// Distance to goal. The two numbers here are deliberately separate and the
// card shows both: how much of the window has gone, and how much of the plan
// is ticked. Merging them into one "percent complete" would be the same
// dishonesty as coaching a sentence nobody parsed -- the clock is a fact and
// the ticks are the user's own claim, and the gap between them is the finding.
//
// The verdict is arithmetic on dates rather than a tuned threshold: a phase
// whose date has passed and is not ticked is overdue, full stop. Ahead means
// nothing is overdue and something not yet due has been ticked. A goal with no
// phases (an old row, or a window too short to periodise) reports its clock and
// says it has nothing to judge, rather than reporting 0% done and looking late.
function goalProgress(goal, todayISO) {
  const today = todayISO || todayStr();
  const milestones = (goal && goal.milestones) || [];
  const start = (goal && goal.created) || today;
  const target = goal && goal.targetDate;
  const span = target ? daysBetween(start, target) : 0;
  const gone = daysBetween(start, today);
  const elapsedPct = span > 0 ? Math.max(0, Math.min(100, Math.round((gone / span) * 100))) : 100;
  const total = milestones.length;
  const doneCount = milestones.filter(m => m.done).length;
  const donePct = total ? Math.round((doneCount / total) * 100) : 0;
  const overdue = milestones.filter(m => !m.done && m.date < today).length;
  const earlyTicks = milestones.filter(m => m.done && m.date >= today).length;

  let verdict = 'on track';
  if (!total) verdict = 'no phases';
  else if (overdue > 0) verdict = 'behind';
  else if (earlyTicks > 0) verdict = 'ahead';

  const daysLeft = target ? daysBetween(today, target) : 0;
  return { elapsedPct, donePct, doneCount, total, overdue, daysLeft, verdict };
}

// The label spells the verdict out rather than leaning on the colour -- a
// reader who does not know the colour code has to be told what was said.
function goalVerdictLabel(progress) {
  if (progress.verdict === 'no phases') return 'no phases to judge';
  if (progress.verdict === 'behind') {
    return progress.overdue === 1 ? '1 phase overdue' : progress.overdue + ' phases overdue';
  }
  if (progress.verdict === 'ahead') return 'ahead of the dates';
  return 'on track';
}

// ---------- telling the user something went wrong ----------
function toast(message) {
  const host = document.getElementById('toast');
  if (!host) return;
  host.textContent = message;
  host.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { host.hidden = true; }, 4000);
}

// ---------- seed data ----------
// True when `seed()` wrote the starter data on this boot, which can only happen
// in a browser that has never opened Marcus before. Not persisted on purpose --
// it is a fact about this page load, and the next one is a returning visit.
let seededThisBoot = false;
function seed() {
  if (!store.get('plan')) {
    seededThisBoot = true;
    store.set('plan', {
      blockName: 'Hypertrophy Block — Week 5',
      days: [
        { day: 'Monday', focus: 'Push', exercises: [
          { name: 'Barbell Bench Press', sets: 4, reps: 8 },
          { name: 'Overhead Press', sets: 3, reps: 10 },
          { name: 'Incline Dumbbell Press', sets: 3, reps: 12 },
          { name: 'Triceps Pushdown', sets: 3, reps: 15 },
        ]},
        { day: 'Tuesday', focus: 'Pull', exercises: [
          { name: 'Deadlift', sets: 3, reps: 5 },
          { name: 'Pull-ups', sets: 4, reps: 8 },
          { name: 'Barbell Row', sets: 3, reps: 10 },
          { name: 'Face Pull', sets: 3, reps: 15 },
        ]},
        { day: 'Wednesday', focus: 'Rest', exercises: [] },
        { day: 'Thursday', focus: 'Legs', exercises: [
          { name: 'Back Squat', sets: 4, reps: 6 },
          { name: 'Romanian Deadlift', sets: 3, reps: 10 },
          { name: 'Leg Press', sets: 3, reps: 12 },
          { name: 'Calf Raise', sets: 4, reps: 15 },
        ]},
        { day: 'Friday', focus: 'Upper Body', exercises: [
          { name: 'Incline Bench Press', sets: 4, reps: 8 },
          { name: 'Lat Pulldown', sets: 3, reps: 10 },
          { name: 'Lateral Raise', sets: 3, reps: 15 },
          { name: 'Barbell Curl', sets: 3, reps: 12 },
        ]},
        { day: 'Saturday', focus: 'Conditioning', exercises: [
          { name: 'Kettlebell Swing', sets: 4, reps: 20 },
          { name: 'Rowing Erg', sets: 1, reps: 1 },
        ]},
        { day: 'Sunday', focus: 'Rest', exercises: [] },
      ]
    });
  }

  if (!store.get('sessions')) {
    const sessions = [];
    const names = { Monday: ['Barbell Bench Press','Overhead Press','Incline Dumbbell Press'], Tuesday: ['Deadlift','Pull-ups','Barbell Row'], Thursday: ['Back Squat','Romanian Deadlift','Leg Press'], Friday: ['Incline Bench Press','Lat Pulldown','Lateral Raise'] };
    for (let i = 27; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dayName = DAY_NAMES[d.getDay()];
      const exList = names[dayName];
      if (!exList) continue;
      const progress = (27 - i) / 27;
      sessions.push({
        id: uid(), date: fmtDate(d), day: dayName,
        exercises: exList.map((n, idx) => ({
          name: n, sets: Array.from({ length: 3 }, () => ({
            reps: 8 + Math.round(Math.random()),
            weight: Math.round((20 + idx * 15 + progress * 12 + Math.random() * 3) * 2) / 2
          }))
        }))
      });
    }
    store.set('sessions', sessions);
  }

  if (!store.get('weights')) {
    const weights = [];
    let w = 84.5;
    for (let i = 27; i >= 0; i -= 2) {
      const d = new Date(); d.setDate(d.getDate() - i);
      w -= 0.12 + Math.random() * 0.08;
      weights.push({ date: fmtDate(d), kg: Math.round(w * 10) / 10 });
    }
    store.set('weights', weights);
  }

  if (!store.get('meals')) {
    const meals = [];
    const sample = [
      ['Oats + whey + banana', 520, 38, 70, 9],
      ['Chicken, rice, broccoli', 640, 52, 68, 14],
      ['Greek yogurt + berries', 260, 22, 28, 6],
      ['Salmon, potatoes, greens', 710, 45, 60, 28],
      ['Protein shake', 220, 30, 10, 4],
    ];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const count = 2 + Math.floor(Math.random() * 2);
      for (let m = 0; m < count; m++) {
        const [name, cal, p, c, f] = sample[Math.floor(Math.random() * sample.length)];
        meals.push({ id: uid(), date: fmtDate(d), time: `${String(7 + m * 4).padStart(2, '0')}:00`, name, calories: cal, protein: p, carbs: c, fat: f });
      }
    }
    store.set('meals', meals);
  }

  if (!store.get('chat')) {
    store.set('chat', [
      { role: 'marcus', text: "Hey! I'm Marcus, your trainer. Ask me about today's session, your plan, or how your progress looks — I'm watching your numbers 💪", ts: Date.now() }
    ]);
  }
}
seed();
