/* Server-side merge for /api/sync, kept apart from the function so it can be
 * tested without Netlify.
 *
 * Uploads used to replace the stored document outright. That loses data the
 * moment two writers overlap: the phone app adds this morning's weigh-in, then
 * a laptop tab that hasn't pulled since logs lunch and uploads its whole
 * state, and the weigh-in is gone from the server. Merging per day, by each
 * day's `u` timestamp (the same rule the browser uses), means an upload can
 * only replace a day with a newer version of that day. Days the upload
 * doesn't mention are kept, so a writer may send just the days it changed.
 * Deletions still work: the client keeps an emptied day as a tombstone with a
 * fresh `u`, and that newer tombstone wins.
 */
/* Weight is merged on its own clock (`wu`), apart from the day's food. A
 * weigh-in usually arrives from the phone on the same day you log meals on
 * the laptop, and whole-day last-write-wins would let the later meal upload
 * erase the morning's weigh-in. Deleting a weight sets `wu` too, so a
 * deletion still beats an older reading. */
export function mergeDay(a, b) {
  const [win, lose] = (Number(a.u) || 0) >= (Number(b.u) || 0) ? [a, b] : [b, a];
  const wWin = Number(win.wu) || 0, wLose = Number(lose.wu) || 0;
  if (wLose <= wWin) return win;
  const out = { ...win, wu: wLose };
  if (lose.weight) out.weight = lose.weight; else delete out.weight;
  return out;
}

export function mergeDocs(stored, incoming) {
  const base = stored && typeof stored === 'object' && stored.days && typeof stored.days === 'object'
    ? stored : { days: {}, settingsU: -1 };
  const days = { ...base.days };
  for (const [k, d] of Object.entries(incoming.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d || typeof d !== 'object') continue;
    const cur = days[k];
    days[k] = cur && typeof cur === 'object' ? mergeDay(d, cur) : d;
  }
  const inU = Number(incoming.settingsU) || 0, baseU = Number(base.settingsU) || 0;
  const incomingSettings = incoming.settings && typeof incoming.settings === 'object';
  const takeIncoming = incomingSettings && (inU >= baseU || !base.settings);
  return {
    version: 1,
    settings: takeIncoming ? incoming.settings : (base.settings || {}),
    settingsU: Math.max(inU, baseU, 0),
    days
  };
}
