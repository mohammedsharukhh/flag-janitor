import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listCodeFiles, mentions, isSafeFlagName } from '../src/repo.js';

function gitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-repo-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('lists only tracked JS/TS files, never symlinks or ignored files', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.js'), `hasFeature('x')`);
  const dir = gitRepo({ 'src/a.ts': '', 'src/b.jsx': '', 'README.md': '', '.gitignore': 'gen/\n', 'gen/c.js': '' });
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(dir, 'src/link.js'));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  assert.deepEqual(listCodeFiles(dir).sort(), ['src/a.ts', 'src/b.jsx']);
});

test('mentions finds the flag in any tracked text file except markdown, whole word only', () => {
  const dir = gitRepo({
    'config.yml': 'flags:\n  - new_checkout\n',
    'app.py': 'if flags.is_feature_enabled("new_checkout"): pass\n',
    'src/x.js': `getValue('new_checkout_v2')`,
    'docs/CHANGELOG.md': 'removed new_checkout',
  });
  assert.deepEqual(mentions(dir, 'new_checkout').sort(), ['app.py', 'config.yml']);
  assert.deepEqual(mentions(dir, 'gone'), []);
});

test('mentions treats regex characters in the name literally', () => {
  const dir = gitRepo({ 'a.js': `hasFeature('a-b')` });
  assert.deepEqual(mentions(dir, 'a.b'), []);
});

test('only plain flag names are safe to use in branches and PR text', () => {
  for (const ok of ['new_checkout', 'dark-mode', 'v2.banner', 'A1']) assert.ok(isSafeFlagName(ok), ok);
  for (const bad of ['', '-rf', 'a b', 'x;rm -rf /', '../x', 'a..b', 'x`y`', 'a\nb', 'x'.repeat(201)]) assert.ok(!isSafeFlagName(bad), bad);
});
