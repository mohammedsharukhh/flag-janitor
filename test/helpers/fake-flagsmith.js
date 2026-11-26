import http from 'node:http';

const listen = async (server) => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; };

// Feature JSON in the shape Flagsmith's /features/?environment= endpoint returns.
const full = (f) => ({
  type: 'STANDARD', multivariate_options: [], num_segment_overrides: 0, num_identity_overrides: null,
  is_archived: false, tags: [], default_enabled: false, ...f,
  environment_feature_state: { enabled: f.enabled ?? false, feature_segment: null, identity: null },
});

/** Minimal stand-in for the Flagsmith Admin + Flags API. Records every request. */
export async function fakeFlagsmith({ features = [], tags = [{ id: 1, label: 'stale', type: 'NONE' }], janitorFlags = {}, pageSize = 2, nextOrigin } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    requests.push({ method: req.method, path: p + url.search, body: body ? JSON.parse(body) : null });
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (p === '/api/v1/flags/') {
      if (req.headers['x-environment-key'] !== 'janitor-key') return send(401, { detail: 'bad env key' });
      return send(200, Object.entries(janitorFlags).map(([name, enabled], i) =>
        ({ id: i + 1, feature: { id: i + 1, name, type: 'STANDARD' }, enabled, feature_state_value: null })));
    }
    if (req.headers.authorization !== 'Api-Key admin-key') return send(401, { detail: 'bad api key' });
    // Janitor's own environment: feature N (1-based index into janitorFlags) has feature state 100 + N.
    const names = Object.keys(janitorFlags);
    if (p === '/api/v1/environments/janitor-key/featurestates/') {
      const id = Number(url.searchParams.get('feature'));
      const name = names[id - 1];
      return send(200, { results: name ? [{ id: 100 + id, feature: id, enabled: janitorFlags[name], identity: null, feature_segment: null }] : [] });
    }
    const fsm = p.match(/^\/api\/v1\/environments\/janitor-key\/featurestates\/(\d+)\/$/);
    if (fsm && req.method === 'PATCH') {
      const name = names[Number(fsm[1]) - 101];
      janitorFlags[name] = JSON.parse(body).enabled;
      return send(200, { id: Number(fsm[1]), enabled: janitorFlags[name] });
    }
    if (p === '/api/v1/environments/prod-key/') return send(200, { id: 2, project: 1, api_key: 'prod-key' });
    if (p === '/api/v1/projects/1/tags/') return send(200, tags);
    if (p === '/api/v1/projects/1/features/' && req.method === 'GET') {
      const search = url.searchParams.get('search');
      const list = search ? features.filter((f) => f.name.includes(search)) : features;
      const page = Number(url.searchParams.get('page') || 1);
      const next = new URL(req.url, nextOrigin || `http://127.0.0.1:${server.address().port}`);
      next.searchParams.set('page', page + 1);
      return send(200, {
        count: list.length,
        next: page * pageSize < list.length ? next.href : null,
        results: list.slice((page - 1) * pageSize, page * pageSize).map(full),
      });
    }
    const m = p.match(/^\/api\/v1\/projects\/1\/features\/(\d+)\/$/);
    if (m && req.method === 'PATCH') {
      const f = features.find((x) => x.id === Number(m[1]));
      Object.assign(f, JSON.parse(body));
      return send(200, full(f));
    }
    send(404, { detail: `not found ${p}` });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/api/v1`, requests, features, janitorFlags, close: () => server.close() };
}

/** A server that only records what reaches it (to prove secrets never do). */
export async function recorder() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.headers); res.end('{}'); });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

export const useEnv = (vars) => {
  const old = { ...process.env };
  Object.assign(process.env, vars);
  return () => { for (const k of Object.keys(vars)) if (k in old) process.env[k] = old[k]; else delete process.env[k]; };
};

import crypto from 'node:crypto';

/** A Flagsmith FLAG_UPDATED webhook body (shape captured from self-hosted Flagsmith), plus its signature. */
export function flagUpdated({ name = 'run_cleanup', id = 1, from = false, to = true, identity = null, segment = null, secret = 'hook-secret-for-tests-only' } = {}) {
  const state = (enabled) => ({ enabled, environment: { id: 3, name: 'Production' }, feature: { id, name, type: 'STANDARD', project: { id: 2, name: 'flag-janitor' } },
    feature_segment: segment, feature_state_value: null, identity, identity_identifier: identity && 'user-1', multivariate_feature_state_values: [] });
  const body = JSON.stringify({ data: { changed_by: 'someone', new_state: state(to), previous_state: state(from), timestamp: new Date().toISOString() }, event_type: 'FLAG_UPDATED' });
  return { body, signature: crypto.createHmac('sha256', secret).update(body).digest('hex') };
}
