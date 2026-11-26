#!/usr/bin/env node
// Lists the flags tagged stale in the current Flagsmith environment, using only the Flagsmith CLI (read-only).
// One short line per flag, so it costs an agent few tokens:
//   <name> on|off           safe to remove: keep the ON or the OFF branch
//   <name> skip <reason>    leave it alone (not one value for everyone, or a name we won't put in a shell)
// Env: FLAGSMITH_ENVIRONMENT (server or client key of the environment whose values win, e.g. Production),
//      JANITOR_TAG (default "stale"), plus the CLI's own FLAGSMITH_API_URL / credentials.
import { execFileSync } from 'node:child_process';

const die = (msg) => { console.error(`find-stale: ${msg}`); process.exit(1); };
const TAG = process.env.JANITOR_TAG || 'stale';
const ENV = process.env.FLAGSMITH_ENVIRONMENT;
if (!/^[A-Za-z0-9_.-]{1,64}$/.test(TAG)) die('JANITOR_TAG must be a plain tag name');
if (!ENV) die('set FLAGSMITH_ENVIRONMENT to the environment key whose values win (e.g. Production)');
if (!/^[A-Za-z0-9_.:-]+$/.test(ENV)) die('FLAGSMITH_ENVIRONMENT looks wrong');

function cli(...args) {
  try {
    return JSON.parse(execFileSync('flagsmith', [...args, '--json', '--no-input'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    die(`flagsmith ${args.join(' ')} failed: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`);
  }
}

const project = cli('api', `api/v1/environments/${ENV}/`).project;
if (!Number.isInteger(project)) die('could not read the project of FLAGSMITH_ENVIRONMENT');
const tagIds = cli('api', `api/v1/projects/${project}/tags/`).results
  .filter((t) => Number.isInteger(t.id) && (t.label === TAG || (TAG === 'stale' && t.type === 'STALE'))).map((t) => t.id);
if (!tagIds.length) { console.log(`no "${TAG}" tag in this project`); process.exit(0); }

const stale = [];
for (let page = 1; ; page++) {
  const r = cli('api', `api/v1/projects/${project}/features/?tags=${tagIds.join(',')}&tag_strategy=UNION&is_archived=false&page=${page}`);
  stale.push(...r.results.map((f) => f.name));
  if (!r.next || page > 100) break;
}
// `flag list` also returns archived features, so cross-check with `feature list` (which hides them).
const live = new Set(cli('feature', 'list', '-p', String(project)).map((f) => f.name));
const state = new Map(cli('flag', 'list', '-p', String(project)).map((f) => [f.feature, f]));

// Flag names are untrusted text headed into an agent's context: only plain names are printed as-is; anything else is
// quoted, escaped (no forged lines) and cut short (no smuggled instructions), and never offered for removal.
const SAFE = (n) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(n) && !n.includes('..');
const show = (n) => (SAFE(n) ? n : JSON.stringify(n.length > 40 ? `${n.slice(0, 40)}…` : n));

for (const name of stale) {
  const f = state.get(name);
  if (!f || !live.has(name)) continue;
  const skip = !SAFE(name) ? 'unsafe name'
    : f.type !== 'standard' ? 'multivariate'
    : f.segment_overrides ? 'segment overrides'
    : f.identity_overrides ? 'identity overrides'
    : null;
  console.log(skip ? `${show(name)} skip ${skip}` : `${name} ${f.enabled ? 'on' : 'off'}`);
}
