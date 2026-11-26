import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const CODE = /\.(m|c)?[jt]sx?$/;

// Letters, digits, _ - . ; no leading dash (git option), no ".." (ref trick), short. Keeps branch names and PR text safe.
export const isSafeFlagName = (name) =>
  typeof name === 'string' && name.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && !name.includes('..');

/**
 * Tracked JS/TS files only. Ignored files are never rewritten (a reset would not undo it),
 * and symlinks are skipped so a write can never land outside the repo.
 */
export function listCodeFiles(dir) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' })
    .split('\0')
    .filter((f) => CODE.test(f) && !fs.lstatSync(path.join(dir, f), { throwIfNoEntry: false })?.isSymbolicLink() &&
      fs.existsSync(path.join(dir, f)));
}

/** Tracked files (any language, config too; not markdown) that still mention the flag as a whole word. */
export function mentions(dir, name) {
  const r = spawnSync('git', ['grep', '-l', '-w', '-F', '-e', name, '--', '.', ':(exclude)*.md'], { cwd: dir, encoding: 'utf8' });
  if (r.status > 1) throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}
