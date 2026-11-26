// Against the real self-hosted Flagsmith (read-only). Run: npm run test:live  (reads .env)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStaleFlags, gate } from '../src/flagsmith.js';

const live = { skip: !process.env.FLAGSMITH_API_KEY && 'no FLAGSMITH_API_KEY; set up .env to run live tests' };

test('live: reads stale flags and their production values', live, async () => {
  const flags = Object.fromEntries((await findStaleFlags()).map((f) => [f.name, f]));
  assert.equal(flags.new_checkout?.enabled, true);
  assert.equal(flags.holiday_banner?.enabled, false);
  assert.equal(flags.dark_mode, undefined); // not tagged stale
});

test('live: reads the janitor gate flag through the Flagsmith SDK', live, async () => {
  assert.equal(typeof (await gate('open_prs')), 'boolean');
});
