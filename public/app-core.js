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
function validatePhoto(rawPose, dataUrl, records, dateISO) {
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
  const used = photoTotalBytes(rows) - photoTotalBytes(replaced);
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

// Proposals with no honest reference: `deload`, `move` and `rest`. The 1.5
// acute-to-chronic line the deload fires on comes from injury-risk workload
// research, not from any of the endurance papers above, and `move`/`rest` are
// about whether you keep the week you wrote -- adherence, not physiology.
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
