/* Calorie Tracker — no build step, no backend, no accounts.
   State lives in localStorage under one key. */
(() => {
'use strict';

const KEY = 'calorie-tracker/v1';
const DEFAULTS = { dailyTarget: 2550, maintenance: 2600, activityFactor: 0.75, weekStart: 1, weightUnit: 'kg' };
const WEIGHT_UNITS = ['kg', 'lb', 'st'];

/* The target is one fixed number. Older saves (and older devices still
   syncing) carry baseCalories/activityMultiplier from when the target grew
   with activity; those are dropped here so the goal can't drift back. */
function cleanSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  const t = Number(src.dailyTarget);
  const m = Number(src.maintenance);
  const f = Number(src.activityFactor);
  const w = Number(src.weekStart);
  return {
    dailyTarget: Number.isFinite(t) && t > 0 ? t : DEFAULTS.dailyTarget,
    maintenance: Number.isFinite(m) && m > 0 ? m : DEFAULTS.maintenance,
    activityFactor: Number.isFinite(f) && f >= 0 && f <= 2 ? f : DEFAULTS.activityFactor,
    weekStart: w === 0 || w === 1 ? w : DEFAULTS.weekStart,
    weightUnit: WEIGHT_UNITS.includes(src.weightUnit) ? src.weightUnit : DEFAULTS.weightUnit
  };
}

/* ─────────────────────────  dates  ─────────────────────────
   Everything is keyed on the *local* calendar day (YYYY-MM-DD).
   Never round-trip through Date.toISOString() — that shifts the day for
   anyone east or west of UTC, which silently files evening meals under
   tomorrow. */
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());

/* A day still in progress is not a deficit. Until this hour (local, 24-hour
   clock) the current day is held out of the week's totals: at noon you have
   eaten a third of your food and logged none of the afternoon's activity, so
   the day reads as a ~3000 kcal deficit that hasn't happened yet.
   Holding the whole day out until it's over keeps a half-eaten day from
   reading as a finished one.
   Move this to change when today folds in: 0 counts today from midnight,
   24 never counts it. */
const SETTLE_HOUR = 21;
const todaySettled = () => new Date().getHours() >= SETTLE_HOUR;
const fmtHour = h => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

function startOfWeek(k, weekStart) {
  const d = parseKey(k);
  const shift = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - shift);
  return keyOf(d);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtLong = k => parseKey(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
const fmtShort = k => parseKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function relativeLabel(k) {
  const t = todayKey();
  if (k === t) return 'Today';
  if (k === addDays(t, -1)) return 'Yesterday';
  if (k === addDays(t, 1)) return 'Tomorrow';
  // The full date is already the heading above this; repeating it says nothing.
  const n = Math.round((parseKey(t) - parseKey(k)) / 864e5);
  return n > 0 ? `${n} days ago` : `in ${-n} days`;
}

/* ─────────────────────────  state  ───────────────────────── */
let state = load();
let cursor = todayKey();                       // selected day
let followToday = true;                        // false once the user picks a day themselves
let editingId = null;                          // entry currently open for inline editing
let weekCursor = startOfWeek(cursor, state.settings.weekStart);
let pendingImport = null;                      // rows awaiting confirmation

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); }
  catch { /* corrupt payload — fall through to a clean slate rather than dying */ }
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    settings: cleanSettings(s.settings),
    settingsU: Number(s.settingsU) || 0,
    days: (s.days && typeof s.days === 'object') ? s.days : {}
  };
}

function pruneTombstones() {
  const cutoff = addDays(todayKey(), -90);
  for (const k of Object.keys(state.days)) {
    const d = state.days[k];
    if (k < cutoff && !d.entries.length && !d.activity && !d.recorded && !d.weight) delete state.days[k];
  }
}

function save() {
  try {
    pruneTombstones();
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    // Quota, or Safari private mode. Say so instead of losing the entry silently.
    toast('Could not save — browser storage is blocked or full');
    console.error(err);
  }
}

const dayOf = k => state.days[k] || { entries: [], activity: null };

function mutateDay(k, fn) {
  const day = state.days[k] || (state.days[k] = { entries: [], activity: null });
  fn(day);
  day.u = Date.now();          // merge timestamp — see mergeStates()
  /* An emptied day is kept, not deleted: it is the tombstone that stops a
     sync from resurrecting entries you deleted on another device. Old ones
     are pruned in save(). */
  save();
  queuePush();
}

/* ─────────────────────────  the calorie model  ─────────────────────────
   target  = fixed daily target (Settings) — activity never moves it
   balance = eaten − target   (positive = surplus, negative = deficit)
   allowance = maintenance + factor × activity   (factor defaults to 0.75)
   net       = eaten − allowance
   The target is what you aim to eat. Net is the energy balance, shown as
   secondary information on Today and as the headline of the Week view — it
   never feeds back into the target. Only part of activity counts because
   wearables overestimate burn and maintenance already covers some movement. */
function activeCalsOf(k) {
  const a = dayOf(k).activity;
  return a && Number.isFinite(a.calories) ? Math.max(0, a.calories) : 0;
}
const eatenOf = k => dayOf(k).entries.reduce((sum, e) => sum + e.calories * (e.qty || 1), 0);
const targetOf = () => state.settings.dailyTarget;

/* Days imported from old notes carry only a net (`recorded`), no food or
   activity. Food logged on such a day takes over and the recorded net is
   ignored, so the two can never be added together. */
function recordedOf(k) {
  const r = dayOf(k).recorded;
  return r && Number.isFinite(r.net) ? r : null;
}

function summaryOf(k) {
  const eaten = eatenOf(k), target = targetOf();
  const active = activeCalsOf(k);
  const allowance = state.settings.maintenance + state.settings.activityFactor * active;
  const hasFood = dayOf(k).entries.length > 0;
  const rec = hasFood ? null : recordedOf(k);
  return {
    eaten, target, active, allowance,
    balance: eaten - target,
    net: rec ? rec.net : eaten - allowance,
    logged: hasFood || !!rec,
    netOnly: !!rec,
    estimate: !!(rec && rec.estimate)
  };
}

/* Totals over a set of day summaries. Net counts every day; eaten, activity
   and allowance only exist for days with food logged, so they are summed
   over those alone and `full` says how many that was. */
function totalsOf(rows) {
  const full = rows.filter(r => !r.netOnly);
  return {
    days: rows.length,
    full: full.length,
    imported: rows.length - full.length,
    net: rows.reduce((a, r) => a + r.net, 0),
    eaten: full.reduce((a, r) => a + r.eaten, 0),
    allowance: full.reduce((a, r) => a + r.allowance, 0),
    active: full.reduce((a, r) => a + r.active, 0)
  };
}

const round = n => Math.round(n);
const withSign = n => { const r = round(n) || 0; return (r > 0 ? '+' : '') + r.toLocaleString(); };  // || 0: no "-0"
const kcal = n => round(n).toLocaleString();

/* ─────────────────────────  dom helpers  ───────────────────────── */
const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ─────────────────────────  today view  ───────────────────────── */
function renderToday() {
  const s = summaryOf(cursor);

  $('#datePicker').value = cursor;
  $('#datePicker').max = todayKey();
  $('#dateText').textContent = parseKey(cursor).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('#dayRelative').textContent = relativeLabel(cursor);
  $('#nextDay').disabled = cursor >= todayKey();

  // An imported day has nothing to eat against — show its recorded net instead.
  const card = $('#balanceCard');
  card.classList.toggle('is-imported', s.netOnly);
  $('#recordedNote').hidden = !s.netOnly;
  if (s.netOnly) {
    const over = s.net > 0;
    card.classList.toggle('is-over', over);
    card.classList.toggle('is-under', !over);
    $('#balanceNum').textContent = kcal(Math.abs(s.net));
    $('#balanceWord').textContent = `kcal ${over ? 'surplus' : 'deficit'}${s.estimate ? ' (estimate)' : ''}`;
    $('#barFill').style.width = '0%';
    renderActivityAndLists(s);
    return;
  }

  // Headline: how many calories left, or how far over.
  const over = s.balance > 0;
  card.classList.toggle('is-over', over);
  card.classList.toggle('is-under', !over);
  $('#balanceNum').textContent = kcal(Math.abs(s.balance));
  $('#balanceWord').textContent = over ? 'kcal over target' : 'kcal left to eat';

  // One bar: how much of the day's allowance is gone. It fills and turns red
  // rather than growing past the track, which would need a shifting scale.
  const pct = s.target > 0 ? Math.min(100, (s.eaten / s.target) * 100) : 0;
  $('#barFill').style.width = pct + '%';

  $('#sumTarget').textContent = kcal(s.target);
  $('#sumEaten').textContent = kcal(s.eaten);
  $('#sumLeftLabel').textContent = over ? 'Over' : 'Left';
  $('#sumLeft').textContent = kcal(Math.abs(s.balance));

  // Secondary: the day's real energy balance. Deliberately small — it is
  // context, not the number to eat to.
  const netEl = $('#dayNet');
  netEl.className = s.net > 0 ? 'pos' : 'neg';
  netEl.textContent = `${kcal(Math.abs(s.net))} ${s.net > 0 ? 'surplus' : 'deficit'}`;
  $('#dayActive').textContent = kcal(s.active);
  $('#dayNetMath').textContent =
    `${kcal(s.eaten)} eaten − (${kcal(state.settings.maintenance)} maintenance + ` +
    `${state.settings.activityFactor} × ${kcal(s.active)} activity)`;

  renderActivityAndLists(s);
}

function renderActivityAndLists(s) {
  // Activity
  const act = dayOf(cursor).activity;
  $('#activityInput').value = act ? act.calories : '';
  $('#activitySource').textContent = !act ? 'not set' : (act.source === 'samsung' ? 'Samsung Health' : 'manual');
  $('#activityNote').textContent =
    `Counts toward the day's net only — your target stays ${kcal(s.target)}.`;

  renderWeightCard();

  renderEntries();
  renderQuickAdd();
}

function renderEntries() {
  const list = $('#entryList');
  const entries = dayOf(cursor).entries;
  list.textContent = '';
  $('#entryEmpty').hidden = entries.length > 0;
  $('#entryTotal').textContent = kcal(eatenOf(cursor)) + ' kcal';

  entries.forEach(e => {
    if (e.id === editingId) { list.append(buildEditRow(e)); return; }

    const li = el('li', 'entry');
    const main = el('div', 'entry-main');
    main.append(el('span', 'entry-name', e.name));

    const qty = e.qty || 1;
    const sub = qty !== 1 ? `${qty} × ${kcal(e.calories)} kcal` : (e.time || '');
    if (sub) main.append(el('span', 'entry-sub', sub));

    const cal = el('span', 'entry-cal', kcal(e.calories * qty));
    const acts = el('div', 'entry-act');

    const edit = el('button', 'mini', '✎');
    edit.title = 'Edit'; edit.setAttribute('aria-label', `Edit ${e.name}`);
    edit.onclick = () => { editingId = e.id; renderEntries(); };

    const del = el('button', 'mini del', '×');
    del.title = 'Delete'; del.setAttribute('aria-label', `Delete ${e.name}`);
    del.onclick = () => removeEntry(e.id);

    acts.append(edit, del);
    li.append(main, cal, acts);
    list.append(li);
  });
}

/* Quick-add: the six things logged most often across all history.
   Cheap personalisation that beats shipping a food database nobody agrees with. */
function renderQuickAdd() {
  const counts = new Map();
  Object.values(state.days).forEach(d => d.entries.forEach(e => {
    const k = e.name.trim().toLowerCase();
    const prev = counts.get(k);
    if (prev) { prev.n++; prev.calories = e.calories; }
    else counts.set(k, { n: 1, name: e.name.trim(), calories: e.calories });
  }));

  const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6);

  const box = $('#quickAdd');
  box.textContent = '';
  top.forEach(f => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.innerHTML = `${escapeHtml(f.name)} <b>${kcal(f.calories)}</b>`;
    b.onclick = () => addEntry(f.name, f.calories, 1);
    box.append(b);
  });

  // Feed the same list into the name field's autocomplete.
  const dl = $('#favourites');
  dl.textContent = '';
  [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 40).forEach(f => {
    const o = document.createElement('option');
    o.value = f.name;
    dl.append(o);
  });
}

const escapeHtml = s => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ─────────────────────────  entry actions  ───────────────────────── */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function addEntry(name, calories, qty) {
  mutateDay(cursor, d => d.entries.push({
    id: newId(),
    name: name.trim(),
    calories: Math.round(calories),
    qty: qty || 1,
    time: new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }));
  render();
  toast(`Added ${name.trim()} · ${kcal(calories * (qty || 1))} kcal`);
}

function removeEntry(id) {
  const e = dayOf(cursor).entries.find(x => x.id === id);
  mutateDay(cursor, d => { d.entries = d.entries.filter(x => x.id !== id); });
  render();
  if (e) toast(`Removed ${e.name}`);
}

/* Editing happens inline: the row swaps into a small form. Three stacked
   prompt() dialogs technically worked, but adjusting an entry is a core
   action here, not an edge case. */
function saveEdit(id, name, cals, qty) {
  const e = dayOf(cursor).entries.find(x => x.id === id);
  if (!e) return false;
  const c = Number(cals), q = Number(qty);
  if (!String(name).trim() || !Number.isFinite(c) || c < 0 || !Number.isFinite(q) || q <= 0) {
    toast('Needs a name, a calorie number and servings above zero');
    return false;
  }
  mutateDay(cursor, () => { e.name = String(name).trim(); e.calories = Math.round(c); e.qty = q; });
  editingId = null;
  render();
  toast('Updated');
  return true;
}

function buildEditRow(e) {
  const li = el('li', 'entry editing');
  const form = el('form', 'editform');

  const name = document.createElement('input');
  name.type = 'text'; name.value = e.name; name.required = true;
  name.setAttribute('aria-label', 'Name');

  const cals = document.createElement('input');
  cals.type = 'number'; cals.value = e.calories; cals.min = '0'; cals.step = '1';
  cals.inputMode = 'numeric'; cals.setAttribute('aria-label', 'Calories per serving');

  const qty = document.createElement('input');
  qty.type = 'number'; qty.value = e.qty || 1; qty.min = '0.25'; qty.step = '0.25';
  qty.inputMode = 'decimal'; qty.setAttribute('aria-label', 'Servings');

  const save = el('button', 'btn primary', 'Save');
  save.type = 'submit';

  const cancel = el('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => { editingId = null; renderEntries(); };

  form.onsubmit = ev => { ev.preventDefault(); saveEdit(e.id, name.value, cals.value, qty.value); };
  form.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { editingId = null; renderEntries(); }
  });

  form.append(name, cals, qty, save, cancel);
  li.append(form);
  setTimeout(() => { name.focus(); name.select(); }, 0);
  return li;
}

function setActivity(cals, source) {
  mutateDay(cursor, d => {
    d.activity = Number.isFinite(cals) && cals > 0 ? { calories: Math.round(cals), source } : null;
  });
  render();
}

/* ─────────────────────────  weight  ─────────────────────────
   Stored per day as day.weight = { kg, source }, always in kilograms (what
   Samsung Health exports), and converted only for display. It lives inside
   the day object rather than a separate map so that older copies of the app
   still syncing on another device carry it through untouched — they merge
   and re-upload whole day objects, but would drop a top-level field they
   don't know about. A weigh-in does not make a day "logged": calorie totals
   are unaffected by it. */
const LB_PER_KG = 2.2046226218;
const wUnit = () => state.settings.weightUnit;

function weightOf(k) {
  const w = dayOf(k).weight;
  return w && Number.isFinite(w.kg) && w.kg > 0 ? w : null;
}

/* Every weigh-in, oldest first, as { key, kg, source }. */
function allWeights() {
  return Object.keys(state.days).sort()
    .map(k => { const w = weightOf(k); return w ? { key: k, kg: w.kg, source: w.source } : null; })
    .filter(Boolean);
}

function fmtWeight(kg, { unit = true } = {}) {
  if (!Number.isFinite(kg)) return '—';
  const u = wUnit();
  if (u === 'st') {
    const lb = kg * LB_PER_KG;
    let st = Math.floor(lb / 14), rem = Math.round((lb - st * 14) * 10) / 10;
    if (rem >= 14) { st++; rem = 0; }
    return `${st} st ${rem.toFixed(1).replace(/\.0$/, '')}${unit ? ' lb' : ''}`;
  }
  const v = u === 'lb' ? kg * LB_PER_KG : kg;
  return v.toFixed(1) + (unit ? ' ' + u : '');
}

/* Changes are shown in kg or lb; "−0.4 st" means nothing to anyone. */
function fmtWeightDelta(kg) {
  if (!Number.isFinite(kg)) return '—';
  const lb = wUnit() !== 'kg';
  const v = lb ? kg * LB_PER_KG : kg;
  const r = Math.round(v * 10) / 10 || 0;
  return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(1) + (lb ? ' lb' : ' kg');
}

/* The input box shows the stored weight in the chosen unit. */
function weightToInput(kg) {
  const u = wUnit();
  if (u === 'kg') return (Math.round(kg * 10) / 10).toString();
  const lb = kg * LB_PER_KG;
  if (u === 'lb') return (Math.round(lb * 10) / 10).toString();
  let st = Math.floor(lb / 14), rem = Math.round((lb - st * 14) * 10) / 10;
  if (rem >= 14) { st++; rem = 0; }
  return `${st} ${rem}`;
}

/* Reads what was typed, in the chosen unit, and returns kilograms (or NaN).
   Stone accepts "13 4", "13st 4lb", "13-4" (13 st 4 lb) or a lone "13.5". */
function parseWeightInput(raw) {
  const t = String(raw).trim().replace(',', '.');
  if (!t) return NaN;
  const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length || nums.length > 2) return NaN;
  const u = wUnit();
  if (u === 'st') return ((nums[0] * 14) + (nums[1] || 0)) / LB_PER_KG;
  if (nums.length !== 1) return NaN;
  return u === 'lb' ? nums[0] / LB_PER_KG : nums[0];
}

const WEIGHT_MIN_KG = 20, WEIGHT_MAX_KG = 350;
/* 'manual' is typed in here and never overwritten by an import or the phone
   app; 'samsung' and 'healthconnect' come from the phone and get refreshed. */
const weightSourceLabel = src => src === 'samsung' ? 'Samsung Health' : src === 'healthconnect' ? 'Health Connect' : 'manual';
const isManualWeight = w => !!w && (w.source === 'manual' || !w.source);
const sensibleKg = kg => Number.isFinite(kg) && kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG;

function setWeight(kg, source) {
  mutateDay(cursor, d => {
    if (Number.isFinite(kg)) d.weight = { kg: Math.round(kg * 100) / 100, source };
    else delete d.weight;
    d.wu = Date.now();
  });
  render();
}

/* Smoothed trend: an exponentially weighted moving average, 10% per day.
   Day-to-day scale readings swing a kilo or more on water and food in the
   gut; the trend is what fat loss actually looks like. A gap of g days
   applies g days' worth of weighting, so sparse weigh-ins aren't treated as
   if they were consecutive. */
const TREND_ALPHA = 0.1;
function withTrend(points) {
  let t = null, prev = null;
  return points.map(p => {
    if (t === null) t = p.kg;
    else {
      const gap = Math.max(1, Math.round((parseKey(p.key) - parseKey(prev)) / 864e5));
      t += (1 - Math.pow(1 - TREND_ALPHA, gap)) * (p.kg - t);
    }
    prev = p.key;
    return Object.assign({ trend: t }, p);
  });
}

/* Least-squares line through the raw readings: slope in kg per day. Used for
   "change" and "rate" because, unlike the moving average, it doesn't lag a
   week or so behind. */
function fitLine(points) {
  if (points.length < 2) return null;
  const x0 = parseKey(points[0].key);
  const xs = points.map(p => Math.round((parseKey(p.key) - x0) / 864e5));
  const ys = points.map(p => p.kg);
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxx = 0, sxy = 0;
  xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my); });
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, span: xs[n - 1], at: x => my + slope * (x - mx) };
}

function renderWeightCard() {
  const w = weightOf(cursor);
  const u = wUnit();
  const input = $('#weightInput');
  // Stone needs a space between st and lb, which a number input can't hold.
  input.type = u === 'st' ? 'text' : 'number';
  input.placeholder = u === 'st' ? 'e.g. 13 4' : '—';
  $('#weightLabel').textContent = `Weight (${u === 'st' ? 'st lb' : u})`;
  if (document.activeElement !== input) input.value = w ? weightToInput(w.kg) : '';
  $('#weightSource').textContent = !w ? 'not set' : weightSourceLabel(w.source);

  const all = withTrend(allWeights());
  const before = all.filter(p => p.key < cursor).pop();
  const here = all.find(p => p.key === cursor);
  const bits = [];
  if (before) {
    const gap = Math.round((parseKey(cursor) - parseKey(before.key)) / 864e5);
    bits.push(here
      ? `${fmtWeightDelta(here.kg - before.kg)} since ${gap === 1 ? 'the day before' : fmtShort(before.key)}`
      : `Last: ${fmtWeight(before.kg)} on ${fmtShort(before.key)}`);
  }
  const ref = here || before;
  if (ref && all.length > 2) bits.push(`trend ${fmtWeight(ref.trend)}`);
  $('#weightNote').textContent = bits.length ? bits.join(' · ')
    : 'Weigh at the same time each day — first thing in the morning is most consistent.';
}

/* ─────────────────────────  weight view  ───────────────────────── */
let weightRange = '90';
try { const r = localStorage.getItem('calorie-tracker/weight-range'); if (['30', '90', '365', 'all'].includes(r)) weightRange = r; }
catch { /* storage blocked */ }

function renderWeight() {
  document.querySelectorAll('#wtRange button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.range === weightRange)));

  const all = withTrend(allWeights());
  $('#wtEmptyState').hidden = all.length > 0;
  $('#wtBody').hidden = all.length === 0;
  if (!all.length) return;

  const t = todayKey();
  const start = weightRange === 'all' ? all[0].key : addDays(t, -(Number(weightRange) - 1));
  const pts = all.filter(p => p.key >= start);
  const last = all[all.length - 1];

  $('#wtLatest').textContent = fmtWeight(last.kg, { unit: wUnit() !== 'st' });
  $('#wtLatestSub').textContent = relativeLabel(last.key) === 'Today' ? 'today' : fmtShort(last.key);
  $('#wtTrend').textContent = all.length > 2 ? fmtWeight(last.trend, { unit: wUnit() !== 'st' }) : '—';
  $('#wtTrendSub').textContent = all.length > 2 ? 'smoothed · ' + (wUnit() === 'st' ? 'st lb' : wUnit()) : 'needs 3+ weigh-ins';

  const fit = fitLine(pts);
  const enough = fit && fit.span >= 7 && pts.length >= 3;
  const change = enough ? fit.at(fit.span) - fit.at(0) : NaN;
  const rate = enough ? fit.slope * 7 : NaN;
  const setCard = (id, v) => {
    $(id).classList.toggle('is-under', enough && v < 0);
    $(id).classList.toggle('is-over', enough && v > 0);
  };
  setCard('#wtChangeCard', change);
  setCard('#wtRateCard', rate);
  $('#wtChange').textContent = enough ? fmtWeightDelta(change) : '—';
  $('#wtChangeSub').textContent = enough ? `over ${fit.span} days` : 'needs a week of weigh-ins';
  $('#wtRate').textContent = enough ? fmtWeightDelta(rate) : '—';
  $('#wtRateSub').textContent = enough ? 'per week' + (weightRange === 'all' ? ' (average)' : '') : 'per week';

  renderWeightChart(pts, start, t);
  renderWeightCompare(pts, fit, enough);
  renderWeightList(pts);
}

/* Drawn at the box's real pixel width (re-rendered on resize), so the dots
   stay round and the labels stay text-sized on any screen. */
function renderWeightChart(pts, start, end) {
  const box = $('#wtChart');
  box.textContent = '';
  const W = Math.max(260, box.clientWidth || 320), H = 190;
  const L = 44, R = 8, T = 10, B = 22;
  const lb = wUnit() !== 'kg';
  const conv = kg => lb ? kg * LB_PER_KG : kg;

  const vals = pts.flatMap(p => [conv(p.kg), conv(p.trend)]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 2) { const mid = (hi + lo) / 2; lo = mid - 1; hi = mid + 1; }
  const step = (wUnit() === 'st' ? [1, 2, 7, 14, 28] : [0.5, 1, 2, 5, 10, 20]).find(s => (hi - lo) / s <= 5) || 50;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

  const t0 = parseKey(start).getTime(), t1 = Math.max(parseKey(end).getTime(), t0 + 864e5);
  const x = k => L + ((parseKey(k).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([a, v]) => n.setAttribute(a, v));
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'wtsvg', role: 'img',
    'aria-label': `Weight from ${fmtShort(pts[0].key)} to ${fmtShort(pts[pts.length - 1].key)}` });

  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.append(mk('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'wt-grid' }));
    const whole = Math.round(v);
    const label = wUnit() === 'st' ? `${Math.floor(whole / 14)}st ${whole % 14}` : (step < 1 ? v.toFixed(1) : String(whole));
    svg.append(mk('text', { x: L - 6, y: y(v) + 3.5, class: 'wt-axis', 'text-anchor': 'end' }, label));
  }
  const mid = keyOf(new Date((t0 + t1) / 2));
  [[start, 'start'], [mid, 'middle'], [end, 'end']].forEach(([k, anchor]) =>
    svg.append(mk('text', { x: x(k), y: H - 6, class: 'wt-axis', 'text-anchor': anchor }, fmtShort(k))));

  pts.forEach(p => {
    const c = mk('circle', { cx: x(p.key), cy: y(conv(p.kg)), r: pts.length > 120 ? 2 : 3, class: 'wt-dot' });
    c.append(mk('title', {}, `${fmtLong(p.key)}: ${fmtWeight(p.kg)}`));
    svg.append(c);
  });
  if (pts.length > 1) {
    svg.append(mk('polyline', { class: 'wt-line',
      points: pts.map(p => `${x(p.key).toFixed(1)},${y(conv(p.trend)).toFixed(1)}`).join(' ') }));
  }
  box.append(svg);
}

/* What the calorie log predicted against what the scale did. The weigh-in
   on day D reflects eating up to the end of D−1, so the net counted runs
   from the first weigh-in's day up to (not including) the last one's. */
function renderWeightCompare(pts, fit, enough) {
  const box = $('#wtCompare');
  box.textContent = '';
  if (!enough) {
    box.append(el('p', 'explain', 'Needs at least three weigh-ins spread over a week or more in this range.'));
    return;
  }
  const first = pts[0].key, lastKey = pts[pts.length - 1].key;
  let span = 0, logged = 0, net = 0;
  for (let k = first; k < lastKey; k = addDays(k, 1)) {
    span++;
    const s = summaryOf(k);
    if (s.logged) { logged++; net += s.net; }
  }
  const coverage = span ? logged / span : 0;
  const actual = fit.at(fit.span) - fit.at(0);

  const rows = el('div', 'cmp');
  const row = (label, value, sub, cls) => {
    const r = el('div', 'cmp-row');
    const v = el('strong', cls || null, value);
    r.append(el('span', 'cmp-label', label), v);
    if (sub) r.append(el('span', 'cmp-sub', sub));
    rows.append(r);
  };
  row('Scale', fmtWeightDelta(actual), `fitted line, ${fmtShort(first)} – ${fmtShort(lastKey)}`, actual > 0 ? 'pos' : 'neg');

  if (!logged) {
    row('Calorie log', '—', 'no logged days in this stretch');
    box.append(rows);
    return;
  }
  // Unlogged days are treated as averaging the same as logged ones. If they
  // were really meals out and weekends, the prediction runs optimistic.
  const predictedKg = (net / logged) * span / KCAL_PER_KG;
  row('Calorie log', fmtWeightDelta(predictedKg),
    `avg net ${withSign(net / logged)} kcal/day over ${logged} of ${span} days` +
    (logged < span ? ', extended to all' : ''), predictedKg > 0 ? 'pos' : 'neg');
  box.append(rows);

  let verdict;
  if (span < 21 || coverage < 0.8 || pts.length < 8) {
    verdict = span < 21
      ? `Too short to judge — ${span} days. Water swings alone can be ±1 kg; give it three weeks or more.`
      : coverage < 0.8
        ? `Only ${logged} of ${span} days logged, so the prediction is a guess. Log more consistently to make this meaningful.`
        : 'Too few weigh-ins to judge. Several a week makes the line far more reliable.';
  } else {
    const gap = (actual - predictedKg) * KCAL_PER_KG / span;   // kcal/day the log is missing
    const g = kcal(Math.abs(gap));
    verdict = Math.abs(gap) < 150
      ? `They agree to within ~${g} kcal/day — your maintenance (${kcal(state.settings.maintenance)}) and activity share (${state.settings.activityFactor}) look about right.`
      : gap > 0
        ? `The scale is about ${g} kcal/day behind what the log predicts. Usual reasons: food under-logged (oils, drinks, bites), activity overestimated, or maintenance set too high (currently ${kcal(state.settings.maintenance)}).`
        : `You're losing about ${g} kcal/day more than the log predicts. Maintenance may be set too low (currently ${kcal(state.settings.maintenance)}) or activity counted too cautiously.`;
  }
  box.append(el('p', 'explain cmp-verdict', verdict));
}

/* The newest ten; the chart already shows the shape, so the full list is
   one tap away rather than a wall of rows under it. */
let weightListAll = false;
function renderWeightList(pts) {
  const list = $('#wtList');
  list.textContent = '';
  $('#wtCount').textContent = `${pts.length} in range`;
  const shown = pts.slice().reverse().slice(0, weightListAll ? 400 : 10);
  shown.forEach((p, i) => {
    const prev = pts[pts.length - 2 - i];
    const li = el('li', 'entry');
    const main = el('div', 'entry-main');
    const name = el('button', 'linkbtn entry-name', fmtLong(p.key));
    name.type = 'button';
    name.onclick = () => { goToDay(p.key); showView('today'); };
    main.append(name, el('span', 'entry-sub',
      weightSourceLabel(p.source) + (prev ? ` · ${fmtWeightDelta(p.kg - prev.kg)}` : '')));
    const del = el('button', 'mini del', '×');
    del.title = 'Delete'; del.setAttribute('aria-label', `Delete weigh-in for ${fmtLong(p.key)}`);
    del.onclick = () => {
      if (!confirm(`Delete the ${fmtWeight(p.kg)} weigh-in on ${fmtLong(p.key)}?` +
        (isManualWeight(p) ? '' : '\n\nThe phone app won\'t send it again unless the reading changes in Samsung Health. A CSV import would.'))) return;
      mutateDay(p.key, d => { delete d.weight; d.wu = Date.now(); });
      render();
      toast('Weigh-in deleted');
    };
    li.append(main, el('span', 'entry-cal', fmtWeight(p.kg)), del);
    list.append(li);
  });
  if (pts.length > 10) {
    const li = el('li', 'entry');
    const more = el('button', 'btn', weightListAll ? 'Show fewer' : `Show ${Math.min(pts.length, 400) - shown.length} more`);
    more.type = 'button';
    more.onclick = () => { weightListAll = !weightListAll; renderWeightList(pts); };
    li.append(more);
    list.append(li);
  }
}

/* ─────────────────────────  week view  ─────────────────────────
   A week only counts days you actually logged. Otherwise every future day
   in the current week reads as a full-target deficit and the weekly number
   is nonsense by Tuesday. */
function weekDays() {
  return Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i));
}

function renderWeek() {
  const days = weekDays();
  const t = todayKey();
  const rows = days.map(k => Object.assign({ key: k }, summaryOf(k)));
  const logged = rows.filter(r => r.logged);

  /* Hold today out of the four summary cards until it has settled. Past weeks
     don't contain today, so this is a no-op the moment you page back.
     All four cards move together: pulling today from Net alone would leave
     Eaten − Allowance no longer equal to Net, which reads as a bug. The chart and
     table below still show today in full — one short bar among seven reads as
     a partial day, where a single aggregate number does not. */
  const pending = !todaySettled() && logged.some(r => r.key === t) ? summaryOf(t) : null;
  const counted = pending ? logged.filter(r => r.key !== t) : logged;

  /* The week tracks the balance against maintenance + discounted activity
     (see the calorie model). The fixed target is a daily eating habit, not
     the measure of the week; adherence to it is shown under the average. */
  const T = totalsOf(counted);
  const { eaten, allowance, active, net } = T;
  const imp = T.imported ? ` · ${T.full} of ${T.days} days` : '';

  const thisWeek = startOfWeek(t, state.settings.weekStart);
  $('#weekLabel').textContent = `${fmtShort(days[0])} – ${fmtShort(days[6])}`;
  $('#weekRelative').textContent =
    weekCursor === thisWeek ? 'This week'
    : weekCursor === addDays(thisWeek, -7) ? 'Last week'
    : parseKey(weekCursor).getFullYear();
  $('#nextWeek').disabled = weekCursor >= thisWeek;

  $('#wkEaten').textContent = T.full ? kcal(eaten) : '—';
  $('#wkEaten').nextElementSibling.textContent = 'kcal this week' + imp;
  const factor = state.settings.activityFactor;
  $('#wkBurned').textContent = T.full ? kcal(allowance) : '—';
  $('#wkBurnedSub').textContent = T.full
    ? `${kcal(state.settings.maintenance)} × ${T.full} + ${factor} × ${kcal(active)} activity`
    : `maintenance + ${factor} × activity`;

  /* Today may have been the only logged day, so an empty week is now reachable
     without the user having logged nothing. Show a dash rather than a 0 that
     would read as a day spent exactly on target. */
  const netCard = $('#wkNetCard');
  netCard.classList.toggle('is-over', counted.length > 0 && net > 0);
  netCard.classList.toggle('is-under', counted.length > 0 && net <= 0);
  $('#wkNet').textContent = counted.length ? withSign(net) : '—';
  $('#wkNetSub').textContent = counted.length
    ? (net > 0 ? 'surplus' : 'deficit') + (pending ? ' — excl. today' : ' this week')
      + (T.imported ? ` · ${T.imported} imported` : '')
    : (pending ? 'today still going' : 'nothing logged');

  $('#wkAvg').textContent = T.full ? kcal(eaten / T.full) : '—';
  const vsTarget = T.full ? eaten / T.full - state.settings.dailyTarget : 0;
  $('#wkAvgSub').textContent = T.full
    ? `eaten · ${withSign(vsTarget)} vs ${kcal(state.settings.dailyTarget)} target`
    : T.imported ? 'no food logged' : (pending ? 'today still going' : 'no logged days');

  /* Today is excluded, not discarded — say what it holds and when it lands,
     so the cards above don't look like they've lost the day's entries. */
  const note = $('#wkPending');
  note.hidden = !pending;
  if (pending) {
    note.textContent =
      `Today so far: ${kcal(pending.eaten)} eaten, ${kcal(pending.active)} activity` +
      ` — joins the totals above at ${fmtHour(SETTLE_HOUR)}.`;
  }

  renderChart(rows);
  renderWeekTable(rows);
}

function renderChart(rows) {
  const chart = $('#weekChart');
  chart.textContent = '';

  // Bars are eaten; the dashed line is that day's allowance (maintenance +
  // factor × activity), so a bar under its line is a deficit day. Scale to
  // whichever is larger so the line is always on-canvas.
  const peak = Math.max(1, ...rows.map(r => Math.max(r.eaten, r.logged ? r.allowance : 0)));
  const t = todayKey();

  rows.forEach(r => {
    const col = el('div', 'col');
    col.classList.toggle('over', r.net > 0 && r.logged);
    col.title = r.netOnly ? `${fmtLong(r.key)} — imported net ${withSign(r.net)}`
      : r.logged
      ? `${fmtLong(r.key)} — ${kcal(r.eaten)} eaten / ${kcal(r.allowance)} allowance (${withSign(r.net)})`
      : `${fmtLong(r.key)} — nothing logged`;

    const bars = el('div', 'col-bars');
    const bar = el('div', 'col-bar');
    if (r.eaten > 0) bar.style.height = ((r.eaten / peak) * 100) + '%';
    else bar.classList.add('empty');
    bars.append(bar);

    if (r.logged && !r.netOnly) {
      const line = el('div', 'col-target');
      line.style.bottom = ((r.allowance / peak) * 100) + '%';
      bars.append(line);
    }

    // Imported days have no bar to draw; print their net where the value goes.
    const val = r.netOnly
      ? el('div', 'col-val ' + (r.net > 0 ? 'pos' : 'neg'), withSign(r.net))
      : el('div', 'col-val', r.eaten ? kcal(r.eaten) : '');
    const lbl = el('div', 'col-label', DOW[parseKey(r.key).getDay()]);
    if (r.key === t) lbl.style.color = 'var(--accent)';

    col.append(val, bars, lbl);
    chart.append(col);
  });
}

function renderWeekTable(rows) {
  const body = $('#weekTableBody');
  body.textContent = '';
  const t = todayKey();

  rows.forEach(r => {
    const tr = el('tr');
    if (r.key === t) tr.className = 'today';
    else if (!r.logged) tr.className = 'muted';

    const day = el('td', null, `${DOW[parseKey(r.key).getDay()]} ${parseKey(r.key).getDate()}`);
    day.style.cursor = 'pointer';
    day.onclick = () => { goToDay(r.key); showView('today'); };

    tr.append(
      day,
      el('td', null, r.logged && !r.netOnly ? kcal(r.eaten) : '—'),
      el('td', null, r.active ? kcal(r.active) : '—')
    );

    const bal = el('td');
    if (r.logged) {
      bal.className = r.net > 0 ? 'pos' : 'neg';
      bal.textContent = withSign(r.net) + (r.netOnly ? '*' : '');
      if (r.netOnly) bal.title = 'Imported net — no food breakdown';
    } else {
      bal.textContent = '—';
    }
    tr.append(bal);
    body.append(tr);
  });
}

/* ─────────────────────────  month view  ─────────────────────────
   A calendar of the month, one ring per day: the ring fills with eaten as a
   share of that day's allowance and turns red past it, so a month of
   deficits reads as a month of green rings at a glance. Totals follow the
   same rules as the week: only logged days count, and today is held out
   until it has settled. */
const KCAL_PER_KG = 7700;   // rule-of-thumb energy in 1 kg of body fat
let monthCursor = monthOf(cursor);     // YYYY-MM-01 of the month on screen
let monthSel = null;                    // day picked in the calendar

function monthOf(k) { return k.slice(0, 8) + '01'; }
function addMonths(mk, n) {
  const d = parseKey(mk);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return keyOf(d);
}
function monthDays(mk) {
  const d = parseKey(mk);
  const len = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Array.from({ length: len }, (_, i) => addDays(mk, i));
}

function ringSvg(r, isToday) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const C = 2 * Math.PI * 15;
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', 18); track.setAttribute('cy', 18); track.setAttribute('r', 15);
  track.setAttribute('class', 'ring-track');
  svg.append(track);
  if (r.logged && (r.netOnly || r.allowance > 0)) {
    // Imported days have no eaten/allowance split, so their ring is drawn
    // full and faded: it says which side of the line, not by how much.
    const share = r.netOnly ? 1 : Math.min(1, r.eaten / r.allowance);
    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', 18); arc.setAttribute('cy', 18); arc.setAttribute('r', 15);
    arc.setAttribute('class', 'ring-arc ' + (r.net > 0 ? 'over' : isToday && !todaySettled() ? 'live' : 'under')
      + (r.netOnly ? ' imported' : ''));
    arc.setAttribute('stroke-dasharray', `${share * C} ${C}`);
    arc.setAttribute('transform', 'rotate(-90 18 18)');
    svg.append(arc);
  }
  return svg;
}

function renderMonth() {
  const t = todayKey();
  const days = monthDays(monthCursor);
  const rows = days.map(k => Object.assign({ key: k }, summaryOf(k)));
  const past = rows.filter(r => r.key <= t);
  const logged = past.filter(r => r.logged);
  const pending = !todaySettled() && logged.some(r => r.key === t);
  const counted = pending ? logged.filter(r => r.key !== t) : logged;

  const T = totalsOf(counted);
  const { eaten, allowance, active, net } = T;
  const deficitDays = counted.filter(r => r.net <= 0).length;

  const thisMonth = monthOf(t);
  $('#monthLabel').textContent = parseKey(monthCursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#monthRelative').textContent =
    monthCursor === thisMonth ? 'This month'
    : monthCursor === addMonths(thisMonth, -1) ? 'Last month' : '';
  $('#nextMonth').disabled = monthCursor >= thisMonth;

  const has = counted.length > 0;
  const netCard = $('#moNetCard');
  netCard.classList.toggle('is-over', has && net > 0);
  netCard.classList.toggle('is-under', has && net <= 0);
  $('#moNet').textContent = has ? withSign(net) : '—';
  // Rough fat equivalent; one decimal, since withSign rounds to whole numbers.
  const kg = net / KCAL_PER_KG;
  $('#moNetSub').textContent = has
    ? `${net > 0 ? 'surplus' : 'deficit'} · ≈ ${kg > 0 ? '+' : ''}${kg.toFixed(1)} kg`
    : (pending ? 'today still going' : 'nothing logged');

  $('#moDays').textContent = has ? `${deficitDays}/${counted.length}` : '—';
  $('#moDaysSub').textContent = has
    ? `deficit days · ${past.length - logged.length} not logged`
    : 'deficit days';

  $('#moAvg').textContent = has ? withSign(net / counted.length) : '—';
  $('#moAvgSub').textContent = has ? 'net per logged day' : 'net per day';

  $('#moEaten').textContent = T.full ? kcal(eaten / T.full) : '—';
  $('#moEatenSub').textContent = T.full
    ? `eaten / day · ${withSign(eaten / T.full - state.settings.dailyTarget)} vs target`
    : T.imported ? 'no food logged' : 'eaten / day';

  const plural = n => `${n} day${n === 1 ? '' : 's'}`;
  $('#moTotals').textContent = !has ? ''
    : (T.full ? `${kcal(eaten)} eaten · ${kcal(active)} activity · ${kcal(allowance)} allowance over ${plural(T.full)}` : '')
      + (T.imported ? `${T.full ? '; ' : ''}${plural(T.imported)} imported as net only` : '')
      + (pending ? ' — today joins at ' + fmtHour(SETTLE_HOUR) : '');

  renderCalendar(rows);
  renderMonthTrend(rows, counted);

  // Keep the detail panel on a day inside this month.
  if (!monthSel || monthOf(monthSel) !== monthCursor) {
    monthSel = monthCursor === thisMonth ? t
      : (logged.length ? logged[logged.length - 1].key : days[days.length - 1]);
  }
  renderMonthDetail();
}

function renderCalendar(rows) {
  const t = todayKey();
  const grid = $('#calGrid');
  grid.textContent = '';

  const ws = state.settings.weekStart;
  for (let i = 0; i < 7; i++) grid.append(el('div', 'cal-dow', DOW[(ws + i) % 7].slice(0, 1)));

  const lead = (parseKey(rows[0].key).getDay() - ws + 7) % 7;
  for (let i = 0; i < lead; i++) grid.append(el('div', 'cal-pad'));

  rows.forEach(r => {
    const future = r.key > t;
    const cell = el('button', 'cal-day');
    cell.type = 'button';
    cell.disabled = future;
    if (r.key === t) cell.classList.add('today');
    if (r.key === monthSel) cell.classList.add('sel');
    if (!r.logged) cell.classList.add('blank');
    cell.setAttribute('aria-label', r.logged
      ? `${fmtLong(r.key)}: ${kcal(r.eaten)} eaten, net ${withSign(r.net)}`
      : `${fmtLong(r.key)}: nothing logged`);

    cell.append(ringSvg(r, r.key === t));
    cell.append(el('span', 'cal-num', String(parseKey(r.key).getDate())));
    const net = el('span', 'cal-net', r.logged ? withSign(r.net) : '');
    // A day still going is not a deficit yet — show its number uncoloured.
    if (r.logged) net.classList.add(r.key === t && !todaySettled() ? 'live' : r.net > 0 ? 'pos' : 'neg');
    cell.append(net);

    cell.onclick = () => { monthSel = r.key; renderCalendarSel(); renderMonthDetail(); };
    cell.ondblclick = () => { goToDay(r.key); showView('today'); };
    cell.dataset.key = r.key;
    grid.append(cell);
  });
}

function renderCalendarSel() {
  document.querySelectorAll('#calGrid .cal-day').forEach(c =>
    c.classList.toggle('sel', c.dataset.key === monthSel));
}

/* Running total of net across the month: where the month's balance stood
   on each day. Unlogged days carry the line flat rather than counting as
   zero-calorie deficits. */
function renderMonthTrend(rows, counted) {
  const box = $('#moTrend');
  box.textContent = '';
  const ok = new Set(counted.map(r => r.key));
  if (!ok.size) { box.append(el('p', 'empty', 'Log a few days to see the running balance.')); return; }

  let run = 0;
  const pts = [];
  rows.forEach((r, i) => {
    if (ok.has(r.key)) run += r.net;
    if (r.key <= todayKey()) pts.push([i, run]);
  });
  const W = 300, H = 90, P = 4;
  const lo = Math.min(0, ...pts.map(p => p[1])), hi = Math.max(0, ...pts.map(p => p[1]));
  const span = hi - lo || 1;
  const x = i => P + (i / Math.max(1, rows.length - 1)) * (W - 2 * P);
  const y = v => P + ((hi - v) / span) * (H - 2 * P);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'trend');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Running balance, ending at ${withSign(run)} kcal`);

  const zero = document.createElementNS(NS, 'line');
  zero.setAttribute('x1', 0); zero.setAttribute('x2', W);
  zero.setAttribute('y1', y(0)); zero.setAttribute('y2', y(0));
  zero.setAttribute('class', 'trend-zero');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  line.setAttribute('class', 'trend-line ' + (run > 0 ? 'over' : 'under'));
  svg.append(zero, line);
  box.append(svg);

  const foot = el('div', 'trend-foot');
  foot.append(el('span', null, fmtShort(rows[0].key)),
              el('span', run > 0 ? 'pos' : 'neg', `${withSign(run)} kcal`),
              el('span', null, fmtShort(rows[rows.length - 1].key)));
  box.append(foot);
}

function renderMonthDetail() {
  const k = monthSel;
  const s = summaryOf(k);
  $('#moSelLabel').textContent = fmtLong(k);
  $('#moSelEaten').textContent = s.logged && !s.netOnly ? kcal(s.eaten) : '—';
  $('#moSelActive').textContent = s.active ? kcal(s.active) : '—';
  $('#moSelAllow').textContent = s.logged && !s.netOnly ? kcal(s.allowance) : '—';
  const n = $('#moSelNet');
  const live = k === todayKey() && !todaySettled();
  n.className = !s.logged || live ? '' : s.net > 0 ? 'pos' : 'neg';
  n.textContent = s.logged ? withSign(s.net) : '—';
  $('#moSelVerdict').textContent = !s.logged ? 'Nothing logged'
    : live ? 'Day still going'
    : (s.net > 0 ? 'Surplus' : 'Deficit') + (s.estimate ? ' · estimate' : s.netOnly ? ' · imported' : '');
}

/* ═════════════════════  past days from notes  ═════════════════════
   For history kept outside the app, where only each day's deficit was
   written down. Accepts the notes as typed — "June 3rd: 1390 calories
   burned (Deficit)", "(*June 14th) -1600 …(surplus)", "July 25: Maintenance",
   "August 9th - August 14th: assume 500 cal deficit" — or plain
   "2026-06-03 1390". The number is read as the notes write it: positive is
   a deficit, negative a surplus; the app stores the opposite sign (net). */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
let pendingHistory = null;

function parseHistory(text, year) {
  const rows = [], problems = [];
  const seen = new Map();
  let prev = null;
  const t = todayKey();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const n = i + 1;

    // Dates: ISO, or month name + day (ordinal suffixes and typos like "23d").
    const dates = [];
    let end = 0;
    const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
    const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th|d)?\b/gi;
    let m;
    while ((m = iso.exec(line)) && dates.length < 2) {
      dates.push(new Date(+m[1], +m[2] - 1, +m[3])); end = iso.lastIndex;
    }
    if (!dates.length) {
      while ((m = named.exec(line)) && dates.length < 2) {
        dates.push(new Date(year, MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)), +m[2])); end = named.lastIndex;
      }
    }
    if (!dates.length) { problems.push({ n, line, why: 'no date found — skipped' }); return; }

    const rest = line.slice(end);
    const num = rest.match(/(^|[^\d])(-?)\s*(\d[\d,]*(?:\.\d+)?)/);
    let value;
    if (num) value = Number((num[2] + num[3]).replace(/,/g, ''));
    else if (/maint/i.test(rest)) value = 0;
    else { problems.push({ n, line, why: 'no number found — skipped' }); return; }

    const estimate = /assum|estimat|guess/i.test(rest);
    if (/surplus/i.test(rest) && value > 0) problems.push({ n, line, why: 'says surplus but the number is positive — imported as a deficit' });
    if (/defic/i.test(rest) && value < 0 && !estimate) problems.push({ n, line, why: 'says deficit but the number is negative — imported as a surplus' });

    // A range ("Aug 9 – Aug 14") gives every day in it the same value.
    const [a, b] = dates.length === 2 && dates[1] > dates[0] ? dates : [dates[0], dates[0]];
    const keys = [];
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) keys.push(keyOf(d));
    if (keys.length > 62) { problems.push({ n, line, why: 'date range longer than two months — skipped' }); return; }

    keys.forEach(k => {
      if (k > t) { problems.push({ n, line, why: `${fmtShort(k)} is in the future — skipped` }); return; }
      if (seen.has(k)) {
        problems.push({ n, line, why: `${fmtShort(k)} already appears on line ${seen.get(k)} — this one skipped. Typo in the month?` });
        return;
      }
      if (prev && k < prev) problems.push({ n, line, why: `${fmtShort(k)} comes after ${fmtShort(prev)} — check the date` });
      seen.set(k, n);
      prev = k;
      rows.push({ key: k, deficit: value, estimate, n });
    });
  });
  return { rows, problems };
}

function previewHistory() {
  const box = $('#historyResult');
  box.textContent = '';
  pendingHistory = null;
  const year = Number($('#historyYear').value) || new Date().getFullYear();
  const { rows, problems } = parseHistory($('#historyText').value, year);
  if (!rows.length) {
    box.append(note('bad', problems.length ? 'No usable lines.' : 'Paste some lines first.'));
    problems.forEach(p => box.append(el('div', 'hist-prob', `Line ${p.n}: ${p.why}`)));
    return;
  }

  const food = rows.filter(r => dayOf(r.key).entries.length);
  const replace = rows.filter(r => !dayOf(r.key).entries.length && recordedOf(r.key));
  const usable = rows.filter(r => !dayOf(r.key).entries.length);
  const total = usable.reduce((s, r) => s + r.deficit, 0);

  box.append(note('ok',
    `${usable.length} day${usable.length === 1 ? '' : 's'}, ${fmtShort(rows[0].key)} – ${fmtShort(rows[rows.length - 1].key)} ` +
    `(sorted by date below). Total ${total >= 0 ? 'deficit' : 'surplus'} ${kcal(Math.abs(total))} kcal ` +
    `≈ ${(Math.abs(total) / KCAL_PER_KG).toFixed(1)} kg.` +
    (replace.length ? ` ${replace.length} already imported will be replaced.` : '') +
    (food.length ? ` ${food.length === 1 ? '1 day has' : food.length + ' days have'} food logged here and ${food.length === 1 ? 'is' : 'are'} left alone.` : '')));

  if (problems.length) {
    const wrap = el('div', 'hist-probs');
    wrap.append(el('strong', null, 'Check these lines'));
    problems.forEach(p => {
      const d = el('div', 'hist-prob');
      d.append(el('b', null, `Line ${p.n}: `), document.createTextNode(p.why));
      d.append(el('div', 'hist-line', p.line));
      wrap.append(d);
    });
    box.append(wrap);
  }

  const tbl = el('table');
  const sorted = rows.slice().sort((a, b) => a.key < b.key ? -1 : 1);
  sorted.forEach(r => {
    const tr = el('tr');
    const has = dayOf(r.key).entries.length > 0;
    if (has) tr.className = 'muted';
    const v = el('td', has ? null : r.deficit > 0 ? 'neg' : r.deficit < 0 ? 'pos' : null,
      r.deficit === 0 ? 'maintenance' : `${kcal(Math.abs(r.deficit))} ${r.deficit > 0 ? 'deficit' : 'surplus'}`);
    tr.append(el('td', null, fmtLong(r.key)), el('td', 'hist-flag', has ? 'food logged — kept' : r.estimate ? 'estimate' : ''), v);
    tbl.append(tr);
  });
  const pv = el('div', 'preview hist-table');
  pv.append(tbl);
  box.append(pv);

  if (usable.length) {
    pendingHistory = usable;
    const row = el('div', 'btnrow');
    row.style.marginTop = '12px';
    const ok = el('button', 'btn primary', `Save ${usable.length} days`);
    ok.type = 'button';
    ok.onclick = saveHistory;
    row.append(ok);
    box.append(row);
  }
}

function saveHistory() {
  if (!pendingHistory) return;
  const now = Date.now();
  pendingHistory.forEach(r => {
    const day = state.days[r.key] || (state.days[r.key] = { entries: [], activity: null });
    if (day.entries.length) return;
    day.recorded = { net: -r.deficit, source: 'notes' };
    if (r.estimate) day.recorded.estimate = true;
    day.u = now;
  });
  const n = pendingHistory.length;
  const first = pendingHistory.reduce((a, r) => r.key < a ? r.key : a, pendingHistory[0].key);
  pendingHistory = null;
  save();
  queuePush();
  $('#historyResult').textContent = '';
  $('#historyResult').append(note('ok', `Saved ${n} days. They show in Week and Month, marked as imported.`));
  $('#historyText').value = '';
  monthCursor = monthOf(first);
  monthSel = null;
  render();
  toast(`${n} past days imported`);
}

/* ═════════════════════  Samsung Health CSV import  ═════════════════════
   Samsung Health has no public web API — the Health Data SDK is an
   Android-native, partner-approved thing, so a website can't read it live.
   The supported route is the "Download personal data" export.

   Those CSVs are awkward in two specific ways:
     1. The first line is a metadata line (`com.samsung.shealth.x,1,`) and
        the *second* line is the real header.
     2. Column names and ordering move between app versions.

   So this parser sniffs rather than assumes, and everything it finds goes
   into an editable preview before it touches your data. */

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }   // escaped quote
        else quoted = false;
      } else cell += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const norm = s => String(s).trim().toLowerCase().replace(/[\s.\-]+/g, '_');

/* Pick the header row. Samsung puts a metadata line first; a real header has
   several named columns, so prefer whichever of the first two rows has more. */
function findHeader(rows) {
  if (rows.length < 2) return 0;
  const score = r => r.filter(c => /[a-z]/i.test(c)).length;
  return score(rows[1]) > score(rows[0]) + 1 ? 1 : 0;
}

function pickColumn(header, patterns, reject) {
  for (const pat of patterns) {
    const i = header.findIndex(h => pat.test(h) && !(reject && reject.test(h)));
    if (i !== -1) return i;
  }
  return -1;
}

/* Samsung writes day_time as epoch millis in some exports and as
   "YYYY-MM-DD HH:MM:SS.mmm" in others. Handle both, plus plain dates. */
function toDayKey(raw) {
  const v = String(raw).trim();
  if (!v) return null;

  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;

  if (/^\d{10,13}$/.test(v)) {
    const ms = v.length <= 10 ? Number(v) * 1000 : Number(v);
    const d = new Date(ms);
    return isNaN(d) ? null : keyOf(d);
  }

  const d = new Date(v);
  return isNaN(d) ? null : keyOf(d);
}

function extractActivity(text, filename) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('That file has no data rows.');

  const h = findHeader(rows);
  const header = rows[h].map(norm);

  const dateIdx = pickColumn(header, [
    /^day_time$/, /^date$/, /^day$/, /start_time/, /^create_time$/, /time/
  ]);
  // Prefer an explicit "active" calorie column; never pick BMR/rest/TEF, which
  // are baseline burn rather than activity.
  const reject = /rest|basal|bmr|tef|goal|target/;
  const calIdx = pickColumn(header, [
    /active_calorie/, /calorie.*active/, /^active_cal/, /^calorie$/, /^calories$/, /calorie/
  ], reject);

  if (dateIdx === -1 || calIdx === -1) {
    throw new Error(
      'Could not find a date and an active-calorie column. Columns seen: ' +
      header.filter(Boolean).slice(0, 12).join(', ')
    );
  }

  // Exercise exports hold one row per session, so those sum. Daily summaries
  // hold one row per device per day — summing there double-counts a phone and
  // a watch, so take the largest instead.
  const meta = norm((rows[0] || []).join(' ') + ' ' + filename);
  const aggregate = /exercise|workout|session/.test(meta) ? 'sum' : 'max';

  const byDay = new Map();
  for (let i = h + 1; i < rows.length; i++) {
    const key = toDayKey(rows[i][dateIdx]);
    const val = Number(String(rows[i][calIdx]).trim());
    if (!key || !Number.isFinite(val) || val <= 0) continue;
    const prev = byDay.get(key) || 0;
    byDay.set(key, aggregate === 'sum' ? prev + val : Math.max(prev, val));
  }
  if (!byDay.size) throw new Error('Found the columns, but no usable rows in them.');

  return {
    aggregate,
    column: rows[h][calIdx] || '(unnamed)',
    rows: [...byDay.entries()]
      .map(([date, calories]) => ({ date, calories: Math.round(calories) }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 60)                   // two months back is plenty
  };
}

/* Samsung Health weight export: com.samsung.health.weight.<stamp>.csv.
   Weight is always kilograms there, whatever unit the app displays. Column
   names come bare (`weight`, `start_time`) or prefixed
   (`com.samsung.health.weight.weight`), so match on the ending.

   Times in these exports are UTC, with the local offset in a separate
   `time_offset` column ("UTC+0100"). Taking the date straight off the
   timestamp would file a 00:30 BST weigh-in under the previous day, so the
   offset is applied first. Without that column the browser's own time zone
   is used. Several readings on one day (a scale and the phone both writing,
   or a re-weigh) collapse to the latest, which is what Samsung Health shows. */
const WEIGHT_COL = /(^|_)weight$/;
const WEIGHT_REJECT = /goal|target|ideal|height|lean|fat|muscle|mass|water|bone/;

function looksLikeWeightFile(rows, filename) {
  const h = findHeader(rows);
  const header = rows[h].map(norm);
  const hasWeight = pickColumn(header, [WEIGHT_COL], WEIGHT_REJECT) !== -1;
  const named = /(^|_)weight(_|$)/.test(norm((rows[0] || []).join(' ') + ' ' + filename));
  const hasCalories = pickColumn(header, [/calorie/], /rest|basal|bmr|tef|goal|target/) !== -1;
  return hasWeight && (named || !hasCalories);
}

function parseOffsetMinutes(raw) {
  const m = String(raw || '').match(/([+-])(\d{1,2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : null;
}

/* Returns { key, ms } — the local day, and an instant for ordering readings. */
function weightTimeOf(raw, offsetRaw) {
  const v = String(raw).trim();
  if (/^\d{10,13}$/.test(v)) {
    const ms = v.length <= 10 ? Number(v) * 1000 : Number(v);
    const off = parseOffsetMinutes(offsetRaw);
    if (off === null) return { key: keyOf(new Date(ms)), ms };
    const d = new Date(ms + off * 60000);
    return { key: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, ms };
  }
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  if (m[4] === undefined) return { key: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, ms: Date.UTC(+m[1], +m[2] - 1, +m[3]) };
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const off = parseOffsetMinutes(offsetRaw);
  if (off === null) return { key: keyOf(new Date(ms)), ms };
  const d = new Date(ms + off * 60000);
  return { key: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, ms };
}

function extractWeight(rows) {
  const h = findHeader(rows);
  const header = rows[h].map(norm);
  const dateIdx = pickColumn(header, [
    /(^|_)start_time$/, /(^|_)day_time$/, /(^|_)create_time$/, /(^|_)date$/, /time/
  ], /offset|update/);
  const wIdx = pickColumn(header, [WEIGHT_COL], WEIGHT_REJECT);
  const offIdx = pickColumn(header, [/(^|_)time_offset$/]);
  if (dateIdx === -1 || wIdx === -1) {
    throw new Error('Could not find a date and a weight column. Columns seen: ' +
      header.filter(Boolean).slice(0, 12).join(', '));
  }

  const t = todayKey();
  const byDay = new Map();
  let skipped = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const when = weightTimeOf(rows[i][dateIdx], offIdx === -1 ? null : rows[i][offIdx]);
    const kg = Number(String(rows[i][wIdx]).trim());
    if (!when || when.key > t || !sensibleKg(kg)) { if (String(rows[i][wIdx]).trim()) skipped++; continue; }
    const prev = byDay.get(when.key);
    if (!prev || when.ms >= prev.ms) byDay.set(when.key, { ms: when.ms, kg });
  }
  if (!byDay.size) throw new Error('Found the weight column, but no usable readings in it.');

  return {
    skipped,
    rows: [...byDay.entries()]
      .map(([date, r]) => ({ date, kg: Math.round(r.kg * 100) / 100 }))
      .sort((a, b) => b.date.localeCompare(a.date))
  };
}

function buildWeightPreview(parsed) {
  const wrap = el('div', 'preview');
  const rows = parsed.rows;
  // A weight typed in by hand is a deliberate correction; an import never
  // overrides it. Earlier Samsung imports are refreshed.
  const manual = rows.filter(r => isManualWeight(weightOf(r.date)));
  const keep = new Set(manual.map(r => r.date));
  const usable = rows.filter(r => !keep.has(r.date));

  const table = el('table');
  rows.slice(0, 14).forEach(r => {
    const tr = el('tr');
    tr.append(el('td', null, fmtLong(r.date)));
    if (keep.has(r.date)) {
      tr.className = 'muted';
      tr.append(el('td', 'hist-flag', `manual ${fmtWeight(weightOf(r.date).kg)} kept`));
    } else {
      const td = el('td');
      const input = document.createElement('input');
      input.type = wUnit() === 'st' ? 'text' : 'number';
      input.step = '0.1';
      input.value = weightToInput(r.kg);
      input.setAttribute('aria-label', `Weight for ${r.date}`);
      input.onchange = () => { r.kg = parseWeightInput(input.value); };
      td.append(input);
      tr.append(td);
    }
    table.append(tr);
  });
  wrap.append(table);
  if (rows.length > 14) wrap.append(el('p', 'explain', `+ ${rows.length - 14} older weigh-ins will also be saved.`));

  const bar = el('div', 'btnrow');
  bar.style.marginTop = '12px';
  const ok = el('button', 'btn primary', `Save ${usable.length} weigh-in${usable.length === 1 ? '' : 's'}`);
  ok.disabled = !usable.length;
  ok.onclick = async () => {
    ok.disabled = true;
    // Bring in another device's edits first: per-day last-write-wins would
    // otherwise let this import overwrite food logged elsewhere on those days.
    if (syncKey) await pullAndMerge({ quiet: true });
    const now = Date.now();
    let n = 0;
    usable.forEach(r => {
      if (!sensibleKg(r.kg)) return;
      const day = state.days[r.date] || (state.days[r.date] = { entries: [], activity: null });
      const cur = day.weight;
      if (isManualWeight(cur)) return;
      const kg = Math.round(r.kg * 100) / 100;
      if (cur && cur.kg === kg) { n++; return; }   // unchanged (from either phone route): leave the day's timestamp alone
      day.weight = { kg, source: 'samsung' };
      day.u = now;
      day.wu = now;
      n++;
    });
    save();
    queuePush();
    $('#importResult').textContent = '';
    $('#importResult').append(note('ok', `Saved ${n} weigh-in${n === 1 ? '' : 's'}. See them in the Weight tab.`));
    render();
    toast(`Imported ${n} weigh-in${n === 1 ? '' : 's'} from Samsung Health`);
  };
  const cancel = el('button', 'btn', 'Cancel');
  cancel.onclick = () => { $('#importResult').textContent = ''; };
  bar.append(ok, cancel);
  wrap.append(bar);
  return { wrap, manual: manual.length };
}

function handleFile(file) {
  const box = $('#importResult');
  const reader = new FileReader();

  reader.onerror = () => { box.innerHTML = ''; box.append(note('bad', 'Could not read that file.')); };
  reader.onload = () => {
    box.textContent = '';
    const text = String(reader.result);
    const csvRows = parseCSV(text);

    if (csvRows.length >= 2 && looksLikeWeightFile(csvRows, file.name)) {
      let w;
      try { w = extractWeight(csvRows); }
      catch (err) { box.append(note('bad', err.message)); return; }
      const { wrap, manual } = buildWeightPreview(w);
      const r = w.rows;
      box.append(note('ok',
        `Weight file: ${r.length} day${r.length === 1 ? '' : 's'} with a weigh-in, ` +
        `${fmtShort(r[r.length - 1].date)} – ${fmtShort(r[0].date)}` +
        (r.length > 1 ? `, ${fmtWeight(r[r.length - 1].kg)} → ${fmtWeight(r[0].kg)}` : '') + '. ' +
        (manual ? `${manual} day${manual === 1 ? '' : 's'} you entered by hand ${manual === 1 ? 'is' : 'are'} kept. ` : '') +
        (w.skipped ? `${w.skipped} reading${w.skipped === 1 ? '' : 's'} skipped as out of range or in the future. ` : '') +
        'Check the numbers, then save.'));
      box.append(wrap);
      return;
    }

    let parsed;
    try {
      parsed = extractActivity(text, file.name);
    } catch (err) {
      box.append(note('bad', err.message));
      return;
    }
    pendingImport = parsed;
    box.append(note('ok',
      `Found ${parsed.rows.length} day${parsed.rows.length === 1 ? '' : 's'} in "${parsed.column}" ` +
      `(${parsed.aggregate === 'sum' ? 'summed per day' : 'highest value per day'}). ` +
      `Check the numbers, then save.`));
    box.append(buildPreview(parsed.rows));
  };
  reader.readAsText(file);
}

function note(kind, msg) { return el('div', 'note ' + kind, msg); }

function buildPreview(rows) {
  const wrap = el('div', 'preview');
  const table = el('table');
  const shown = rows.slice(0, 14);

  shown.forEach(r => {
    const tr = el('tr');
    tr.append(el('td', null, `${fmtLong(r.date)}`));
    const td = el('td');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.step = '1';
    input.value = r.calories;
    input.setAttribute('aria-label', `Active calories for ${r.date}`);
    input.oninput = () => { r.calories = Number(input.value) || 0; };
    td.append(input);
    tr.append(td);
    table.append(tr);
  });

  wrap.append(table);
  if (rows.length > shown.length) {
    wrap.append(el('p', 'explain', `+ ${rows.length - shown.length} older days will also be saved.`));
  }

  const bar = el('div', 'btnrow');
  bar.style.marginTop = '12px';

  const ok = el('button', 'btn primary', `Save ${rows.length} day${rows.length === 1 ? '' : 's'}`);
  ok.onclick = () => {
    let n = 0;
    rows.forEach(r => {
      if (r.calories > 0) {
        mutateDay(r.date, d => { d.activity = { calories: Math.round(r.calories), source: 'samsung' }; });
        n++;
      }
    });
    pendingImport = null;
    $('#importResult').textContent = '';
    $('#importResult').append(note('ok', `Saved activity calories for ${n} day${n === 1 ? '' : 's'}.`));
    render();
    toast(`Imported ${n} day${n === 1 ? '' : 's'} from Samsung Health`);
  };

  const cancel = el('button', 'btn', 'Cancel');
  cancel.onclick = () => { pendingImport = null; $('#importResult').textContent = ''; };

  bar.append(ok, cancel);
  wrap.append(bar);
  return wrap;
}

/* ═════════════════════════  cloud sync  ═════════════════════════
   Optional. localStorage stays the source of truth for the current session —
   the app works fully offline — and the server copy is what lets a second
   device (or a browser whose storage got cleared) pick the log back up.

   Auth is a passphrase you choose, stretched client-side with PBKDF2. Only
   the derived key is sent, so the passphrase never reaches the server, and
   the server never learns who you are. That also means: lose the passphrase
   and the data is unreachable — there is nobody to reset it. */

const SYNC_KEY_STORE = 'calorie-tracker/sync-key';
const DIRTY_STORE = 'calorie-tracker/pending';
const SYNC_ENDPOINT = '/api/sync';
const MIN_PASSPHRASE = 8;

let syncKey = null;          // 64-hex derived key, or null when sync is off
let pushTimer = null;
let retryTimer = null;
let syncing = false;
let dirty = false;           // local edits the server has not accepted yet

try {
  syncKey = localStorage.getItem(SYNC_KEY_STORE) || null;
  dirty = localStorage.getItem(DIRTY_STORE) === '1';
} catch { /* storage blocked */ }

/* A push that fails (offline, flaky signal, server hiccup) must not be
   forgotten — otherwise the edit only reaches the server if you happen to
   change something else later. The flag outlives a reload. */
function setDirty(v) {
  dirty = v;
  try { v ? localStorage.setItem(DIRTY_STORE, '1') : localStorage.removeItem(DIRTY_STORE); }
  catch { /* storage blocked */ }
  if (v) scheduleRetry(); else clearTimeout(retryTimer);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!syncKey || !dirty) return;
  retryTimer = setTimeout(() => { pushNow({ quiet: true }); }, 60000);
}

async function deriveKey(passphrase) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('calorie-tracker/v1/sync'), iterations: 200000, hash: 'SHA-256' },
    material, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Per-day last-write-wins. Whole-document LWW would throw away a day logged
   on the phone the moment the laptop saved a different one. */
/* Weight rides on its own clock (`wu`): the weigh-in usually comes from the
   phone on the same day meals are logged here, and whole-day last-write-wins
   would let either one erase the other. Same rule as the server's merge. */
function mergeDay(a, b) {
  const [win, lose] = (a.u || 0) >= (b.u || 0) ? [a, b] : [b, a];
  if ((lose.wu || 0) <= (win.wu || 0)) return win;
  const out = Object.assign({}, win, { wu: lose.wu });
  if (lose.weight) out.weight = lose.weight; else delete out.weight;
  return out;
}

function mergeStates(local, remote) {
  const days = {};
  for (const k of new Set([...Object.keys(local.days || {}), ...Object.keys(remote.days || {})])) {
    const l = local.days[k], r = remote.days[k];
    if (!l) days[k] = r;
    else if (!r) days[k] = l;
    else days[k] = mergeDay(l, r);
  }
  const localNewer = (local.settingsU || 0) >= (remote.settingsU || 0);
  return {
    version: 1,
    settings: cleanSettings(localNewer ? local.settings : remote.settings),
    settingsU: Math.max(local.settingsU || 0, remote.settingsU || 0),
    days
  };
}

function syncStatus(text, kind) {
  const n = $('#syncStatus');
  if (!n) return;
  n.textContent = text;
  n.className = 'note ' + (kind || 'ok');
  n.hidden = !text;
}

async function pullAndMerge({ quiet } = {}) {
  if (!syncKey || syncing) return;
  syncing = true;
  try {
    const res = await fetch(SYNC_ENDPOINT, { headers: { 'x-sync-key': syncKey } });
    if (!res.ok) throw new Error(`Server said ${res.status}`);
    const { doc } = await res.json();
    if (doc && typeof doc === 'object' && doc.days) {
      state = mergeStates(state, doc);
      save();
      syncWeekToCursor();
      render();
    }
    if (!quiet) syncStatus('Synced. ' + Object.keys(state.days).length + ' days stored.', 'ok');
    return true;
  } catch (err) {
    if (!quiet) syncStatus('Could not reach the server — your data is safe in this browser. ' + err.message, 'bad');
    return false;
  } finally {
    syncing = false;
  }
}

async function pushNow({ quiet } = {}) {
  if (!syncKey) return;
  try {
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'PUT',
      headers: { 'x-sync-key': syncKey, 'content-type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error(`Server said ${res.status}`);
    setDirty(false);
    /* The server merges uploads and sends back the result, which may hold
       days another device (or the phone app) added since this one pulled.
       Only re-render if it does: a render resets input boxes mid-typing. */
    const body = await res.json().catch(() => null);
    const doc = body && body.doc;
    if (doc && doc.days && typeof doc.days === 'object' &&
        Object.keys(doc.days).some(k => !state.days[k] || (doc.days[k].u || 0) > (state.days[k].u || 0)
          || (doc.days[k].wu || 0) > (state.days[k].wu || 0))) {
      state = mergeStates(state, doc);
      save();
      render();
    }
    if (!quiet) syncStatus('Saved to the server.', 'ok');
    renderSyncPanel();
    return true;
  } catch (err) {
    setDirty(true);
    if (!quiet) syncStatus('Save failed — kept safely in this browser, will retry. ' + err.message, 'bad');
    return false;
  }
}

/* Debounced: typing three meals in a row is one upload, not three. */
function queuePush() {
  if (!syncKey) return;
  setDirty(true);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow({ quiet: true }), 1500);
}

async function enableSync(passphrase) {
  if (!window.crypto || !crypto.subtle) {
    return syncStatus('This browser cannot derive a key here. Sync needs an https:// page.', 'bad');
  }
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
    return syncStatus(`Use at least ${MIN_PASSPHRASE} characters — this passphrase is the only thing protecting your data.`, 'bad');
  }
  syncStatus('Connecting…', 'ok');
  syncKey = await deriveKey(passphrase);
  try { localStorage.setItem(SYNC_KEY_STORE, syncKey); } catch { /* storage blocked */ }

  // Pull anything already stored under this passphrase, merge, then push back
  // so the server ends up holding the union of both sides.
  const pulled = await pullAndMerge({ quiet: true });
  if (!pulled) {
    syncStatus('Could not reach the server. Sync is on and will retry; nothing was lost.', 'bad');
    renderSyncPanel();
    return;
  }
  await pushNow({ quiet: true });
  syncStatus(`Sync on. ${Object.keys(state.days).length} day(s) stored on the server.`, 'ok');
  renderSyncPanel();
  toast('Sync enabled');
}

function disableSync() {
  syncKey = null;
  clearTimeout(pushTimer);
  try { localStorage.removeItem(SYNC_KEY_STORE); } catch { /* storage blocked */ }
  renderSyncPanel();
  syncStatus('Sync off. Your data stays in this browser; the server copy is untouched.', 'ok');
}

/* One tap hands the phone app this device's sync key, so the passphrase is
   never retyped (a stray capital or space derives a different key, and the
   app then finds no log). An intent: link with the app's package named goes
   to that app only; if it isn't installed, the browser opens the APK
   download instead. The key never leaves the phone: the browser resolves
   the link locally. */
const ANDROID_PACKAGE = 'io.github.aftab355.weightsync';
function phoneLinkHref() {
  const apk = new URL('android/calorie-weight-sync.apk', location.href).href;
  return `intent://connect?site=${encodeURIComponent(location.origin)}&key=${syncKey}` +
    `#Intent;scheme=weightsync;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(apk)};end`;
}

function renderSyncPanel() {
  const on = !!syncKey;
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  $('#syncBadge').textContent = on ? 'on' : 'off';
  $('#syncKeyId').textContent = on ? syncKey.slice(0, 6) : '';
  $('#phoneLink').hidden = !on;
  $('#phoneLinkOff').hidden = on;
  if (on) $('#phoneLink').href = phoneLinkHref();
}

/* ─────────────────────────  settings & backup  ───────────────────────── */
function renderSettings() {
  $('#setTarget').value = state.settings.dailyTarget;
  $('#setMaint').value = state.settings.maintenance;
  $('#setFactor').value = state.settings.activityFactor;
  $('#setWeekStart').value = String(state.settings.weekStart);
  $('#setWeightUnit').value = state.settings.weightUnit;
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `calorie-tracker-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded');
}

function restoreBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const msg = $('#dataMsg');
    msg.textContent = '';
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object') {
        throw new Error('That is not a Calorie Tracker backup.');
      }
      const days = Object.keys(parsed.days).length;
      if (!confirm(`Replace everything currently stored with this backup (${days} days)?`)) return;
      /* The server keeps the newer copy of each day, so a restore re-dates
         every restored day to now, and empties (tombstones) days the backup
         doesn't have — otherwise sync would quietly bring them back. */
      const now = Date.now();
      const restored = {};
      Object.keys(state.days).forEach(k => { restored[k] = { entries: [], activity: null, u: now }; });
      Object.entries(parsed.days).forEach(([k, d]) => {
        if (d && typeof d === 'object') restored[k] = Object.assign({ entries: [], activity: null }, d, { u: now });
      });
      state = {
        version: 1,
        settings: cleanSettings(parsed.settings),
        settingsU: now,
        days: restored
      };
      save();
      queuePush();
      weekCursor = startOfWeek(cursor, state.settings.weekStart);
      render();
      msg.append(note('ok', `Restored ${days} days.`));
      toast('Backup restored');
    } catch (err) {
      msg.append(note('bad', err.message));
    }
  };
  reader.readAsText(file);
}

/* ─────────────────────────  views  ───────────────────────── */
let view = 'today';

function showView(name) {
  view = name;
  ['today', 'week', 'month', 'weight', 'settings'].forEach(v => {
    document.getElementById('view-' + v).hidden = v !== name;
  });
  document.querySelectorAll('.tab').forEach(t => {
    t.setAttribute('aria-selected', String(t.dataset.view === name));
  });
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  // The chart is sized to its box, which has no width while the tab is hidden.
  if (name === 'weight') renderWeight();
}

function render() {
  renderToday();
  renderWeek();
  renderMonth();
  renderWeight();
  renderSettings();
}

/* ─────────────────────────  wiring  ───────────────────────── */
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => showView(t.dataset.view);
});

// Day navigation
$('#prevDay').onclick = () => { goToDay(addDays(cursor, -1)); };
$('#nextDay').onclick = () => {
  if (cursor >= todayKey()) return;
  goToDay(addDays(cursor, 1));
};
/* The native date input sits invisibly over the formatted label: Android
   renders it as a left-aligned dd/mm/yyyy box with its own chevron that
   ignores text-align. showPicker() opens it where tapping the overlay alone
   would not (desktop Chrome). */
$('#datePicker').onclick = e => { try { e.target.showPicker(); } catch { /* unsupported — native tap handles it */ } };
$('#datePicker').onchange = e => {
  if (!e.target.value) return;
  goToDay(e.target.value > todayKey() ? todayKey() : e.target.value);
};
function goToDay(k) {
  cursor = k;
  followToday = (k === todayKey());
  syncWeekToCursor();
  monthCursor = monthOf(k);
  monthSel = k;
  render();
}
function syncWeekToCursor() { weekCursor = startOfWeek(cursor, state.settings.weekStart); }

// Week navigation
$('#prevWeek').onclick = () => { weekCursor = addDays(weekCursor, -7); renderWeek(); };
$('#nextWeek').onclick = () => {
  const thisWeek = startOfWeek(todayKey(), state.settings.weekStart);
  if (weekCursor >= thisWeek) return;
  weekCursor = addDays(weekCursor, 7); renderWeek();
};

// Month navigation
$('#prevMonth').onclick = () => { monthCursor = addMonths(monthCursor, -1); renderMonth(); };
$('#nextMonth').onclick = () => {
  if (monthCursor >= monthOf(todayKey())) return;
  monthCursor = addMonths(monthCursor, 1); renderMonth();
};
$('#moOpenDay').onclick = () => { goToDay(monthSel); showView('today'); };

// Add food
$('#addForm').onsubmit = e => {
  e.preventDefault();
  const name = $('#fName').value.trim();
  const cals = Number($('#fCals').value);
  const qty = Number($('#fQty').value) || 1;
  if (!name) return toast('Give it a name');
  if (!Number.isFinite(cals) || cals < 0) return toast('Calories must be a number');
  addEntry(name, cals, qty);
  e.target.reset();
  $('#fQty').value = 1;
  $('#fName').focus();
};

// Activity — commit on blur/change rather than each keystroke.
$('#activityInput').onchange = e => {
  const v = Number(e.target.value);
  setActivity(Number.isFinite(v) ? v : 0, 'manual');
};

// Weight — commit on change, like activity. Clearing the box removes it.
$('#weightInput').onchange = e => {
  const raw = e.target.value.trim();
  if (!raw) { if (weightOf(cursor)) { setWeight(NaN); toast('Weight removed'); } return; }
  const kg = parseWeightInput(raw);
  if (!sensibleKg(kg)) {
    toast(wUnit() === 'st' ? 'Type stone and pounds, e.g. 13 4' : `That doesn't look like a weight in ${wUnit()}`);
    renderWeightCard();
    return;
  }
  setWeight(kg, 'manual');
  toast(`Weight saved · ${fmtWeight(kg)}`);
};
document.querySelectorAll('#wtRange button').forEach(b => {
  b.onclick = () => {
    weightRange = b.dataset.range;
    try { localStorage.setItem('calorie-tracker/weight-range', weightRange); } catch { /* storage blocked */ }
    renderWeight();
  };
});
$('#wtGoToday').onclick = () => { goToDay(todayKey()); showView('today'); setTimeout(() => $('#weightInput').focus(), 50); };
$('#wtGoImport').onclick = () => { showView('settings'); $('#dropZone').scrollIntoView({ block: 'center' }); };
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view === 'weight') renderWeight(); }, 150);
});

// Settings
$('#setWeightUnit').onchange = e => {
  state.settings.weightUnit = e.target.value;
  state.settingsU = Date.now();
  save(); queuePush(); render();
};
$('#setTarget').onchange = e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) { state.settings.dailyTarget = Math.round(v); state.settingsU = Date.now(); save(); queuePush(); }
  render();
};
$('#setMaint').onchange = e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) { state.settings.maintenance = Math.round(v); state.settingsU = Date.now(); save(); queuePush(); }
  render();
};
$('#setFactor').onchange = e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v >= 0 && v <= 2) { state.settings.activityFactor = v; state.settingsU = Date.now(); save(); queuePush(); }
  render();
};
$('#setWeekStart').onchange = e => {
  state.settings.weekStart = Number(e.target.value);
  state.settingsU = Date.now();
  save(); queuePush(); syncWeekToCursor(); render();
};

// Past days from notes
$('#historyYear').value = new Date().getFullYear();
$('#historyPreview').onclick = previewHistory;
$('#clearRecorded').onclick = () => {
  if (!confirm('Remove the imported net for this day?')) return;
  mutateDay(cursor, d => { delete d.recorded; });
  render();
  toast('Imported net removed');
};

// Import
const drop = $('#dropZone'), fileInput = $('#fileInput');
drop.onclick = () => fileInput.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// Sync
$('#syncForm').onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;                       // PBKDF2 takes a moment; don't let it double-fire
  try { await enableSync($('#syncPass').value); }
  finally { btn.disabled = false; $('#syncPass').value = ''; }
};
$('#syncNowBtn').onclick = async () => {
  syncStatus('Syncing…', 'ok');
  if (await pullAndMerge({ quiet: true })) await pushNow();
  else syncStatus('Could not reach the server — nothing was lost.', 'bad');
};
$('#syncOffBtn').onclick = () => {
  if (confirm('Stop syncing on this device? The log stays here and the server copy is left alone.')) disableSync();
};

// Backup
$('#exportBtn').onclick = exportBackup;
$('#importBtn').onclick = () => $('#restoreInput').click();
$('#restoreInput').onchange = e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; };
$('#wipeBtn').onclick = () => {
  if (!confirm('Erase every logged day and reset settings? This cannot be undone.')) return;
  if (!confirm('Really erase everything? Export a backup first if you are unsure.')) return;
  // Tombstone every known day so the wipe propagates instead of syncing back.
  const wiped = {};
  Object.keys(state.days).forEach(k => { wiped[k] = { entries: [], activity: null, u: Date.now() }; });
  state = { version: 1, settings: cleanSettings(), settingsU: Date.now(), days: wiped };
  save();
  queuePush();
  goToDay(todayKey());
  toast('Everything erased');
};

/* A tab left open past midnight would otherwise keep filing meals under
   yesterday. Roll forward only if the user never navigated away from today —
   if they deliberately opened a past day, leave them on it. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (followToday && cursor !== todayKey()) { cursor = todayKey(); syncWeekToCursor(); monthCursor = monthOf(cursor); monthSel = null; }
  render();
});

render();
showView('today');
renderSyncPanel();

/* Pull whatever another device wrote, then flush anything this device still
   owes the server. Order matters: merging first means the retry uploads the
   union, not a stale local snapshot. */
async function reconcile() {
  if (!syncKey) return;
  await pullAndMerge({ quiet: true });
  if (dirty) await pushNow({ quiet: true });
}

reconcile();
if (dirty) scheduleRetry();

// Returning to the tab is the natural moment to pick up another device's edits.
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcile(); });
window.addEventListener('online', reconcile);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
})();
