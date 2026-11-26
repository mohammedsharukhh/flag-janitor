#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { removeFlag } from './codemod.js';
import { findStaleFlags, archiveFlag, gate, switchOff } from './flagsmith.js';
import { createWebhookServer, RUN_FLAG } from './serve.js';
import { listCodeFiles, mentions, isSafeFlagName } from './repo.js';

const USAGE = `flag-janitor <command> [--dir <repo>] [--dry-run]

  scan            list stale flags and the files that use them
  run             remove each stale flag, run tests, open one PR per flag
  archive <flag>  archive the flag in Flagsmith (refuses while code still uses it)
  rewrite <flag> on|off   only rewrite the code as if the flag were always on/off (no Flagsmith, no git)
  serve           receive Flagsmith webhooks: flip the run_cleanup flag ON to start the GitHub workflow

env: FLAGSMITH_API_URL, FLAGSMITH_API_KEY (admin key), FLAGSMITH_ENVIRONMENT (env key whose values win),
     JANITOR_TAG (default "stale"), JANITOR_ENVIRONMENT_KEY (optional, gates janitor's own actions),
     TEST_CMD (default "npm test" when package.json has a test script)
serve: JANITOR_WEBHOOK_SECRET (same secret as the Flagsmith webhook), JANITOR_DISPATCH_REPO (owner/repo),
       JANITOR_WORKFLOW (default flag-janitor.yml), JANITOR_HOST (default 127.0.0.1), JANITOR_PORT (default 8788)`;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const dir = path.resolve(opt('--dir') || '.');
const dryRun = args.includes('--dry-run') && args.splice(args.indexOf('--dry-run'), 1);
const [cmd, flagArg] = args;

const codeFiles = () => listCodeFiles(dir);
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const sh = (bin, a) => execFileSync(bin, a, { cwd: dir, encoding: 'utf8' }).trim();

function plan(flag, files) {
  const changes = [];
  const errors = [];
  for (const f of files) {
    try {
      const out = removeFlag(read(f), flag.name, flag.enabled, f);
      if (out !== null) changes.push({ file: f, out });
    } catch (e) {
      errors.push(`${f}: ${e.message.split('\n')[0]}`);
    }
  }
  return { changes, errors };
}

function diff(file, out) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
  const tmp = path.join(tmpDir, path.basename(file));
  fs.writeFileSync(tmp, out);
  const r = spawnSync('git', ['diff', '--no-index', '--color=always', path.join(dir, file), tmp], { encoding: 'utf8' });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return r.stdout.replaceAll(`a${path.join(dir, file)}`, `a/${file}`).replaceAll(`b${tmp}`, `b/${file}`);
}

// The repo's tests are arbitrary code: they must not be able to read our credentials.
const SECRETS = ['FLAGSMITH_API_KEY', 'JANITOR_ENVIRONMENT_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRETS.includes(k)));

function testCommand() {
  if (process.env.TEST_CMD) return process.env.TEST_CMD;
  const pkg = path.join(dir, 'package.json');
  return fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts?.test ? 'npm test' : null;
}

async function scan() {
  const files = codeFiles();
  const flags = await findStaleFlags();
  if (!flags.length) return console.log('No stale flags. Nothing to clean.');
  for (const flag of flags) {
    const { changes, errors } = plan(flag, files);
    const state = flag.enabled ? 'ON ' : 'OFF';
    console.log(`${flag.name.padEnd(28)} prod=${state}  ${flag.skip ? `skip: ${flag.skip}` : `${changes.length} file(s) to rewrite`}`);
    changes.forEach((c) => console.log(`    ${c.file}`));
    errors.forEach((e) => console.log(`    parse error ${e}`));
  }
}

async function run() {
  const files = codeFiles();
  const flags = (await findStaleFlags()).filter((f) => !f.skip);
  const live = !dryRun && (await gate('open_prs'));
  if (!dryRun && !live) console.log('Flagsmith flag "open_prs" is off: dry run only.');
  if (live && sh('git', ['status', '--porcelain'])) throw new Error('Working tree has uncommitted changes; commit or stash first.');
  const baseBranch = live && sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (baseBranch === 'HEAD') throw new Error('Detached HEAD: check out the branch the PRs should target.');
  const test = testCommand();

  for (const flag of flags) {
    const { changes, errors } = plan(flag, files);
    if (!changes.length) { console.log(`- ${flag.name}: not referenced in code`); continue; }
    console.log(`\n# ${flag.name} (prod ${flag.enabled ? 'ON' : 'OFF'}): ${changes.length} file(s)`);
    if (!live) { changes.forEach((c) => process.stdout.write(diff(c.file, c.out))); continue; }

    const branch = `flag-janitor/remove-${flag.name}`;
    const states = sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state', '--jq', '[.[].state] | join(",")']);
    if (states.includes('OPEN')) { console.log(`  PR already open for ${branch}`); continue; }
    // A human said no. Respect it until they remove the stale tag or reopen the PR.
    if (states.includes('CLOSED')) { console.log(`  a PR for ${branch} was closed without merging; skipping`); continue; }
    sh('git', ['checkout', '-B', branch]);
    try {
      changes.forEach((c) => fs.writeFileSync(path.join(dir, c.file), c.out));
      const t = test && spawnSync(test, { cwd: dir, shell: true, encoding: 'utf8', env: testEnv() });
      if (t && t.status !== 0) {
        console.log(`  tests failed, no PR:\n${(t.stdout + t.stderr).slice(-1500)}`);
        continue;
      }
      const left = mentions(dir, flag.name);
      sh('git', ['commit', '-am', `chore: remove stale flag ${flag.name}`]);
      sh('git', ['push', '-f', '-u', 'origin', branch]);
      const url = sh('gh', ['pr', 'create', '--base', baseBranch, '--head', branch,
        '--title', `Remove stale flag \`${flag.name}\``, '--body', prBody(flag, changes, test, left, errors)]);
      console.log(`  opened ${url}`);
    } finally {
      sh('git', ['reset', '--hard']);
      sh('git', ['checkout', baseBranch]);
    }
  }
}

function prBody(flag, changes, test, left, errors) {
  return [
    `Flagsmith marks \`${flag.name}\` as **stale** and it is **${flag.enabled ? 'ON' : 'OFF'}** for everyone in production,`,
    `so this PR hard-codes that value and deletes the dead branch.`,
    '', '**Files rewritten**', ...changes.map((c) => `- \`${c.file}\``),
    '', `**Tests:** ${test ? `\`${test}\` passed` : 'no test command found, please check manually'}`,
    ...(left.length || errors.length ? ['', '**Needs a human look** (flag still mentioned, or file could not be parsed):',
      ...left.map((f) => `- \`${f}\``), ...errors.map((e) => `- ${e}`)] : []),
    '', `After merge, Flag Janitor archives \`${flag.name}\` in Flagsmith (only once no file in the repo mentions it).`,
    '', '_Opened by [Flag Janitor](https://github.com/mohammedsharukhh/flag-janitor)._',
  ].join('\n');
}

async function archive(name) {
  if (!name) throw new Error('usage: flag-janitor archive <flag>');
  if (!isSafeFlagName(name)) throw new Error(`Refusing unsafe flag name: ${JSON.stringify(name)}`);
  const left = mentions(dir, name);
  if (left.length) throw new Error(`Not archiving ${name}: still mentioned in ${left.join(', ')}`);
  if (!dryRun && !(await gate('archive_flags'))) return console.log('Flagsmith flag "archive_flags" is off: not archiving.');
  if (dryRun) return console.log(`Would archive ${name}.`);
  console.log((await archiveFlag(name)) ? `Archived ${name} in Flagsmith.` : `${name} was already archived.`);
}

async function serve() {
  const env = process.env;
  const secret = env.JANITOR_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) throw new Error('Set JANITOR_WEBHOOK_SECRET (16+ chars, same as the Flagsmith webhook secret).');
  const repo = env.JANITOR_DISPATCH_REPO || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Set JANITOR_DISPATCH_REPO to owner/repo.');
  const workflow = env.JANITOR_WORKFLOW || 'flag-janitor.yml';
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('JANITOR_WORKFLOW must be a workflow file name.');
  if (!env.JANITOR_ENVIRONMENT_KEY) throw new Error('Set JANITOR_ENVIRONMENT_KEY (the environment that holds run_cleanup).');

  const server = createWebhookServer({
    secret,
    onTrigger: async (payload) => {
      // Never trust the payload alone: a replayed webhook must not start a run while the flag is off.
      if (!(await gate(RUN_FLAG))) return console.log(`${RUN_FLAG} is off in Flagsmith; ignoring (replayed webhook?)`);
      try {
        execFileSync('gh', ['workflow', 'run', workflow, '-R', repo], { encoding: 'utf8' });
        console.log(`${new Date().toISOString()} started ${workflow} on ${repo}`);
      } finally {
        await switchOff(payload.data.new_state.feature.id); // reset even on failure, or the button sticks ON
        console.log(`${RUN_FLAG} switched back off`);
      }
    },
  });
  server.requestTimeout = 10_000; // a slow client cannot hold connections open
  const host = env.JANITOR_HOST || '127.0.0.1';
  server.listen(Number(env.JANITOR_PORT ?? 8788), host, () =>
    console.log(`flag-janitor serve listening on http://${host}:${server.address().port}`));
  await new Promise(() => {}); // run until killed
}

// Offline building block for agents (the flagsmith-flag-debt skill): Flagsmith work goes through the Flagsmith CLI,
// this only does the code. Output is kept to a line or two so it costs an agent few tokens.
async function rewrite(name, value) {
  if (!name || !['on', 'off'].includes(value)) throw new Error('usage: flag-janitor rewrite <flag> on|off');
  if (!isSafeFlagName(name)) throw new Error(`unsafe flag name: ${JSON.stringify(name)}`);
  const { changes, errors } = plan({ name, enabled: value === 'on' }, codeFiles());
  for (const c of changes) fs.writeFileSync(path.join(dir, c.file), c.out);
  console.log(`rewrote ${changes.length} file(s)${changes.length ? `: ${changes.map((c) => c.file).join(' ')}` : ''}`);
  errors.forEach((e) => console.log(`parse error ${e}`));
  const left = mentions(dir, name);
  if (left.length) console.log(`still mentions ${name} (fix by hand): ${left.join(' ')}`);
}

const commands = { scan, run, serve, archive: () => archive(flagArg), rewrite: () => rewrite(flagArg, args[2]) };
if (!commands[cmd]) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
commands[cmd]().catch((e) => { console.error(`flag-janitor: ${e.message}`); process.exit(1); });
