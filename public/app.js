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
  refreshBadge();
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
  return trainingStreak(store.get('sessions', []), todayStr(), store.get('plan'));
}

function renderHome() {
  const plan = store.get('plan');
  const todayName = planDayName();
  const todayPlan = plan.days.find(d => d.day === todayName);
  const weights = store.get('weights', []);
  const change = bodyweightChange(weights, todayStr());
  const delta = change ? `${change.delta > 0 ? '+' : ''}${change.delta.toFixed(1)}kg` : '—';
  const doneToday = todayLogged(store.get('sessions', []), todayStr());
  const meals = store.get('meals', []).filter(m => m.date === todayStr());
  const kcal = meals.reduce((s, m) => s + m.calories, 0);
  // The nearest goal, and the first phase of it still outstanding -- that pair is
  // what turns a far-off date into something today can be measured against.
  const nextGoal = homeGoal();
  const nextPhase = nextGoal && nextGoal.milestones.find(m => !m.done);
  const week = homeWeekTarget();

  view.innerHTML = `
    <div class="card">
      <div class="card__title-row"><h2>Today · ${todayName}</h2><span class="chip ${todayPlan.focus==='Rest'?'':'chip--primary'}">${esc(todayPlan.focus)}</span></div>
      ${todayPlan.exercises.length ? todayPlan.exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets}×${e.reps}</span></div>`).join('') : ``}
      ${todayPlan.cardio ? `<div class="exercise-line"><span>${esc(todayPlan.cardio.activity)}</span><span>${todayPlan.cardio.minutes} min</span></div>` : ``}
      ${!todayPlan.exercises.length && !todayPlan.cardio ? `<div class="empty">Rest day — recovery is training too.</div>` : ``}
      ${doneToday ? `<div class="exercise-line exercise-line--done"><span><span class="material-icons-round">check_circle</span> Logged today</span><span>${esc(doneToday.label)}</span></div>` : ``}
      <button class="btn btn--filled btn--block" style="margin-top:12px" onclick="switchTab('log')"><span class="material-icons-round">add</span> ${doneToday ? 'Log another session' : 'Log this session'}</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat__value">${weekSessions().length}</div><div class="stat__label">sessions this wk</div></div>
      <div class="stat"><div class="stat__value">${streak()}</div><div class="stat__label">day streak</div></div>
      <div class="stat"><div class="stat__value">${delta}</div><div class="stat__label">${bodyweightChangeLabel(change)}</div></div>
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
  const review = planReview(plan, store.get('sessions', []), todayStr(), undefined, homeGoal());
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
        ${raceCalendarBlock(raceCalendar(g), g.id)}
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
        <p class="card__note">${linkGlossary(p.reason)}</p>
        ${referencesFor(p.kind).map(c => `
          <div class="card__note" style="margin-top:8px;padding-left:8px;border-left:2px solid var(--md-outline, #ccc)">
            <a href="${esc(c.ref.url)}" target="_blank" rel="noopener noreferrer">${esc(c.ref.authors)} (${c.ref.year})</a> &middot; ${esc(c.ref.venue)}<br>${linkGlossary(c.ref.finding)}<br><em>${linkGlossary(c.stretch)}</em>
          </div>`).join('')}
        <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="acceptProposal('${p.id}')">Change the plan</button>
      </div>`).join('') : `<div class="empty">${esc(review.note)}</div>`}
    <div class="card__note" style="padding:0 4px 4px">Every number above is read off your own log. Where endurance research points the same way, the paper is quoted under the suggestion with how far it actually goes; suggestions about which days and which lifts you keep carry none, because that is adherence rather than physiology.</div>

    <div class="section-title">Let Marcus draft the week</div>
    <div class="card">
      <p class="card__note">He reads your goal and your log and writes a full week. Nothing changes until you accept it.</p>
      <button class="btn btn--tonal btn--block" id="draftWeek"${planDraftBusy ? ' disabled' : ''}><span class="material-icons-round">auto_awesome</span> ${planDraftBusy ? 'Marcus is writing…' : 'Draft my week'}</button>
    </div>
    ${draftCard(plan, planDraft)}

    <div class="section-title">The research behind this</div>
    ${TRAINING_REFERENCES.map(r => `
      <div class="card" style="display:block">
        <div class="card__title-row"><h2><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></h2></div>
        <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">${esc(r.authors)} (${r.year}) &middot; ${esc(r.venue)}</div>
        <p class="card__note">${esc(r.finding)}</p>
      </div>`).join('')}

    <div class="section-title">This week</div>
    <div class="card">
      <h2>${linkGlossary(plan.blockName)}</h2>
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
          <span class="plan-day__name">${esc(d.day)}</span>
          <span class="plan-day__focus">${esc(d.focus)}</span>
        </div>
        ${d.exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets}×${e.reps}</span></div>`).join('')}
        ${d.cardio ? `<div class="exercise-line"><span>${esc(d.cardio.activity)}</span><span>${d.cardio.minutes} min <button class="icon-btn" onclick="clearPlanCardio('${esc(d.day)}')"><span class="material-icons-round">close</span></button></span></div>` : ``}
      </div>
    `).join('')}

    ${exerciseLibraryCard(formGuideLibrary())}
  `;

  document.getElementById('addGoal').addEventListener('click', () => {
    const result = validateGoal(document.getElementById('goalText').value, document.getElementById('goalDate').value);
    if (!result.ok) { toast(result.message); return; }
    const all = store.get('goals', []);
    all.push(result.goal);
    if (!store.set('goals', all)) return;
    renderPlan();
  });

  // Wrapped so requestDraft gets no arguments; it also ignores a click event.
  document.getElementById('draftWeek').addEventListener('click', () => requestDraft());

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
  const review = planReview(plan, store.get('sessions', []), todayStr(), undefined, homeGoal());
  const proposal = review.proposals.find(p => p.id === id);
  if (!proposal) { toast('That suggestion is no longer current'); return; }
  if (!setPlan(applyProposal(plan, proposal))) return;
  toast('Plan updated');
  renderPlan();
}

// A later row of one goal's "every week to the race" list, with the goal's text,
// or null. This week's row is not one: Draft my week already drafts it.
function calendarRow(goalId, start) {
  const goal = store.get('goals', []).find(g => g && g.id === goalId);
  if (!goal || !start || start <= weekStartOf(todayStr())) return null;
  const row = raceCalendar(goal).find(r => r.start === start);
  return row ? Object.assign({ goal: goal.text }, row) : null;
}

// Pure: the Home card's target resized by a calendar row's own phase, so a
// drafted Build week is not sized for the Base week Home is showing today. The
// baseline is his log and belongs to no goal; only the multiplier moves.
function calendarWeekTarget(target, row) {
  if (!target || target.reason !== 'ok' || !row || row.multiplier == null) return null;
  return Object.assign({}, target, {
    phase: row.phase, phaseEnds: null, multiplier: row.multiplier,
    volumeTarget: Math.round(target.baseline * row.multiplier),
  });
}

function calendarRowLabel(row) {
  return row.phase ? row.phase + (row.week ? ` week ${row.week} of ${row.weeks}` : '') : 'no phase';
}

async function requestDraft(goalId, start) {
  if (planDraftBusy) return;
  // Only a string is a goal id; anything else (a click event) is Draft my week.
  const fromRow = typeof goalId === 'string';
  const row = fromRow ? calendarRow(goalId, start) : null;
  if (fromRow && !row) { toast('That week is no longer on the calendar'); return; }
  if (row) raceCalendarOpen = goalId;
  planDraftBusy = true;
  renderPlan();
  try {
    const res = await fetch('/api/plan-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goals: draftGoals(),
        today: todayStr(),
        // The kilogram target the Home card is showing him right now, so the
        // week Marcus drafts and the number on Home cannot disagree.
        week: row ? calendarWeekTarget(homeWeekTarget(), row) : homeWeekTarget(),
        // The row's own label rather than its date: the server counting from
        // the date gets a phase that began mid-week this week one week short.
        calendarWeek: row ? { goal: row.goal, start: row.start, phase: row.phase,
                              week: row.week, weeks: row.weeks, raceWeek: row.raceWeek } : undefined,
        context: {
          plan: store.get('plan'),
          sessions: store.get('sessions', []),
          weights: store.get('weights', []),
          goals: store.get('goals', []),
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { toast(body.error || 'Marcus could not draft a week'); return; }
    if (!body.days || !body.days.length) { toast('Marcus did not draft a week'); return; }
    planDraft = { days: body.days, note: body.note || '',
                  weekOf: row ? row.start : null, label: row ? calendarRowLabel(row) : null };
  } catch {
    toast('Marcus could not be reached');
  } finally {
    planDraftBusy = false;
    renderPlan();
  }
}

function acceptDraft() {
  if (!planDraft) return;
  if (!setPlan(applyDraft(store.get('plan'), planDraft.days))) return;
  planDraft = null;
  toast('Plan updated');
  renderPlan();
}

function discardDraft() {
  planDraft = null;
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
//
// The separator refuses to split on punctuation followed by a digit, because
// "1.5 hours" and "82,5 kg" are one number and not two clauses. That did not
// matter while this fed `feel` only -- half of a number carries no feel word --
// and it matters now that the duration, the distance and the weight are read
// from these clauses too.
function pastClauses(text) {
  return String(text == null ? '' : text)
    .split(/[.;,!?]+(?![0-9])|\bso\b|\bbut\b/i)
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

  // What was done is read from `past`, not from `raw`. `pastClauses` was added
  // for `feel` alone -- "I want to take it easy next run" was writing an easy
  // session -- and every reading of the *activity* kept running on the whole
  // sentence. So "Did the plan, tomorrow I will run 5 km" opened a cardio form
  // for a run not yet done, and "Did the plan. Next week I want to do 3x10
  // squats at 80kg" saved a lift called "Next week I want to do squats" into his
  // history, where the exercise library and the stalled-lift report then read it
  // back. One clause filter in one place, or the next reading added here
  // inherits the same bug.
  //
  // A sentence whose every clause is forward-looking now falls through to the
  // refusal at the bottom instead of guessing. That is a real behaviour change
  // and it is the honest direction: a refusal is on the screen and he can retype,
  // a wrong session is saved in silence.
  const past = pastClauses(raw).join('. ');
  const words = sessionSentenceWords(past);
  const date = sessionSentenceDate(words, todayISO || todayStr());

  let feel = null;
  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(FEEL_WORDS, w)) { feel = FEEL_WORDS[w]; break; }
  }
  // Deliberately the whole sentence and not `past`: a sore knee named in a
  // clause about tomorrow is still a sore knee today, which is a different
  // question from what was done in the session. That call was already made and
  // "still reads an injury named in a forward-looking clause" in
  // app-sessionsentence.test.ts is the test that holds it.
  const injury = sessionSentenceWords(raw).some((w) => INJURY_WORDS.indexOf(w) !== -1);
  // The note keeps the raw sentence: he typed it, and the clause filter is my
  // reading of it rather than a correction to it.
  const common = { date, feel, injury, note: raw };

  const followedPlan = /\b(follow(?:ed)?|did|done|completed)\b[^.]{0,20}\bplan\b/i.test(past)
    || /\bas\s+planned\b/i.test(past)
    || /\bplanned\s+session\b/i.test(past);

  let activity = null;
  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(CARDIO_VERBS, w)) { activity = CARDIO_VERBS[w]; break; }
  }

  const spoken = sessionSentenceExercises(past);

  // Both in one sentence is two sessions, and the form can only open one. I
  // refuse rather than pick, because either pick drops something you told me.
  if (activity && spoken.length) {
    return { ok: false, reason: 'I heard a ' + activity.toLowerCase() + ' and lifting in the same sentence. Log them one at a time.' };
  }

  // A named activity wins over a plan reference: "I ran the plan's easy run"
  // is a run, and the plan's strength rows would be the wrong form to open.
  if (activity) {
    const minutes = sessionSentenceMinutes(past);
    const distance = sessionSentenceDistance(past);
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
      const weight = sentenceWeightFor(past, e.name);
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
        <select id="logDay">${plan.days.map(d => `<option value="${esc(d.day)}"${heard && heard.day === d.day ? ' selected' : ''}>${esc(d.day)} — ${esc(d.focus)}</option>`).join('')}</select>
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
      if (prefill.rpe != null) node.querySelector('.ex-rpe').value = prefill.rpe;
    }
    node.querySelector('.ex-remove').addEventListener('click', (e) => e.target.closest('.exercise-row').remove());
    // The ramp is read off the weight box as it is typed rather than on save,
    // because it is only useful before the working set -- after it there is
    // nothing left to warm up for.
    const warmupNode = node.querySelector('.ex-warmup');
    const weightInput = node.querySelector('.ex-weight');
    const nameInput = node.querySelector('.ex-name');
    // How to load the bar for the weight in the box. It depends on the name as
    // well as the weight -- only a barbell lift gets a bar under it -- so both
    // inputs call it, and it is defined here because `showWarmup` needs it and
    // runs first.
    const platesNode = node.querySelector('.ex-plates');
    const showPlates = () => {
      const label = plateLoadLabel(nameInput.value, weightInput.value);
      platesNode.textContent = label;
      platesNode.hidden = !label;
    };
    // How long to rest between sets. It reads the reps box, so it is wired to
    // that input rather than to the weight or the name -- the other three
    // labels on this row all move when the weight does and this one does not.
    const restNode = node.querySelector('.ex-rest');
    const repsInput = node.querySelector('.ex-reps');
    const showRest = () => {
      const label = restLabel(repsInput.value);
      restNode.textContent = label;
      restNode.hidden = !label;
    };
    repsInput.addEventListener('input', showRest);
    showRest();
    const showWarmup = () => {
      const label = warmupLabel(weightInput.value);
      warmupNode.textContent = label;
      warmupNode.hidden = !label;
      showPlates();
    };
    weightInput.addEventListener('input', showWarmup);
    showWarmup();
    // What you lifted last time, read off your own log. The name box is the
    // key, so it is re-read as you type -- renaming a row to an exercise you
    // have done before has to find it.
    const lastNode = node.querySelector('.ex-last');
    const dateInput = document.getElementById('logDate');
    // How to do the lift (idea #193). The handle is hidden unless the name in
    // the box actually has a guide, so an empty row and an exercise Marcus has
    // no cues for both show nothing rather than an icon that opens nothing.
    const formNode = node.querySelector('.ex-form');
    const showForm = () => {
      const guide = formGuide(nameInput.value);
      formNode.hidden = !guide;
      if (guide) formNode.dataset.form = guide.name;
      else delete formNode.dataset.form;
    };
    const showLast = () => {
      const last = lastPerformance(store.get('sessions', []), nameInput.value, dateInput ? dateInput.value : todayStr());
      lastNode.textContent = lastPerformanceLabel(last);
      lastNode.hidden = !last;
      showForm();
      showPlates();
      lastSeen = last;
      showNext();
      return last;
    };
    // What to do about it. It depends on the history *and* on the reps box --
    // the plan is what says how many reps you are supposed to get today -- so
    // both inputs call it, and `showLast` hands it the row it just found rather
    // than re-reading the log.
    const nextNode = node.querySelector('.ex-next');
    let lastSeen = null;
    const showNext = () => {
      // The third argument is the layoff, measured as of the date on the row.
      // `LOAD_FATIGUE_DAYS` is the same window the Training load card calls
      // `resting` on, and it is read here rather than restated in app-core.js so
      // that one number decides both.
      const since = daysSinceSession(store.get('sessions', []), dateInput ? dateInput.value : todayStr());
      const layoff = typeof since === 'number' && since >= LOAD_FATIGUE_DAYS ? since : null;
      const label = nextTargetLabel(nextTarget(lastSeen, repsInput.value, layoff));
      nextNode.textContent = label;
      nextNode.hidden = !label;
    };
    repsInput.addEventListener('input', showNext);
    nameInput.addEventListener('input', showLast);
    const last = showLast();
    // Only ever fill a box that is empty. A weight the plan carried, or one you
    // typed into the sentence box, is yours -- overwriting it with history would
    // be the app arguing with what you just said.
    if (last && !weightInput.value) {
      weightInput.value = String(last.weight);
      showWarmup();
    }
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
      weight: r.querySelector('.ex-weight').value,
      rpe: r.querySelector('.ex-rpe').value
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
    ${exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets.length} sets${e.rpe != null ? ` \u00b7 ${linkGlossary('RPE')} ${e.rpe}` : ''}</span></div>`).join('')}
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

// Which meal the file picker is about to write to. One hidden input serves
// every row, because a file input per meal would put one in the DOM for each
// meal logged today and only ever one of them is used.
let mealPhotoTarget = null;

function wireMealPhotos() {
  const input = document.getElementById('mealPhotoFile');
  if (!input) return;

  view.querySelectorAll('[data-meal-photo]').forEach(btn => {
    btn.addEventListener('click', () => {
      mealPhotoTarget = btn.getAttribute('data-meal-photo');
      input.click();
    });
  });

  view.querySelectorAll('[data-meal-photo-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kept = detachMealPhoto(store.get('meals', []), btn.getAttribute('data-meal-photo-delete'));
      if (!store.set('meals', kept)) return;
      renderNutrition();
    });
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    const target = mealPhotoTarget;
    mealPhotoTarget = null;
    if (!file || !target) return;
    shrinkImage(file, MEAL_PHOTO_MAX_EDGE, (dataUrl) => {
      if (!dataUrl) { toast('Marcus could not read that image.'); return; }
      const result = validateMealPhoto(target, dataUrl, store.get('meals', []), store.get('photos', []));
      if (!result.ok) { toast(result.message); return; }
      const all = attachMealPhoto(store.get('meals', []), result);
      if (!store.set('meals', all)) return;
      renderNutrition();
    });
  });
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
      <button class="btn btn--tonal btn--block" id="scanBarcode"><span class="material-icons-round">photo_camera</span> Scan it with the camera</button>
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
    <input id="mealPhotoFile" type="file" accept="image/*" hidden>
    <div id="mealList">${today.length ? today.map(m => `
      <div class="list-item">
        <div style="display:flex;align-items:center;gap:10px">
          ${m.photo ? `<img class="meal-photo" src="${esc(m.photo)}" alt="Photo of ${esc(m.name)}" loading="lazy">` : ''}
          <div><div>${esc(m.name)}</div><div class="list-item__meta">${esc(m.time)} · P ${m.protein || 0} g · C ${m.carbs || 0} g · F ${m.fat || 0} g</div></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span>${m.calories} kcal</span>
          <button class="icon-btn" data-meal-photo="${esc(String(m.id))}" aria-label="${m.photo ? 'Replace the photo of' : 'Add a photo of'} ${esc(m.name)}"><span class="material-icons-round">photo_camera</span></button>
          ${m.photo ? `<button class="icon-btn" data-meal-photo-delete="${esc(String(m.id))}" aria-label="Remove the photo of ${esc(m.name)}"><span class="material-icons-round">hide_image</span></button>` : ''}
          <button class="icon-btn" onclick="deleteMeal('${m.id}')"><span class="material-icons-round">delete</span></button>
        </div>
      </div>`).join('') : `<div class="empty">No meals logged today.</div>`}</div>
  `;

  wireMealPhotos();

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
  // The scan fills the same field the typing fills and then presses the same
  // button, rather than having a lookup path of its own -- so everything the
  // typed path already handles (an unknown code, a dead database, a row with no
  // calories on it) is handled here for free and cannot drift from it.
  document.getElementById('scanBarcode').addEventListener('click', () => {
    openBarcodeScanner(code => { barcode.value = code; lookUp.click(); });
  });
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
  const weeks = Object.keys(buckets).sort();
  if (!weeks.length) return [];
  // A week he did not train is a real zero, not a missing reading -- unlike the
  // line charts, where a day with no entry is unknown. Leaving it out entirely
  // drew a deload week and a hard week side by side with nothing between them,
  // so the bar chart showed an unbroken run of training that never happened.
  const filled = [];
  const cursor = new Date(weeks[0] + 'T00:00');
  const last = weeks[weeks.length - 1];
  for (;;) {
    const key = fmtDate(cursor);
    filled.push([key, buckets[key] || 0]);
    if (key >= last) break;
    cursor.setDate(cursor.getDate() + 7);
  }
  return filled;
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

// Day keys are done in UTC on purpose: every input here is already an ISO
// date string, so anchoring it at Greenwich midnight keeps the arithmetic on
// whole days and out of reach of a DST jump. `fmtDate` is the other half --
// it turns a Date into the day it fell on locally.
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
    return { fitness: 0, fatigue: 0, ratio: 0, days: 0, daysSinceLast: null, trend: 'none', verdict: 'nothing logged' };
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

  const daysSinceLast = Math.max(0, Math.round(
    (new Date(today + 'T00:00:00Z') - new Date(days[days.length - 1] + 'T00:00:00Z')) / 86400000));

  return { fitness, fatigue, ratio, days: covered, daysSinceLast, trend,
           verdict: loadVerdict(ratio, covered, daysSinceLast) };
}

// The band edges are the acute:chronic ratio literature's, not mine: under 0.8
// is detraining, 0.8-1.3 is the range that builds fitness without an injury
// cost, and above 1.5 is where injury rates climb sharply. They are the
// product decision in this whole card, so they live in one named function
// rather than inline in the arithmetic.
// `resting` is checked before either of the ratio bands, and before the
// thin-history guard, because it is not an inference from the ratio at all --
// it is the fact that no session was logged inside the fatigue window. During a
// layoff both averages simply decay at their own fixed rates, so the ratio
// converges on a number that depends only on how long ago you stopped: eight
// days off Edvard's real data reads 0.81, which is the middle of the band the
// card calls "training hard enough to improve without digging a hole".
function loadVerdict(ratio, coveredDays, daysSinceLast) {
  if (typeof daysSinceLast === 'number' && daysSinceLast >= LOAD_FATIGUE_DAYS) return 'resting';
  if (coveredDays < LOAD_MIN_DAYS) return 'too early';
  if (ratio < 0.8) return 'backing off';
  if (ratio <= 1.3) return 'building';
  if (ratio <= 1.5) return 'overreaching';
  return 'load spike';
}

function loadVerdictLabel(load) {
  if (load.verdict === 'nothing logged') return 'no sessions logged';
  if (load.verdict === 'resting') return 'no sessions in ' + load.daysSinceLast + ' days';
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
const INJURY_WINDOW_DAYS = 7;    // an injury from a month ago is history, not a signal
const TRIM_MIN_SESSIONS = 2;     // one short session is a bad day, not a pattern

// Idea #220 left one thread open: the sentence parser has flagged an injury on
// a session since 09-01 -- "got a small injury in my leg" sets `injury: true`
// -- and nothing in the plan review has ever read it. The flag is something
// Edvard typed rather than something Marcus inferred, so it needs no minimum
// weeks of history the way an adherence pattern does; it is one fact about one
// day, and the window is short for the same reason.
// Newest first, so the reason can name the most recent one.
function recentInjuries(sessions, todayISO, windowDays) {
  const today = dayKey(todayISO || todayStr());
  const first = shiftDay(today, -((windowDays || INJURY_WINDOW_DAYS) - 1));
  return (sessions || [])
    .filter(s => s && s.injury && s.date && s.date >= first && s.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));
}

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

// How long the window the counts came from actually is, in weeks. This is NOT
// `reviewWeeks`, and the difference is the point: `reviewWeeks` measures how much
// history you have, and gates the review on it, while every count in a review
// sentence is taken over the whole `windowDays` window whether you trained in all
// of it or not. Reporting the history figure beside a window count produces a
// sentence that cannot be true -- 27 days of history floors to "3 weeks" while the
// 28-day window it counted holds four Mondays, so "over the last 3 weeks you
// trained on Monday 4 times" is reachable, and "3 times" reads as every Monday
// kept when one was missed. The window is a constant, so this is the honest number
// for the prose.
function reviewWindowWeeks(windowDays) {
  return Math.max(1, Math.round((windowDays || REVIEW_WINDOW_DAYS) / 7));
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
const PROPOSAL_CHIPS = { deload: 'ease off', build: 'add volume', move: 'move a day', rest: 'drop a day', drop: 'drop a lift', trim: 'trim a lift', phase: 'match the phase' };
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

// Both of the reasons to ease off produce the same edit -- one set off every
// exercise -- so they are one proposal with one id rather than two that would
// stack and cut the same week twice. The reason names whichever fired, and both
// when both did.
//
// `load` is null on the early-return path in planReview, where there is not yet
// enough history to compute a ratio. An injury still counts there.
function deloadProposal(plan, load, injuries) {
  const hurt = (injuries || []).slice();
  const overloaded = !!load && (load.verdict === 'load spike' || load.verdict === 'overreaching');
  if (!hurt.length && !overloaded) return null;
  // The only lever the plan has is sets, so a week with nothing cuttable gets no
  // proposal -- the same guard the load-driven deload always had. An injury with
  // no set to take off is still shown on the session card; it is not silently
  // dropped from the app, only from a proposal that would do nothing.
  const cuttable = planTrainingDays(plan).filter(d => (d.exercises || []).some(e => (e.sets || 0) > DELOAD_SET_FLOOR));
  if (!cuttable.length) return null;

  const reasons = [];
  if (hurt.length) {
    const latest = hurt[0];
    // His own words, quoted, because Marcus read a boolean out of them and he is
    // the one who can tell whether that reading was right.
    reasons.push('You flagged an injury on ' + niceDate(latest.date)
      + (latest.note ? ': \u201c' + latest.note + '\u201d' : '') + '.');
    if (hurt.length > 1) {
      reasons.push(hurt.length + ' of your sessions in the last ' + INJURY_WINDOW_DAYS + ' days mention one.');
    }
  }
  if (overloaded) {
    reasons.push('Your fatigue is ' + load.ratio.toFixed(2) + ' times your fitness over the last ' + load.days + ' days. Above 1.5 is the range injuries cluster in.');
  }
  reasons.push('This drops one set from each exercise on ' + cuttable.length + ' day(s), never below ' + DELOAD_SET_FLOOR + '.');
  return {
    id: 'deload',
    kind: 'deload',
    title: 'Take a set off every exercise this week',
    reason: reasons.join(' '),
  };
}

// `move` and `rest` ask whether you keep the day. This asks the same question one
// level down, about a single lift on a day you do keep, and it is the level the
// written week actually rots at: a day survives because you train on it, while
// two of the six exercises on it have not been touched in a month.
//
// Three decisions, and each one is what stops this being noise.
//
// A lift counts as done if it appears in ANY session in the window, not only in
// a session that landed on that weekday. Squatting on Thursday instead of Monday
// means the lift is in your training and the day is wrong -- which is what `move`
// is for -- so proposing to delete it would be the wrong edit read off the right
// number.
//
// It is one proposal per day naming every unlogged lift on it, not one per lift.
// The edit is the same edit either way, and six cards saying "drop one thing off
// Monday" is a review nobody finishes reading.
//
// And it never proposes emptying a day. If nothing the plan writes for Monday has
// ever been logged while you keep training on Monday, the whole day is wrong
// rather than the lifts on it, and an empty day with a focus still on it is a
// worse plan than the one it replaced. That case is deliberately silent here.
function dropProposals(plan, sessions, todayISO, windowDays, weeks) {
  const today = dayKey(todayISO || todayStr());
  const first = shiftDay(today, -((windowDays || REVIEW_WINDOW_DAYS) - 1));
  // Bare objects, not `{}`: the keys are exercise names the user typed, so a lift
  // called `constructor` or `toString` would otherwise read as already-logged off
  // Object.prototype and could never be proposed. Same reason `linkGlossary` does it.
  const done = Object.create(null);
  const loggedOn = {};
  DAY_NAMES.forEach(name => { loggedOn[name] = 0; });
  (sessions || []).forEach(s => {
    if (!s || !s.date || s.date < first || s.date > today) return;
    loggedOn[weekdayOf(s.date)] += 1;
    (s.exercises || []).forEach(e => { if (e && e.name) done[exerciseKey(e.name)] = true; });
  });
  const out = [];
  planTrainingDays(plan).forEach(d => {
    if (!loggedOn[d.day]) return;
    const all = (d.exercises || []).filter(e => e && e.name);
    if (!all.length) return;
    const unlogged = all.filter(e => !done[exerciseKey(e.name)]);
    if (!unlogged.length || unlogged.length === all.length) return;
    const names = unlogged.map(e => e.name);
    out.push({
      id: 'drop-' + d.day,
      kind: 'drop',
      day: d.day,
      names: names,
      title: 'Take ' + listNames(names) + ' off ' + d.day,
      reason: 'Over the last ' + weeks + ' weeks you trained on ' + d.day + ' ' + loggedOn[d.day]
            + ' time' + (loggedOn[d.day] === 1 ? '' : 's') + ' and never logged '
            + listNames(names) + ' on any day. The plan is describing '
            + (names.length === 1 ? 'a lift' : 'lifts') + ' you are not doing. '
            + (all.length - names.length) + ' of the ' + all.length + ' on that day stay.',
    });
  });
  return out;
}

// `drop` asks whether a lift on a day you keep is a lift you do. This asks the
// last question left underneath that: the lift IS one you do, and you have never
// once done the number of sets written next to it. That gap is invisible to
// everything above -- `adherenceByWeekday` counts sessions, so a day you showed
// up for reads as kept whatever you actually did inside it.
//
// Three decisions, same shape as `dropProposals`, and each one is what keeps it
// from being noise.
//
// The evidence is tied to the weekday the prescription is written on, not to any
// session anywhere. A lift can sit on two days at two set counts, and counting a
// Thursday session against Monday's number would trim the wrong day.
//
// Every logged instance has to agree. Sets that vary -- 4, then 3, then 4 -- are
// a week that went badly, not a plan that is wrong, and the plan already has
// `deload` for the first. Only a count you have hit every single time is a
// description of what you do.
//
// And it never trims below `DELOAD_SET_FLOOR`, for the same reason the deload
// does not: one set is not a session, and a plan that says so is worse than the
// one it replaced. It also cannot collide with `drop`, which names only lifts
// with no logged instance at all -- this one needs at least TRIM_MIN_SESSIONS.
function trimProposals(plan, sessions, todayISO, windowDays, weeks) {
  const today = dayKey(todayISO || todayStr());
  const first = shiftDay(today, -((windowDays || REVIEW_WINDOW_DAYS) - 1));
  // Keyed by weekday, then by exercise key: every set count logged for that lift
  // on that weekday. Bare objects for the same reason `dropProposals` uses them.
  const counts = {};
  DAY_NAMES.forEach(name => { counts[name] = Object.create(null); });
  (sessions || []).forEach(s => {
    if (!s || !s.date || s.date < first || s.date > today) return;
    const on = counts[weekdayOf(s.date)];
    (s.exercises || []).forEach(e => {
      if (!e || !e.name || !Array.isArray(e.sets)) return;
      const key = exerciseKey(e.name);
      (on[key] = on[key] || []).push(e.sets.length);
    });
  });
  const out = [];
  planTrainingDays(plan).forEach(d => {
    const lifts = [];
    (d.exercises || []).forEach(e => {
      if (!e || !e.name || !(e.sets > 0)) return;
      const logged = counts[d.day][exerciseKey(e.name)] || [];
      if (logged.length < TRIM_MIN_SESSIONS) return;
      const done = logged[0];
      if (!logged.every(n => n === done)) return;
      if (done >= e.sets || done < DELOAD_SET_FLOOR) return;
      lifts.push({ name: e.name, sets: done, was: e.sets, times: logged.length });
    });
    if (!lifts.length) return;
    out.push({
      id: 'trim-' + d.day,
      kind: 'trim',
      day: d.day,
      lifts: lifts,
      title: 'Write ' + listNames(lifts.map(l => l.name + ' as ' + setsLabel(l.sets))) + ' on ' + d.day,
      reason: 'Over the last ' + weeks + ' weeks you logged '
            + listNames(lifts.map(l => l.name + ' on ' + d.day + ' ' + l.times + ' time'
                + (l.times === 1 ? '' : 's') + ' and did ' + setsLabel(l.sets) + ' every time, where the plan asks for ' + l.was))
            + '. The plan is describing '
            + (lifts.length === 1 ? 'a set' : 'sets') + ' you are not doing.',
    });
  });
  return out;
}

function setsLabel(n) { return n + ' set' + (n === 1 ? '' : 's'); }

// "Dip", "Dip and Row", "Dip, Row and Curl" -- the title reads as a sentence
// rather than as an array, and the same helper writes it into the reason so the
// two can never drift apart.
function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
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
  const windowWeeks = reviewWindowWeeks(windowSize);
  const phaseFirst = phaseProposal(plan, goal, todayISO);
  const injuries = recentInjuries(sessions, todayISO, INJURY_WINDOW_DAYS);
  if (weeks < REVIEW_MIN_WEEKS) {
    const early = phaseFirst ? [phaseFirst] : [];
    const hurtEarly = deloadProposal(plan, null, injuries);
    if (hurtEarly) early.push(hurtEarly);
    return { weeks, proposals: early,
      note: 'Marcus reviews the rest of the plan once you have ' + REVIEW_MIN_WEEKS + ' weeks of sessions logged. ' + weeks + ' so far.' };
  }

  const load = trainingLoad(sessions || [], todayISO);
  const rows = adherenceByWeekday(plan, sessions, todayISO, windowSize);
  const training = planTrainingDays(plan);
  const proposals = phaseFirst ? [phaseFirst] : [];

  const easeOff = deloadProposal(plan, load, injuries);
  if (easeOff) proposals.push(easeOff);

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
        reason: 'Over the last ' + windowWeeks + ' weeks you trained on ' + row.day + ' 0 times and on ' + to.day + ' ' + to.logged + ' times, and the plan calls ' + to.day + ' a rest day. The plan is describing a week you are not having.',
      });
    } else {
      proposals.push({
        id: 'rest-' + row.day,
        kind: 'rest',
        day: row.day,
        title: 'Make ' + row.day + ' a rest day',
        reason: 'Over the last ' + windowWeeks + ' weeks you trained on ' + row.day + ' 0 times. A plan you never keep is not a plan you are behind on.',
      });
    }
  });

  dropProposals(plan, sessions, todayISO, windowSize, windowWeeks).forEach(p => proposals.push(p));
  trimProposals(plan, sessions, todayISO, windowSize, windowWeeks).forEach(p => proposals.push(p));

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
        reason: 'Your fatigue is ' + load.ratio.toFixed(2) + ' times your fitness, below the 0.8 where training stops building, and you kept every planned day over the last ' + windowWeeks + ' weeks. ' + lightest.day + ' is your lightest at ' + totalSets(lightest) + ' sets.',
      });
    }
  }

  return { weeks, proposals, note: proposals.length ? '' : 'Nothing to change. You are keeping the plan and your load is in the range that builds fitness.' };
}

// ---------- a week drafted by the coach (idea #187) ----------
// The one piece of the Plan tab that a model writes. Everything else here is
// arithmetic off Edvard's own log, so it is checkable; a drafted week is not,
// and that is why it goes through a gate rather than into the plan. The draft
// lives in this variable until he presses Use this week or Discard, and it is
// deliberately not stored: a proposal that survives a reload is a plan nobody
// agreed to.
let planDraft = null;
let planDraftBusy = false;
// The goal whose "every week to the race" list a row's Draft button was tapped
// in, so the re-render that shows the busy state does not fold that list shut.
let raceCalendarOpen = null;

// Pure: a plan and the coach's days in, a new plan out. A day the draft does
// not name becomes a rest day rather than keeping last week's exercises --
// "here is your week" has to mean the whole week, or the days it left out read
// as ones it endorsed. Cardio the coach drafts goes on its day, replacing what
// was there; a day it drafted no cardio for keeps Edvard's own, because he put
// it there himself and a draft that says nothing about it has not asked to
// take it away.
function applyDraft(plan, days) {
  const next = JSON.parse(JSON.stringify(plan || {}));
  const drafted = days || [];
  next.days = (next.days || []).map(d => {
    const match = drafted.find(x => x && x.day === d.day);
    // Spreading the existing day first is what keeps its cardio: only focus and
    // exercises are ever overwritten, on a drafted day and on a cleared one.
    if (!match) return Object.assign({}, d, { focus: 'Rest', exercises: [] });
    const day = Object.assign({}, d, {
      focus: match.focus,
      exercises: (match.exercises || []).map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
    });
    if (match.cardio) day.cardio = { activity: match.cardio.activity, minutes: match.cardio.minutes };
    return day;
  });
  return next;
}

// Pure: the week that pressing Use this week actually produces, one row per day
// of the plan. It is built by running applyDraft rather than by re-deriving the
// same rules, so the preview cannot disagree with the write it is previewing.
// The `change` field is the part the old preview had no way to show: a day the
// coach did not name is cleared, and a card that lists only the days he did
// name hides that from the one person who has to agree to it.
function draftPreview(plan, days) {
  const before = (plan && plan.days) || [];
  const after = applyDraft(plan, days).days || [];
  return after.map((d, i) => {
    const named = (days || []).some(x => x && x.day === d.day);
    const had = ((before[i] && before[i].exercises) || []).length > 0;
    const draftedCardio = (days || []).some(x => x && x.day === d.day && x.cardio);
    return Object.assign({}, d, {
      change: named ? 'drafted' : (had ? 'cleared' : 'rest'),
      cardioChange: d.cardio ? (draftedCardio ? 'drafted' : 'kept') : null,
    });
  });
}

// The preview card, as a string. It is a function rather than a block inside
// renderPlan so a test can read the markup Edvard is shown -- there is no DOM
// harness in this suite, and a preview nobody can assert on is how the old one
// came to show four days of a seven-day change.
function draftCard(plan, draft) {
  if (!draft) return '';
  return `
      <div class="card" style="display:block">
        <div class="card__title-row"><h2>Marcus's week${draft.weekOf ? ` of ${niceDate(draft.weekOf)}` : ''}</h2><span class="chip chip--primary">Not applied</span></div>
        ${draft.label ? `<div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">Drafted for ${esc(draft.label)}</div>` : ``}
        ${draft.note ? `<p class="card__note">${esc(draft.note)}</p>` : ``}
        ${draftPreview(plan, draft.days).map(d => `
          <div class="plan-day" style="margin-top:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="plan-day__name">${esc(d.day)}</span>
              <span class="plan-day__focus">${esc(d.focus)}${d.change === 'cleared' ? ' &middot; cleared' : ''}</span>
            </div>
            ${d.exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets}\u00d7${e.reps}</span></div>`).join('')}
            ${d.cardio ? `<div class="exercise-line"><span>${esc(d.cardio.activity)}</span><span>${d.cardio.minutes} min &middot; ${d.cardioChange === 'drafted' ? 'new' : 'kept'}</span></div>` : ``}
            ${d.change === 'cleared' ? `<div class="exercise-line exercise-line--cleared"><span>Marcus left this day out, so what is on it now goes</span></div>` : ``}
          </div>`).join('')}
        ${draft.weekOf ? `<p class="card__note">Marcus keeps one weekly plan, so using this replaces the week you are on now.</p>` : ``}
        <button class="btn btn--filled btn--block" style="margin-top:12px" onclick="acceptDraft()"><span class="material-icons-round">check</span> ${draft.weekOf ? 'Use it as my plan now' : 'Use this week'}</button>
        <button class="btn btn--tonal btn--block" style="margin-top:8px" onclick="discardDraft()">Discard</button>
      </div>`;
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
  } else if (proposal.kind === 'drop') {
    const day = next.days.find(d => d.day === proposal.day);
    if (day) {
      const gone = Object.create(null);
      (proposal.names || []).forEach(n => { gone[exerciseKey(n)] = true; });
      day.exercises = (day.exercises || []).filter(e => !gone[exerciseKey(e.name)]);
    }
  } else if (proposal.kind === 'trim') {
    const day = next.days.find(d => d.day === proposal.day);
    if (day) {
      const to = Object.create(null);
      (proposal.lifts || []).forEach(l => { to[exerciseKey(l.name)] = l.sets; });
      (day.exercises || []).forEach(e => {
        const want = to[exerciseKey(e.name)];
        // Only ever downward. The proposal was measured against the plan as it
        // was when the review ran, and the plan can have been edited since.
        if (want != null && want < (e.sets || 0)) e.sets = want;
      });
    }
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

// The Home card's week, and the one the Draft button sends: one call, so the
// two screens cannot be sized from different goals or sessions.
function homeWeekTarget(todayISO) {
  const today = todayISO || todayStr();
  return weekTarget(homeGoal(today), store.get('plan'), store.get('sessions', []), today);
}

// Idea #209's week-by-week progression: every calendar week from this one to
// the race, with the phase it falls in and how the week is sized. The phase
// follows currentPhase's rule -- the first one whose end date has not passed,
// starting the day after the previous one ended -- so this list and the Home
// card cannot put a week in different phases. This week is judged on today, not
// on its Monday, for the same reason currentPhase is.
function raceCalendar(goal, todayISO) {
  const today = dayKey(todayISO || todayStr());
  if (!goal || !goal.targetDate || goal.targetDate < today) return [];
  const phases = (goal.milestones || []).filter(m => m && m.date).slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = weekStartOf(goal.targetDate);
  const weeks = [];
  for (let k = weekStartOf(today); k <= last; k = shiftDay(k, 7)) {
    const ref = k < today ? today : k;
    const index = phases.findIndex(p => p.date >= ref);
    const row = { start: k, phase: null, week: null, weeks: null, multiplier: null,
                  raceWeek: k === last, then: null };
    // A phase that begins after this row's Monday and before the next one
    // would otherwise never be named -- a four-day Taper in the race week read
    // "Peak" here while Home says Taper on race day -- so the row names it too.
    const end = shiftDay(k, 6);
    const starting = phases.find((p, i) => i > 0 && phases[i - 1].date >= ref
      && shiftDay(phases[i - 1].date, 1) <= end && shiftDay(phases[i - 1].date, 1) <= goal.targetDate);
    if (starting) row.then = { phase: starting.label, from: shiftDay(phases[phases.indexOf(starting) - 1].date, 1) };
    if (index >= 0) {
      const phase = phases[index];
      const from = index > 0 ? shiftDay(phases[index - 1].date, 1) : (goal.created || null);
      row.phase = phase.label;
      row.multiplier = PHASE_VOLUME[phase.label] == null ? null : PHASE_VOLUME[phase.label];
      // Counted over the rows this phase owns, Monday to Monday. A row belongs
      // to the phase its Monday is in, so a phase that starts mid-week owns
      // from the next Monday -- unless it has already started this week, when
      // this row (judged on today) is its first. Counting from the phase's
      // first day instead starts such a phase at "week 2" on this list. The
      // coach's draft line (phasePosition in src/plan-draft.ts) counts the same
      // way, and a test holds the two to the same answer on every day.
      if (from && from <= ref) {
        const thisMonday = weekStartOf(today);
        let first = weekStartOf(shiftDay(from, 6));
        if (first > thisMonday && from <= today) first = thisMonday;
        row.weeks = Math.max(1, Math.floor(daysBetween(first, weekStartOf(phase.date)) / 7) + 1);
        row.week = Math.max(1, Math.min(row.weeks, Math.floor(daysBetween(first, k) / 7) + 1));
      }
    }
    weeks.push(row);
  }
  return weeks;
}

// The Home card's phase multipliers (PHASE_VOLUME) as a short label.
function volumeChangeLabel(multiplier) {
  if (multiplier == null) return 'no volume rule';
  if (multiplier === 1) return 'volume level';
  const pct = Math.round(Math.abs(multiplier - 1) * 100);
  return `volume ${multiplier > 1 ? '+' : '−'}${pct}%`;
}

// Folded by default: a goal a year out is fifty rows (ten years, the most a goal
// may be, is 520), and they are there when he opens them rather than between
// him and the next card.
// Every row after this week carries a Draft button for that week (idea #209);
// this week's row does not, because Draft my week is that button.
function raceCalendarBlock(weeks, goalId) {
  if (!weeks.length) return '';
  return `
    <details class="race-calendar" style="margin:8px 0"${goalId && goalId === raceCalendarOpen ? ' open' : ''}>
      <summary>Every week to the race (${weeks.length})</summary>
      ${weeks.map((w, i) => `
        <div class="exercise-line">
          <span>${niceDate(w.start)}${w.raceWeek ? ' · race week' : ''}</span>
          <span>${w.phase ? esc(w.phase) + (w.week ? ` week ${w.week} of ${w.weeks}` : '') + ' · ' + esc(volumeChangeLabel(w.multiplier)) : 'no phase'}${w.then ? ` · ${esc(w.then.phase)} from ${niceDate(w.then.from)}` : ''}${goalId && i > 0 ? ` <button class="icon-btn" title="Draft this week" aria-label="Draft the week of ${niceDate(w.start)}" onclick="requestDraft('${esc(goalId)}','${w.start}')"${planDraftBusy ? ' disabled' : ''}><span class="material-icons-round">auto_awesome</span></button>` : ''}</span>
        </div>`).join('')}
    </details>`;
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

// ---------- home-screen badge ----------
// The nudges that do not deserve a notification (idea #212): they sit on the
// app icon as a count and cost nothing until Edvard looks at his home screen.
// Two of them at most, and they are deliberately disjoint -- today is excluded
// from the week nudge, so a skipped session is never counted twice, and the
// week is one nudge however many days it covers so the badge cannot read as a
// backlog nobody can clear.
function openNudges(plan, sessions, todayISO) {
  const today = dayKey(todayISO || todayStr());
  const start = weekStartOf(today);
  const byWeekday = {};
  ((plan && plan.days) || []).forEach(d => { if (d && d.day) byWeekday[d.day] = d; });
  const logged = {};
  (sessions || []).forEach(s => { if (s && s.date) logged[dayKey(s.date)] = true; });
  // A cardio-only day is a training day (isTrainingDay), and any session dated
  // that day clears it -- a swim logged on a lifting day still counts as logged.
  const missed = (iso) => isTrainingDay(byWeekday[weekdayOf(iso)]) && !logged[iso];

  const nudges = [];
  if (missed(today)) {
    const focus = (byWeekday[weekdayOf(today)] || {}).focus;
    nudges.push({ kind: 'today', text: focus ? 'Today is ' + focus + ' \u2014 nothing logged yet.'
                                             : 'Today is a training day \u2014 nothing logged yet.' });
  }
  let earlier = 0;
  for (let iso = start; iso < today; iso = shiftDay(iso, 1)) if (missed(iso)) earlier++;
  if (earlier) {
    nudges.push({ kind: 'week', text: earlier === 1
      ? 'One session earlier this week is still unlogged.'
      : earlier + ' sessions earlier this week are still unlogged.' });
  }
  return nudges;
}

// Feature-detected rather than assumed: the Badging API answers only in an
// installed PWA on iOS and not at all in Firefox. And setAppBadge *rejects*
// rather than throwing when Safari has the page open as an ordinary tab, so
// the promise needs a catch or every tab switch logs an unhandled rejection.
// Zero calls clearAppBadge instead of setAppBadge(0), because a browser that
// implements only the clear half still clears.
function applyBadge(nav, count) {
  if (!nav) return false;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (typeof (n > 0 ? nav.setAppBadge : nav.clearAppBadge) !== 'function') return false;
  try {
    const result = n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) { return false; }
  return true;
}

// todayISO is a seam for the tests only -- switchTab calls this with nothing
// and the date is resolved in the body, not bound as a default argument.
function refreshBadge(todayISO) {
  return applyBadge(typeof navigator === 'undefined' ? null : navigator,
                    openNudges(store.get('plan'), store.get('sessions', []), todayISO || todayStr()).length);
}

function trainingLoadCard(load) {
  const alert = load.verdict === 'load spike' || load.verdict === 'overreaching';
  const resting = load.verdict === 'resting';
  const kg = (n) => Math.round(n).toLocaleString() + ' kg/day';
  // Only printed once there is something to print. `daysSinceLast` is null with
  // nothing logged, and 0 is a session today, which the rest of the card
  // already says better than a line reading "0 days ago" would.
  const lastLine = typeof load.daysSinceLast === 'number' && load.daysSinceLast > 0
    ? `<div class="exercise-line"><span>Last session</span><span>${load.daysSinceLast} day${load.daysSinceLast === 1 ? '' : 's'} ago</span></div>`
    : '';
  const trendWord = load.trend === 'rising' ? 'rising' : load.trend === 'falling' ? 'falling'
                  : load.trend === 'flat' ? 'holding' : 'not enough history';
  return `
    <div class="card">
      <div class="card__title-row"><h2>Training load</h2><span class="chip ${alert ? 'chip--alert' : 'chip--primary'}">${esc(loadVerdictLabel(load))}</span></div>
      <div class="exercise-line"><span>Fitness — weighted over 42 days</span><span>${kg(load.fitness)}</span></div>
      <div class="exercise-line"><span>Fatigue — weighted over 7 days</span><span>${kg(load.fatigue)}</span></div>
      <div class="exercise-line"><span>Fatigue vs fitness</span><span>${load.ratio.toFixed(2)}</span></div>
      <div class="exercise-line"><span>Fitness over the last week</span><span>${trendWord}</span></div>
      ${lastLine}
      <p class="card__note">${resting
        ? `Both numbers are still falling from the training you did before you stopped, so the ratio between them says nothing about now. Log a session and this starts describing you again.`
        : `Fitness is what you have built up; fatigue is what you are carrying right now. Between 0.8 and 1.3 you are training hard enough to improve without digging a hole. Above 1.5 is the range injuries cluster in.`}</p>
    </div>`;
}

// Personal bests sit under Training load rather than beside the charts,
// because it is the one thing on this tab that reads without a graph library
// having arrived -- the same call goalProgressCard makes above.
// The bar is drawn in plain CSS for the same reason the goal bars are: Chart.js
// is loaded async and a stalled CDN must not take the number with it. Its width
// is the count against MUSCLE_SETS_MAX, capped, so a group at 30 sets fills the
// bar rather than overflowing the card.
// Idea #193, the browse half. Every button carries `data-form`, which the one
// delegated `[data-form]` listener at the bottom of this file already turns into
// the same sheet the Log row opens -- so there is no second opener and no second
// sheet to keep in step with this one.
function exerciseLibraryCard(library) {
  if (!library.length) return '';
  return `
    <div class="section-title">How to do the lifts</div>
    <div class="card">
      ${library.map(g => `
      <div class="lib-group">
        <div class="lib-group__name">${esc(g.group)}</div>
        ${g.lifts.map(l => `<button class="btn btn--tonal btn--block lib-lift" data-form="${esc(l.name)}"><span class="material-icons-round">fitness_center</span> <span>${esc(l.name)}${l.aka.length ? `<span class="lib-lift__aka">also ${esc(l.aka.join(', '))}</span>` : ''}</span></button>`).join('')}
      </div>`).join('')}
      <p class="card__note">Set-up, execution and the mistakes that actually happen, for every lift Marcus has cues for. The same sheet opens from the dumbbell handle on a Log row once the name in the box matches one of these.</p>
    </div>`;
}

function muscleBalanceCard(balance) {
  const rows = balance.groups;
  // An unplaceable lift is still a set that was logged, so it keeps the card
  // out of its empty state -- otherwise a session of lifts Marcus does not know
  // renders "log a set" at somebody who just did.
  const any = rows.some(r => r.sets > 0) || balance.unmatched.length > 0;
  if (!any) {
    return `
    <div class="card">
      <h2>Weekly balance</h2>
      <div class="empty">Log a set in the last ${balance.days} days and this shows how they split across the body.</div>
    </div>`;
  }
  return `
    <div class="card">
      <h2>Weekly balance</h2>
      ${rows.map(r => `
      <div class="mg-row">
        <div class="exercise-line">
          <span>${esc(r.group)}</span>
          <span>${r.sets} ${r.sets === 1 ? 'set' : 'sets'} · <span class="chip chip--${r.verdict === 'on target' ? 'primary' : 'muted'}">${esc(r.verdict)}</span></span>
        </div>
        <div class="mg-bar"><span style="width:${Math.min(100, Math.round(r.sets / MUSCLE_SETS_MAX * 100))}%"></span></div>
      </div>`).join('')}
      ${balance.unmatched.length ? `<p class="card__note">Not counted, because Marcus does not know which muscle they train: ${esc(balance.unmatched.join(', '))}.</p>` : ''}
      <p class="card__note">Hard sets per muscle group over the last ${balance.days} days, counted as sets and not kilograms — one set of squats outweighs a whole session of raises, so tonnage cannot tell you a leg week from a chest week. ${MUSCLE_SETS_MIN}–${MUSCLE_SETS_MAX} sets a week is the usual range for growth; it is a rule of thumb from group averages, not a target you owe anyone.</p>
    </div>`;
}

function personalBestsCard(rows) {
  if (!rows.length) {
    return `
    <div class="card">
      <h2>Personal bests</h2>
      <div class="empty">Log a set with a weight and a rep count and your best ever shows up here.</div>
    </div>`;
  }
  return `
    <div class="card">
      <h2>Personal bests</h2>
      ${rows.map(r => `
      <div class="exercise-line">
        <span>${esc(r.name)}${r.isNew ? ` <span class="chip chip--primary">new</span>` : ``}</span>
        <span>${esc(personalBestLabel(r))} · ${niceDate(r.date)}</span>
      </div>`).join('')}
      <p class="card__note">The heaviest set you have logged for each lift. Same weight, more reps wins — which is why a bodyweight lift is ranked on reps without needing a second scoreboard.</p>
    </div>`;
}

// Sits under Personal bests, because the two are the same reading taken from
// opposite ends: that card is every lift at its best, this one is every lift
// that has not reached a new best in a while. Plain CSS and no chart, for the
// same reason the cards above it are -- Chart.js arrives async and the thing
// that says "change something" must not be the thing that disappears.
function stalledLiftsCard(report) {
  if (!report.watched) {
    return `
    <div class="card">
      <h2>Stuck lifts</h2>
      <div class="empty">Log a lift with a weight and a rep count and this says when it stops getting better.</div>
    </div>`;
  }
  if (!report.stalled.length) {
    return `
    <div class="card">
      <div class="card__title-row"><h2>Stuck lifts</h2><span class="chip chip--primary">none</span></div>
      <div class="empty">Nothing is stuck. None of your ${report.watched} ${report.watched === 1 ? 'lift has' : 'lifts have'} gone ${report.threshold} sessions without getting heavier or adding a rep.</div>
    </div>`;
  }
  return `
    <div class="card">
      <div class="card__title-row"><h2>Stuck lifts</h2><span class="chip ${report.active ? 'chip--alert' : 'chip--primary'}">${report.active ? `${report.active} of ${report.watched}` : 'none active'}</span></div>
      ${report.stalled.map(r => `
      <div class="exercise-line">
        <span>${esc(r.name)}</span>
        <span>${r.dormant ? `not trained for ${r.daysSinceLast} day${r.daysSinceLast === 1 ? '' : 's'}` : `${r.sessions} sessions`} · ${esc(personalBestLabel(r.best))} · ${niceDate(r.best.date)}</span>
      </div>`).join('')}
      <p class="card__note">Sessions logged since the lift last got heavier or added a rep, and the set it has been stuck on. ${report.threshold} in a row is where holding the weight has stopped being a plan — back the weight off and build it again, or change the rep target. One or two held sessions is the progression working, not a problem.${report.active < report.stalled.length ? ` A lift you have stopped training is listed with how long it has been instead of a session count — it stalled once, but it is not stuck now.` : ''}</p>
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

// Which measurement series the Progress tab is showing. It is a view choice, not
// data, so it is deliberately not stored: reopening the app on the waist is the
// right default and not worth a store key to remember otherwise.
let measureSite = 'waist';
let photoPoseKey = 'front';

// One reading is a starting point, not a trend, and this says so rather than
// printing a change of 0 -- which would read as "you have not moved".
function measurementTrendLine(trend, site) {
  if (!trend) return '<span>Nothing logged yet</span><span></span>';
  const latest = `${trend.latest} ${site.unit}`;
  if (trend.change === null) return `<span>${esc(latest)} on ${esc(niceDate(trend.date))}</span><span>first reading</span>`;
  const arrow = trend.change > 0 ? '+' : '';
  return `<span>${esc(latest)} on ${esc(niceDate(trend.date))}</span><span>${esc(arrow + trend.change + ' ' + site.unit)} since ${esc(niceDate(trend.since))}</span>`;
}

// A single photo gets "first photo" rather than a span, for the same reason a
// single measurement gets a null change: 0 days is a claim about elapsed time
// this has no second reading to make.
function photoSpanLine(span) {
  if (!span) return '<span>No photos yet</span><span>the first one is the baseline</span>';
  if (span.days === null) return `<span>First photo, ${esc(niceDate(span.first))}</span><span>1 photo</span>`;
  return `<span>${esc(niceDate(span.first))} &rarr; ${esc(niceDate(span.last))}</span><span>${span.days} days, ${span.count} photos</span>`;
}

function photoStripHtml(shots) {
  if (!shots.length) return '';
  return '<div class="photo-strip">' + shots.map(p => `
    <figure class="photo-strip__item">
      <img src="${esc(p.dataUrl)}" alt="Progress photo from ${esc(niceDate(p.date))}" loading="lazy">
      <figcaption>${esc(niceDate(p.date))}</figcaption>
      <button class="photo-strip__del" data-photo-delete="${esc(String(p.id))}" aria-label="Delete the photo from ${esc(niceDate(p.date))}"><span class="material-icons-round">close</span></button>
    </figure>`).join('') + '</div>';
}

// The browser holds the only copy of the full-size file and it is the only thing
// here that can resize it, so this is the one part of the feature that has to
// touch the DOM. Everything it decides -- whether the result fits, what it
// costs, what replaces what -- is in app-core.js where a test can reach it.
function shrinkImage(file, maxEdge, done) {
  const reader = new FileReader();
  reader.onerror = () => done(null);
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => done(null);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
      canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { done(null); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try { done(canvas.toDataURL('image/jpeg', 0.72)); } catch (err) { done(null); }
    };
    img.src = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

function renderProgress() {
  const weights = store.get('weights', []);
  const measurements = store.get('measurements', []);
  const measureSeries = measurementSeries(measurements, measureSite);
  const measureTrend = measurementTrend(measurements, measureSite);
  const photos = store.get('photos', []);
  const photoShots = photoSeries(photos, photoPoseKey);
  const photoGap = photoSpan(photos, photoPoseKey);
  const photoUsed = photoTotalBytes(photos);
  const meals = store.get('meals', []);
  const calByDay = {};
  meals.forEach(m => { calByDay[m.date] = (calByDay[m.date] || 0) + m.calories; });
  const calEntries = Object.entries(calByDay).sort(([a],[b]) => a.localeCompare(b));
  const weightDays = dailySeries(weights.map(w => ({ date: w && w.date, value: w && w.kg })));
  const measureDays = dailySeries(measureSeries.map(m => ({ date: m.date, value: m.value })));
  const calDays = dailySeries(calEntries.map(([d, v]) => ({ date: d, value: v })));
  const vols = weeklyVolumes();

  const goals = goalsSorted();

  view.innerHTML = `
    ${goals.length ? `<div class="section-title">Goal progress</div>` + goals.map(g => goalProgressCard(g)).join('') : ''}
    <div class="section-title">Where you stand</div>
    ${trainingLoadCard(trainingLoad(store.get('sessions', [])))}
    ${personalBestsCard(personalBests(store.get('sessions', [])))}
    ${stalledLiftsCard(stalledLifts(store.get('sessions', []), todayStr()))}
    ${muscleBalanceCard(weeklyMuscleSets(store.get('sessions', [])))}
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
      <h2>Body measurements</h2>
      <p class="card__note">The tape says things the scale cannot. Measure the same spot at the same time of day and the trend is the useful part, not any one reading.</p>
      <div class="field" style="margin-top:10px"><label>What did you measure?</label>
        <select id="measureSite">${MEASUREMENT_SITES.map(m => `<option value="${m.key}"${m.key === measureSite ? ' selected' : ''}>${esc(m.label)} (${esc(m.unit)})</option>`).join('')}</select>
      </div>
      <div class="field"><label>Today's reading (${esc(measurementSite(measureSite).unit)})</label>
        <div style="display:flex;gap:8px">
          <input id="measureInput" type="number" step="0.1" placeholder="${measureSite === 'bodyfat' ? 'e.g. 18.5' : 'e.g. 86.5'}">
          <button class="btn btn--filled" id="addMeasure">Save</button>
        </div>
      </div>
      <div class="exercise-line" id="measureTrend">${measurementTrendLine(measureTrend, measurementSite(measureSite))}</div>
      <div class="chart-wrap"><canvas id="measureChart"></canvas></div>
    </div>
    <div class="card">
      <h2>Progress photos</h2>
      <p class="card__note">Same pose, same spot, same light. What two photos eight weeks apart show is the thing the scale and the tape both miss.</p>
      <div class="field" style="margin-top:10px"><label>Which pose?</label>
        <select id="photoPose">${PHOTO_POSES.map(p => `<option value="${p.key}"${p.key === photoPoseKey ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
      </div>
      <input id="photoFile" type="file" accept="image/*" hidden>
      <button class="btn btn--filled btn--block" id="addPhoto"><span class="material-icons-round">photo_camera</span> Add today&rsquo;s ${esc(photoPose(photoPoseKey).label.toLowerCase())} photo</button>
      <div class="exercise-line" id="photoSpanLine">${photoSpanLine(photoGap)}</div>
      ${photoStripHtml(photoShots)}
      <p class="card__note">${esc(photoSizeLabel(photoUsed))} of ${esc(photoSizeLabel(PHOTO_BUDGET_BYTES))} used. Photos ride along in the same synced document as your log, so they have a ceiling.</p>
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
      <button class="btn btn--tonal btn--block" id="testReminder" style="margin-top:10px" hidden><span class="material-icons-round">send</span> Send a test notification</button>
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

  document.getElementById('measureSite').addEventListener('change', (e) => {
    measureSite = e.target.value;
    renderProgress();
  });

  document.getElementById('addMeasure').addEventListener('click', () => {
    const result = validateMeasurement(measureSite, document.getElementById('measureInput').value);
    if (!result.ok) { toast(result.message); return; }
    const all = upsertMeasurement(store.get('measurements', []), { date: todayStr(), site: result.site, value: result.value });
    if (!store.set('measurements', all)) return;
    renderProgress();
  });

  document.getElementById('photoPose').addEventListener('change', (e) => {
    photoPoseKey = e.target.value;
    renderProgress();
  });

  document.getElementById('addPhoto').addEventListener('click', () => {
    document.getElementById('photoFile').click();
  });

  document.getElementById('photoFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    shrinkImage(file, PHOTO_MAX_EDGE, (dataUrl) => {
      if (!dataUrl) { toast('Marcus could not read that image.'); return; }
      const result = validatePhoto(photoPoseKey, dataUrl, store.get('photos', []), todayStr(), store.get('meals', []));
      if (!result.ok) { toast(result.message); return; }
      const all = upsertPhoto(store.get('photos', []), {
        id: uid(), date: result.date, pose: result.pose, dataUrl: result.dataUrl, bytes: result.bytes
      });
      if (!store.set('photos', all)) return;
      renderProgress();
    });
  });

  view.querySelectorAll('[data-photo-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-photo-delete');
      const kept = store.get('photos', []).filter(r => String(r && r.id) !== id);
      if (!store.set('photos', kept)) return;
      recordDeletion('photos', id);
      renderProgress();
    });
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
    scales: { x: { ticks: { color: axisColor, font: { size: 10 }, autoSkip: true, maxTicksLimit: 7, maxRotation: 0 }, grid: { display: false } },
              y: { ticks: { color: axisColor, font: { size: 10 } }, grid: { color: gridColor } } } };

  charts.weight = new Chart(document.getElementById('weightChart'), {
    type: 'line',
    data: { labels: weightDays.labels.map(niceDate), datasets: [{ data: weightDays.values, spanGaps: true, borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,.15)', tension: .3, fill: true, pointRadius: 2 }] },
    options: common
  });
  charts.measure = new Chart(document.getElementById('measureChart'), {
    type: 'line',
    data: { labels: measureDays.labels.map(niceDate), datasets: [{ data: measureDays.values, spanGaps: true, borderColor: '#8E24AA', backgroundColor: 'rgba(142,36,170,.15)', tension: .3, fill: true, pointRadius: 2 }] },
    options: common
  });
  charts.volume = new Chart(document.getElementById('volumeChart'), {
    type: 'bar',
    data: { labels: vols.map(([k]) => niceDate(k)), datasets: [{ data: vols.map(([,v]) => Math.round(v)), backgroundColor: '#FB8C00', borderRadius: 6 }] },
    options: common
  });
  charts.cal = new Chart(document.getElementById('calChart'), {
    type: 'line',
    data: { labels: calDays.labels.map(niceDate), datasets: [{ data: calDays.values, spanGaps: true, borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,.15)', tension: .3, fill: true, pointRadius: 2 }] },
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
const BACKUP_KEYS = ['plan', 'sessions', 'weights', 'measurements', 'photos', 'meals', 'goals', 'chat', 'deletions'];

// The three stores the app can delete from, and the reason this list is three
// names rather than every store: `deleteSession`, `deleteMeal` and `deleteGoal`
// are the only delete buttons in the app, and all three key on an id this
// browser minted. `weights` and `chat` have no delete path at all, so they
// carry no tombstones and nothing below touches them.
const DELETABLE_STORES = ['sessions', 'meals', 'goals', 'photos'];

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

// A failed sync used to be the end of it: `serverStatus` went to 'unreachable'
// and nothing tried again, so a set logged on gym wifi stayed in this browser
// until the next thing typed happened to succeed. localStorage never lost it --
// but the copy on the server is what a second phone reads and what survives
// clearing this browser's site data, so "not lost" is not the same as "saved".
const SYNC_RETRY_BASE_MS = 5000;
const SYNC_RETRY_MAX_MS = 300000;

// Doubling, capped. `attempt` is how many failures have already happened, so
// the first retry sits one base delay out. A huge attempt count overflows to
// Infinity rather than to a negative, and `Math.min` takes the cap, so no
// second guard on the exponent is needed -- I wrote one, mutated it away, and
// every test still passed, which is the definition of a line that does nothing.
// What DOES need guarding is a non-number: `setTimeout` reads NaN as 0 and
// would turn the backoff into a busy loop on the one device already struggling.
function nextSyncRetryDelay(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(SYNC_RETRY_BASE_MS * Math.pow(2, n), SYNC_RETRY_MAX_MS);
}

// What this browser thinks the server is at. It starts at 0, which is also what
// an untouched server answers, so a first push from a fresh browser succeeds.
const syncRev = () => { const v = store.get(SYNC_REV_KEY, 0); return typeof v === 'number' && Number.isFinite(v) ? v : 0; };

// One line the user can read: the app cannot promise a copy exists, so it says
// which of the three states it is actually in rather than a green tick.
function describeServerCopy(status) {
  if (!status || status.state === 'unknown') return 'Server copy: checking...';
  if (status.state === 'unreachable') return 'Server copy: not reachable right now. This browser still has everything, and keeps trying until it saves.';
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
  measurements: { by: ['date', 'site'] },
  photos: { by: ['date', 'pose'] },
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
let retryTimer = null;
let syncFailures = 0;

function cancelSyncRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function scheduleSyncRetry() {
  cancelSyncRetry();
  retryTimer = setTimeout(() => { retryTimer = null; syncNow(); }, nextSyncRetryDelay(syncFailures));
  syncFailures += 1;
}

// Only ever retries something that is actually unsent. A phone comes back to
// the foreground constantly, and pushing the whole state every time it does
// would be a new cost paid by every user for a problem only an offline one has.
function retryServerSyncNow() {
  if (!serverStatus || serverStatus.state !== 'unreachable') return;
  cancelSyncRetry();
  syncFailures = 0;
  syncNow();
}

// A phone that walks out of the gym fires `online`; one that was in a pocket
// fires `visibilitychange`. Both mean the network may be back, and sitting out
// the rest of a five-minute backoff when the answer is already available is the
// difference between a save the user sees and one they do not.
function retryWhenBackOnline(win, doc, retry) {
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('online', () => retry());
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState !== 'visible') return;
      retry();
    });
  }
}

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
    cancelSyncRetry();
    syncFailures = 0;
    if (gained) { toast('Merged in what the other device logged.'); switchTab(currentTab); }
  } else {
    // A refusal and an unreachable server are both retried. A 4xx that will
    // never succeed costs one request every five minutes; a 500 or a dropped
    // connection that WOULD succeed is the whole point of the retry, and
    // deciding which is which from a status code is a guess.
    serverStatus = { state: 'unreachable' };
    scheduleSyncRetry();
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
  // The debounced sync below carries the whole payload, so it supersedes a
  // pending retry. `syncFailures` is deliberately NOT reset: if the network is
  // still down, typing more should not walk the backoff back to five seconds.
  cancelSyncRetry();
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

// A message stored with offline: true came from the built-in rules, not the
// coach. The note is rendered from the stored flag rather than from whatever
// the last request did, so scrolling back up still tells the truth about a
// bubble written days ago.
function renderChatMessages() {
  const msgs = store.get('chat', []);
  chatMessages.innerHTML = msgs.map(m => {
    const note = m.role === 'marcus' && m.offline
      ? '<span class="msg__offline">built-in reply — the coach was not reachable</span>'
      : '';
    return `<div class="msg msg--${m.role === 'marcus' ? 'marcus' : 'user'}">${esc(m.text)}${note}</div>`;
  }).join('');
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
    const bw = bodyweightChange(weights, todayStr());
    const w = bw ? bw.delta.toFixed(1) : null;
    const vol = weeklyVolumes();
    const lastVol = vol.length ? Math.round(vol[vol.length-1][1]) : 0;
    // The same correction the Home tile got: a delta whose last reading is old
    // is not a trend, so the sentence says when the scale stopped rather than
    // quoting the span as if it ran up to today.
    const bwPhrase = !bw ? ''
      : bw.stale ? `bodyweight moved ${w}kg, though you have not weighed in for ${bw.daysSinceLast} days, `
      : `bodyweight moved ${w}kg over ${bw.days} days, `;
    return `You're trending well — ${bwPhrase}and you put up ${lastVol.toLocaleString()}kg of volume this week. Keep stacking sessions.`;
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
//
// Both paths now return { text, offline } rather than a bare string, because
// the two answers are indistinguishable once they are on the screen and they
// are not the same thing. The rule-based reply knows today's plan and this
// week's volume and nothing else; the coach has read the whole log. Edvard is
// the only user and has no other way to tell which one he is talking to, so
// the fallback says so on the bubble instead of quietly passing for a coach.
function marcusReplyAfterAPause(text) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ text: marcusReply(text), offline: true }), 650 + Math.random() * 500);
  });
}

async function askMarcus(text) {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        // This phone's own date. The server runs in UTC and the coach used to
        // get no clock at all, so it read the newest rows in the log as
        // current and called an eight-day-old week "this week".
        today: todayStr(),
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
    if (typeof body.reply === 'string' && body.reply.trim()) return { text: body.reply, offline: false };
    return marcusReplyAfterAPause(text);
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
    const msg = { role: 'marcus', text: reply.text, ts: Date.now() };
    // Only set on the fallback path, so the 13 turns already in the store --
    // every one of them written before the coach existed -- are not
    // retroactively relabelled by a key they do not carry.
    if (reply.offline) msg.offline = true;
    all.push(msg);
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
  const fetchFn = deps && deps.fetchFn;
  if (!notification || !registration) return { state: 'unsupported' };
  if (notification.permission === 'denied') return { state: 'blocked' };
  let sub = null;
  try {
    sub = await registration.pushManager.getSubscription();
  } catch {
    return { state: 'off' };
  }
  if (!sub) return { state: 'off' };

  // The browser saying yes is half the answer and it was the whole answer until
  // now. The other half is the server's list, which is what the 20:00 job sends
  // to -- and Edvard's phone was subscribed in this browser while Marcus held no
  // record of it, so the card read "on for this device" about a device that was
  // never going to hear anything. Ask.
  const body = subscriptionBody(sub);
  if (!body || !fetchFn) return { state: 'on' };
  let known;
  try {
    const res = await fetchFn('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: body.endpoint }),
    });
    // An unreachable or unhappy server says nothing about this subscription, and
    // this browser is still genuinely subscribed. Reporting 'off' here would turn
    // every offline app-open into "your reminders are off", which is a lie in the
    // other direction.
    if (!res || !res.ok) return { state: 'on' };
    const json = await res.json();
    known = json && json.known === true;
  } catch {
    return { state: 'on' };
  }
  if (known) return { state: 'on' };

  // Marcus has never heard of this device, or has forgotten it. The browser holds
  // the only copy of the endpoint, so this is the one moment it can be handed
  // back -- and POST /api/push/subscribe is idempotent, which is what makes a
  // silent repair the right thing rather than a hidden write.
  try {
    const res = await fetchFn('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res && res.ok) return { state: 'on' };
  } catch {
    /* fall through to the honest answer below */
  }
  // The repair failed, so nothing will be delivered to this phone. 'off' is the
  // true state and tapping the toggle re-runs the whole enable path.
  return { state: 'off' };
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

// Issue #154. Turning reminders on produces silence until 20:00 the next day,
// and silence is also what a broken chain produces -- so the button above could
// never tell Edvard whether it had worked. This sends one notification through
// the real path: the same VAPID key, the same encryption, the same service
// worker, the same push service. Nothing about it is a simulation, which is the
// only version of this worth having.
async function sendTestReminder(deps) {
  const { registration, fetchFn } = deps;
  let sub = null;
  try {
    sub = await registration.pushManager.getSubscription();
  } catch {
    sub = null;
  }
  // The endpoint IS the credential here, so a browser that cannot produce one
  // has nothing to ask with -- and it is also the honest answer to the user:
  // this device is not subscribed.
  const body = sub ? subscriptionBody(sub) : null;
  if (!body) return { ok: false, state: 'off', message: 'This device is not subscribed, so there is nothing to test yet.' };
  let res;
  try {
    res = await fetchFn('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: body.endpoint }),
    });
  } catch {
    return { ok: false, state: 'on', message: 'Marcus could not be reached. Reminders are still on.' };
  }
  if (res && res.ok) return { ok: true, state: 'on', message: 'Sent. It should appear within a few seconds.' };
  // 410 is the one answer that changes what this device is, rather than just
  // failing: the push service has retired this subscription, the server has
  // already dropped it, and the card must stop saying reminders are on.
  if (res && res.status === 410) return { ok: false, state: 'off', message: 'This phone\'s subscription has expired. Turn reminders on again.' };
  if (res && res.status === 404) return { ok: false, state: 'off', message: 'Marcus has no record of this device. Turn reminders on again.' };
  if (res && res.status === 409) return { ok: false, state: 'on', message: 'A notification is already on its way.' };
  return { ok: false, state: 'on', message: 'The push service would not take it. Nothing about your reminders has changed.' };
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
  // Only offered when there is something to test. Drawn from the same status
  // the toggle is drawn from, so the two can never disagree.
  const test = document.getElementById('testReminder');
  if (test) test.hidden = state !== 'on';
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
  const test = document.getElementById('testReminder');
  test?.addEventListener('click', async () => {
    const deps = await reminderDeps();
    if (!deps) { renderReminders({ state: 'unsupported' }); return; }
    test.disabled = true;
    const result = await sendTestReminder(deps);
    test.disabled = false;
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

// ---------- term explainers (idea #197) ----------
// One listener on the document rather than one per button: the terms are
// rendered inside innerHTML that is rebuilt on every tab switch, so a handler
// bound to a button would be thrown away with it. This also means a `data-term`
// written straight into index.html works with no extra wiring.
const termSheet = document.getElementById('termSheet');

function openTerm(word) {
  const entry = glossaryTerm(word);
  if (!entry) return false;
  document.getElementById('termTitle').textContent = entry.title;
  document.getElementById('termBody').textContent = entry.body;
  termSheet.hidden = false;
  document.getElementById('termClose').focus();
  return true;
}
function closeTerm() { termSheet.hidden = true; }

// The form cues reuse the glossary's sheet rather than adding a second one --
// same panel, same scrim, same Escape key. Only the text differs.
function openForm(name) {
  const entry = formGuide(name);
  if (!entry) return false;
  document.getElementById('termTitle').textContent = entry.name;
  document.getElementById('termBody').textContent = formGuideBody(entry);
  termSheet.hidden = false;
  document.getElementById('termClose').focus();
  return true;
}

document.addEventListener('click', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (form) { if (openForm(form.dataset.form)) ev.preventDefault(); return; }
  const handle = ev.target.closest('[data-term]');
  if (!handle) return;
  if (openTerm(handle.dataset.term)) ev.preventDefault();
});
document.getElementById('termClose').addEventListener('click', closeTerm);
termSheet.querySelector('.term-sheet__scrim').addEventListener('click', closeTerm);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !termSheet.hidden) closeTerm(); });

// ---------- boot ----------
switchTab('home');
adoptServerCopyOnBoot().catch(() => {});
retryWhenBackOnline(window, document, retryServerSyncNow);
document.getElementById('updateReload')?.addEventListener('click', () => window.location.reload());
if ('serviceWorker' in navigator) {
  watchForUpdate(navigator.serviceWorker, showUpdateBanner);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { if (reg) recheckOnVisible(document, reg); })
      .catch(() => {});
  });
}

// --- The camera half of the barcode field (idea #204) ------------------------
// app-core.js holds the decoder, which is pure and tested. Everything here is
// the part that cannot be: opening the camera, drawing a frame, and closing it
// again. Keeping the split at exactly that line is deliberate -- there is no
// decision in this file, so there is nothing here for a test to be missing.

// How often to read a frame. The decoder is well under a millisecond, so this
// is paced by the camera and by not heating the phone, not by the maths.
const SCAN_INTERVAL_MS = 120;
// A scan that has found nothing for this long is not going to. Saying so and
// closing beats a camera left running against a barcode it cannot read.
const SCAN_GIVE_UP_MS = 25000;

let scanTeardown = null;

// One frame: video -> canvas -> the decoder. Split out so it can be handed a
// fake video and a fake canvas; the browser is the only thing it needs from the
// page, and it takes both of them as arguments.
function readBarcodeFrame(video, canvas) {
  const w = video.videoWidth | 0;
  const h = video.videoHeight | 0;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || typeof ctx.drawImage !== 'function') return null;
  ctx.drawImage(video, 0, 0, w, h);
  let frame;
  try {
    frame = ctx.getImageData(0, 0, w, h);
  } catch (err) {
    // A cross-origin frame taints the canvas. It cannot happen with our own
    // camera stream, and if it ever does, this stops rather than throwing on
    // every tick for twenty-five seconds.
    return null;
  }
  return decodeEan13Frame(frame.data, w, h);
}

function closeBarcodeScanner() {
  if (scanTeardown) { const stop = scanTeardown; scanTeardown = null; stop(); }
}

async function openBarcodeScanner(onFound) {
  const sheet = document.getElementById('scanSheet');
  const video = document.getElementById('scanVideo');
  const hint = document.getElementById('scanHint');
  if (!sheet || !video) return;
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') {
    toast('This browser will not open the camera \u2014 type the barcode in instead.');
    return;
  }
  let stream;
  try {
    // `ideal` rather than `exact`: a laptop with only a front camera should
    // still open one, and it is the phone that has a rear camera to prefer.
    stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } });
  } catch (err) {
    // Permission is the one failure worth naming on its own: it is a thing he
    // can change, and every other failure here is not.
    toast(err && err.name === 'NotAllowedError'
      ? 'Marcus needs permission to use the camera \u2014 type the barcode in instead.'
      : 'Could not open the camera \u2014 type the barcode in instead.');
    return;
  }

  const canvas = document.createElement('canvas');
  const close = document.getElementById('scanClose');
  const scrim = sheet.querySelector('.scan-sheet__scrim');
  let timer = null;
  let giveUp = null;

  const teardown = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (giveUp) { clearTimeout(giveUp); giveUp = null; }
    // Stopping every track is what turns the camera light off. Hiding the sheet
    // does not, and a page holding a live camera it is not showing is the worst
    // outcome this file can produce.
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    sheet.hidden = true;
    if (close) close.onclick = null;
    if (scrim) scrim.onclick = null;
  };
  scanTeardown = teardown;

  video.srcObject = stream;
  sheet.hidden = false;
  if (hint) hint.textContent = "Hold the packet steady, about a hand's width away.";
  if (close) close.onclick = closeBarcodeScanner;
  if (scrim) scrim.onclick = closeBarcodeScanner;
  if (typeof video.play === 'function') { try { video.play(); } catch (err) { /* autoplay attribute covers it */ } }

  timer = setInterval(() => {
    const code = readBarcodeFrame(video, canvas);
    if (!code) return;
    closeBarcodeScanner();
    onFound(code);
  }, SCAN_INTERVAL_MS);

  giveUp = setTimeout(() => {
    closeBarcodeScanner();
    toast('Could not read that barcode \u2014 type the digits in instead.');
  }, SCAN_GIVE_UP_MS);
}
