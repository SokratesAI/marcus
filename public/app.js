// ---------- storage helpers ----------
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
  bodyweight: { min: 20, max: 400, label: 'Weight', unit: 'kg' }
};

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

function validateMeal(name, rawCalories) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return { ok: false, message: 'Give the meal a name.' };
  const r = checkNumber(rawCalories, 'calories');
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, meal: { name: trimmed, calories: r.value } };
}

function validateBodyweight(rawKg) {
  const r = checkNumber(rawKg, 'bodyweight');
  return r.ok ? { ok: true, kg: r.value } : r;
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
        meals.push({ id: uid(), date: fmtDate(d), time: `${7 + m * 4}:00`, name, calories: cal, protein: p, carbs: c, fat: f });
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

    <div class="section-title">Today's nutrition</div>
    <div class="card">
      <div class="card__title-row"><h2>${kcal} kcal logged</h2><button class="btn btn--tonal" onclick="switchTab('nutrition')">Add meal</button></div>
      ${meals.length ? meals.map(m => `<div class="exercise-line"><span>${esc(m.name)}</span><span>${m.calories} kcal</span></div>`).join('') : `<div class="empty">Nothing logged yet today.</div>`}
    </div>
  `;
}

// ---------- plan ----------
function renderPlan() {
  const plan = store.get('plan');
  const todayName = planDayName();
  view.innerHTML = `
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
}

// ---------- log ----------
function renderLog() {
  const plan = store.get('plan');
  view.innerHTML = `
    <div class="card">
      <h2>Log a session</h2>
      <div class="field">
        <label>Date</label>
        <input type="date" id="logDate" value="${todayStr()}">
      </div>
      <div class="field">
        <label>Day / focus</label>
        <select id="logDay">${plan.days.map(d => `<option value="${d.day}">${d.day} — ${d.focus}</option>`).join('')}</select>
      </div>
      <div id="exerciseRows"></div>
      <button type="button" class="btn btn--tonal" id="addExercise"><span class="material-icons-round">add</span> Add exercise</button>
      <button type="button" class="btn btn--filled btn--block" id="saveSession" style="margin-top:14px">Save session</button>
    </div>
    <div class="section-title">Recent sessions</div>
    <div id="recentSessions"></div>
  `;

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
  const todayName = planDayName();
  const todayPlan = plan.days.find(d => d.day === todayName) || plan.days[0];
  (todayPlan.exercises.length ? todayPlan.exercises : [{ name: '', sets: 3, reps: 10 }]).forEach(addRow);

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
    sessions.push({ id: uid(), date: document.getElementById('logDate').value, day: document.getElementById('logDay').value, exercises: result.exercises });
    if (!store.set('sessions', sessions)) return;
    switchTab('log');
  });

  const recent = store.get('sessions', []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  document.getElementById('recentSessions').innerHTML = recent.length ? recent.map(s => {
    const volume = s.exercises.reduce((sum, e) => sum + e.sets.reduce((ss, st) => ss + st.reps * st.weight, 0), 0);
    return `<div class="card">
      <div class="card__title-row"><h2>${niceDate(s.date)} · ${s.day}</h2>
        <button class="icon-btn" onclick="deleteSession('${s.id}')"><span class="material-icons-round">delete</span></button>
      </div>
      ${s.exercises.map(e => `<div class="exercise-line"><span>${esc(e.name)}</span><span>${e.sets.length} sets</span></div>`).join('')}
      <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">Volume: ${Math.round(volume).toLocaleString()} kg</div>
    </div>`;
  }).join('') : `<div class="empty">No sessions logged yet.</div>`;
}
function deleteSession(id) {
  store.set('sessions', store.get('sessions', []).filter(s => s.id !== id));
  renderLog();
}

// ---------- nutrition ----------
function renderNutrition() {
  const meals = store.get('meals', []);
  const today = meals.filter(m => m.date === todayStr()).sort((a, b) => a.time.localeCompare(b.time));
  const goal = 2400;
  const kcal = today.reduce((s, m) => s + m.calories, 0);
  const pct = Math.min(100, Math.round((kcal / goal) * 100));

  view.innerHTML = `
    <div class="card">
      <div class="card__title-row"><h2>Today</h2><span class="chip chip--primary">${kcal} / ${goal} kcal</span></div>
      <div style="height:8px;border-radius:4px;background:var(--md-surface-variant);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:var(--md-secondary)"></div>
      </div>
    </div>
    <div class="card">
      <h2>Add a meal</h2>
      <div class="field"><label>What did you eat</label><input id="mealName" type="text" placeholder="e.g. Chicken, rice, broccoli"></div>
      <div class="field"><label>Calories (kcal)</label><input id="mealCal" type="number" min="0" placeholder="e.g. 600"></div>
      <button class="btn btn--filled btn--block" id="addMeal"><span class="material-icons-round">add</span> Add meal</button>
    </div>
    <div class="section-title">Logged today</div>
    <div id="mealList">${today.length ? today.map(m => `
      <div class="list-item">
        <div><div>${esc(m.name)}</div><div class="list-item__meta">${esc(m.time)}</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span>${m.calories} kcal</span>
          <button class="icon-btn" onclick="deleteMeal('${m.id}')"><span class="material-icons-round">delete</span></button>
        </div>
      </div>`).join('') : `<div class="empty">No meals logged today.</div>`}</div>
  `;

  document.getElementById('addMeal').addEventListener('click', () => {
    const result = validateMeal(document.getElementById('mealName').value, document.getElementById('mealCal').value);
    if (!result.ok) { toast(result.message); return; }
    const all = store.get('meals', []);
    const now = new Date();
    all.push({ id: uid(), date: todayStr(), time: `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`, name: result.meal.name, calories: result.meal.calories, protein: 0, carbs: 0, fat: 0 });
    if (!store.set('meals', all)) return;
    renderNutrition();
  });
}
function deleteMeal(id) {
  store.set('meals', store.get('meals', []).filter(m => m.id !== id));
  renderNutrition();
}

// ---------- progress ----------
function weeklyVolumes() {
  const sessions = store.get('sessions', []);
  const buckets = {};
  sessions.forEach(s => {
    const d = new Date(s.date + 'T00:00');
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = fmtDate(monday);
    const vol = s.exercises.reduce((sum, e) => sum + e.sets.reduce((ss, st) => ss + st.reps * st.weight, 0), 0);
    buckets[key] = (buckets[key] || 0) + vol;
  });
  return Object.entries(buckets).sort(([a],[b]) => a.localeCompare(b));
}

function renderProgress() {
  const weights = store.get('weights', []);
  const meals = store.get('meals', []);
  const calByDay = {};
  meals.forEach(m => { calByDay[m.date] = (calByDay[m.date] || 0) + m.calories; });
  const calEntries = Object.entries(calByDay).sort(([a],[b]) => a.localeCompare(b));
  const vols = weeklyVolumes();

  view.innerHTML = `
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
  `;

  document.getElementById('addWeight').addEventListener('click', () => {
    const result = validateBodyweight(document.getElementById('weightInput').value);
    if (!result.ok) { toast(result.message); return; }
    const all = store.get('weights', []);
    all.push({ date: todayStr(), kg: result.kg });
    if (!store.set('weights', all)) return;
    renderProgress();
  });

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
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (hadController) onUpdate();
  });
}

// The browser only re-checks sw.js on navigation, and an installed PWA that is
// left open and switched back to never navigates. Asking on every return to the
// foreground is what makes the banner appear without a manual reload.
function recheckOnVisible(doc, registration) {
  if (!doc || typeof doc.addEventListener !== 'function') return;
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    try { Promise.resolve(registration.update()).catch(() => {}); } catch (e) { /* nothing to do */ }
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
