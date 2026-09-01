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
const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);
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
  const setCount = Math.round(parsed.sets);
  const reps = Math.round(parsed.reps);
  return { ok: true, exercise: { name, sets: Array.from({ length: setCount }, () => ({ reps, weight: parsed.weight })) } };
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

// Sorted by how soon they are, so "next up" is always the first one.
function goalsSorted() {
  return store.get('goals', []).slice().sort((a, b) => a.targetDate.localeCompare(b.targetDate));
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
function seed() {
  if (!store.get('plan')) {
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

// ---------- tabs ----------
const view = document.getElementById('view');
let currentTab = 'home';
let charts = {};

function destroyCharts() { Object.values(charts).forEach(c => c.destroy()); charts = {}; }

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.bottomnav__item').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  destroyCharts();
  const renderers = { home: renderHome, plan: renderPlan, log: renderLog, nutrition: renderNutrition, progress: renderProgress };
  view.innerHTML = '';
  renderers[tab]();
  view.scrollTop = 0;
}
document.querySelectorAll('.bottomnav__item').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- home ----------
function weekSessions() {
  const sessions = store.get('sessions', []);
  const start = new Date(); start.setDate(start.getDate() - start.getDay());
  start.setHours(0,0,0,0);
  return sessions.filter(s => new Date(s.date + 'T00:00') >= start);
}

function streak() {
  const sessions = store.get('sessions', []).map(s => s.date).sort().reverse();
  let count = 0; let cursor = new Date();
  for (const d of sessions) {
    const diff = Math.round((cursor - new Date(d + 'T00:00')) / 86400000);
    if (diff <= 1) { count++; cursor = new Date(d + 'T00:00'); } else break;
  }
  return count;
}

function renderHome() {
  const plan = store.get('plan');
  const todayName = planDayName();
  const todayPlan = plan.days.find(d => d.day === todayName);
  const weights = store.get('weights', []);
  const lastWeight = weights[weights.length - 1];
  const firstWeight = weights[0];
  const delta = lastWeight && firstWeight ? (lastWeight.kg - firstWeight.kg).toFixed(1) : '—';
  const meals = store.get('meals', []).filter(m => m.date === todayStr());
  const kcal = meals.reduce((s, m) => s + m.calories, 0);
  // The nearest goal, and the first phase of it still outstanding -- that pair is
  // what turns a far-off date into something today can be measured against.
  const nextGoal = goalsSorted()[0];
  const nextPhase = nextGoal && nextGoal.milestones.find(m => !m.done);
  const week = weekTarget(nextGoal, plan, store.get('sessions', []), todayStr());

  view.innerHTML = `
    <div class="card">
      <div class="card__title-row"><h2>Today · ${todayName}</h2><span class="chip ${todayPlan.focus==='Rest'?'':'chip--primary'}">${todayPlan.focus}</span></div>
      ${todayPlan.exercises.length ? todayPlan.exercises.map(e => `<div class="exercise-line"><span>${e.name}</span><span>${e.sets}×${e.reps}</span></div>`).join('') : `<div class="empty">Rest day — recovery is training too.</div>`}
      <button class="btn btn--filled btn--block" style="margin-top:12px" onclick="switchTab('log')"><span class="material-icons-round">add</span> Log this session</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat__value">${weekSessions().length}</div><div class="stat__label">sessions this wk</div></div>
      <div class="stat"><div class="stat__value">${streak()}</div><div class="stat__label">day streak</div></div>
      <div class="stat"><div class="stat__value">${delta}kg</div><div class="stat__label">weight change</div></div>
    </div>

    ${nextGoal ? `
    <div class="section-title">Next goal</div>
    <div class="card">
      <div class="card__title-row"><h2>${esc(nextGoal.text)}</h2><span class="chip chip--primary">${esc(goalCountdown(nextGoal.targetDate))}</span></div>
      ${nextPhase ? `<div class="exercise-line"><span>${esc(nextPhase.label)} phase</span><span>through ${niceDate(nextPhase.date)}</span></div>`
                  : `<div class="empty">Every phase ticked off — target day is the only thing left.</div>`}
    </div>` : ``}

    ${week.phase ? `
    <div class="section-title">This week</div>
    <div class="card">
      <div class="card__title-row"><h2>${esc(week.phase)} phase</h2><span class="chip chip--primary">${week.sessionsDone}/${week.sessionsPlanned} sessions</span></div>
      ${week.volumeTarget != null ? `<div class="exercise-line"><span>Volume</span><span>${week.volumeDone} / ${week.volumeTarget} kg</span></div>` : ``}
      <div class="card__note">${esc(weekTargetLabel(week))}</div>
    </div>` : ``}

    <div class="section-title">Today's nutrition</div>
    <div class="card">
      <div class="card__title-row"><h2>${kcal} kcal logged</h2><button class="btn btn--tonal" onclick="switchTab('nutrition')">Add meal</button></div>
      ${meals.length ? meals.map(m => `<div class="exercise-line"><span>${esc(m.name)}</span><span>${m.calories} kcal</span></div>`).join('') : `<div class="empty">Nothing logged yet today.</div>`}
    </div>
  `;
}

// ---------- plan ----------
// Goals sit above the week because the week is supposed to serve them. The
// phases under a goal are arithmetic on the dates the user typed -- Marcus says
// so on the card rather than passing them off as coaching.
function renderPlan() {
  const plan = store.get('plan');
  const todayName = planDayName();
  const goals = goalsSorted();
  const review = planReview(plan, store.get('sessions', []), todayStr());
  view.innerHTML = `
    <div class="section-title">Goals</div>
    ${goals.length ? goals.map(g => `
      <div class="card" style="display:block">
        <div class="card__title-row"><h2>${esc(g.text)}</h2><span class="chip chip--primary">${esc(goalCountdown(g.targetDate))}</span></div>
        <div style="font-size:12px;color:var(--md-on-surface-variant);margin:2px 0 8px">Target ${niceDate(g.targetDate)} · phases are cut from your dates, not coached yet</div>
        ${g.milestones.map(m => `
          <div class="exercise-line">
            <span><button class="icon-btn" onclick="toggleMilestone('${g.id}','${m.id}')"><span class="material-icons-round">${m.done ? 'check_box' : 'check_box_outline_blank'}</span></button>${esc(m.label)} — ${esc(m.note)}</span>
            <span>${niceDate(m.date)}</span>
          </div>`).join('')}
        <button class="btn btn--tonal btn--block" style="margin-top:12px" onclick="deleteGoal('${g.id}')">Remove goal</button>
      </div>`).join('') : `<div class="empty">No goal yet — tell Marcus what you are training for and he will date the phases.</div>`}

    <div class="card">
      <h2>Add a goal</h2>
      <div class="field"><label>What are you training for</label><input id="goalText" type="text" placeholder="e.g. Olympic triathlon next summer"></div>
      <div class="field"><label>Target date</label><input id="goalDate" type="date"></div>
      <button class="btn btn--filled btn--block" id="addGoal"><span class="material-icons-round">flag</span> Set goal</button>
    </div>

    <div class="section-title">Marcus suggests</div>
    ${review.proposals.length ? review.proposals.map(p => `
      <div class="card" style="display:block">
        <div class="card__title-row"><h2>${esc(p.title)}</h2><span class="chip ${p.kind === 'deload' ? 'chip--alert' : 'chip--primary'}">${esc(proposalChip(p.kind))}</span></div>
        <p class="card__note">${esc(p.reason)}</p>
        <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="acceptProposal('${p.id}')">Change the plan</button>
      </div>`).join('') : `<div class="empty">${esc(review.note)}</div>`}
    <div class="card__note" style="padding:0 4px 4px">Reasons come from your own numbers only. Marcus does not cite research here yet.</div>

    <div class="section-title">This week</div>
    <div class="card">
      <h2>${plan.blockName}</h2>
      <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">Prepared by Marcus</div>
    </div>
    ${plan.days.map(d => `
      <div class="card plan-day ${d.day===todayName?'is-today':''}" style="display:block">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="plan-day__name">${d.day}</span>
          <span class="plan-day__focus">${d.focus}</span>
        </div>
        ${d.exercises.map(e => `<div class="exercise-line"><span>${e.name}</span><span>${e.sets}×${e.reps}</span></div>`).join('')}
      </div>
    `).join('')}
  `;

  document.getElementById('addGoal').addEventListener('click', () => {
    const result = validateGoal(document.getElementById('goalText').value, document.getElementById('goalDate').value);
    if (!result.ok) { toast(result.message); return; }
    const all = store.get('goals', []);
    all.push(result.goal);
    if (!store.set('goals', all)) return;
    renderPlan();
  });
}

function acceptProposal(id) {
  const plan = store.get('plan');
  const review = planReview(plan, store.get('sessions', []), todayStr());
  const proposal = review.proposals.find(p => p.id === id);
  if (!proposal) { toast('That suggestion is no longer current'); return; }
  if (!store.set('plan', applyProposal(plan, proposal))) return;
  toast('Plan updated');
  renderPlan();
}

function toggleMilestone(goalId, milestoneId) {
  const all = store.get('goals', []);
  const goal = all.find(g => g.id === goalId);
  const milestone = goal && goal.milestones.find(m => m.id === milestoneId);
  if (!milestone) return;
  milestone.done = !milestone.done;
  if (!store.set('goals', all)) return;
  renderPlan();
}

function deleteGoal(id) {
  store.set('goals', store.get('goals', []).filter(g => g.id !== id));
  renderPlan();
}

// ---------- describing a session in a sentence ----------
// The Food tab already takes a whole sentence; this is the same idea for
// training. It fills the form and never saves behind your back, which is what
// keeps it honest: a plan session has no weights in it, and inventing one would
// write a made-up number into the log as a measurement.

// The verb someone actually types, mapped to the activity the picker offers.
// Only these words start a cardio session -- an activity not in this table is
// not guessed at, it is reported back unread.
const CARDIO_VERBS = {
  ran: 'Run', run: 'Run', running: 'Run', jog: 'Run', jogged: 'Run', jogging: 'Run',
  bike: 'Bike', biked: 'Bike', biking: 'Bike', cycle: 'Bike', cycled: 'Bike', cycling: 'Bike', rode: 'Bike',
  swim: 'Swim', swam: 'Swim', swimming: 'Swim',
  row: 'Row', rowed: 'Row', rowing: 'Row', erg: 'Row',
  ski: 'Ski', skied: 'Ski', skiing: 'Ski',
  walk: 'Walk', walked: 'Walk', walking: 'Walk', hike: 'Walk', hiked: 'Walk', hiking: 'Walk'
};

// How it felt, in the words people use. The stored value is one of four so the
// adaptive plan review can read it; the sentence itself is kept as well.
const FEEL_WORDS = {
  easy: 'easy', light: 'easy', comfortable: 'easy', fine: 'easy',
  hard: 'hard', tough: 'hard', heavy: 'hard', brutal: 'hard', exhausting: 'hard',
  good: 'good', great: 'good', strong: 'good',
  rough: 'rough', bad: 'rough', terrible: 'rough', awful: 'rough', flat: 'rough'
};

const INJURY_WORDS = ['injury', 'injured', 'pain', 'painful', 'hurt', 'hurts', 'sore', 'niggle', 'strain', 'strained', 'tweaked'];

// Words that put a clause in the future. "I ran 7km today, got a small injury
// so I want to take it easy next run" says the *next* run should be easy and
// says nothing about how this one felt -- and reading "easy" out of it writes a
// feel nobody reported. Found by driving the deployed app, not by a test.
const FUTURE_MARKERS = ['next', 'tomorrow', 'will', 'gonna', 'later'];
const FUTURE_PHRASES = [/\bwant\s+to\b/, /\bgoing\s+to\b/, /\bplan\s+to\b/, /\bneed\s+to\b/, /\bshould\b/];

// A clause is forward-looking if it names a future time or announces an
// intention. Only the clauses that are left describe the session just done.
function pastClauses(text) {
  return String(text == null ? '' : text)
    .split(/[.;,!?]+|\bso\b|\bbut\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter((c) => {
      const words = sessionSentenceWords(c);
      if (words.some((w) => FUTURE_MARKERS.indexOf(w) !== -1)) return false;
      return !FUTURE_PHRASES.some((re) => re.test(c.toLowerCase()));
    });
}

function sessionSentenceWords(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

// "today", "yesterday" and a weekday name are the three ways a date gets named
// in a sentence about training. A weekday resolves backwards -- you describe a
// session you did, not one you are going to do -- and today's own name is today.
function sessionSentenceDate(words, todayISO) {
  const today = new Date(todayISO + 'T00:00');
  if (words.indexOf('yesterday') !== -1) {
    const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d);
  }
  for (let back = 0; back < 7; back++) {
    const d = new Date(today); d.setDate(d.getDate() - back);
    if (words.indexOf(DAY_NAMES[d.getDay()].toLowerCase()) !== -1) return fmtDate(d);
  }
  return todayISO;
}

// Distance only from a unit that can mean nothing else. A bare "m" is not read
// as metres because "45 m" is how people write minutes, and a wrong distance is
// worse than a missing one.
function sessionSentenceDistance(text) {
  const km = text.match(/(\d+(?:[.,]\d+)?)\s*(kilometres|kilometers|kilometre|kilometer|kms|km|k)\b/i);
  if (km) return parseFloat(km[1].replace(',', '.'));
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(metres|meters|metre|meter)\b/i);
  if (m) return parseFloat(m[1].replace(',', '.')) / 1000;
  return null;
}

function sessionSentenceMinutes(text) {
  const half = text.match(/half\s+an?\s+hour/i);
  if (half) return 30;
  const hm = text.match(/(\d+(?:[.,]\d+)?)\s*(hours|hour|hrs|hr|h)\b/i);
  if (hm) return Math.round(parseFloat(hm[1].replace(',', '.')) * 60);
  if (/\ban\s+hour\b/i.test(text)) return 60;
  const mm = text.match(/(\d+(?:[.,]\d+)?)\s*(minutes|minute|mins|min)\b/i);
  if (mm) return Math.round(parseFloat(mm[1].replace(',', '.')));
  return null;
}

// The one sentence, read into whatever the form needs. `ok: false` means I could
// not tell what was done, and that is a refusal rather than a best guess.
// `missing` names a field the sentence genuinely did not carry, so the form can
// ask for it instead of filling it in with arithmetic nobody typed.
function parseSessionSentence(text, plan, todayISO) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, reason: 'Describe the session first.' };

  const words = sessionSentenceWords(raw);
  const date = sessionSentenceDate(words, todayISO || todayStr());

  let feel = null;
  for (const w of sessionSentenceWords(pastClauses(raw).join(' '))) {
    if (Object.prototype.hasOwnProperty.call(FEEL_WORDS, w)) { feel = FEEL_WORDS[w]; break; }
  }
  const injury = words.some((w) => INJURY_WORDS.indexOf(w) !== -1);
  const common = { date, feel, injury, note: raw };

  const followedPlan = /\b(follow(?:ed)?|did|done|completed)\b[^.]{0,20}\bplan\b/i.test(raw)
    || /\bas\s+planned\b/i.test(raw)
    || /\bplanned\s+session\b/i.test(raw);

  let activity = null;
  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(CARDIO_VERBS, w)) { activity = CARDIO_VERBS[w]; break; }
  }

  // A named activity wins over a plan reference: "I ran the plan's easy run"
  // is a run, and the plan's strength rows would be the wrong form to open.
  if (activity) {
    const minutes = sessionSentenceMinutes(raw);
    const distance = sessionSentenceDistance(raw);
    return {
      ok: true,
      kind: 'cardio',
      cardio: { activity, minutes, distance },
      missing: minutes == null ? ['minutes'] : [],
      ...common
    };
  }

  if (followedPlan) {
    const days = (plan && plan.days) || [];
    const dayName = planDayName(new Date(date + 'T00:00'));
    const day = days.find((d) => d.day === dayName);
    if (!day || !day.exercises || !day.exercises.length) {
      return { ok: false, reason: `Your plan has nothing on ${dayName}, so I do not know what you did. Pick a day and fill it in.` };
    }
    return {
      ok: true,
      kind: 'strength',
      day: day.day,
      exercises: day.exercises.map((e) => ({ name: e.name, sets: e.sets, reps: e.reps })),
      // The plan carries sets and reps and no weight, so every row still needs
      // one. This is the "amount stays blank and asks you" rule from the meal
      // parser: the form opens filled in, and you type the kilos.
      missing: ['weight'],
      ...common
    };
  }

  return { ok: false, reason: 'I could not tell what you did. Name the activity ("ran 7 km"), or say you followed the plan.' };
}

// What I understood, said back before anything is saved. It names the missing
// field rather than hiding it, because the whole point of not guessing is that
// you can see what was left blank.
function sessionSentenceSummary(result) {
  if (!result || !result.ok) return '';
  const parts = [];
  if (result.kind === 'cardio') {
    parts.push(result.cardio.activity);
    if (result.cardio.distance != null) parts.push(`${result.cardio.distance} km`);
    if (result.cardio.minutes != null) parts.push(`${result.cardio.minutes} min`);
  } else {
    parts.push(`${result.day} — ${result.exercises.length} exercises from your plan`);
  }
  parts.push(niceDate(result.date));
  if (result.feel) parts.push(`felt ${result.feel}`);
  if (result.injury) parts.push('injury mentioned');
  let out = `Heard: ${parts.join(' \u00b7 ')}.`;
  if (result.missing.indexOf('minutes') !== -1) out += ' I did not hear how long it took — fill in the duration.';
  if (result.missing.indexOf('weight') !== -1) out += ' Your plan has no weights in it — type what you lifted.';
  return out;
}

// The note fields written onto a saved session. `feel` and `injury` come from
// the sentence and only from it: they are a reading of what you typed, so a
// note you edited by hand keeps its text and drops the flags rather than
// carrying a verdict the words no longer support.
function sessionNote() {
  const el = document.getElementById('logNote');
  const note = el ? String(el.value || '').trim() : '';
  const out = {};
  if (note) out.note = note;
  if (logSentence && note === logSentence.note) {
    if (logSentence.feel) out.feel = logSentence.feel;
    if (logSentence.injury) out.injury = true;
  }
  return out;
}

// ---------- log ----------
// Which kind of session the Log tab is showing is UI state, not stored data,
// so it lives here beside the food picker's own index.
let logKind = 'strength';

// What the sentence box understood, held across the re-render that fills the
// form. Cleared as soon as the session is saved so it cannot re-apply itself.
let logSentence = null;

function renderLog() {
  const plan = store.get('plan');
  const cardio = logKind === 'cardio';
  const heard = logSentence;
  view.innerHTML = `
    <div class="card">
      <h2>Describe your session</h2>
      <div class="field">
        <input type="text" id="sessionSentence" placeholder="e.g. I ran 7 km today, felt easy">
      </div>
      <button type="button" class="btn btn--tonal btn--block" id="readSentence">Read it</button>
      ${heard ? `<div class="hint" id="sentenceHeard">${esc(heard.summary)}</div>` : ''}
    </div>
    <div class="card">
      <h2>Log a session</h2>
      <div class="seg" id="logKind" role="tablist">
        <button type="button" class="seg__btn ${cardio ? '' : 'seg__btn--on'}" id="logKindStrength" role="tab" aria-selected="${cardio ? 'false' : 'true'}">Strength</button>
        <button type="button" class="seg__btn ${cardio ? 'seg__btn--on' : ''}" id="logKindCardio" role="tab" aria-selected="${cardio ? 'true' : 'false'}">Cardio</button>
      </div>
      <div class="field">
        <label>Date</label>
        <input type="date" id="logDate" value="${heard ? heard.date : todayStr()}">
      </div>
      ${cardio ? `
      <div class="field">
        <label>Activity</label>
        <select id="cardioActivity">${CARDIO_ACTIVITIES.map(a => `<option value="${a}"${heard && heard.cardio && heard.cardio.activity === a ? ' selected' : ''}>${a}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Duration (minutes)</label>
        <input type="number" id="cardioMinutes" min="1" step="1" placeholder="e.g. 45" value="${heard && heard.cardio && heard.cardio.minutes != null ? heard.cardio.minutes : ''}">
      </div>
      <div class="field">
        <label>Distance (km) — optional</label>
        <input type="number" id="cardioDistance" min="0" step="0.01" placeholder="leave blank for a pool swim or a class" value="${heard && heard.cardio && heard.cardio.distance != null ? heard.cardio.distance : ''}">
      </div>
      <div class="field">
        <label>How it felt / notes — optional</label>
        <input type="text" id="logNote" value="${heard && heard.kind === 'cardio' ? esc(heard.note) : ''}">
      </div>
      <button type="button" class="btn btn--filled btn--block" id="saveCardio" style="margin-top:14px">Save session</button>
      ` : `
      <div class="field">
        <label>Day / focus</label>
        <select id="logDay">${plan.days.map(d => `<option value="${d.day}"${heard && heard.day === d.day ? ' selected' : ''}>${d.day} — ${d.focus}</option>`).join('')}</select>
      </div>
      <div id="exerciseRows"></div>
      <button type="button" class="btn btn--tonal" id="addExercise"><span class="material-icons-round">add</span> Add exercise</button>
      <div class="field">
        <label>How it felt / notes — optional</label>
        <input type="text" id="logNote" value="${heard && heard.kind === 'strength' ? esc(heard.note) : ''}">
      </div>
      <button type="button" class="btn btn--filled btn--block" id="saveSession" style="margin-top:14px">Save session</button>
      `}
    </div>
    <div class="section-title">Recent sessions</div>
    <div id="recentSessions"></div>
  `;

  document.getElementById('logKindStrength').addEventListener('click', () => { logKind = 'strength'; renderLog(); });
  document.getElementById('logKindCardio').addEventListener('click', () => { logKind = 'cardio'; renderLog(); });

  document.getElementById('readSentence').addEventListener('click', () => {
    const result = parseSessionSentence(document.getElementById('sessionSentence').value, store.get('plan'), todayStr());
    if (!result.ok) { toast(result.reason); return; }
    logSentence = { ...result, summary: sessionSentenceSummary(result) };
    logKind = result.kind;
    renderLog();
  });

  if (cardio) {
    document.getElementById('saveCardio').addEventListener('click', () => {
      const result = validateCardio(
        document.getElementById('cardioActivity').value,
        document.getElementById('cardioMinutes').value,
        document.getElementById('cardioDistance').value
      );
      if (!result.ok) { toast(result.message); return; }
      const sessions = store.get('sessions', []);
      sessions.push({ id: uid(), date: document.getElementById('logDate').value, kind: 'cardio', ...result.cardio, ...sessionNote() });
      if (!store.set('sessions', sessions)) return;
      logSentence = null;
      renderLog();
    });
    renderRecentSessions();
    return;
  }

  const tpl = document.getElementById('tpl-log-exercise-row');
  const rows = document.getElementById('exerciseRows');
  function addRow(prefill) {
    const node = tpl.content.cloneNode(true);
    if (prefill) {
      node.querySelector('.ex-name').value = prefill.name;
      node.querySelector('.ex-sets').value = prefill.sets;
      node.querySelector('.ex-reps').value = prefill.reps;
    }
    node.querySelector('.ex-remove').addEventListener('click', (e) => e.target.closest('.exercise-row').remove());
    rows.appendChild(node);
  }
  const heardRows = heard && heard.kind === 'strength' && heard.exercises && heard.exercises.length ? heard.exercises : null;
  const todayName = heard && heard.day ? heard.day : planDayName();
  const todayPlan = plan.days.find(d => d.day === todayName) || plan.days[0];
  (heardRows || (todayPlan.exercises.length ? todayPlan.exercises : [{ name: '', sets: 3, reps: 10 }])).forEach(addRow);

  document.getElementById('logDay').addEventListener('change', (e) => {
    rows.innerHTML = '';
    const d = plan.days.find(d => d.day === e.target.value);
    (d.exercises.length ? d.exercises : [{ name: '', sets: 3, reps: 10 }]).forEach(addRow);
  });
  document.getElementById('addExercise').addEventListener('click', () => addRow());

  document.getElementById('saveSession').addEventListener('click', () => {
    const result = validateSession([...rows.querySelectorAll('.exercise-row')].map(r => ({
      name: r.querySelector('.ex-name').value,
      sets: r.querySelector('.ex-sets').value,
      reps: r.querySelector('.ex-reps').value,
      weight: r.querySelector('.ex-weight').value
    })));
    if (!result.ok) { toast(result.message); return; }
    const sessions = store.get('sessions', []);
    sessions.push({ id: uid(), date: document.getElementById('logDate').value, kind: 'strength', day: document.getElementById('logDay').value, exercises: result.exercises, ...sessionNote() });
    if (!store.set('sessions', sessions)) return;
    logSentence = null;
    switchTab('log');
  });

  renderRecentSessions();
}

function sessionNoteLine(s) {
  if (!s || !s.note) return '';
  const flags = [];
  if (s.feel) flags.push(`felt ${s.feel}`);
  if (s.injury) flags.push('injury');
  const tail = flags.length ? ` <span class="chip">${esc(flags.join(' \u00b7 '))}</span>` : '';
  return `<div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">${esc(s.note)}${tail}</div>`;
}

function sessionCard(s) {
  const del = `<button class="icon-btn" onclick="deleteSession('${s.id}')"><span class="material-icons-round">delete</span></button>`;
  if (sessionKind(s) === 'cardio') {
    return `<div class="card">
      <div class="card__title-row"><h2>${niceDate(s.date)} · ${esc(s.activity)}</h2>${del}</div>
      <div class="exercise-line"><span>${esc(cardioSummary(s))}</span><span>cardio</span></div>
      ${sessionNoteLine(s)}
    </div>`;
  }
  const exercises = s.exercises || [];
  const volume = exercises.reduce((sum, e) => sum + e.sets.reduce((ss, st) => ss + st.reps * st.weight, 0), 0);
  return `<div class="card">
    <div class="card__title-row"><h2>${niceDate(s.date)} · ${esc(s.day || 'Session')}</h2>${del}</div>
    ${exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets.length} sets</span></div>`).join('')}
    <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">Volume: ${Math.round(volume).toLocaleString()} kg</div>
    ${sessionNoteLine(s)}
  </div>`;
}

function renderRecentSessions() {
  const recent = store.get('sessions', []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  document.getElementById('recentSessions').innerHTML = recent.length
    ? recent.map(sessionCard).join('')
    : `<div class="empty">No sessions logged yet.</div>`;
}
function deleteSession(id) {
  store.set('sessions', store.get('sessions', []).filter(s => s.id !== id));
  renderLog();
}

// ---------- nutrition ----------
// Which food is picked and which recent meals are on screen are UI state, not
// stored data, so they live here rather than in `store`.
let foodPickIndex = null;
let recentMealCache = [];
// The result of the last sentence read, held so the amounts can be corrected
// before anything is written into the log.
let mealParse = null;

function saveMeal(meal) {
  const all = store.get('meals', []);
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  all.push({
    id: uid(), date: todayStr(), time,
    name: meal.name, calories: meal.calories,
    protein: meal.protein || 0, carbs: meal.carbs || 0, fat: meal.fat || 0
  });
  return store.set('meals', all);
}

function renderNutrition() {
  const meals = store.get('meals', []);
  const today = meals.filter(m => m.date === todayStr()).sort((a, b) => a.time.localeCompare(b.time));
  const goal = 2400;
  const totals = macroTotals(today);
  const pct = Math.min(100, Math.round((totals.calories / goal) * 100));
  recentMealCache = recentMeals(meals, 6);

  view.innerHTML = `
    <div class="card">
      <div class="card__title-row"><h2>Today</h2><span class="chip chip--primary">${totals.calories} / ${goal} kcal</span></div>
      <div style="height:8px;border-radius:4px;background:var(--md-surface-variant);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:var(--md-secondary)"></div>
      </div>
      <div class="macro-row"><span>Protein ${totals.protein} g</span><span>Carbs ${totals.carbs} g</span><span>Fat ${totals.fat} g</span></div>
    </div>
    <div class="card">
      <h2>Add a meal</h2>
      ${recentMealCache.length ? `<div class="chip-row">${recentMealCache.map((r, i) =>
        `<button class="chip" onclick="addRecentMeal(${i})">${esc(r.name)} · ${r.calories} kcal</button>`).join('')}</div>` : ''}
      <div class="field"><label>Describe your meal</label><input id="mealSentence" type="text" autocomplete="off" placeholder="e.g. 150 g chicken, rice and broccoli"></div>
      <button class="btn btn--tonal btn--block" id="readMeal"><span class="material-icons-round">auto_awesome</span> Read it</button>
      <div id="mealParse"></div>
      <div class="field"><label>Search foods</label><input id="foodSearch" type="text" autocomplete="off" placeholder="e.g. chicken, oats, banana"></div>
      <div id="foodResults"></div>
      <div id="foodPicked"></div>
      <details class="manual-meal">
        <summary>Not in the list? Type it in yourself</summary>
        <div class="field"><label>What did you eat</label><input id="mealName" type="text" placeholder="e.g. Chicken, rice, broccoli"></div>
        <div class="field"><label>Calories (kcal)</label><input id="mealCal" type="number" min="0" placeholder="e.g. 600"></div>
        <button class="btn btn--filled btn--block" id="addMeal"><span class="material-icons-round">add</span> Add meal</button>
      </details>
    </div>
    <div class="section-title">Logged today</div>
    <div id="mealList">${today.length ? today.map(m => `
      <div class="list-item">
        <div><div>${esc(m.name)}</div><div class="list-item__meta">${esc(m.time)} · P ${m.protein || 0} g · C ${m.carbs || 0} g · F ${m.fat || 0} g</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span>${m.calories} kcal</span>
          <button class="icon-btn" onclick="deleteMeal('${m.id}')"><span class="material-icons-round">delete</span></button>
        </div>
      </div>`).join('') : `<div class="empty">No meals logged today.</div>`}</div>
  `;

  const search = document.getElementById('foodSearch');
  search.addEventListener('input', () => {
    foodPickIndex = null;
    renderFoodResults(search.value);
    renderFoodPick();
  });
  renderFoodResults('');
  renderFoodPick();
  renderMealParse();

  const sentence = document.getElementById('mealSentence');
  document.getElementById('readMeal').addEventListener('click', () => {
    if (!String(sentence.value).trim()) { toast('Type what you ate first'); return; }
    const out = parseMealSentence(sentence.value);
    if (!out.items.length && !out.unmatched.length) { toast('Nothing to read there'); return; }
    mealParse = out;
    renderMealParse();
  });

  document.getElementById('addMeal').addEventListener('click', () => {
    const result = validateMeal(document.getElementById('mealName').value, document.getElementById('mealCal').value);
    if (!result.ok) { toast(result.message); return; }
    if (!saveMeal(result.meal)) return;
    renderNutrition();
  });
}

function renderFoodResults(query) {
  const box = document.getElementById('foodResults');
  if (!box) return;
  const hits = searchFoods(query);
  if (!hits.length) {
    box.innerHTML = String(query || '').trim()
      ? `<div class="list-item__meta">Nothing matched. Type it in yourself below.</div>` : '';
    return;
  }
  box.innerHTML = hits.map(h => `
    <div class="list-item">
      <div><div>${esc(h.food.name)}</div><div class="list-item__meta">${h.food.kcal} kcal ${h.food.unit === 'g' ? 'per 100 g' : 'each'}</div></div>
      <button class="btn btn--tonal" onclick="pickFood(${h.index})">Pick</button>
    </div>`).join('');
}

function renderFoodPick() {
  const box = document.getElementById('foodPicked');
  if (!box) return;
  if (foodPickIndex == null) { box.innerHTML = ''; return; }
  const food = FOODS[foodPickIndex];
  box.innerHTML = `
    <div class="food-pick">
      <div class="card__title-row"><h2>${esc(food.name)}</h2>
        <button class="icon-btn" onclick="clearFoodPick()"><span class="material-icons-round">close</span></button></div>
      <div class="field"><label>${food.unit === 'g' ? 'Amount (g)' : 'How many'}</label>
        <input id="foodAmount" type="number" min="0" step="${food.unit === 'g' ? '10' : '1'}" value="${food.unit === 'g' ? 100 : 1}"></div>
      <div class="list-item__meta" id="foodPreview"></div>
      <button class="btn btn--filled btn--block" id="addPicked"><span class="material-icons-round">add</span> Add to today</button>
    </div>`;

  const amount = document.getElementById('foodAmount');
  const preview = document.getElementById('foodPreview');
  const update = () => {
    const r = portionFrom(food, amount.value);
    preview.textContent = r.ok
      ? `${r.meal.calories} kcal · P ${r.meal.protein} g · C ${r.meal.carbs} g · F ${r.meal.fat} g`
      : r.message;
  };
  amount.addEventListener('input', update);
  update();

  document.getElementById('addPicked').addEventListener('click', () => {
    const r = portionFrom(food, amount.value);
    if (!r.ok) { toast(r.message); return; }
    if (!saveMeal(r.meal)) return;
    foodPickIndex = null;
    renderNutrition();
  });
}

// One row per food the sentence placed, each with the amount showing so it can
// be corrected. A row whose amount is unknown says so and is not addable until
// it is filled -- the alternative is writing a guessed weight into the log as if
// it had been measured.
function renderMealParse() {
  const box = document.getElementById('mealParse');
  if (!box) return;
  if (!mealParse) { box.innerHTML = ''; return; }
  const rows = mealParse.items.map((item, i) => {
    const r = item.amount == null ? null : portionFrom(item.food, item.amount);
    const meta = r && r.ok
      ? `${r.meal.calories} kcal \u00b7 P ${r.meal.protein} g \u00b7 C ${r.meal.carbs} g \u00b7 F ${r.meal.fat} g${item.assumed ? ' \u00b7 assumed 1' : ''}`
      : (r ? r.message : 'needs an amount');
    return `
      <div class="list-item">
        <div><div>${esc(item.food.name)}</div><div class="list-item__meta" id="parseMeta${i}">${esc(meta)}</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" min="0" style="width:88px" value="${item.amount == null ? '' : item.amount}" placeholder="${item.unit === 'g' ? 'grams' : 'how many'}" oninput="setParsedAmount(${i}, this.value)">
          <button class="icon-btn" onclick="dropParsedItem(${i})"><span class="material-icons-round">close</span></button>
        </div>
      </div>`;
  }).join('');
  const missed = mealParse.unmatched.length
    ? `<div class="list-item__meta">Not in the food table: ${esc(mealParse.unmatched.join(', '))}. Type those in yourself below.</div>`
    : '';
  const ready = mealParse.items.filter((i) => i.amount != null).length;
  const button = mealParse.items.length
    ? `<button class="btn btn--filled btn--block" onclick="addParsedMeals()"><span class="material-icons-round">add</span> Add ${ready} of ${mealParse.items.length}</button>`
    : '';
  box.innerHTML = rows + missed + button;
}

function setParsedAmount(index, value) {
  const item = mealParse && mealParse.items[index];
  if (!item) return;
  const raw = String(value == null ? '' : value).trim();
  item.amount = raw === '' ? null : Number(raw);
  item.assumed = false;
  const label = document.getElementById('parseMeta' + index);
  if (!label) return;
  const r = item.amount == null ? null : portionFrom(item.food, item.amount);
  label.textContent = r && r.ok
    ? `${r.meal.calories} kcal \u00b7 P ${r.meal.protein} g \u00b7 C ${r.meal.carbs} g \u00b7 F ${r.meal.fat} g`
    : (r ? r.message : 'needs an amount');
}

function dropParsedItem(index) {
  if (!mealParse) return;
  mealParse.items.splice(index, 1);
  if (!mealParse.items.length && !mealParse.unmatched.length) mealParse = null;
  renderMealParse();
}

// Only the rows that carry an amount are written. The ones still asking for one
// stay on screen rather than going in at a number nobody typed.
function addParsedMeals() {
  if (!mealParse) return;
  const ready = mealParse.items.filter((item) => item.amount != null);
  if (!ready.length) { toast('Fill in an amount first'); return; }
  let added = 0;
  ready.forEach((item) => {
    const r = portionFrom(item.food, item.amount);
    if (r.ok && saveMeal(r.meal)) added += 1;
  });
  // A box holding something that is not a number leaves `added` at zero with
  // every row still looking ready, so say so rather than doing nothing quietly.
  if (!added) { toast('Check the amounts'); return; }
  mealParse.items = mealParse.items.filter((item) => item.amount == null);
  if (!mealParse.items.length && !mealParse.unmatched.length) mealParse = null;
  toast(added === 1 ? 'Added 1 meal' : `Added ${added} meals`);
  renderNutrition();
}

function pickFood(index) { foodPickIndex = index; renderFoodPick(); }
function clearFoodPick() { foodPickIndex = null; renderFoodPick(); }

function addRecentMeal(index) {
  const meal = recentMealCache[index];
  if (!meal) return;
  if (!saveMeal(meal)) return;
  renderNutrition();
}

function deleteMeal(id) {
  store.set('meals', store.get('meals', []).filter(m => m.id !== id));
  renderNutrition();
}

// ---------- progress ----------
// Kilograms lifted in one session. This was about to be written out a third
// time, and the two copies that already existed had drifted: dailyLoads guarded
// an exercise row with no `sets` array and weeklyVolumes did not, so the same
// malformed row counted zero on the Progress chart and threw on the volume
// chart. One definition, three callers.
function sessionVolume(session) {
  return ((session && session.exercises) || []).reduce(
    (sum, e) => sum + ((e && e.sets) || []).reduce((ss, st) => ss + st.reps * st.weight, 0), 0);
}

function weeklyVolumes() {
  const sessions = store.get('sessions', []);
  const buckets = {};
  sessions.forEach(s => {
    const d = new Date(s.date + 'T00:00');
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = fmtDate(monday);
    buckets[key] = (buckets[key] || 0) + sessionVolume(s);
  });
  return Object.entries(buckets).sort(([a],[b]) => a.localeCompare(b));
}

// ---------- training load: fitness, fatigue, form (idea #194) ----------
// TrainingPeaks' CTL/ATL shape, computed on the one load signal Marcus
// actually holds: kilograms lifted per day. Two exponentially weighted
// averages over the same daily series -- 42 days for fitness, 7 for fatigue.
//
// The verdict is the ACUTE:CHRONIC RATIO (fatigue / fitness), deliberately not
// the TSB subtraction the same methodology usually reports. TSB's published
// bands (+25 fresh, -30 overreached) are in TSS units and say nothing about
// kilograms; a ratio is unit-free, so it survives the fact that this app
// measures load in a unit that research was not written in.
const LOAD_FITNESS_DAYS = 42;
const LOAD_FATIGUE_DAYS = 7;
// Below this much history the two averages have not separated yet -- one
// session on day one gives a ratio of 5.6 and a "load spike" chip nobody has
// earned. Say "too early" instead of inventing an alarm.
const LOAD_MIN_DAYS = 28;

// Day keys are done in UTC on purpose. `fmtDate` runs a local Date through
// toISOString, which in any zone east of Greenwich moves midnight back a day.
const dayKey = (iso) => new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10);
const shiftDay = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

function dailyLoads(sessions) {
  const byDay = {};
  (sessions || []).forEach(s => {
    if (!s || !s.date) return;
    const k = dayKey(s.date);
    byDay[k] = (byDay[k] || 0) + sessionVolume(s);
  });
  return byDay;
}

// Walks every calendar day from the first logged session to today, so a rest
// day contributes a real zero rather than being skipped. Skipping rest days is
// what turns "trained once a week" into "trained every day" in the average.
function trainingLoad(sessions, todayISO) {
  const today = dayKey(todayISO || todayStr());
  const byDay = dailyLoads(sessions);
  const days = Object.keys(byDay).sort();
  if (!days.length) {
    return { fitness: 0, fatigue: 0, ratio: 0, days: 0, trend: 'none', verdict: 'nothing logged' };
  }

  const fitAlpha = 1 - Math.exp(-1 / LOAD_FITNESS_DAYS);
  const fatAlpha = 1 - Math.exp(-1 / LOAD_FATIGUE_DAYS);
  const span = Math.max(0, Math.round((new Date(today + 'T00:00:00Z') - new Date(days[0] + 'T00:00:00Z')) / 86400000));
  let fitness = 0, fatigue = 0;
  let fitnessWeekAgo = null;
  let cursor = days[0];
  for (let i = 0; i <= span; i++) {
    const load = byDay[cursor] || 0;
    fitness += (load - fitness) * fitAlpha;
    fatigue += (load - fatigue) * fatAlpha;
    if (i === span - 7) fitnessWeekAgo = fitness;
    cursor = shiftDay(cursor, 1);
  }

  const ratio = fitness > 0 ? fatigue / fitness : 0;
  const covered = span + 1;
  let trend = 'none';
  if (fitnessWeekAgo !== null) {
    const delta = fitness - fitnessWeekAgo;
    trend = Math.abs(delta) < fitness * 0.02 ? 'flat' : (delta > 0 ? 'rising' : 'falling');
  }

  return { fitness, fatigue, ratio, days: covered, trend, verdict: loadVerdict(ratio, covered) };
}

// The band edges are the acute:chronic ratio literature's, not mine: under 0.8
// is detraining, 0.8-1.3 is the range that builds fitness without an injury
// cost, and above 1.5 is where injury rates climb sharply. They are the
// product decision in this whole card, so they live in one named function
// rather than inline in the arithmetic.
function loadVerdict(ratio, coveredDays) {
  if (coveredDays < LOAD_MIN_DAYS) return 'too early';
  if (ratio < 0.8) return 'backing off';
  if (ratio <= 1.3) return 'building';
  if (ratio <= 1.5) return 'overreaching';
  return 'load spike';
}

function loadVerdictLabel(load) {
  if (load.verdict === 'nothing logged') return 'no sessions logged';
  if (load.verdict === 'too early') return 'too early to judge';
  if (load.verdict === 'load spike') return 'load spike — ease off';
  return load.verdict;
}

// ---------- adaptive plan revision (idea #208) ----------
// After a week of logging, Marcus proposes changes to the written plan and
// says why in the same sentence. Every reason here is arithmetic on data the
// app already holds -- the acute:chronic ratio from the card above, and which
// weekdays sessions actually landed on. There is deliberately NO training
// science cited and no coaching prose: Edvard asked for recent Norwegian
// endurance research to back a proposal, and a citation this app invents
// without a model behind it is worse than no citation. That half is idea #206.
const REVIEW_WINDOW_DAYS = 28;
const REVIEW_MIN_WEEKS = 2;      // one week is a holiday, not a pattern
const DELOAD_SET_FLOOR = 2;      // a deload that leaves one set is not a session

function weekdayOf(iso) { return DAY_NAMES[new Date(iso + 'T00:00:00Z').getUTCDay()]; }

function planTrainingDays(plan) {
  return (plan && plan.days || []).filter(d => (d.exercises || []).length > 0);
}

// Whole weeks of history inside the window -- the denominator for "you were
// meant to train Thursday four times and did it none".
function reviewWeeks(sessions, todayISO, windowDays) {
  const today = dayKey(todayISO || todayStr());
  const first = shiftDay(today, -(windowDays - 1));
  const dates = (sessions || []).map(s => s.date).filter(d => d >= first && d <= today).sort();
  if (!dates.length) return 0;
  const span = Math.round((new Date(today + 'T00:00:00Z') - new Date(dates[0] + 'T00:00:00Z')) / 86400000) + 1;
  return Math.floor(Math.min(span, windowDays) / 7);
}

// One row per weekday: how many sessions landed on it inside the window, and
// whether the written plan says anything is meant to happen there.
function adherenceByWeekday(plan, sessions, todayISO, windowDays) {
  const today = dayKey(todayISO || todayStr());
  const first = shiftDay(today, -((windowDays || REVIEW_WINDOW_DAYS) - 1));
  const logged = {};
  DAY_NAMES.forEach(name => { logged[name] = 0; });
  (sessions || []).forEach(s => {
    if (!s || !s.date || s.date < first || s.date > today) return;
    logged[weekdayOf(s.date)] += 1;
  });
  return (plan && plan.days || []).map(d => ({
    day: d.day,
    planned: (d.exercises || []).length > 0,
    logged: logged[d.day] || 0,
  }));
}

// The chip has to read on its own -- a one-word kind like 'rest' tells a
// reader nothing unless they already know the four kinds.
const PROPOSAL_CHIPS = { deload: 'ease off', build: 'add volume', move: 'move a day', rest: 'drop a day' };
function proposalChip(kind) { return PROPOSAL_CHIPS[kind] || kind; }

function totalSets(day) {
  return (day.exercises || []).reduce((sum, e) => sum + (e.sets || 0), 0);
}

// Proposals, most urgent first. Each one carries the number that produced it,
// because a change with no measurement behind it is just an opinion.
function planReview(plan, sessions, todayISO, windowDays) {
  const windowSize = windowDays || REVIEW_WINDOW_DAYS;
  const weeks = reviewWeeks(sessions, todayISO, windowSize);
  if (weeks < REVIEW_MIN_WEEKS) {
    return { weeks, proposals: [], note: 'Marcus reviews the plan once you have ' + REVIEW_MIN_WEEKS + ' weeks of sessions logged. ' + weeks + ' so far.' };
  }

  const load = trainingLoad(sessions || [], todayISO);
  const rows = adherenceByWeekday(plan, sessions, todayISO, windowSize);
  const training = planTrainingDays(plan);
  const proposals = [];

  if (load.verdict === 'load spike' || load.verdict === 'overreaching') {
    const cuttable = training.filter(d => (d.exercises || []).some(e => (e.sets || 0) > DELOAD_SET_FLOOR));
    if (cuttable.length) {
      proposals.push({
        id: 'deload',
        kind: 'deload',
        title: 'Take a set off every exercise this week',
        reason: 'Your fatigue is ' + load.ratio.toFixed(2) + ' times your fitness over the last ' + load.days + ' days. Above 1.5 is the range injuries cluster in. This drops one set from each exercise on ' + cuttable.length + ' day(s), never below ' + DELOAD_SET_FLOOR + '.',
      });
    }
  }

  const skipped = rows.filter(r => r.planned && r.logged === 0);
  const usedRest = rows.filter(r => !r.planned && r.logged > 0).sort((a, b) => b.logged - a.logged);
  skipped.forEach((row, i) => {
    const to = usedRest[i];
    if (to) {
      proposals.push({
        id: 'move-' + row.day,
        kind: 'move',
        day: row.day,
        toDay: to.day,
        title: 'Move ' + row.day + '’s work to ' + to.day,
        reason: 'Over the last ' + weeks + ' weeks you trained on ' + row.day + ' 0 times and on ' + to.day + ' ' + to.logged + ' times, and the plan calls ' + to.day + ' a rest day. The plan is describing a week you are not having.',
      });
    } else {
      proposals.push({
        id: 'rest-' + row.day,
        kind: 'rest',
        day: row.day,
        title: 'Make ' + row.day + ' a rest day',
        reason: 'Over the last ' + weeks + ' weeks you trained on ' + row.day + ' 0 times. A plan you never keep is not a plan you are behind on.',
      });
    }
  });

  if (!proposals.length && load.verdict === 'backing off') {
    const lightest = training.slice().sort((a, b) => totalSets(a) - totalSets(b))[0];
    if (lightest) {
      proposals.push({
        id: 'build',
        kind: 'build',
        day: lightest.day,
        title: 'Add a set to each exercise on ' + lightest.day,
        reason: 'Your fatigue is ' + load.ratio.toFixed(2) + ' times your fitness, below the 0.8 where training stops building, and you kept every planned day over the last ' + weeks + ' weeks. ' + lightest.day + ' is your lightest at ' + totalSets(lightest) + ' sets.',
      });
    }
  }

  return { weeks, proposals, note: proposals.length ? '' : 'Nothing to change. You are keeping the plan and your load is in the range that builds fitness.' };
}

// Pure: takes a plan, returns a new one. Nothing here writes to storage, so a
// proposal can be rendered, previewed and tested without a DOM.
function applyProposal(plan, proposal) {
  const next = JSON.parse(JSON.stringify(plan));
  if (!proposal) return next;
  if (proposal.kind === 'deload') {
    next.days.forEach(d => (d.exercises || []).forEach(e => {
      if ((e.sets || 0) > DELOAD_SET_FLOOR) e.sets = e.sets - 1;
    }));
  } else if (proposal.kind === 'build') {
    const day = next.days.find(d => d.day === proposal.day);
    if (day) (day.exercises || []).forEach(e => { e.sets = (e.sets || 0) + 1; });
  } else if (proposal.kind === 'move') {
    const from = next.days.find(d => d.day === proposal.day);
    const to = next.days.find(d => d.day === proposal.toDay);
    if (from && to) {
      to.focus = from.focus;
      to.exercises = from.exercises;
      from.focus = 'Rest';
      from.exercises = [];
    }
  } else if (proposal.kind === 'rest') {
    const day = next.days.find(d => d.day === proposal.day);
    if (day) { day.focus = 'Rest'; day.exercises = []; }
  }
  return next;
}

// ---------- this week, sized from the goal's phase (idea #209) ----------
// The goal already cuts the window into phases with dates on them, and the plan
// already says which days are training days. What was missing is the step
// between them: what THIS week is supposed to look like.
//
// The multipliers below are not research and Marcus does not pretend they are.
// They are the phase notes in GOAL_PHASES read as arithmetic -- Base says
// "volume over intensity" so it grows, Build says "the volume holds" so it
// holds, Peak sharpens so it trims, Taper says "cut volume" so it cuts. What
// makes the kilogram number mean anything is the other half: it is a multiple
// of YOUR OWN recent weekly average, never a number this app invented.
const PHASE_VOLUME = { Base: 1.10, Build: 1.00, Peak: 0.90, Taper: 0.60 };
const WEEK_BASELINE_WEEKS = 4;
// Below this, the average is one week wearing a plural. Say so instead.
const WEEK_MIN_BASELINE_WEEKS = 2;

// Monday of the week containing `iso`, in UTC, same as dayKey/shiftDay.
function weekStartOf(iso) {
  const k = dayKey(iso);
  return shiftDay(k, -((new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7));
}

// The phase you are in by the calendar -- the first one whose date has not
// passed. Deliberately not "the first one not ticked": an untidied tickbox
// from six weeks ago should not decide what this week does.
function currentPhase(goal, todayISO) {
  const today = dayKey(todayISO || todayStr());
  return ((goal && goal.milestones) || []).find(m => m && m.date >= today) || null;
}

function weekTarget(goal, plan, sessions, todayISO) {
  const today = dayKey(todayISO || todayStr());
  const start = weekStartOf(today);
  const list = sessions || [];
  const inWeek = list.filter(s => s && s.date && dayKey(s.date) >= start && dayKey(s.date) <= today);
  // A cardio session counts toward the session count and contributes zero
  // kilograms, which is the same boundary the load model draws.
  const base = {
    phase: null, phaseEnds: null, multiplier: null, baseline: null, baselineWeeks: 0,
    volumeTarget: null,
    volumeDone: inWeek.reduce((sum, s) => sum + sessionVolume(s), 0),
    sessionsPlanned: planTrainingDays(plan).length,
    sessionsDone: inWeek.length,
  };

  const phase = currentPhase(goal, today);
  if (!phase) {
    return Object.assign(base, {
      reason: goal ? 'phases done' : 'no goal',
      note: goal ? 'Every phase date has passed — the target day is the only thing left.'
                 : 'No goal yet, so there is no phase to size the week from.',
    });
  }
  const multiplier = PHASE_VOLUME[phase.label];
  Object.assign(base, { phase: phase.label, phaseEnds: phase.date, multiplier: multiplier == null ? null : multiplier });

  const dates = list.map(s => (s && s.date) ? dayKey(s.date) : null).filter(Boolean).sort();
  const firstWeek = dates.length ? weekStartOf(dates[0]) : null;
  const byWeek = {};
  list.forEach(s => {
    if (!s || !s.date) return;
    byWeek[weekStartOf(s.date)] = (byWeek[weekStartOf(s.date)] || 0) + sessionVolume(s);
  });
  // Completed calendar weeks, including ones with nothing in them -- a week off
  // is part of the average, and dropping it is how "trains every other week"
  // turns into "trains every week". Weeks before the first session ever logged
  // are not history, so they are left out rather than counted as zeros.
  const covered = [];
  for (let i = 1; i <= WEEK_BASELINE_WEEKS; i++) {
    const k = shiftDay(start, -7 * i);
    if (firstWeek && k >= firstWeek) covered.push(k);
  }
  base.baselineWeeks = covered.length;
  if (multiplier == null) {
    return Object.assign(base, { reason: 'unknown phase',
      note: 'Marcus has no volume rule for a ' + phase.label + ' phase, so this week carries the session count only.' });
  }
  if (covered.length < WEEK_MIN_BASELINE_WEEKS) {
    return Object.assign(base, { reason: 'too early',
      note: 'Marcus sets a kilogram target once ' + WEEK_MIN_BASELINE_WEEKS
            + ' full weeks are logged. ' + covered.length + ' so far.' });
  }
  const baseline = Math.round(covered.reduce((sum, k) => sum + (byWeek[k] || 0), 0) / covered.length);
  return Object.assign(base, {
    reason: 'ok', baseline, volumeTarget: Math.round(baseline * multiplier),
    note: null,
  });
}

// One plain sentence, so the card is not a row of numbers a reader has to know
// the rule to decode.
function weekTargetLabel(week) {
  if (!week) return '';
  if (week.note) return week.note;
  const pct = Math.round(Math.abs(week.multiplier - 1) * 100);
  const direction = week.multiplier > 1 ? pct + '% above' : week.multiplier < 1 ? pct + '% below' : 'level with';
  // Always plural: a baseline under WEEK_MIN_BASELINE_WEEKS never reaches here.
  return week.phase + ' phase through ' + niceDate(week.phaseEnds) + ' — your last '
    + week.baselineWeeks + ' weeks averaged ' + week.baseline + ' kg, so this week aims '
    + direction + ' that.';
}

function trainingLoadCard(load) {
  const alert = load.verdict === 'load spike' || load.verdict === 'overreaching';
  const kg = (n) => Math.round(n).toLocaleString() + ' kg/day';
  const trendWord = load.trend === 'rising' ? 'rising' : load.trend === 'falling' ? 'falling'
                  : load.trend === 'flat' ? 'holding' : 'not enough history';
  return `
    <div class="card">
      <div class="card__title-row"><h2>Training load</h2><span class="chip ${alert ? 'chip--alert' : 'chip--primary'}">${esc(loadVerdictLabel(load))}</span></div>
      <div class="exercise-line"><span>Fitness — 42-day average</span><span>${kg(load.fitness)}</span></div>
      <div class="exercise-line"><span>Fatigue — 7-day average</span><span>${kg(load.fatigue)}</span></div>
      <div class="exercise-line"><span>Fatigue vs fitness</span><span>${load.ratio.toFixed(2)}</span></div>
      <div class="exercise-line"><span>Fitness over the last week</span><span>${trendWord}</span></div>
      <p class="card__note">Fitness is what you have built up; fatigue is what you are carrying right now. Between 0.8 and 1.3 you are training hard enough to improve without digging a hole. Above 1.5 is the range injuries cluster in.</p>
    </div>`;
}

// Goals go at the top of Progress because the graphs below are supposed to
// serve them. Drawn in plain CSS, not Chart.js: the library is loaded async so
// a stalled CDN can leave it absent, and the one thing on this tab that
// answers "am I on track" should not be the thing that disappears.
function goalProgressCard(goal, todayISO) {
  const p = goalProgress(goal, todayISO);
  const left = p.daysLeft < 0 ? 'target date passed'
             : p.daysLeft === 0 ? 'target day is today'
             : p.daysLeft === 1 ? '1 day left'
             : p.daysLeft + ' days left';
  return `
    <div class="card">
      <div class="card__title-row"><h2>${esc(goal.text)}</h2><span class="chip ${p.verdict === 'behind' ? 'chip--alert' : 'chip--primary'}">${esc(goalVerdictLabel(p))}</span></div>
      <div class="meter-row"><span>Time gone</span><span>${p.elapsedPct}%</span></div>
      <div class="meter"><div class="meter__fill meter__fill--time" style="width:${p.elapsedPct}%"></div></div>
      <div class="meter-row"><span>Phases ticked</span><span>${p.total ? p.doneCount + ' of ' + p.total : 'none set'}</span></div>
      <div class="meter"><div class="meter__fill" style="width:${p.donePct}%"></div></div>
      <div class="exercise-line"><span>Target ${niceDate(goal.targetDate)}</span><span>${esc(left)}</span></div>
    </div>`;
}

function renderProgress() {
  const weights = store.get('weights', []);
  const meals = store.get('meals', []);
  const calByDay = {};
  meals.forEach(m => { calByDay[m.date] = (calByDay[m.date] || 0) + m.calories; });
  const calEntries = Object.entries(calByDay).sort(([a],[b]) => a.localeCompare(b));
  const vols = weeklyVolumes();

  const goals = goalsSorted();

  view.innerHTML = `
    ${goals.length ? `<div class="section-title">Goal progress</div>` + goals.map(g => goalProgressCard(g)).join('') : ''}
    <div class="section-title">Where you stand</div>
    ${trainingLoadCard(trainingLoad(store.get('sessions', [])))}
    <div class="card">
      <h2>Bodyweight</h2>
      <div class="field" style="margin-top:10px"><label>Log today's weight (kg)</label>
        <div style="display:flex;gap:8px">
          <input id="weightInput" type="number" step="0.1" placeholder="e.g. 83.4">
          <button class="btn btn--filled" id="addWeight">Save</button>
        </div>
      </div>
      <div class="chart-wrap"><canvas id="weightChart"></canvas></div>
    </div>
    <div class="card">
      <h2>Weekly training volume (kg lifted)</h2>
      <div class="chart-wrap"><canvas id="volumeChart"></canvas></div>
    </div>
    <div class="card">
      <h2>Daily calories</h2>
      <div class="chart-wrap"><canvas id="calChart"></canvas></div>
    </div>
    <div class="section-title">Your data</div>
    <div class="card">
      <h2>Backup</h2>
      <p class="card__note">Marcus keeps a copy on the server as well as in this browser, and a file you save yourself is the third. Clearing site data or changing phone loses the browser copy only.</p>
      <div id="serverCopy" class="card__note" style="margin-bottom:10px"></div>
      <button class="btn btn--filled btn--block" id="exportData"><span class="material-icons-round">download</span> Save a backup file</button>
      <input id="importFile" type="file" accept="application/json,.json" hidden>
      <button class="btn btn--tonal btn--block" id="importData" style="margin-top:10px"><span class="material-icons-round">upload</span> Restore from a file</button>
      <button class="btn btn--tonal btn--block" id="loadServerCopy" style="margin-top:10px"><span class="material-icons-round">cloud_download</span> Load the server copy</button>
      <div id="restorePreview"></div>
    </div>
  `;

  document.getElementById('addWeight').addEventListener('click', () => {
    const result = validateBodyweight(document.getElementById('weightInput').value);
    if (!result.ok) { toast(result.message); return; }
    const all = store.get('weights', []);
    all.push({ date: todayStr(), kg: result.kg });
    if (!store.set('weights', all)) return;
    renderProgress();
  });

  wireBackup();

  // Chart.js is loaded async so a stalled CDN can never hold the app, which
  // means it may genuinely not be here yet. Everything above this line works
  // without it -- logging a weight is the useful half of this tab -- so draw
  // that, say so where the graphs go, and redraw once the library arrives.
  if (typeof Chart === 'undefined') {
    view.querySelectorAll('.chart-wrap').forEach(el => {
      el.innerHTML = '<div class="empty">Graphs are still loading.</div>';
    });
    window.addEventListener('chartjs-ready', () => {
      if (currentTab === 'progress') renderProgress();
    }, { once: true });
    return;
  }

  const axisColor = getComputedStyle(document.body).getPropertyValue('--md-on-surface-variant').trim();
  const gridColor = 'rgba(128,128,128,.15)';
  const common = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { x: { ticks: { color: axisColor, font: { size: 10 } }, grid: { display: false } },
              y: { ticks: { color: axisColor, font: { size: 10 } }, grid: { color: gridColor } } } };

  charts.weight = new Chart(document.getElementById('weightChart'), {
    type: 'line',
    data: { labels: weights.map(w => niceDate(w.date)), datasets: [{ data: weights.map(w => w.kg), borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,.15)', tension: .3, fill: true, pointRadius: 2 }] },
    options: common
  });
  charts.volume = new Chart(document.getElementById('volumeChart'), {
    type: 'bar',
    data: { labels: vols.map(([k]) => niceDate(k)), datasets: [{ data: vols.map(([,v]) => Math.round(v)), backgroundColor: '#FB8C00', borderRadius: 6 }] },
    options: common
  });
  charts.cal = new Chart(document.getElementById('calChart'), {
    type: 'line',
    data: { labels: calEntries.map(([d]) => niceDate(d)), datasets: [{ data: calEntries.map(([,v]) => v), borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,.15)', tension: .3, fill: true, pointRadius: 2 }] },
    options: common
  });
}

// ---------- backup: export and restore ----------
// Everything Marcus knows lives in this browser's localStorage and nowhere
// else, so clearing site data, switching phone or reinstalling loses all of
// it. Idea #198 asks for a nightly export of Marcus's database to a repo; there
// is no database and no server yet (issue #153), so this is the half that can
// exist today -- a file the user holds -- and it is deliberately the same
// shape the server-side job would write, so the later one can read these.
const BACKUP_VERSION = 1;
// Every store key the app writes. `chat` is in here because the coach's memory
// of the conversation is data the user would miss, not chrome.
const BACKUP_KEYS = ['plan', 'sessions', 'weights', 'meals', 'goals', 'chat'];

function buildBackup(nowISO) {
  const data = {};
  BACKUP_KEYS.forEach(k => {
    const v = store.get(k, null);
    if (v !== null && v !== undefined) data[k] = v;
  });
  return { app: 'marcus', version: BACKUP_VERSION, exportedAt: nowISO || new Date().toISOString(), data };
}

function backupFilename(nowISO) {
  return 'marcus-backup-' + String(nowISO || new Date().toISOString()).slice(0, 10) + '.json';
}

// Counts what a restore would actually put back, so the confirm step can say
// it out loud. A key holding an array counts its entries; `plan` is a single
// object, so it counts as one thing.
function backupSummary(data) {
  return BACKUP_KEYS.filter(k => k in data).map(k => ({
    key: k,
    count: Array.isArray(data[k]) ? data[k].length : 1,
  }));
}

// Refuses rather than guesses. A file that is not ours, or is from a newer
// Marcus than this one, would be restored as garbage that silently replaces
// real training history -- so the only accepted outcome is a payload this
// version knows how to write back.
function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, message: 'That file is not valid JSON.' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'That file does not look like a Marcus backup.' };
  if (raw.app !== 'marcus') return { ok: false, message: 'That file does not look like a Marcus backup.' };
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) return { ok: false, message: 'That backup has no version, so it cannot be read safely.' };
  if (raw.version > BACKUP_VERSION) return { ok: false, message: 'That backup was written by a newer Marcus (version ' + raw.version + '). Update the app first.' };
  const src = raw.data;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { ok: false, message: 'That backup has no data in it.' };
  const data = {};
  BACKUP_KEYS.forEach(k => {
    if (!(k in src)) return;
    const v = src[k];
    if (v === null || v === undefined) return;
    if (k === 'plan' ? typeof v !== 'object' || Array.isArray(v) : !Array.isArray(v)) return;
    data[k] = v;
  });
  if (Object.keys(data).length === 0) return { ok: false, message: 'That backup has no data in it.' };
  return { ok: true, version: raw.version, exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null, data };
}

// A restore replaces, it does not merge -- two copies of the same session
// merged by id is a guess about which one is right, and the user asked for the
// file they picked. Keys the file does not carry are left alone.
function restoreBackup(parsed) {
  const restored = [];
  const failed = [];
  Object.keys(parsed.data).forEach(k => {
    if (store.set(k, parsed.data[k])) restored.push(k); else failed.push(k);
  });
  return { restored, failed };
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
  wireServerCopy();
}

// Every write to a store key the backup carries pushes the whole copy up, once
// the typing has stopped. Set here rather than at the top because `BACKUP_KEYS`
// and `buildBackup` are defined further down this file.
onStoreWrite = scheduleServerSync;

// ---------- the server copy ----------
// Issue #153: until now the only copy of everything lived in one browser. The
// server keeps one too, on the volume the pod mounts, in exactly the envelope
// `buildBackup` writes -- so the file you save yourself and the copy on the
// server are the same shape, and either can be read by the other.
//
// Deliberate boundary, and this is the whole of it: **this browser pushes, it
// never silently pulls.** Adopting a server copy replaces every logged session
// in this browser, and doing that automatically on boot means one bug deletes a
// training history. Loading the server copy is a button, next to the file
// restore, and it goes through the same confirm-against-a-count step.
const SYNC_REV_KEY = 'syncRev';
const SYNC_DEBOUNCE_MS = 1500;

// What this browser thinks the server is at. It starts at 0, which is also what
// an untouched server answers, so a first push from a fresh browser succeeds.
const syncRev = () => { const v = store.get(SYNC_REV_KEY, 0); return typeof v === 'number' && Number.isFinite(v) ? v : 0; };

// One line the user can read: the app cannot promise a copy exists, so it says
// which of the three states it is actually in rather than a green tick.
function describeServerCopy(status) {
  if (!status || status.state === 'unknown') return 'Server copy: checking...';
  if (status.state === 'unreachable') return 'Server copy: not reachable right now. This browser still has everything.';
  if (status.state === 'empty') return 'Server copy: nothing saved there yet.';
  if (status.state === 'ahead') return 'Server copy: there is one on the server that this browser has never seen. Load it before this browser starts saving over it.';
  const when = status.updatedAt ? new Date(status.updatedAt) : null;
  const stamp = when && !isNaN(when.getTime()) ? when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time';
  return 'Server copy: last saved ' + stamp + '.';
}

// The server stores the backup `data` object and nothing else, so wrapping it
// back into an envelope is what lets `parseBackup` judge it -- one validator for
// a file and for the server, rather than two that drift.
function serverStateToBackup(state) {
  if (!state || !state.data || typeof state.data !== 'object' || Array.isArray(state.data)) return null;
  return { app: 'marcus', version: BACKUP_VERSION, exportedAt: state.updatedAt || null, data: state.data };
}

// Push, with exactly one retry, and the retry is the interesting part: a 409
// means another browser wrote after this one last looked. This browser's copy
// is then written on top, which is last-write-wins for the *server* copy only --
// the other browser still holds its own. That is a backup, not a merge, and
// calling it a merge would be the lie.
async function pushServerCopy(fetchFn, payloadData, rev) {
  const put = (r) => fetchFn('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rev: r, data: payloadData }),
  });
  let res = await put(rev);
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const serverRev = body && body.state && typeof body.state.rev === 'number' ? body.state.rev : null;
    if (serverRev === null) return { ok: false, reason: 'conflict' };
    res = await put(serverRev);
  }
  if (!res.ok) return { ok: false, reason: 'refused', status: res.status };
  const saved = await res.json().catch(() => null);
  if (!saved || typeof saved.rev !== 'number') return { ok: false, reason: 'refused' };
  return { ok: true, rev: saved.rev, updatedAt: saved.updatedAt };
}

// The one case where pushing loses data that nothing else holds: a browser
// that has never synced (rev 0) meets a server that already has a copy. That
// browser has just seeded itself with an empty plan, so pushing would write
// blank seed data over a real training history. It refuses and says so; the
// "Load the server copy" button is the way out.
function shouldPush(localRev, serverRev) {
  return !(localRev === 0 && serverRev > 0);
}

let serverStatus = { state: 'unknown' };
let syncTimer = null;

function renderServerCopy() {
  const host = document.getElementById('serverCopy');
  if (host) host.textContent = describeServerCopy(serverStatus);
}

async function syncNow() {
  if (typeof fetch !== 'function') return;
  if (syncRev() === 0) {
    const existing = await readServerCopy();
    if (existing && !shouldPush(0, existing.rev)) {
      serverStatus = { state: 'ahead', updatedAt: existing.updatedAt };
      renderServerCopy();
      return;
    }
  }
  const payload = buildBackup();
  const result = await pushServerCopy(fetch, payload.data, syncRev()).catch(() => ({ ok: false, reason: 'unreachable' }));
  if (result.ok) {
    store.set(SYNC_REV_KEY, result.rev);
    serverStatus = { state: 'saved', updatedAt: result.updatedAt };
  } else if (result.reason === 'unreachable') {
    serverStatus = { state: 'unreachable' };
  } else {
    serverStatus = { state: 'unreachable' };
  }
  renderServerCopy();
}

function scheduleServerSync(key) {
  // `syncRev` is not in BACKUP_KEYS, so writing it does not re-enter here.
  if (!BACKUP_KEYS.includes(key)) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);
}

async function readServerCopy() {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch('/api/state');
    if (!res.ok) { serverStatus = { state: 'unreachable' }; return null; }
    const state = await res.json();
    serverStatus = state && state.rev > 0 ? { state: 'saved', updatedAt: state.updatedAt } : { state: 'empty' };
    return state;
  } catch {
    serverStatus = { state: 'unreachable' };
    return null;
  }
}

function wireServerCopy() {
  renderServerCopy();
  readServerCopy().then(() => renderServerCopy());
  document.getElementById('loadServerCopy')?.addEventListener('click', async () => {
    const state = await readServerCopy();
    renderServerCopy();
    const envelope = serverStateToBackup(state);
    if (!envelope) { toast('There is nothing saved on the server to load.'); return; }
    const parsed = parseBackup(JSON.stringify(envelope));
    if (!parsed.ok) { toast(parsed.message); return; }
    pendingRestore = parsed;
    renderRestorePreview();
  });
}

// ---------- chat ----------
const chatSheet = document.getElementById('chatSheet');
const chatMessages = document.getElementById('chatMessages');
const chatStatus = document.getElementById('chatStatus');

function renderChatMessages() {
  const msgs = store.get('chat', []);
  chatMessages.innerHTML = msgs.map(m => `<div class="msg msg--${m.role === 'marcus' ? 'marcus' : 'user'}">${esc(m.text)}</div>`).join('');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function openChat() {
  chatSheet.hidden = false;
  renderChatMessages();
  document.getElementById('chatInput').focus();
}
function closeChat() { chatSheet.hidden = true; }
document.getElementById('chatFab').addEventListener('click', openChat);
document.getElementById('chatClose').addEventListener('click', closeChat);
document.querySelector('.chat-sheet__scrim').addEventListener('click', closeChat);

function marcusReply(text) {
  const t = text.toLowerCase();
  const sessions = store.get('sessions', []);
  const plan = store.get('plan');
  const weights = store.get('weights', []);
  const meals = store.get('meals', []).filter(m => m.date === todayStr());
  const todayName = planDayName();
  const todayPlan = plan.days.find(d => d.day === todayName);

  if (/plan|today.*(do|training)|workout/.test(t)) {
    if (!todayPlan.exercises.length) return `${todayName} is a rest day on your plan — recover well, I'll see you next session.`;
    return `Today's ${todayPlan.focus} day: ${todayPlan.exercises.map(e => `${e.name} ${e.sets}×${e.reps}`).join(', ')}. Let's get it.`;
  }
  if (/progress|how.*doing|going well|on track/.test(t)) {
    const w = weights.length > 1 ? (weights[weights.length-1].kg - weights[0].kg).toFixed(1) : null;
    const vol = weeklyVolumes();
    const lastVol = vol.length ? Math.round(vol[vol.length-1][1]) : 0;
    return `You're trending well — ${w ? `bodyweight moved ${w}kg over your logged history, ` : ''}and you put up ${lastVol.toLocaleString()}kg of volume this week. Keep stacking sessions.`;
  }
  if (/sore|tired|pain|hurt|exhaust/.test(t)) {
    return `Listen to that. A short easy day or extra sleep beats grinding through soreness — swap in mobility work if today's lift feels rough, and tell me if it's a specific joint.`;
  }
  if (/eat|food|nutrition|calorie|meal/.test(t)) {
    const kcal = meals.reduce((s,m)=>s+m.calories,0);
    return meals.length ? `You're at ${kcal} kcal logged today. ${kcal < 1800 ? "Might want another solid meal in." : "Looking solid — good work staying on top of it."}` : `Nothing logged yet today — pop it into the Food tab and I'll keep an eye on it.`;
  }
  if (/log/.test(t)) {
    return `Head to the Log tab and I'll pull in today's exercises automatically — just fill in your weights.`;
  }
  if (/hi|hello|hey/.test(t)) {
    return `Hey! Ready to work? Ask me about today's plan, your progress, or how nutrition's looking.`;
  }
  const fallback = [
    "Stay consistent — that's the whole game. What do you need, plan, progress, or nutrition?",
    "Good effort shows up in the numbers over weeks, not days. Trust the process.",
    "I've got eyes on your log. Ask me anything about your plan or progress.",
  ];
  return fallback[Math.floor(Math.random() * fallback.length)];
}

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const msgs = store.get('chat', []);
  msgs.push({ role: 'user', text, ts: Date.now() });
  store.set('chat', msgs);
  input.value = '';
  renderChatMessages();

  chatStatus.textContent = 'typing…';
  chatStatus.classList.add('is-typing');
  const typing = document.createElement('div');
  typing.className = 'msg msg--typing';
  typing.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  chatMessages.appendChild(typing);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  setTimeout(() => {
    typing.remove();
    chatStatus.textContent = 'online';
    chatStatus.classList.remove('is-typing');
    const reply = marcusReply(text);
    const all = store.get('chat', []);
    all.push({ role: 'marcus', text: reply, ts: Date.now() });
    store.set('chat', all);
    renderChatMessages();
  }, 650 + Math.random() * 500);
});

// ---------- updates ----------
// A deploy is invisible to an already-open app: the new service worker installs
// and takes over (sw.js calls skipWaiting + clients.claim), but this page keeps
// running the app.js it loaded. controllerchange is the moment of the swap, and
// it only means "a new version" when this page already had a controller --
// on a first visit it fires because the very first worker claimed us.
function watchForUpdate(sw, onUpdate) {
  if (!sw || typeof sw.addEventListener !== 'function') return;
  // `let`, not `const`: on a first-ever visit this starts false and the initial
  // claim is correctly silent, but the page now HAS a controller. A second
  // deploy in the same sitting is a real update and must announce itself.
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (hadController) onUpdate();
    hadController = true;
  });
}

// The browser only re-checks sw.js on navigation, and an installed PWA that is
// left open and switched back to never navigates. Asking on every return to the
// foreground is what makes the banner appear without a manual reload.
function recheckOnVisible(doc, registration) {
  if (!doc || typeof doc.addEventListener !== 'function') return;
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    try { Promise.resolve(registration.update()).catch(() => {}); } catch { /* a stub or a browser that throws synchronously */ }
  });
}

function showUpdateBanner() {
  const host = document.getElementById('updateBanner');
  if (host) host.hidden = false;
}

// ---------- boot ----------
switchTab('home');
document.getElementById('updateReload')?.addEventListener('click', () => window.location.reload());
if ('serviceWorker' in navigator) {
  watchForUpdate(navigator.serviceWorker, showUpdateBanner);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { if (reg) recheckOnVisible(document, reg); })
      .catch(() => {});
  });
}
