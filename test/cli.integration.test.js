// End to end: real CLI process, real git repo + bare "origin", fake Flagsmith server, fake `gh` on PATH.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fakeFlagsmith, flagUpdated } from './helpers/fake-flagsmith.js';

const CLI = path.resolve('src/cli.js');
const servers = [];
after(() => servers.forEach((s) => s.close()));

const APP = {
  'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  'src/checkout.js': `export function total(flags) {\n  if (flags.isFeatureEnabled('new_checkout')) {\n    return 'new';\n  } else {\n    return 'old';\n  }\n}\n`,
  'src/banner.js': `export const banner = (flagsmith) => (flagsmith.hasFeature('holiday_banner') ? 'sale' : '');\n`,
  'checkout.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './src/checkout.js';\ntest('t', () => assert.equal(total({ isFeatureEnabled: () => true }), 'new'));\n`,
};

function setup({ files = APP, features, janitorFlags } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-it-'));
  const repo = path.join(tmp, 'repo');
  const origin = path.join(tmp, 'origin.git');
  const bin = path.join(tmp, 'bin');
  const ghLog = path.join(tmp, 'gh.log');
  fs.mkdirSync(bin);
  // Fake gh: `pr list` answers $FAKE_GH_STATES (e.g. OPEN, CLOSED); `pr create` prints a URL. Logs every call, one per line.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n[ "$1 $2" = "workflow run" ] && [ -n "$FAKE_GH_FAIL" ] && exit 1
case "$1 $2" in "pr list") echo "$FAKE_GH_STATES";; "pr create") echo https://github.com/o/r/pull/1;; esac\n`, { mode: 0o755 });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { repo, origin, bin, ghLog, git, features, janitorFlags };
}

async function cli(ctx, args, extraEnv = {}) {
  const fsm = await fakeFlagsmith({
    features: ctx.features ?? [
      { id: 1, name: 'new_checkout', tags: [1], enabled: true },
      { id: 2, name: 'holiday_banner', tags: [1], enabled: false },
    ],
    janitorFlags: ctx.janitorFlags,
  });
  servers.push(fsm);
  const env = { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, FLAGSMITH_API_URL: fsm.url, FLAGSMITH_API_KEY: 'admin-key',
    FLAGSMITH_ENVIRONMENT: 'prod-key', JANITOR_ENVIRONMENT_KEY: '', TEST_CMD: '', ...extraEnv };
  delete env.NODE_TEST_CONTEXT; // or the inner `node --test` reports to this runner instead of exiting normally
  // Async on purpose: spawnSync would block this process, so the fake Flagsmith could never answer.
  const child = spawn('node', [CLI, ...args, '--dir', ctx.repo], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const status = await new Promise((r) => child.on('close', r));
  return { status, out, fsm, gh: fs.existsSync(ctx.ghLog) ? fs.readFileSync(ctx.ghLog, 'utf8') : '' };
}

const remoteFile = (ctx, branch, file) => execFileSync('git', ['--git-dir', ctx.origin, 'show', `${branch}:${file}`], { encoding: 'utf8' });
const remoteBranches = (ctx) => execFileSync('git', ['--git-dir', ctx.origin, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).trim().split('\n');

test('run: one tested PR per stale flag, repo left clean on main', async () => {
  const ctx = setup();
  const r = await cli(ctx, ['run']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(remoteBranches(ctx).sort(), ['flag-janitor/remove-holiday_banner', 'flag-janitor/remove-new_checkout', 'main']);
  const checkout = remoteFile(ctx, 'flag-janitor/remove-new_checkout', 'src/checkout.js');
  assert.match(checkout, /return 'new'/);
  assert.doesNotMatch(checkout, /new_checkout|'old'/);
  assert.match(remoteFile(ctx, 'flag-janitor/remove-holiday_banner', 'src/banner.js'), /=> \(?''\)?/); // recast keeps old parens; still valid
  assert.match(r.gh, /pr create --base main --head flag-janitor\/remove-new_checkout --title Remove stale flag `new_checkout`/);
  assert.match(r.gh, /`npm test` passed/);
  assert.equal(ctx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(ctx.git('status', '--porcelain'), '');
});

test('run: failing tests mean no push and no PR', async () => {
  const ctx = setup();
  const r = await cli(ctx, ['run'], { TEST_CMD: 'exit 3' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /tests failed, no PR/);
  assert.deepEqual(remoteBranches(ctx), ['main']);
  assert.doesNotMatch(r.gh, /pr create/);
  assert.equal(ctx.git('status', '--porcelain'), '');
  assert.equal(ctx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('run: open_prs flag off in Flagsmith = dry run, nothing pushed', async () => {
  const ctx = setup({ janitorFlags: { open_prs: false } });
  const r = await cli(ctx, ['run'], { JANITOR_ENVIRONMENT_KEY: 'janitor-key' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /"open_prs" is off: dry run only/);
  assert.match(r.out, /-\s+return 'old';/);
  assert.deepEqual(remoteBranches(ctx), ['main']);
  assert.equal(r.gh, '');
});

test('run: refuses a dirty working tree', async () => {
  const ctx = setup();
  fs.appendFileSync(path.join(ctx.repo, 'src/checkout.js'), '// my unsaved work\n');
  const r = await cli(ctx, ['run']);
  assert.equal(r.status, 1);
  assert.match(r.out, /uncommitted changes/);
  assert.match(fs.readFileSync(path.join(ctx.repo, 'src/checkout.js'), 'utf8'), /my unsaved work/);
});

test('run: skips flags with unsafe names or segment overrides', async () => {
  const ctx = setup({ features: [
    { id: 1, name: 'new_checkout', tags: [1], enabled: true, num_segment_overrides: 1 },
    { id: 2, name: 'x;touch pwned', tags: [1] },
  ] });
  const r = await cli(ctx, ['run']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(remoteBranches(ctx), ['main']);
  assert.equal(fs.existsSync(path.join(ctx.repo, 'pwned')), false);
});

test('archive: only after the code no longer mentions the flag', async () => {
  const ctx = setup({ files: { ...APP, 'deploy/flags.yml': 'enabled:\n  - holiday_banner\n' } });
  let r = await cli(ctx, ['archive', 'new_checkout']);
  assert.equal(r.status, 1);
  assert.match(r.out, /still mentioned in src\/checkout\.js/);
  assert.equal(r.fsm.requests.filter((q) => q.method === 'PATCH').length, 0);

  fs.writeFileSync(path.join(ctx.repo, 'src/checkout.js'), `export const total = () => 'new';\n`);
  ctx.git('commit', '-qam', 'merge cleanup');
  r = await cli(ctx, ['archive', 'new_checkout']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.fsm.requests.find((q) => q.method === 'PATCH').body, { is_archived: true });

  r = await cli(ctx, ['archive', 'holiday_banner']); // still in YAML config: archiving would break deploys
  assert.equal(r.status, 1);
  assert.match(r.out, /deploy\/flags\.yml/);
});

test('archive: refuses unsafe names and flags not tagged stale', async () => {
  const ctx = setup({ features: [{ id: 1, name: 'dark_mode', tags: [], enabled: true }] });
  let r = await cli(ctx, ['archive', 'dark_mode']);
  assert.equal(r.status, 1);
  assert.match(r.out, /not tagged stale/);
  r = await cli(ctx, ['archive', '--help;rm']);
  assert.equal(r.status, 1);
  assert.match(r.out, /unsafe flag name/);
  assert.equal(r.fsm.requests.filter((q) => q.method === 'PATCH').length, 0);
});

test('run: the repo\'s tests never see the Flagsmith key or GitHub token', async () => {
  const ctx = setup();
  const leak = `node -e "process.exit(process.env.FLAGSMITH_API_KEY || process.env.GH_TOKEN || process.env.JANITOR_ENVIRONMENT_KEY ? 7 : 0)"`;
  const r = await cli(ctx, ['run'], { TEST_CMD: leak, GH_TOKEN: 'ghs_secret', JANITOR_ENVIRONMENT_KEY: '' });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /tests failed/);
  assert.match(r.gh, /pr create/);
});

test('run: a PR a human closed is not reopened every week', async () => {
  const ctx = setup();
  for (const [state, msg] of [['OPEN', /already open/], ['CLOSED', /closed without merging/]]) {
    const r = await cli(ctx, ['run'], { FAKE_GH_STATES: state });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, msg);
    assert.deepEqual(remoteBranches(ctx), ['main']);
  }
});

// `flag-janitor serve`: signed Flagsmith webhook in -> GitHub workflow dispatched -> run_cleanup switched back off.
async function serve(ctx, janitorFlags, extraEnv = {}) {
  const fsm = await fakeFlagsmith({ janitorFlags });
  servers.push(fsm);
  const env = { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, FLAGSMITH_API_URL: fsm.url, FLAGSMITH_API_KEY: 'admin-key',
    FLAGSMITH_ENVIRONMENT: 'prod-key', JANITOR_ENVIRONMENT_KEY: 'janitor-key', JANITOR_WEBHOOK_SECRET: 'hook-secret-for-tests-only',
    JANITOR_DISPATCH_REPO: 'o/demo', JANITOR_PORT: '0', ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn('node', [CLI, 'serve'], { env });
  after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serve did not start: ${out}`)), 5000);
    child.stdout.on('data', () => { const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    child.on('exit', () => { clearTimeout(t); reject(new Error(`serve exited: ${out}`)); });
  });
  const post = (p) => fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', body: p.body, headers: { 'X-Flagsmith-Signature': p.signature } });
  return { fsm, post, out: () => out, gh: () => (fs.existsSync(ctx.ghLog) ? fs.readFileSync(ctx.ghLog, 'utf8') : '') };
}

test('serve: flipping run_cleanup ON in Flagsmith dispatches the workflow and flips it back', async () => {
  const ctx = setup();
  const s = await serve(ctx, { open_prs: true, run_cleanup: true });
  const r = await s.post(flagUpdated({ id: 2 }));
  assert.equal(r.status, 202, s.out());
  assert.match(s.gh(), /^workflow run flag-janitor\.yml -R o\/demo$/m);
  assert.equal(s.fsm.janitorFlags.run_cleanup, false);
});

test('serve: a replayed webhook does nothing when run_cleanup is actually off', async () => {
  const ctx = setup();
  const s = await serve(ctx, { open_prs: true, run_cleanup: false });
  const r = await s.post(flagUpdated({ id: 2 }));
  assert.equal(r.status, 202);
  assert.equal(s.gh(), '');
  assert.match(s.out(), /run_cleanup is off in Flagsmith/);
});

test('serve: refuses to start without a webhook secret or with a bad repo name', async () => {
  const ctx = setup();
  for (const [extra, msg] of [[{ JANITOR_WEBHOOK_SECRET: '' }, /JANITOR_WEBHOOK_SECRET/], [{ JANITOR_DISPATCH_REPO: 'o/demo;touch pwned' }, /JANITOR_DISPATCH_REPO/]]) {
    await assert.rejects(serve(ctx, {}, extra), msg);
  }
});

test('serve: if starting the workflow fails, run_cleanup is still switched back off', async () => {
  const ctx = setup();
  const s = await serve(ctx, { open_prs: true, run_cleanup: true }, { FAKE_GH_FAIL: '1' });
  const r = await s.post(flagUpdated({ id: 2 }));
  assert.equal(r.status, 500);
  assert.equal(s.fsm.janitorFlags.run_cleanup, false); // the button works again next time
});
