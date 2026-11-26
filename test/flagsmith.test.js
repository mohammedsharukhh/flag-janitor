import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findStaleFlags, archiveFlag, gate } from '../src/flagsmith.js';
import { fakeFlagsmith, recorder, useEnv } from './helpers/fake-flagsmith.js';

const env = (fs, extra = {}) => useEnv({ FLAGSMITH_API_URL: fs.url, FLAGSMITH_API_KEY: 'admin-key', FLAGSMITH_ENVIRONMENT: 'prod-key', JANITOR_ENVIRONMENT_KEY: '', ...extra });

test('finds stale flags across pages with the production value and skip reasons', async () => {
  const fs = await fakeFlagsmith({
    tags: [{ id: 1, label: 'Stale', type: 'NONE' }, { id: 2, label: 'whatever', type: 'STALE' }, { id: 3, label: 'ui', type: 'NONE' }],
    features: [
      { id: 1, name: 'on_flag', tags: [1], enabled: true },
      { id: 2, name: 'off_flag', tags: [2], enabled: false },
      { id: 3, name: 'not_stale', tags: [3], enabled: true },
      { id: 4, name: 'segmented', tags: [1], num_segment_overrides: 2 },
      { id: 5, name: 'per_user', tags: [1], num_identity_overrides: 4 },
      { id: 6, name: 'variants', tags: [1], type: 'MULTIVARIATE' },
      { id: 7, name: 'archived', tags: [1], is_archived: true },
      { id: 8, name: 'bad name;rm', tags: [1] },
    ],
  });
  const restore = env(fs);
  after(() => { restore(); fs.close(); });
  const flags = Object.fromEntries((await findStaleFlags()).map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(flags).sort(), ['bad name;rm', 'off_flag', 'on_flag', 'per_user', 'segmented', 'variants']);
  assert.equal(flags.on_flag.enabled, true);
  assert.equal(flags.on_flag.skip, null);
  assert.equal(flags.off_flag.enabled, false);
  assert.equal(flags.segmented.skip, 'has segment overrides');
  assert.equal(flags.per_user.skip, 'has identity overrides');
  assert.equal(flags.variants.skip, 'multivariate flag');
  assert.equal(flags['bad name;rm'].skip, 'unsafe flag name');
});

test('never sends the admin key to another host named in a pagination link', async () => {
  const evil = await recorder();
  const fs = await fakeFlagsmith({ nextOrigin: evil.origin, features: [1, 2, 3].map((id) => ({ id, name: `f${id}`, tags: [1] })) });
  const restore = env(fs);
  after(() => { restore(); fs.close(); evil.close(); });
  assert.equal((await findStaleFlags()).length, 3);
  assert.equal(evil.hits.length, 0);
});

test('archives only a flag that is still tagged stale', async () => {
  const fs = await fakeFlagsmith({ features: [{ id: 1, name: 'old', tags: [1] }, { id: 2, name: 'live_feature', tags: [] }] });
  const restore = env(fs);
  after(() => { restore(); fs.close(); });
  assert.equal(await archiveFlag('old'), true);
  assert.equal(fs.features[0].is_archived, true);
  assert.equal(await archiveFlag('old'), false);
  await assert.rejects(archiveFlag('live_feature'), /not tagged stale/);
  assert.equal(fs.features[1].is_archived, undefined);
  await assert.rejects(archiveFlag('missing'), /No flag named missing/);
});

test('gate reads the janitor\'s own flags; missing flag is off; unreachable fails closed', async () => {
  const fs = await fakeFlagsmith({ janitorFlags: { open_prs: true, archive_flags: false } });
  const restore = env(fs, { JANITOR_ENVIRONMENT_KEY: 'janitor-key' });
  after(() => { restore(); fs.close(); });
  assert.equal(await gate('open_prs'), true);
  assert.equal(await gate('archive_flags'), false);
  assert.equal(await gate('not_there'), false);
  process.env.FLAGSMITH_API_URL = 'http://127.0.0.1:9/api/v1';
  assert.equal(await gate('open_prs'), false);
});

test('no gate key means no gates', async () => {
  const restore = useEnv({ JANITOR_ENVIRONMENT_KEY: '' });
  after(restore);
  assert.equal(await gate('open_prs'), true);
});

test('switchOff turns a janitor flag back off in its environment', async () => {
  const { switchOff } = await import('../src/flagsmith.js');
  const fs = await fakeFlagsmith({ janitorFlags: { open_prs: true, run_cleanup: true } });
  const restore = env(fs, { JANITOR_ENVIRONMENT_KEY: 'janitor-key' });
  after(() => { restore(); fs.close(); });
  await switchOff(2);
  assert.equal(fs.janitorFlags.run_cleanup, false);
  assert.equal(fs.janitorFlags.open_prs, true);
  await assert.rejects(switchOff(99), /No environment state/);
});
