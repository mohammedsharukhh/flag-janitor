import { Flagsmith } from 'flagsmith-nodejs';
import { isSafeFlagName } from './repo.js';

const env = process.env;
const need = (k) => env[k] || (() => { throw new Error(`Missing env var ${k}`); })();
const base = () => need('FLAGSMITH_API_URL').replace(/\/$/, '');

async function api(pathOrUrl, opts = {}) {
  // Pagination links are absolute. Keep only their path so the admin key never goes to another host or scheme.
  const url = pathOrUrl.startsWith('http')
    ? new URL(new URL(pathOrUrl).pathname + new URL(pathOrUrl).search, base()).href
    : base() + pathOrUrl;
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

const project = async () => (await api(`/environments/${encodeURIComponent(need('FLAGSMITH_ENVIRONMENT'))}/`));

async function staleTagIds(projectId) {
  const label = (env.JANITOR_TAG || 'stale').toLowerCase();
  return new Set((await all(`/projects/${projectId}/tags/`))
    .filter((t) => t.type === 'STALE' || t.label.toLowerCase() === label).map((t) => t.id));
}

/**
 * Flags tagged stale (Flagsmith's system Stale tag, or a tag named $JANITOR_TAG, default "stale"),
 * with their value in the target environment. `skip` says why a flag is not safe to hard-code.
 */
export async function findStaleFlags() {
  const { id: envId, project: projectId } = await project();
  const staleTags = await staleTagIds(projectId);
  const features = await all(`/projects/${projectId}/features/?environment=${envId}`);
  return features.filter((f) => !f.is_archived && f.tags.some((t) => staleTags.has(t))).map((f) => ({
    id: f.id,
    name: f.name,
    enabled: f.environment_feature_state?.enabled ?? f.default_enabled,
    // Only a flag with one value for everyone can be hard-coded.
    skip: !isSafeFlagName(f.name) ? 'unsafe flag name'
      : f.type !== 'STANDARD' || f.multivariate_options.length ? 'multivariate flag'
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
  // The name can come from a PR branch: only ever archive what Flagsmith itself marks stale.
  const stale = await staleTagIds(projectId);
  if (!f.tags.some((t) => stale.has(t))) throw new Error(`Not archiving ${name}: it is not tagged stale in Flagsmith`);
  await api(`/projects/${projectId}/features/${f.id}/`, { method: 'PATCH', body: JSON.stringify({ is_archived: true }) });
  return true;
}

/**
 * Flag Janitor's own risky actions are behind Flagsmith flags (open_prs, archive_flags)
 * in a separate environment. No JANITOR_ENVIRONMENT_KEY = no gates; a missing flag = off.
 */
export async function gate(name) {
  if (!env.JANITOR_ENVIRONMENT_KEY) return true;
  try {
    const fs = new Flagsmith({ environmentKey: env.JANITOR_ENVIRONMENT_KEY, apiUrl: base() + '/', retries: 0, requestTimeoutSeconds: 5 });
    return (await fs.getEnvironmentFlags()).isFeatureEnabled(name);
  } catch (e) {
    console.error(`Could not read gate "${name}" from Flagsmith (${e.message}); treating it as off.`);
    return false; // fail closed: no answer means no risky action
  }
}
