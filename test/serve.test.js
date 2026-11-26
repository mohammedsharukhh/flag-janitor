import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, isRunRequest, createWebhookServer } from '../src/serve.js';
import { flagUpdated } from './helpers/fake-flagsmith.js';

const SECRET = 'hook-secret-for-tests-only';

test('signature: HMAC-SHA256 of the raw body, compared safely', () => {
  const { body, signature } = flagUpdated();
  assert.equal(verifySignature(SECRET, body, signature), true);
  assert.equal(verifySignature(SECRET, body + ' ', signature), false);
  assert.equal(verifySignature('other-secret', body, signature), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, ''), false);
  assert.equal(verifySignature(SECRET, body, signature.slice(0, 10)), false); // different length must not throw
  assert.equal(verifySignature(SECRET, body, 'zz'.repeat(32)), false);
  assert.equal(verifySignature('', body, signature), false); // no secret configured = nothing is trusted
});

test('only an OFF -> ON flip of run_cleanup for the whole environment is a run request', () => {
  const run = (o) => isRunRequest(JSON.parse(flagUpdated(o).body));
  assert.equal(run({}), true);
  assert.equal(run({ from: true, to: true }), false);
  assert.equal(run({ from: true, to: false }), false); // our own reset
  assert.equal(run({ name: 'open_prs' }), false);
  assert.equal(run({ identity: 7 }), false); // one user's override is not a run request
  assert.equal(run({ segment: { id: 1 } }), false);
  assert.equal(isRunRequest({ event_type: 'AUDIT_LOG_CREATED', data: {} }), false);
  assert.equal(isRunRequest(null), false);
});

async function start(onTrigger) {
  const server = createWebhookServer({ secret: SECRET, onTrigger, cooldownMs: 60_000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const post = (body, sig, method = 'POST') =>
    fetch(url, { method, body: method === 'GET' ? undefined : body, headers: sig ? { 'X-Flagsmith-Signature': sig } : {} });
  return { post };
}

test('server: rejects unsigned, forged, oversized, malformed and non-POST requests', async () => {
  const calls = [];
  const { post } = await start(async (p) => calls.push(p));
  const { body, signature } = flagUpdated();
  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, flagUpdated({ secret: 'attacker' }).signature)).status, 401);
  assert.equal((await post(body, null, 'GET')).status, 405);
  assert.equal((await post('x'.repeat(70_000), signature)).status, 413);
  const junk = 'not json';
  assert.equal((await post(junk, createHmac('sha256', SECRET).update(junk).digest('hex'))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await post(body, signature)).status, 202);
  assert.equal(calls.length, 1);
});

test('server: Flagsmith\'s duplicate deliveries trigger one run; unrelated events are ignored', async () => {
  const calls = [];
  const { post } = await start(async (p) => calls.push(p));
  const off = flagUpdated({ from: true, to: false });
  assert.equal((await post(off.body, off.signature)).status, 200);
  const on = flagUpdated();
  const codes = await Promise.all([post(on.body, on.signature), post(on.body, on.signature)]);
  assert.deepEqual(codes.map((r) => r.status).sort(), [200, 202]);
  assert.equal(calls.length, 1);
});

test('server: a failing run answers 500 and does not crash the server', async () => {
  const { post } = await start(async () => { throw new Error('gh exploded'); });
  const { body, signature } = flagUpdated();
  assert.equal((await post(body, signature)).status, 500);
  assert.equal((await post(body, signature)).status, 200); // still alive (cooling down)
});
