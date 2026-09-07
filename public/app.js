// The UI half: tabs, rendering, event wiring. It runs after app-core.js and
// reads its top-level declarations out of the shared global scope.

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
      ${todayPlan.exercises.length ? todayPlan.exercises.map(e => `<div class="exercise-line"><span>${e.name}</span><span>${e.sets}×${e.reps}</span></div>`).join('') : ``}
      ${todayPlan.cardio ? `<div class="exercise-line"><span>${esc(todayPlan.cardio.activity)}</span><span>${todayPlan.cardio.minutes} min</span></div>` : ``}
      ${!todayPlan.exercises.length && !todayPlan.cardio ? `<div class="empty">Rest day — recovery is training too.</div>` : ``}
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
  const review = planReview(plan, store.get('sessions', []), todayStr(), undefined, goals[0]);
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
        ${referencesFor(p.kind).map(c => `
          <div class="card__note" style="margin-top:8px;padding-left:8px;border-left:2px solid var(--md-outline, #ccc)">
            <a href="${esc(c.ref.url)}" target="_blank" rel="noopener noreferrer">${esc(c.ref.authors)} (${c.ref.year})</a> &middot; ${esc(c.ref.venue)}<br>${esc(c.ref.finding)}<br><em>${esc(c.stretch)}</em>
          </div>`).join('')}
        <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="acceptProposal('${p.id}')">Change the plan</button>
      </div>`).join('') : `<div class="empty">${esc(review.note)}</div>`}
    <div class="card__note" style="padding:0 4px 4px">Every number above is read off your own log. Where endurance research points the same way, the paper is quoted under the suggestion with how far it actually goes; suggestions about which days you keep carry none, because that is adherence rather than physiology.</div>

    <div class="section-title">The research behind this</div>
    ${TRAINING_REFERENCES.map(r => `
      <div class="card" style="display:block">
        <div class="card__title-row"><h2><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></h2></div>
        <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">${esc(r.authors)} (${r.year}) &middot; ${esc(r.venue)}</div>
        <p class="card__note">${esc(r.finding)}</p>
      </div>`).join('')}

    <div class="section-title">This week</div>
    <div class="card">
      <h2>${plan.blockName}</h2>
      <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">Sized for the ${esc(plan.phase || PLAN_DEFAULT_PHASE)} phase &middot; ${planTotalSets(plan)} sets across ${planTrainingDays(plan).length} training day(s)</div>
    </div>
    <div class="card">
      <h2>Plan a cardio session</h2>
      <div class="field"><label>Day</label><select id="planCardioDay">${plan.days.map(d => `<option value="${esc(d.day)}"${d.day === todayName ? ' selected' : ''}>${esc(d.day)}</option>`).join('')}</select></div>
      <div class="field"><label>Activity</label><select id="planCardioActivity">${CARDIO_ACTIVITIES.map(a => `<option value="${a}">${a}</option>`).join('')}</select></div>
      <div class="field"><label>Duration (minutes)</label><input id="planCardioMinutes" type="number" min="1" step="1" placeholder="e.g. 45"></div>
      <button class="btn btn--tonal btn--block" id="addPlanCardio"><span class="material-icons-round">directions_run</span> Put it in the week</button>
    </div>
    ${plan.days.map(d => `
      <div class="card plan-day ${d.day===todayName?'is-today':''}" style="display:block">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="plan-day__name">${d.day}</span>
          <span class="plan-day__focus">${d.focus}</span>
        </div>
        ${d.exercises.map(e => `<div class="exercise-line"><span>${e.name}</span><span>${e.sets}×${e.reps}</span></div>`).join('')}
        ${d.cardio ? `<div class="exercise-line"><span>${esc(d.cardio.activity)}</span><span>${d.cardio.minutes} min <button class="icon-btn" onclick="clearPlanCardio('${esc(d.day)}')"><span class="material-icons-round">close</span></button></span></div>` : ``}
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

  document.getElementById('addPlanCardio').addEventListener('click', () => {
    const result = validatePlanCardio(
      document.getElementById('planCardioActivity').value,
      document.getElementById('planCardioMinutes').value
    );
    if (!result.ok) { toast(result.message); return; }
    if (!setPlan(withPlanCardio(store.get('plan'), document.getElementById('planCardioDay').value, result.cardio))) return;
    renderPlan();
  });
}

function clearPlanCardio(dayName) {
  if (!setPlan(withPlanCardio(store.get('plan'), dayName, null))) return;
  renderPlan();
}

// Every deliberate change to the plan goes through here, so a conflicting push
// can tell which of two copies is the later one (see `newerPlan`). `seed()`
// deliberately does not: seeding is not an edit, and a browser opened for the
// first time must not out-rank a plan the user actually wrote on their other
// phone. Neither does a restore -- the backup file carries whatever stamp it
// was exported with, and claiming an old file is the newest plan would be a
// second last-write-wins wearing a timestamp.
function setPlan(plan) {
  return store.set('plan', Object.assign({}, plan, { updatedAt: Date.now() }));
}

function acceptProposal(id) {
  const plan = store.get('plan');
  const review = planReview(plan, store.get('sessions', []), todayStr(), undefined, goalsSorted()[0]);
  const proposal = review.proposals.find(p => p.id === id);
  if (!proposal) { toast('That suggestion is no longer current'); return; }
  if (!setPlan(applyProposal(plan, proposal))) return;
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
  recordDeletion('goals', id);
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

// ---------- exercise detail inside the sentence ----------
// "3x10 squats at 80kg" is the half of idea #220 that was left unbuilt: until
// now a strength sentence could only say "I followed the plan", and the rows
// came from the plan rather than from what was typed. A decimal comma is
// normalised first, so splitting on the comma cannot cut "82,5kg" in half.
const EX_SETS_REPS = /(\d+)\s*(?:x|\u00d7|\*)\s*(\d+)|(\d+)\s*sets?\s*(?:of|x|\u00d7)\s*(\d+)/i;
const EX_WEIGHT = /(?:at|@|with|using|on)?\s*(\d+(?:\.\d+)?)\s*(kgs|kg|kilograms|kilogrammes|kilos|kilo)\b/i;

// Filler around the exercise name. Whatever is left after the numbers and these
// words are taken out is the name, as typed -- there is no list of known
// exercises, because the plan lets you name your own.
const EX_FILLER = ['i', 'did', 'do', 'done', 'doing', 'also', 'then', 'and', 'plus', 'some', 'my', 'the', 'a', 'of', 'on', 'for', 'with', 'at', 'went', 'got', 'in', 'today', 'yesterday', 'was', 'were'];

function exerciseSegments(text) {
  return String(text == null ? '' : text)
    .replace(/(\d),(\d)/g, '$1.$2')
    .split(/[,;]|\.(?=\s|$)|\band\b|\bthen\b|\bplus\b|\+/i)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

function exerciseName(text) {
  // A bare number left over is not part of the name -- "3x10 squats at 80" is a
  // weight with no unit, and the row is still Squats. The digits go first so the
  // "at" they were hiding is then stripped as the filler it is; refusing the
  // whole row would lose a real exercise over a missing "kg".
  const words = String(text == null ? '' : text).replace(/[^A-Za-z0-9'\-\s]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean).filter((w) => !/^\d/.test(w));
  while (words.length && EX_FILLER.indexOf(words[0].toLowerCase()) !== -1) words.shift();
  while (words.length && EX_FILLER.indexOf(words[words.length - 1].toLowerCase()) !== -1) words.pop();
  if (!words.length) return null;
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Every segment that carries sets and reps, read as one exercise row. A weight
// is optional here and stays null when it was not said -- the same rule the
// plan branch already follows, because a made-up kilo is a made-up measurement.
function sessionSentenceExercises(text) {
  const out = [];
  for (const seg of exerciseSegments(text)) {
    const sr = seg.match(EX_SETS_REPS);
    if (!sr) continue;
    const sets = parseInt(sr[1] != null ? sr[1] : sr[3], 10);
    const reps = parseInt(sr[2] != null ? sr[2] : sr[4], 10);
    let rest = seg.replace(sr[0], ' ');
    const w = rest.match(EX_WEIGHT);
    let weight = null;
    if (w) { weight = parseFloat(w[1]); rest = rest.replace(w[0], ' '); }
    const name = exerciseName(rest);
    if (!name) continue;
    out.push(weight == null ? { name, sets, reps } : { name, sets, reps, weight });
  }
  return out;
}

// The weight for one exercise the plan already named. "I did the plan, squats
// at 80kg" is the common way to say this: the sets and reps are the plan's and
// only the kilos were missing. Matched by the plan's own name appearing in the
// segment, so a number somewhere else in the sentence cannot land on a row.
function sentenceWeightFor(text, name) {
  const needle = String(name == null ? '' : name).toLowerCase().trim();
  if (!needle) return null;
  for (const seg of exerciseSegments(text)) {
    if (seg.toLowerCase().indexOf(needle) === -1) continue;
    const w = seg.match(EX_WEIGHT);
    if (w) return parseFloat(w[1]);
  }
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

  const spoken = sessionSentenceExercises(raw);

  // Both in one sentence is two sessions, and the form can only open one. I
  // refuse rather than pick, because either pick drops something you told me.
  if (activity && spoken.length) {
    return { ok: false, reason: 'I heard a ' + activity.toLowerCase() + ' and lifting in the same sentence. Log them one at a time.' };
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

  // What you typed beats what the plan says, including when you say both:
  // "did the plan, 3x10 squats at 80kg" is a report of the squats you actually
  // did, and the plan is what you meant to do.
  if (spoken.length) {
    return {
      ok: true,
      kind: 'strength',
      source: 'sentence',
      day: planDayName(new Date(date + 'T00:00')),
      exercises: spoken,
      missing: spoken.some((e) => e.weight == null) ? ['weight'] : [],
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
    // The plan carries sets and reps and no weight, so a row still needs one --
    // unless the sentence named it ("did the plan, squats at 80kg"). This is the
    // "amount stays blank and asks you" rule from the meal parser: the form
    // opens filled in, and you type whatever kilos you did not say.
    const exercises = day.exercises.map((e) => {
      const weight = sentenceWeightFor(raw, e.name);
      return weight == null
        ? { name: e.name, sets: e.sets, reps: e.reps }
        : { name: e.name, sets: e.sets, reps: e.reps, weight };
    });
    return {
      ok: true,
      kind: 'strength',
      source: 'plan',
      day: day.day,
      exercises,
      missing: exercises.some((e) => e.weight == null) ? ['weight'] : [],
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
  } else if (result.source === 'sentence') {
    parts.push(result.exercises.map((e) => `${e.sets}\u00d7${e.reps} ${e.name}${e.weight != null ? ` at ${e.weight} kg` : ''}`).join(', '));
  } else {
    parts.push(`${result.day} — ${result.exercises.length} exercises from your plan`);
  }
  parts.push(niceDate(result.date));
  if (result.feel) parts.push(`felt ${result.feel}`);
  if (result.injury) parts.push('injury mentioned');
  let out = `Heard: ${parts.join(' \u00b7 ')}.`;
  if (result.missing.indexOf('minutes') !== -1) out += ' I did not hear how long it took — fill in the duration.';
  if (result.missing.indexOf('weight') !== -1) {
    out += result.source === 'sentence'
      ? ' I did not hear a weight for every exercise — type what you lifted.'
      : ' Your plan has no weights in it — type what you lifted.';
  }
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
      if (prefill.weight != null) node.querySelector('.ex-weight').value = prefill.weight;
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
  recordDeletion('sessions', id);
  store.set('sessions', store.get('sessions', []).filter(s => s.id !== id));
  renderLog();
}

// ---------- nutrition ----------
// Which food is picked and which recent meals are on screen are UI state, not
// stored data, so they live here rather than in `store`.
let foodPick = null;
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
      <div class="field"><label>Or the barcode on the packet</label><input id="foodBarcode" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 7038010009457"></div>
      <button class="btn btn--tonal btn--block" id="lookUpBarcode"><span class="material-icons-round">qr_code_scanner</span> Look it up</button>
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
    foodPick = null;
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

  const barcode = document.getElementById('foodBarcode');
  const lookUp = document.getElementById('lookUpBarcode');
  lookUp.addEventListener('click', async () => {
    // Disabled while it is in flight: the upstream call is the slow part, and a
    // second tap would queue a second request against someone else's API.
    lookUp.disabled = true;
    const result = await lookupBarcodeFood(barcode.value);
    lookUp.disabled = false;
    if (!result.ok) { toast(result.message); return; }
    foodPick = result.food;
    renderFoodPick();
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
  if (!foodPick) { box.innerHTML = ''; return; }
  const food = foodPick;
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
    foodPick = null;
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
  // Every phrase the table could not place gets its own button rather than one
  // button for all of them: they are separate foods and the database has an
  // answer for some and not others, so a single "look these up" would report
  // one verdict for several questions.
  const missed = mealParse.unmatched.length
    ? `<div class="list-item__meta">Not in the food table \u2014 look one up, or type it in yourself below.</div>`
      + mealParse.unmatched.map((phrase, i) => `
      <div class="list-item">
        <div>${esc(phrase)}</div>
        <button class="btn btn--tonal" id="lookUpPhrase${i}" onclick="lookUpParsedPhrase(${i})"><span class="material-icons-round">search</span> Look it up</button>
      </div>`).join('')
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

// The looked-up food lands in the same picker a searched or scanned food lands
// in -- amount, live macro preview, add to today -- rather than going straight
// into the log: the database answers with a 100 g row and nobody ate 100 g of
// anything by coincidence. The phrase leaves the unmatched list on success only,
// so a lookup that found nothing leaves it there to try again or type in.
async function lookUpParsedPhrase(index) {
  if (!mealParse) return;
  const phrase = mealParse.unmatched[index];
  if (!phrase) return;
  const button = document.getElementById('lookUpPhrase' + index);
  // Disabled while it is in flight: the upstream call is the slow part and a
  // second tap would queue a second request against someone else's API.
  if (button) button.disabled = true;
  const result = await lookUpFoodByName(phrase);
  if (button) button.disabled = false;
  if (!result.ok) { toast(result.message); return; }
  foodPick = result.foods[0];
  // The parse can be gone or re-ordered by the time the answer lands -- adding
  // the ready rows clears it, and dropping one shifts every index after it --
  // so the phrase is found again rather than spliced at the index it was at
  // when the request went out. The food still goes in the picker either way:
  // he waited for that answer and it is right whatever happened to the list.
  const at = mealParse ? mealParse.unmatched.indexOf(phrase) : -1;
  if (at !== -1) {
    mealParse.unmatched.splice(at, 1);
    if (!mealParse.items.length && !mealParse.unmatched.length) mealParse = null;
  }
  renderMealParse();
  renderFoodPick();
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

function pickFood(index) { foodPick = FOODS[index]; renderFoodPick(); }
function clearFoodPick() { foodPick = null; renderFoodPick(); }

function addRecentMeal(index) {
  const meal = recentMealCache[index];
  if (!meal) return;
  if (!saveMeal(meal)) return;
  renderNutrition();
}

function deleteMeal(id) {
  recordDeletion('meals', id);
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
// weekdays sessions actually landed on.
//
// Idea #214 added the citation half without a model: TRAINING_REFERENCES in
// app-core.js is a checked-in table of the endurance papers, and referencesFor()
// attaches one to a proposal only where the paper's finding speaks to the same
// quantity the arithmetic computed. Two of the five kinds have one. `deload`,
// `move` and `rest` deliberately have none -- see the comment beside
// PROPOSAL_REFERENCES for why -- and the card says so rather than reaching for
// a paper that does not say it.
const REVIEW_WINDOW_DAYS = 28;
const REVIEW_MIN_WEEKS = 2;      // one week is a holiday, not a pattern
const DELOAD_SET_FLOOR = 2;      // a deload that leaves one set is not a session

function weekdayOf(iso) { return DAY_NAMES[new Date(iso + 'T00:00:00Z').getUTCDay()]; }

// A day counts as training if it asks for anything at all -- exercises, a cardio
// session, or both. This used to read `exercises.length > 0` only, which made a
// swim day indistinguishable from a rest day everywhere the plan is counted.
function isTrainingDay(day) {
  return !!day && ((day.exercises || []).length > 0 || !!day.cardio);
}

function planTrainingDays(plan) {
  return (plan && plan.days || []).filter(isTrainingDay);
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
    planned: isTrainingDay(d),
    logged: logged[d.day] || 0,
  }));
}

// The chip has to read on its own -- a one-word kind like 'rest' tells a
// reader nothing unless they already know the four kinds.
const PROPOSAL_CHIPS = { deload: 'ease off', build: 'add volume', move: 'move a day', rest: 'drop a day', phase: 'match the phase' };
function proposalChip(kind) { return PROPOSAL_CHIPS[kind] || kind; }

function totalSets(day) {
  return (day.exercises || []).reduce((sum, e) => sum + (e.sets || 0), 0);
}

// The written week is supposed to serve the goal, and until now it did not: the
// seed plan was the same four days whether the target was eight weeks out or two
// years, and it stayed the same the day the goal crossed from Base into Taper.
// This is the step that connects them, and it is arithmetic rather than coaching.
//
// A plan carries the phase it was last sized for. PHASE_VOLUME already says what
// each phase does to a week's volume -- Base 1.10, Build 1.00, Peak 0.90, Taper
// 0.60 -- so moving from one to another is a ratio, and that ratio times the
// week's total sets is a whole number of sets to add or take away. A plan with no
// phase recorded is read as Build: the seed block is a straight hypertrophy week
// at 1.00, so that is a description of what is there rather than a default picked
// for convenience.
//
// It proposes nothing when the arithmetic rounds to zero sets, which is the
// common case for one step along the phase list. A proposal that changes nothing
// is worse than silence -- the user accepts it, sees no difference, and stops
// reading the next one.
const PLAN_DEFAULT_PHASE = 'Build';

function planTotalSets(plan) {
  return planTrainingDays(plan).reduce((sum, d) => sum + totalSets(d), 0);
}

function phaseProposal(plan, goal, todayISO) {
  const phase = currentPhase(goal, todayISO);
  if (!phase) return null;
  const was = (plan && plan.phase) || PLAN_DEFAULT_PHASE;
  if (phase.label === was) return null;
  const to = PHASE_VOLUME[phase.label];
  const from = PHASE_VOLUME[was];
  if (to == null || from == null) return null;
  const sets = planTotalSets(plan);
  if (!sets) return null;
  const wanted = Math.round(sets * (to / from)) - sets;
  // Clamped to what the deload floor actually allows, so the headline is the
  // number of sets that will move rather than the number the ratio asked for.
  // The seed week has exactly enough room for its own Build-to-Taper cut (58
  // sets over 18 exercises: 23 wanted, 23 spare), so the clamp is invisible
  // there and bites on a week the user has already trimmed.
  const room = planTrainingDays(plan).reduce((sum, d) =>
    sum + (d.exercises || []).reduce((n, e) => n + Math.max(0, (e.sets || 0) - DELOAD_SET_FLOOR), 0), 0);
  const delta = wanted < 0 ? -Math.min(-wanted, room) : wanted;
  if (!delta) return null;
  const pct = Math.round(Math.abs(to / from - 1) * 100);
  const word = delta < 0 ? 'takes' : 'adds';
  return {
    id: 'phase-' + phase.label,
    kind: 'phase',
    phase: phase.label,
    setDelta: delta,
    title: (delta < 0 ? 'Take ' + (-delta) + ' set' + (delta === -1 ? '' : 's') + ' off the week'
                     : 'Add ' + delta + ' set' + (delta === 1 ? '' : 's') + ' to the week')
         + ' for the ' + phase.label + ' phase',
    reason: 'Your goal is in its ' + phase.label + ' phase through ' + niceDate(phase.date)
          + ', and the written week was last sized for ' + was + '. ' + phase.label + ' runs at '
          + Math.round(to * 100) + '% of a ' + was + ' week, which is ' + pct + '% ' + (delta < 0 ? 'less' : 'more')
          + ' \u2014 on ' + sets + ' sets that ' + word + ' ' + Math.abs(delta) + '.',
  };
}

// Proposals, most urgent first. Each one carries the number that produced it,
// because a change with no measurement behind it is just an opinion.
//
// The phase proposal is the one that does not wait for REVIEW_MIN_WEEKS: it is
// arithmetic on the goal's dates and the plan's own sets, so it is exactly as
// true on the first day as on the fiftieth, and holding it back would leave a
// brand-new goal staring at a week written for a phase it is not in.
function planReview(plan, sessions, todayISO, windowDays, goal) {
  const windowSize = windowDays || REVIEW_WINDOW_DAYS;
  const weeks = reviewWeeks(sessions, todayISO, windowSize);
  const phaseFirst = phaseProposal(plan, goal, todayISO);
  if (weeks < REVIEW_MIN_WEEKS) {
    return { weeks, proposals: phaseFirst ? [phaseFirst] : [],
      note: 'Marcus reviews the rest of the plan once you have ' + REVIEW_MIN_WEEKS + ' weeks of sessions logged. ' + weeks + ' so far.' };
  }

  const load = trainingLoad(sessions || [], todayISO);
  const rows = adherenceByWeekday(plan, sessions, todayISO, windowSize);
  const training = planTrainingDays(plan);
  const proposals = phaseFirst ? [phaseFirst] : [];

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

  // 'add volume' is the fallback when nothing else needed saying. A phase
  // resize already changed the week's volume this render, so it does not count
  // as nothing -- stacking both would move the same number twice.
  if (!proposals.some(p => p.kind !== 'phase') && !phaseFirst && load.verdict === 'backing off') {
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
      // The cardio session moves with the day. Leaving it behind would move the
      // lifting off a day the user never trains and leave the swim on it.
      if (from.cardio) { to.cardio = from.cardio; delete from.cardio; }
      from.focus = 'Rest';
      from.exercises = [];
    }
  } else if (proposal.kind === 'rest') {
    const day = next.days.find(d => d.day === proposal.day);
    if (day) { day.focus = 'Rest'; day.exercises = []; delete day.cardio; }
  } else if (proposal.kind === 'phase') {
    // Sets come off the exercise carrying the most and go onto the one carrying
    // the least, one at a time, so a week loses breadth last: cutting six sets
    // from one exercise would delete a movement, and this is a volume change,
    // not a decision about which lift matters.
    const exercises = planTrainingDays(next).reduce((all, d) => all.concat(d.exercises || []), []);
    let left = Math.abs(proposal.setDelta || 0);
    const down = (proposal.setDelta || 0) < 0;
    while (left > 0 && exercises.length) {
      const pool = down ? exercises.filter(e => (e.sets || 0) > DELOAD_SET_FLOOR) : exercises;
      if (!pool.length) break;
      const pick = pool.reduce((best, e) => (down ? (e.sets || 0) > (best.sets || 0) : (e.sets || 0) < (best.sets || 0)) ? e : best, pool[0]);
      pick.sets = (pick.sets || 0) + (down ? -1 : 1);
      left -= 1;
    }
    // Recorded whether or not every set landed. The plan really has been sized
    // for this phase now -- if the floor stopped it short, re-proposing the same
    // change every render would be a button that never finishes.
    next.phase = proposal.phase;
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
    <div class="section-title">Reminders</div>
    <div class="card">
      <h2>Evening reminder</h2>
      <p class="card__note">Marcus can buzz this phone once in the evening. On iPhone that only works when Marcus has been added to the Home Screen and opened from there &mdash; not from a Safari tab.</p>
      <div id="reminderStatus" class="card__note" style="margin-bottom:10px"></div>
      <button class="btn btn--filled btn--block" id="toggleReminders"><span class="material-icons-round">notifications_active</span> Turn on reminders</button>
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
  wireReminders();

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
const BACKUP_KEYS = ['plan', 'sessions', 'weights', 'meals', 'goals', 'chat', 'deletions'];

// The three stores the app can delete from, and the reason this list is three
// names rather than every store: `deleteSession`, `deleteMeal` and `deleteGoal`
// are the only delete buttons in the app, and all three key on an id this
// browser minted. `weights` and `chat` have no delete path at all, so they
// carry no tombstones and nothing below touches them.
const DELETABLE_STORES = ['sessions', 'meals', 'goals'];

// A deletion has to be a record of its own or it does not survive a sync. From
// the other phone, "deleted here" and "never arrived here" are the same
// observation, so the union in `mergeList` brings a deleted session straight
// back on the next push -- which is the limit `mergeBackupData` used to state
// and this closes.
//
// A tombstone cannot suppress a record the user logged afresh, because the id
// is minted per record: re-logging a session writes a new id, and the old
// tombstone names the one that is gone. The one path that does reuse an id is a
// restore -- a backup file preserves them -- and `forgetDeletionsOf` is what
// covers that.
function recordDeletion(storeKey, id) {
  if (DELETABLE_STORES.indexOf(storeKey) === -1) return false;
  if (id === null || id === undefined || id === '') return false;
  const log = store.get('deletions', []);
  const rows = Array.isArray(log) ? log : [];
  // Two tabs of the app share one localStorage, so the same delete can be
  // recorded twice. `mergeList` only ever dedups this side against the other
  // one, so a duplicate written here would survive every merge from now on.
  const key = recordKey({ store: storeKey, id: String(id) }, ['store', 'id']);
  if (rows.some(d => recordKey(d, ['store', 'id']) === key)) return true;
  return store.set('deletions', rows.concat([
    { store: storeKey, id: String(id), ts: Date.now() },
  ]));
}

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
//
// `deletions` is left out: it is bookkeeping this browser keeps so a delete
// survives a sync, not a section the user logged and would recognise getting
// back. `restoreBackup` leaves it out of its count for the same reason, so the
// preview and the toast that follows it name the same number.
function backupSummary(data) {
  return BACKUP_KEYS.filter(k => k !== 'deletions' && k in data).map(k => ({
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
    const ok = store.set(k, parsed.data[k]);
    // Written either way; only counted when it is a section the user would
    // recognise. A refused write is still reported, because that is a failure.
    if (!ok) failed.push(k);
    else if (k !== 'deletions') restored.push(k);
  });
  forgetDeletionsOf(parsed.data);
  return { restored, failed };
}

// A restore is the one way a record comes back carrying the id it had when it
// was deleted -- `recordDeletion`'s "the id is minted per record" holds for
// anything the user logs afresh and does not hold here, because a backup file
// preserves ids by design. Without this, restoring an old file put the session
// back on screen and the next conflicting sync quietly took it away again: the
// tombstone outlived the record it named.
//
// So a restore forgets the tombstones for exactly the records it just wrote
// back. The file is the user saying these exist, which is newer information
// than a delete recorded before it.
function forgetDeletionsOf(data) {
  const log = store.get('deletions', []);
  if (!Array.isArray(log) || !log.length) return false;
  const alive = {};
  DELETABLE_STORES.forEach(name => {
    if (!Array.isArray(data[name])) return;
    data[name].forEach(r => {
      const k = recordKey({ store: name, id: r && r.id }, ['store', 'id']);
      if (k !== null) alive[k] = true;
    });
  });
  const kept = log.filter(d => {
    const k = recordKey(d, ['store', 'id']);
    return k === null || !alive[k];
  });
  if (kept.length === log.length) return false;
  return store.set('deletions', kept);
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

// Two phones that both logged something hold two lists, and only one of them
// can be the copy on the server. Until now the loser's records were written
// over: a 409 was retried by re-sending this browser's payload at the server's
// revision, which is last-write-wins and drops a session somebody actually did.
//
// So a conflicting push merges first. Identity is named per key rather than
// assumed, because these records do not all carry an id -- `weights` is one
// entry per date and `chat` is an append-only log -- and minting ids they do
// not have would be worse than naming the fields that already make a record
// itself.
const MERGE_KEYS = {
  sessions: { by: ['id'] },
  meals: { by: ['id'] },
  goals: { by: ['id'] },
  weights: { by: ['date'] },
  chat: { by: ['ts', 'role', 'text'], sort: 'ts' },
  // A tombstone is a record like any other and merges like one: the union of
  // both sides is what either phone deleted, and a deletion both sides know
  // about is one deletion.
  deletions: { by: ['store', 'id'], sort: 'ts' },
};

// null, never a partial key: two records missing the same field would otherwise
// collide on the empty string and one of them would vanish.
function recordKey(rec, fields) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const v = rec[fields[i]];
    if (v === null || v === undefined) return null;
    parts.push(String(v));
  }
  return parts.join('\u0000');
}

// Union, never subtraction. A record only one side holds is kept; a record both
// sides hold is taken from `mine`, because this browser is the one that just
// wrote.
//
// A record the other phone deleted used to come back, because from here
// "deleted there" and "never reached this browser" are the same observation.
// It no longer does: a delete writes a tombstone into `deletions`, that list
// merges like any other, and `applyDeletions` runs over the union. The union
// still runs this way round because resurrecting a record is a smaller harm
// than dropping a logged session, and that is now the fallback rather than the
// outcome.
//
// A record with no usable identity is kept from `mine` and dropped from
// `theirs` -- without a key there is no way to tell a duplicate from a second
// record, and keeping both would grow the list on every sync.
function mergeList(mine, theirs, spec) {
  if (!Array.isArray(mine)) return Array.isArray(theirs) ? theirs.slice() : [];
  if (!Array.isArray(theirs)) return mine.slice();
  const seen = {};
  const out = [];
  mine.forEach(r => {
    const k = recordKey(r, spec.by);
    if (k !== null) seen[k] = true;
    out.push(r);
  });
  theirs.forEach(r => {
    const k = recordKey(r, spec.by);
    if (k === null || seen[k]) return;
    seen[k] = true;
    out.push(r);
  });
  // Only where the stored order is the displayed order: every other list is
  // sorted again at render time, so re-ordering it here would be noise.
  if (spec.sort) out.sort((a, b) => (Number(a[spec.sort]) || 0) - (Number(b[spec.sort]) || 0));
  return out;
}

// `plan` is one object with no per-record identity, so it still cannot be merged
// the way a list is -- one of the two copies has to win whole. What has changed
// is which one. "This browser wins" was the wrong rule for the common case: a
// phone that pushes a meal sends its whole payload, so it overwrote a plan the
// other phone had edited an hour earlier while never having touched the plan
// itself. `setPlan` stamps `updatedAt` when this browser actually changes the
// plan, and the newer stamp wins.
//
// A plan with no stamp is one nobody has edited since this shipped -- including
// a freshly seeded one -- so it loses to any stamped plan. With neither stamped
// there is nothing to compare and this browser still wins, which is exactly the
// old rule.
// No array guard, unlike `recordKey`: JSON cannot produce an array carrying a
// named `updatedAt`, so an array falls out as unstamped through the `Number`
// check anyway and the guard was a branch nothing could reach.
function planStamp(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const v = Number(plan.updatedAt);
  return Number.isFinite(v) ? v : null;
}

function newerPlan(mine, theirs) {
  const t = planStamp(theirs);
  if (t === null) return mine;
  const m = planStamp(mine);
  if (m === null) return theirs;
  return t > m ? theirs : mine;
}

function mergeBackupData(mine, theirs) {
  const a = mine && typeof mine === 'object' && !Array.isArray(mine) ? mine : {};
  const b = theirs && typeof theirs === 'object' && !Array.isArray(theirs) ? theirs : {};
  const out = {};
  BACKUP_KEYS.forEach(k => {
    const spec = MERGE_KEYS[k];
    const mineHas = Array.isArray(a[k]);
    const theirsHas = Array.isArray(b[k]);
    if (spec && (mineHas || theirsHas)) {
      out[k] = mergeList(mineHas ? a[k] : null, theirsHas ? b[k] : null, spec);
      return;
    }
    if (k === 'plan' && k in a && k in b) { out[k] = newerPlan(a[k], b[k]); return; }
    if (k in a) out[k] = a[k];
    else if (k in b) out[k] = b[k];
  });
  return applyDeletions(out);
}

// Applied after the union rather than inside it, on purpose: a tombstone only
// one side holds has to suppress a record only the other side holds, and the
// union is exactly the step that has just put those two next to each other.
//
// A record with no id is kept. Without an id there is nothing a tombstone could
// name, so dropping it would be guessing rather than honouring a delete.
function applyDeletions(data) {
  const log = Array.isArray(data.deletions) ? data.deletions : null;
  if (!log || !log.length) return data;
  const gone = {};
  log.forEach(d => {
    const k = recordKey(d, ['store', 'id']);
    if (k !== null) gone[k] = true;
  });
  DELETABLE_STORES.forEach(name => {
    if (!Array.isArray(data[name])) return;
    data[name] = data[name].filter(r => {
      const k = recordKey({ store: name, id: r && r.id }, ['store', 'id']);
      return k === null || !gone[k];
    });
  });
  return data;
}

// Push, with exactly one retry. A 409 means another browser wrote after this
// one last looked, and the retry now carries the union of both copies rather
// than this browser's alone. `merged` comes back on the result when that
// happened, because the caller has to put those records into this browser too
// -- a merge only the server holds is half a merge.
//
// A 409 whose body carries no `data` (an older server, or a state with nothing
// in it) falls back to the old behaviour of re-sending this payload: there is
// nothing to merge with, so there is nothing to lose.
async function pushServerCopy(fetchFn, payloadData, rev) {
  const put = (r, body) => fetchFn('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rev: r, data: body }),
  });
  let merged = null;
  let res = await put(rev, payloadData);
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const serverRev = body && body.state && typeof body.state.rev === 'number' ? body.state.rev : null;
    if (serverRev === null) return { ok: false, reason: 'conflict' };
    const theirs = body.state.data;
    if (theirs && typeof theirs === 'object' && !Array.isArray(theirs)) {
      merged = mergeBackupData(payloadData, theirs);
    }
    res = await put(serverRev, merged || payloadData);
  }
  if (!res.ok) return { ok: false, reason: 'refused', status: res.status };
  const saved = await res.json().catch(() => null);
  if (!saved || typeof saved.rev !== 'number') return { ok: false, reason: 'refused' };
  return { ok: true, rev: saved.rev, updatedAt: saved.updatedAt, merged: merged };
}

// The one case where pushing loses data that nothing else holds: a browser
// that has never synced (rev 0) meets a server that already has a copy. That
// browser has just seeded itself with an empty plan, so pushing would write
// blank seed data over a real training history. It refuses and says so; the
// "Load the server copy" button is the way out.
function shouldPush(localRev, serverRev) {
  return !(localRev === 0 && serverRev > 0);
}

// The other side of that same case, and the half issue #153 is actually about:
// a second phone opens the app, finds a stranger's demo log, and the real
// training history is sitting on the server behind a button it has no reason to
// know about. Adopting the server copy destroys nothing when this browser has
// nothing of the user's in it, so that -- and only that -- happens on its own.
//
// "Nothing of the user's" cannot be tested by looking at the data, because
// `seed()` writes sixteen demo sessions, a run of weights and a day of meals
// into every new browser: an empty log and a seeded one look nothing alike, and
// the seeded one is what a new phone actually holds. What separates them is
// whether `seed()` ran *on this boot*, which is true exactly once per browser.
function shouldAdoptServerCopy(localRev, serverRev, freshBoot) {
  return localRev === 0 && serverRev > 0 && freshBoot === true;
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
    const gained = result.merged ? adoptMergedCopy(result.merged) : null;
    store.set(SYNC_REV_KEY, result.rev);
    serverStatus = { state: 'saved', updatedAt: result.updatedAt };
    if (gained) { toast('Merged in what the other device logged.'); switchTab(currentTab); }
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
  // The first real write ends the fresh boot. `seed()` runs long before this
  // hook is wired, so anything arriving here is the user, or a restore -- and
  // either way there is now something in this browser worth not overwriting,
  // which matters because the boot fetch below can still be in flight.
  seededThisBoot = false;
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

// A merge the server accepted has to land in this browser as well, or the
// records the other phone logged are visible everywhere except here until the
// next reload. This is not a restore: `mergeBackupData` already ran, so what is
// written back is a superset of what this browser held, and nothing it holds is
// dropped.
//
// Returns false when the merge added nothing this browser did not already have,
// which is the ordinary case for the phone that just typed -- the caller uses
// that to decide whether the screen is worth repainting.
function adoptMergedCopy(merged) {
  if (!merged || typeof merged !== 'object') return false;
  let gained = false;
  Object.keys(merged).forEach(k => {
    const before = store.get(k, null);
    // A key this browser did not hold at all counts as zero, not as absent:
    // otherwise an empty list arriving where there was no key reads as a gain
    // and toasts about records nobody logged.
    const beforeCount = Array.isArray(before) ? before.length : 0;
    if (!store.set(k, merged[k])) return;
    // `deletions` is bookkeeping, not something the other phone logged, so a
    // tombstone arriving on its own must not toast about records nobody wrote
    // -- the same call backupSummary and restoreBackup make.
    if (k === 'deletions') return;
    if (Array.isArray(merged[k]) && merged[k].length > beforeCount) gained = true;
  });
  // `store.set` on a backup key armed a push of what was just pulled. The
  // server already holds exactly this, so that push is a revision bump for
  // nothing -- the same reason adoptServerCopy cancels it.
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  return gained;
}

// Returns null when it declined, so a caller can tell "did not fire" from
// "fired and failed" instead of inferring it from what got rendered.
function adoptServerCopy(state) {
  const serverRev = state && typeof state.rev === 'number' ? state.rev : 0;
  if (!shouldAdoptServerCopy(syncRev(), serverRev, seededThisBoot)) return null;
  const envelope = serverStateToBackup(state);
  if (!envelope) return null;
  const parsed = parseBackup(JSON.stringify(envelope));
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const result = restoreBackup(parsed);
  if (!result.restored.length) return { ok: false, message: 'This browser could not save the copy from the server.' };
  store.set(SYNC_REV_KEY, serverRev);
  // `restoreBackup` wrote backup keys, which armed a push of what was just
  // pulled. Nothing has changed, so that push is a rev bump for no reason.
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  return { ok: true, restored: result.restored, rev: serverRev };
}

// Runs at boot rather than when the Progress tab is opened, which is the only
// place that read the server copy before. Home is the screen a second phone
// shows first, and a Home full of somebody else's demo plan is what reads as
// "my training log is gone".
async function adoptServerCopyOnBoot() {
  const state = await readServerCopy();
  renderServerCopy();
  const adopted = adoptServerCopy(state);
  if (!adopted) return;
  if (!adopted.ok) { toast(adopted.message); return; }
  toast('Loaded your data from the server -- ' + adopted.restored.length + ' section(s).');
  switchTab(currentTab);
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

// The coach lives on the server (idea #206): POST /api/chat assembles the
// prompt from this data and asks a real model through Agora. The rule-based
// marcusReply above is the fallback and stays exactly as it was -- a deploy
// with no coach configured, a phone offline at the gym, or Agora being busy
// all land there rather than on an error bubble. So this can only make the
// chat better, never worse.
//
// The pause is deliberate on the fallback path only: a rule-based answer that
// arrives instantly reads as a canned answer, and it used to be the whole
// behaviour. A real reply has already taken its own time to arrive.
function marcusReplyAfterAPause(text) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(marcusReply(text)), 650 + Math.random() * 500);
  });
}

async function askMarcus(text) {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        // Only what the coach is meant to reason about. Nothing else in the
        // store is sent.
        context: {
          plan: store.get('plan'),
          sessions: store.get('sessions', []),
          weights: store.get('weights', []),
          meals: store.get('meals', []),
          goals: store.get('goals', []),
        },
        // The turn just typed is already in the store; it goes in as the
        // message, not a second time as history.
        history: store.get('chat', []).slice(0, -1).map(m => ({ role: m.role, text: m.text })),
      }),
    });
    if (!res.ok) return marcusReplyAfterAPause(text);
    const body = await res.json();
    return typeof body.reply === 'string' && body.reply.trim() ? body.reply : marcusReplyAfterAPause(text);
  } catch {
    return marcusReplyAfterAPause(text);
  }
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

  askMarcus(text).then((reply) => {
    typing.remove();
    chatStatus.textContent = 'online';
    chatStatus.classList.remove('is-typing');
    const all = store.get('chat', []);
    all.push({ role: 'marcus', text: reply, ts: Date.now() });
    store.set('chat', all);
    renderChatMessages();
  });
});

// ---------- reminders (idea #217, the browser half) ----------
// The server could already mint a VAPID key, remember a device and encrypt a
// send before any of this existed -- and the list of devices it fanned out to
// was empty and could not become non-empty, because nothing here ever asked
// for permission. This is that ask.
//
// Three things about iOS drive the shape, and none of them are visible from a
// desktop browser: Web Push only exists in a Home Screen web app (never a
// Safari tab), the permission prompt is only allowed while the tap that asked
// for it is still the current user activation, and a permission the user has
// denied can never be re-requested from script. So: feature-detect before
// drawing a button that cannot work, ask for permission BEFORE the first
// network call, and say plainly when the answer is no rather than retrying.

// Whether this browser can subscribe at all. Three separate capabilities --
// a Safari tab on iOS has the service worker and not the other two.
function pushSupported(nav, win) {
  return !!(nav && nav.serviceWorker && win && win.PushManager && win.Notification);
}

// One line the user can read. Same rule as `describeServerCopy`: name the state
// it is actually in, because "off" and "your phone has blocked this" need
// different things from the reader.
function describeReminders(status) {
  if (!status || status.state === 'unknown') return 'Reminders: checking...';
  if (status.state === 'unsupported') return 'Reminders: this browser cannot receive them. On iPhone, add Marcus to your Home Screen and open it from there.';
  if (status.state === 'blocked') return 'Reminders: your phone has blocked notifications for Marcus, so it cannot ask again from here. Turn them back on in Settings.';
  if (status.state === 'on') return 'Reminders: on for this device.';
  return 'Reminders: off. Marcus will not send anything until you turn them on.';
}

// The VAPID public key arrives base64url and `pushManager.subscribe` wants the
// raw bytes. Checked rather than converted blindly: an uncompressed P-256 point
// is 65 bytes starting 0x04, and a browser handed anything else fails inside
// subscribe() with a message that says nothing about where the key came from.
function applicationServerKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('the push key is missing');
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let raw;
  try {
    raw = atob(padded);
  } catch {
    throw new Error('the push key is not base64');
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('the push key is not a P-256 public key');
  return bytes;
}

// What the server's `validateSubscription` will accept, built from the
// subscription's own `toJSON` rather than read off its properties -- `endpoint`
// is a property and the two keys are only reachable through `getKey`, so
// `toJSON` is the one call that produces the whole record.
function subscriptionBody(sub) {
  const json = sub && typeof sub.toJSON === 'function' ? sub.toJSON() : null;
  if (!json || typeof json.endpoint !== 'string' || json.endpoint.length === 0) return null;
  const keys = json.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  return { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// Where this device stands, without asking for anything. `permission` is the
// phone's answer and `getSubscription` is whether this browser is actually
// registered -- both are needed, because a granted permission with no
// subscription is exactly what a cleared site data leaves behind.
async function readReminderState(deps) {
  const notification = deps && deps.notification;
  const registration = deps && deps.registration;
  if (!notification || !registration) return { state: 'unsupported' };
  if (notification.permission === 'denied') return { state: 'blocked' };
  let sub = null;
  try {
    sub = await registration.pushManager.getSubscription();
  } catch {
    return { state: 'off' };
  }
  return { state: sub ? 'on' : 'off' };
}

async function enableReminders(deps) {
  const { notification, registration, fetchFn } = deps;
  // First, and before any `await` on the network. Safari only allows the prompt
  // while the tap that opened it is still the current user activation, and an
  // awaited fetch spends that -- so fetching the key first would make the
  // prompt never appear, on the one platform this feature exists for.
  let permission;
  try {
    permission = await notification.requestPermission();
  } catch {
    return { ok: false, state: 'off', message: 'This browser would not ask for notification permission.' };
  }
  if (permission === 'denied') return { ok: false, state: 'blocked', message: 'Notifications are blocked for Marcus. Turn them back on in your phone settings.' };
  if (permission !== 'granted') return { ok: false, state: 'off', message: 'Reminders stay off until you allow notifications.' };

  let key;
  try {
    const res = await fetchFn('/api/push/key');
    if (!res || !res.ok) throw new Error('the server would not hand over its push key');
    const body = await res.json();
    key = applicationServerKey(body && body.key);
  } catch {
    return { ok: false, state: 'off', message: 'Marcus could not read its push key. Nothing has changed.' };
  }

  let sub;
  try {
    sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return { ok: false, state: 'off', message: 'This browser refused the subscription. Nothing has changed.' };
  }

  const body = subscriptionBody(sub);
  // Every failure below unsubscribes again on the way out. A browser that is
  // subscribed to a push service Marcus has no record of is the worst of the
  // three states: the button reads "on", the server will never send to it, and
  // nothing on either side says so.
  if (!body) {
    await unsubscribeQuietly(sub);
    return { ok: false, state: 'off', message: 'This browser handed back a subscription Marcus cannot use.' };
  }
  let res;
  try {
    res = await fetchFn('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    await unsubscribeQuietly(sub);
    return { ok: false, state: 'off', message: 'Marcus could not be reached. Reminders are still off.' };
  }
  if (!res || !res.ok) {
    await unsubscribeQuietly(sub);
    const full = res && res.status === 507;
    return { ok: false, state: 'off', message: full ? 'Marcus is already remembering as many devices as it can hold.' : 'Marcus would not save this device. Reminders are still off.' };
  }
  return { ok: true, state: 'on', message: 'Reminders are on for this device.' };
}

async function disableReminders(deps) {
  const { registration, fetchFn } = deps;
  let sub = null;
  try {
    sub = await registration.pushManager.getSubscription();
  } catch {
    sub = null;
  }
  if (!sub) return { ok: true, state: 'off', message: 'Reminders are off for this device.' };
  const body = subscriptionBody(sub);
  // The server is told first, on purpose. Unsubscribing first and then failing
  // to reach the server leaves a dead endpoint on its list that nothing can
  // ever name again -- this browser has just thrown away the only copy of it.
  if (body) {
    try {
      await fetchFn('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: body.endpoint }),
      });
    } catch {
      // A push service that keeps sending to an endpoint the user has turned
      // off is worse than a stale row on the server, so the unsubscribe below
      // happens either way.
    }
  }
  await unsubscribeQuietly(sub);
  return { ok: true, state: 'off', message: 'Reminders are off for this device.' };
}

async function unsubscribeQuietly(sub) {
  try {
    if (sub && typeof sub.unsubscribe === 'function') await sub.unsubscribe();
  } catch {
    /* nothing useful to tell the user about a failed rollback */
  }
}

// What the card last drew. Read by the click handler to decide which way the
// toggle goes, so the button can never act on a state it is not showing.
let reminderState = { state: 'unknown' };

// The card only ever draws from a state, never from what the last click tried
// to do, so a failed enable cannot leave the button reading "on".
function renderReminders(status) {
  reminderState = status;
  const line = document.getElementById('reminderStatus');
  if (line) line.textContent = describeReminders(status);
  const btn = document.getElementById('toggleReminders');
  if (!btn) return;
  const state = (status && status.state) || 'unknown';
  const off = state !== 'on';
  btn.disabled = state === 'unsupported' || state === 'blocked';
  btn.innerHTML = off
    ? '<span class="material-icons-round">notifications_active</span> Turn on reminders'
    : '<span class="material-icons-round">notifications_off</span> Turn off reminders';
}

async function reminderDeps() {
  if (!pushSupported(navigator, window)) return null;
  let registration = null;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
  if (!registration || !registration.pushManager) return null;
  return { notification: Notification, registration, fetchFn: (...args) => fetch(...args) };
}

function wireReminders() {
  renderReminders({ state: 'unknown' });
  const btn = document.getElementById('toggleReminders');
  btn?.addEventListener('click', async () => {
    const deps = await reminderDeps();
    if (!deps) { renderReminders({ state: 'unsupported' }); return; }
    const wasOn = reminderState && reminderState.state === 'on';
    btn.disabled = true;
    const result = wasOn ? await disableReminders(deps) : await enableReminders(deps);
    renderReminders({ state: result.state });
    toast(result.message);
  });
  reminderDeps()
    .then((deps) => (deps ? readReminderState(deps) : { state: 'unsupported' }))
    .then(renderReminders)
    .catch(() => renderReminders({ state: 'unsupported' }));
}

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
adoptServerCopyOnBoot().catch(() => {});
document.getElementById('updateReload')?.addEventListener('click', () => window.location.reload());
if ('serviceWorker' in navigator) {
  watchForUpdate(navigator.serviceWorker, showUpdateBanner);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { if (reg) recheckOnVisible(document, reg); })
      .catch(() => {});
  });
}
