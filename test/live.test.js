// Against the real self-hosted Flagsmith (read-only). Run: npm run test:live  (reads .env)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStaleFlags, gate } from '../src/flagsmith.js';

const live = { skip: !process.env.FLAGSMITH_API_KEY && 'no FLAGSMITH_API_KEY; set up .env to run live tests' };

test('live: reads stale flags and their production values', live, async () => {
  // Rules, not a snapshot: the demo archives flags as it goes.
  const flags = await findStaleFlags();
  for (const f of flags) assert.equal(typeof f.enabled, 'boolean', f.name);
  const byName = Object.fromEntries(flags.map((f) => [f.name, f]));
  assert.equal(byName.dark_mode, undefined); // live flag, not tagged stale
  if (byName.holiday_banner) assert.equal(byName.holiday_banner.enabled, false); // OFF in production
});

test('live: reads the janitor gate flag through the Flagsmith SDK', live, async () => {
  assert.equal(typeof (await gate('open_prs')), 'boolean');
});
