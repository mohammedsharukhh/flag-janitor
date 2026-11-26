import { Flagsmith } from 'flagsmith-nodejs';

const env = process.env;
const need = (k) => env[k] || (() => { throw new Error(`Missing env var ${k}`); })();
const base = () => need('FLAGSMITH_API_URL').replace(/\/$/, '');

async function api(pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : base() + pathOrUrl;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Api-Key ${need('FLAGSMITH_API_KEY')}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Flagsmith ${opts.method || 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Follows Flagsmith's ?page= pagination; some endpoints return a bare list.
async function all(path) {
  const out = [];
  for (let url = path; url;) {
    const page = await api(url);
    if (Array.isArray(page)) return page;
    out.push(...page.results);
    url = page.next;
  }
  return out;
}

const project = async () => (await api(`/environments/${need('FLAGSMITH_ENVIRONMENT')}/`));

/**
 * Flags tagged stale (Flagsmith's system Stale tag, or a tag named $JANITOR_TAG, default "stale"),
 * with their value in the target environment. `skip` says why a flag is not safe to hard-code.
 */
export async function findStaleFlags() {
  const { id: envId, project: projectId } = await project();
  const label = (env.JANITOR_TAG || 'stale').toLowerCase();
  const staleTags = new Set((await all(`/projects/${projectId}/tags/`))
    .filter((t) => t.type === 'STALE' || t.label.toLowerCase() === label).map((t) => t.id));
  const features = await all(`/projects/${projectId}/features/?environment=${envId}`);
  return features.filter((f) => !f.is_archived && f.tags.some((t) => staleTags.has(t))).map((f) => ({
    id: f.id,
    name: f.name,
    enabled: f.environment_feature_state?.enabled ?? f.default_enabled,
    // Only a flag with one value for everyone can be hard-coded.
    skip: f.type !== 'STANDARD' || f.multivariate_options.length ? 'multivariate flag'
      : f.num_segment_overrides ? 'has segment overrides'
      : f.num_identity_overrides ? 'has identity overrides'
      : null,
  }));
}

export async function archiveFlag(name) {
  const { project: projectId } = await project();
  const f = (await all(`/projects/${projectId}/features/?search=${encodeURIComponent(name)}`)).find((x) => x.name === name);
  if (!f) throw new Error(`No flag named ${name}`);
  if (f.is_archived) return false;
  await api(`/projects/${projectId}/features/${f.id}/`, { method: 'PATCH', body: JSON.stringify({ is_archived: true }) });
  return true;
}

/**
 * Flag Janitor's own risky actions are behind Flagsmith flags (open_prs, archive_flags)
 * in a separate environment. No JANITOR_ENVIRONMENT_KEY = no gates; a missing flag = off.
 */
export async function gate(name) {
  if (!env.JANITOR_ENVIRONMENT_KEY) return true;
  const fs = new Flagsmith({ environmentKey: env.JANITOR_ENVIRONMENT_KEY, apiUrl: base() + '/' });
  return (await fs.getEnvironmentFlags()).isFeatureEnabled(name);
}
