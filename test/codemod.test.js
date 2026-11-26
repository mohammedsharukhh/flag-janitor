import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeFlag } from '../src/codemod.js';

const clean = (s) => s.replace(/\s+/g, ''); // formatting is recast's job; compare code only
const check = (src, flag, on, want) => assert.equal(clean(removeFlag(src, flag, on)), clean(want));

test('returns null when the flag is not used', () => {
  assert.equal(removeFlag(`hasFeature('other')`, 'x', true), null);
});

test('keeps the live if-branch, drops the dead one', () => {
  const src = `if (flagsmith.hasFeature('x')) { a(); } else { b(); }`;
  check(src, 'x', true, 'a();');
  check(src, 'x', false, 'b();');
});

test('negation, else-if chain and missing else', () => {
  check(`if (!flags.isFeatureEnabled('x')) { old(); }`, 'x', true, '');
  check(`if (a) { p(); } else if (hasFeature('x')) { q(); } else { r(); }`, 'x', false, 'if (a) { p(); } else { r(); }');
});

test('ternary, && and || fold', () => {
  check(`const c = hasFeature('x') ? 'new' : 'old';`, 'x', true, `const c = 'new';`);
  check(`if (user.admin && hasFeature('x')) { go(); }`, 'x', true, 'if (user.admin) { go(); }');
  check(`if (user.admin && hasFeature('x')) { go(); }`, 'x', false, '');
  check(`if (load() && hasFeature('x')) { go(); }`, 'x', false, 'if (load() && false) { go(); }'); // keeps the side effect
});

test('inlines a const that holds the flag', () => {
  check(`const on = await flags.isFeatureEnabled('x'); if (on) { a(); } else { b(); } log(obj.on);`, 'x', false, 'b(); log(obj.on);');
});

test('keeps block when unwrapping would clash names', () => {
  check(`const v = 1; if (hasFeature('x')) { const v = 2; use(v); }`, 'x', true, 'const v = 1; { const v = 2; use(v); }');
});

test('JSX children', () => {
  check(`const A = () => <div>{hasFeature('x') && <Banner />}<Main /></div>;`, 'x', false, 'const A = () => <div><Main /></div>;');
  check(`const A = () => <div>{hasFeature('x') && <Banner />}</div>;`, 'x', true, 'const A = () => <div><Banner /></div>;');
});
