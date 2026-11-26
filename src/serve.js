import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 64 * 1024; // Flagsmith's FLAG_UPDATED payload is ~2 KB
export const RUN_FLAG = 'run_cleanup';

/** Flagsmith signs webhooks with X-Flagsmith-Signature = hex HMAC-SHA256 of the raw body. */
export function verifySignature(secret, body, signature) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** True only when run_cleanup goes OFF -> ON for the whole environment (not one user or segment). */
export function isRunRequest(payload) {
  const { new_state: now, previous_state: before } = payload?.data ?? {};
  return payload?.event_type === 'FLAG_UPDATED' && now?.feature?.name === RUN_FLAG &&
    now.enabled === true && before?.enabled === false && !now.identity && !now.feature_segment;
}

/**
 * Receives Flagsmith webhooks. A verified run request calls onTrigger(payload) once;
 * repeats within cooldownMs (Flagsmith delivers duplicates) are ignored.
 */
export function createWebhookServer({ secret, onTrigger, cooldownMs = 30_000 }) {
  let busyUntil = 0;
  return http.createServer(async (req, res) => {
    const reply = (code, text) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(text); };
    if (req.method !== 'POST') return reply(405, 'POST only');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) { reply(413, 'too large'); return req.destroy(); }
    }
    if (!verifySignature(secret, body, req.headers['x-flagsmith-signature'])) return reply(401, 'bad signature');
    let payload;
    try { payload = JSON.parse(body); } catch { return reply(400, 'bad json'); }
    if (!isRunRequest(payload) || Date.now() < busyUntil) return reply(200, 'ignored');
    busyUntil = Date.now() + cooldownMs; // set before awaiting so a concurrent duplicate is ignored
    try {
      await onTrigger(payload);
      reply(202, 'run started');
    } catch (e) {
      console.error(`flag-janitor serve: run failed: ${e.message}`);
      reply(500, 'run failed');
    }
  });
}
