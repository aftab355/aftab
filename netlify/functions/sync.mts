import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { mergeDocs } from '../lib/merge.mjs';

/* Server-side storage so a day's log is not trapped in one browser.
 *
 * There are no accounts. The client derives a 64-hex key from a passphrase
 * with PBKDF2 and sends only that key — the passphrase itself never leaves
 * the device, and the server stores nothing that identifies anyone. The key
 * is therefore the whole credential: whoever holds it can read and write that
 * document, which is why the client enforces a passphrase length floor.
 *
 * PUT merges into what is stored rather than replacing it (see
 * ../lib/merge.mjs), and returns the merged document so the writer can pick
 * up anything another device added. GET advertises `merge: 1`; the Android
 * weight-sync app sends only the days it changed and checks for that flag
 * first, because a partial upload to a replacing server would wipe the log.
 *
 * Two PUTs landing within the same few milliseconds can still race (Blobs
 * 8.x has no conditional write); merging on every later write narrows that
 * to a window nobody will hit by hand.
 */

const KEY_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1_000_000;          // ~years of logs; anything larger is a bug or abuse

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

export default async (req: Request, _context: Context) => {
  const key = req.headers.get('x-sync-key') || '';
  if (!KEY_RE.test(key)) return json({ error: 'Bad or missing sync key.' }, 400);

  const store = getStore({ name: 'calorie-tracker', consistency: 'strong' });

  if (req.method === 'GET') {
    const doc = await store.get(key, { type: 'json' });
    return json({ doc: doc ?? null, merge: 1 });
  }

  if (req.method === 'PUT') {
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json({ error: 'Payload too large.' }, 413);

    let doc: any;
    try { doc = JSON.parse(raw); }
    catch { return json({ error: 'Body is not valid JSON.' }, 400); }

    if (!doc || typeof doc !== 'object' || typeof doc.days !== 'object' || doc.days === null) {
      return json({ error: 'Not a tracker document.' }, 400);
    }

    const stored = await store.get(key, { type: 'json' });
    const merged = mergeDocs(stored, doc);
    const out = JSON.stringify(merged);
    if (out.length > MAX_BYTES) return json({ error: 'Payload too large.' }, 413);
    await store.setJSON(key, merged);
    return json({ ok: true, savedAt: Date.now(), doc: merged, merge: 1 });
  }

  if (req.method === 'DELETE') {
    await store.delete(key);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed.' }, 405);
};

export const config: Config = { path: '/api/sync' };
