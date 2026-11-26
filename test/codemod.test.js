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

test('if without braces in a loop body or nested if stays valid code', () => {
  check(`for (const i of xs) if (hasFeature('x')) a(i);`, 'x', false, 'for (const i of xs) {}');
  check(`for (const i of xs) if (hasFeature('x')) a(i);`, 'x', true, 'for (const i of xs) a(i);');
  check(`if (a) if (hasFeature('x')) b();`, 'x', false, 'if (a) {}');
  check(`while (go()) if (!hasFeature('x')) { b(); c(); }`, 'x', false, 'while (go()) { b(); c(); }');
});

test('optional call flags?.isFeatureEnabled', () => {
  check(`if (flags?.isFeatureEnabled('x')) { a(); }`, 'x', true, 'a();');
});

test('exported const keeps its export', () => {
  check(`export const showX = hasFeature('x');`, 'x', true, 'export const showX = true;');
  check(`const showX = hasFeature('x'); export { showX };`, 'x', true, 'const showX = true; export { showX };');
});

test('shorthand property and TS typeof keep working', () => {
  check(`const on = hasFeature('x'); return { on, off: !on };`, 'x', true, 'return { on: true, off: false };');
  check(`const on = hasFeature('x'); let t: typeof on = on;`, 'x', false, 'const on = false; let t: typeof on = on;'); // type use: keep the const
});

test('does not touch a different flag or a non-literal name', () => {
  assert.equal(removeFlag(`hasFeature('x_v2'); hasFeature(name);`, 'x', true), null);
});
