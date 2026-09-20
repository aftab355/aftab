import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

/* Server-side storage so a day's log is not trapped in one browser.
 *
 * There are no accounts. The client derives a 64-hex key from a passphrase
 * with PBKDF2 and sends only that key — the passphrase itself never leaves
 * the device, and the server stores nothing that identifies anyone. The key
 * is therefore the whole credential: whoever holds it can read and write that
 * document, which is why the client enforces a passphrase length floor.
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
    return json({ doc: doc ?? null });
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

    await store.setJSON(key, doc);
    return json({ ok: true, savedAt: Date.now() });
  }

  if (req.method === 'DELETE') {
    await store.delete(key);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed.' }, 405);
};

export const config: Config = { path: '/api/sync' };
