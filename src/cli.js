#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { removeFlag } from './codemod.js';
import { findStaleFlags, archiveFlag, gate } from './flagsmith.js';
import { listCodeFiles, mentions, isSafeFlagName } from './repo.js';

const USAGE = `flag-janitor <command> [--dir <repo>] [--dry-run]

  scan            list stale flags and the files that use them
  run             remove each stale flag, run tests, open one PR per flag
  archive <flag>  archive the flag in Flagsmith (refuses while code still uses it)

env: FLAGSMITH_API_URL, FLAGSMITH_API_KEY (admin key), FLAGSMITH_ENVIRONMENT (env key whose values win),
     JANITOR_TAG (default "stale"), JANITOR_ENVIRONMENT_KEY (optional, gates janitor's own actions),
     TEST_CMD (default "npm test" when package.json has a test script)`;

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
      const out = removeFlag(read(f), flag.name, flag.enabled);
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

const commands = { scan, run, archive: () => archive(flagArg) };
if (!commands[cmd]) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
commands[cmd]().catch((e) => { console.error(`flag-janitor: ${e.message}`); process.exit(1); });
