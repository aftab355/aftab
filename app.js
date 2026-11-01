/* Calorie Tracker — no build step, no backend, no accounts.
   State lives in localStorage under one key. */
(() => {
'use strict';

const KEY = 'calorie-tracker/v1';
const DEFAULTS = { dailyTarget: 2550, maintenance: 2600, activityFactor: 0.75, weekStart: 1 };

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
    weekStart: w === 0 || w === 1 ? w : DEFAULTS.weekStart
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
    if (k < cutoff && !d.entries.length && !d.activity) delete state.days[k];
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

function summaryOf(k) {
  const eaten = eatenOf(k), target = targetOf();
  const active = activeCalsOf(k);
  const allowance = state.settings.maintenance + state.settings.activityFactor * active;
  return {
    eaten, target, active, allowance,
    balance: eaten - target, net: eaten - allowance,
    logged: dayOf(k).entries.length > 0
  };
}

const round = n => Math.round(n);
const withSign = n => (n > 0 ? '+' : '') + round(n).toLocaleString();
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

  // Headline: how many calories left, or how far over.
  const card = $('#balanceCard');
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

  // Activity
  const act = dayOf(cursor).activity;
  $('#activityInput').value = act ? act.calories : '';
  $('#activitySource').textContent = !act ? 'not set' : (act.source === 'samsung' ? 'Samsung Health' : 'manual');
  $('#activityNote').textContent =
    `Counts toward the day's net only — your target stays ${kcal(s.target)}.`;

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
  const eaten = counted.reduce((s, r) => s + r.eaten, 0);
  const allowance = counted.reduce((s, r) => s + r.allowance, 0);
  const active = counted.reduce((s, r) => s + r.active, 0);
  const net = eaten - allowance;

  const thisWeek = startOfWeek(t, state.settings.weekStart);
  $('#weekLabel').textContent = `${fmtShort(days[0])} – ${fmtShort(days[6])}`;
  $('#weekRelative').textContent =
    weekCursor === thisWeek ? 'This week'
    : weekCursor === addDays(thisWeek, -7) ? 'Last week'
    : parseKey(weekCursor).getFullYear();
  $('#nextWeek').disabled = weekCursor >= thisWeek;

  $('#wkEaten').textContent = counted.length ? kcal(eaten) : '—';
  const factor = state.settings.activityFactor;
  $('#wkBurned').textContent = counted.length ? kcal(allowance) : '—';
  $('#wkBurnedSub').textContent = counted.length
    ? `${kcal(state.settings.maintenance)} × ${counted.length} + ${factor} × ${kcal(active)} activity`
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
    : (pending ? 'today still going' : 'nothing logged');

  $('#wkAvg').textContent = counted.length ? kcal(eaten / counted.length) : '—';
  const vsTarget = counted.length ? eaten / counted.length - state.settings.dailyTarget : 0;
  $('#wkAvgSub').textContent = counted.length
    ? `eaten · ${withSign(vsTarget)} vs ${kcal(state.settings.dailyTarget)} target`
    : (pending ? 'today still going' : 'no logged days');

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
    col.title = r.logged
      ? `${fmtLong(r.key)} — ${kcal(r.eaten)} eaten / ${kcal(r.allowance)} allowance (${withSign(r.net)})`
      : `${fmtLong(r.key)} — nothing logged`;

    const bars = el('div', 'col-bars');
    const bar = el('div', 'col-bar');
    if (r.eaten > 0) bar.style.height = ((r.eaten / peak) * 100) + '%';
    else bar.classList.add('empty');
    bars.append(bar);

    if (r.logged) {
      const line = el('div', 'col-target');
      line.style.bottom = ((r.allowance / peak) * 100) + '%';
      bars.append(line);
    }

    const val = el('div', 'col-val', r.eaten ? kcal(r.eaten) : '');
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
      el('td', null, r.logged ? kcal(r.eaten) : '—'),
      el('td', null, r.active ? kcal(r.active) : '—')
    );

    const bal = el('td');
    if (r.logged) {
      bal.className = r.net > 0 ? 'pos' : 'neg';
      bal.textContent = withSign(r.net);
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
  if (r.logged && r.allowance > 0) {
    const share = Math.min(1, r.eaten / r.allowance);
    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', 18); arc.setAttribute('cy', 18); arc.setAttribute('r', 15);
    arc.setAttribute('class', 'ring-arc ' + (r.net > 0 ? 'over' : isToday && !todaySettled() ? 'live' : 'under'));
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

  const eaten = counted.reduce((s, r) => s + r.eaten, 0);
  const allowance = counted.reduce((s, r) => s + r.allowance, 0);
  const active = counted.reduce((s, r) => s + r.active, 0);
  const net = eaten - allowance;
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

  $('#moEaten').textContent = has ? kcal(eaten / counted.length) : '—';
  $('#moEatenSub').textContent = has
    ? `eaten / day · ${withSign(eaten / counted.length - state.settings.dailyTarget)} vs target`
    : 'eaten / day';

  $('#moTotals').textContent = has
    ? `${kcal(eaten)} eaten · ${kcal(active)} activity · ${kcal(allowance)} allowance over ${counted.length} day${counted.length === 1 ? '' : 's'}`
      + (pending ? ' — today joins at ' + fmtHour(SETTLE_HOUR) : '')
    : '';

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
  $('#moSelEaten').textContent = s.logged ? kcal(s.eaten) : '—';
  $('#moSelActive').textContent = s.active ? kcal(s.active) : '—';
  $('#moSelAllow').textContent = s.logged ? kcal(s.allowance) : '—';
  const n = $('#moSelNet');
  const live = k === todayKey() && !todaySettled();
  n.className = !s.logged || live ? '' : s.net > 0 ? 'pos' : 'neg';
  n.textContent = s.logged ? withSign(s.net) : '—';
  $('#moSelVerdict').textContent = !s.logged ? 'Nothing logged'
    : live ? 'Day still going'
    : s.net > 0 ? 'Surplus' : 'Deficit';
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

function handleFile(file) {
  const box = $('#importResult');
  const reader = new FileReader();

  reader.onerror = () => { box.innerHTML = ''; box.append(note('bad', 'Could not read that file.')); };
  reader.onload = () => {
    box.textContent = '';
    let parsed;
    try {
      parsed = extractActivity(String(reader.result), file.name);
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
function mergeStates(local, remote) {
  const days = {};
  for (const k of new Set([...Object.keys(local.days || {}), ...Object.keys(remote.days || {})])) {
    const l = local.days[k], r = remote.days[k];
    if (!l) days[k] = r;
    else if (!r) days[k] = l;
    else days[k] = (l.u || 0) >= (r.u || 0) ? l : r;
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

function renderSyncPanel() {
  const on = !!syncKey;
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  $('#syncBadge').textContent = on ? 'on' : 'off';
}

/* ─────────────────────────  settings & backup  ───────────────────────── */
function renderSettings() {
  $('#setTarget').value = state.settings.dailyTarget;
  $('#setMaint').value = state.settings.maintenance;
  $('#setFactor').value = state.settings.activityFactor;
  $('#setWeekStart').value = String(state.settings.weekStart);
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
      state = {
        version: 1,
        settings: cleanSettings(parsed.settings),
        settingsU: Date.now(),
        days: parsed.days
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
  ['today', 'week', 'month', 'settings'].forEach(v => {
    document.getElementById('view-' + v).hidden = v !== name;
  });
  document.querySelectorAll('.tab').forEach(t => {
    t.setAttribute('aria-selected', String(t.dataset.view === name));
  });
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function render() {
  renderToday();
  renderWeek();
  renderMonth();
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

// Settings
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
