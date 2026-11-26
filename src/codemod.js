import jscodeshift from 'jscodeshift';

const j = jscodeshift.withParser('tsx');
// Flagsmith SDK calls that return a flag's on/off state.
const CHECKS = new Set(['hasFeature', 'isFeatureEnabled']);

const isBool = (n) => n && (n.type === 'BooleanLiteral' || (n.type === 'Literal' && typeof n.value === 'boolean'));
const isStr = (n) => n && (n.type === 'StringLiteral' || (n.type === 'Literal' && typeof n.value === 'string'));
// Safe to drop without changing behaviour (no calls, no side effects).
const isPure = (n) =>
  n.type === 'Identifier' || n.type === 'ThisExpression' || isBool(n) || isStr(n) ||
  (n.type === 'MemberExpression' && !n.computed && isPure(n.object));
const inTest = (p) =>
  ['IfStatement', 'ConditionalExpression', 'WhileStatement'].includes(p.parent.node.type) && p.name === 'test';
// let/const/class/function at block top level would leak or clash if we unwrap the block.
const declaresNames = (stmts) =>
  stmts.some((s) => s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration' ||
    (s.type === 'VariableDeclaration' && s.kind !== 'var'));

/**
 * Hard-code a flag to its production value and delete the dead branch.
 * Returns the new source, or null when the file never checks this flag.
 */
export function removeFlag(source, flag, enabled) {
  const root = j(source);
  const hits = root.find(j.CallExpression).filter((p) => {
    const c = p.node.callee;
    const name = c.type === 'Identifier' ? c.name : c.property?.name;
    return CHECKS.has(name) && isStr(p.node.arguments[0]) && p.node.arguments[0].value === flag;
  });
  if (!hits.size()) return null;
  hits.replaceWith(() => j.booleanLiteral(enabled));
  while (fold(root));
  return root.toSource({ quote: 'single' });
}

// One simplification pass. Returns true if anything changed, so the caller loops to a fixed point.
function fold(root) {
  let changed = false;
  const mark = (fn) => (p) => { if (fn(p) !== false) changed = true; };

  root.find(j.AwaitExpression).filter((p) => isBool(p.node.argument))
    .forEach(mark((p) => p.replace(p.node.argument)));

  root.find(j.UnaryExpression, { operator: '!' }).filter((p) => isBool(p.node.argument))
    .forEach(mark((p) => p.replace(j.booleanLiteral(!p.node.argument.value))));

  root.find(j.LogicalExpression).forEach(mark((p) => {
    const { left, right, operator } = p.node;
    if (operator !== '&&' && operator !== '||') return false;
    if (isBool(left)) {
      // true && x -> x, false && x -> false, true || x -> true, false || x -> x
      return p.replace((operator === '&&') === left.value ? right : left);
    }
    // x && true -> x only where just truthiness matters (an if/ternary test).
    if (isBool(right) && inTest(p)) {
      if ((operator === '&&') === right.value) return p.replace(left);
      if (isPure(left)) return p.replace(right);
    }
    return false;
  }));

  root.find(j.ConditionalExpression).filter((p) => isBool(p.node.test))
    .forEach(mark((p) => p.replace(p.node.test.value ? p.node.consequent : p.node.alternate)));

  root.find(j.IfStatement).filter((p) => isBool(p.node.test)).forEach(mark((p) => {
    const kept = p.node.test.value ? p.node.consequent : p.node.alternate;
    if (p.parent.node.type === 'IfStatement') return p.replace(kept); // else-if chain: null drops the else
    if (!kept) return p.prune();
    const body = kept.type === 'BlockStatement' ? kept.body : [kept];
    if (kept.type === 'BlockStatement' && declaresNames(body)) return p.replace(kept);
    return body.length ? p.replace(...body) : p.prune();
  }));

  // const showX = true;  ->  inline every use, then drop the declaration.
  root.find(j.VariableDeclarator).filter((p) =>
    p.parent.node.kind === 'const' && p.node.id.type === 'Identifier' && isBool(p.node.init)
  ).forEach(mark((p) => {
    const { name } = p.node.id;
    const scope = p.scope;
    root.find(j.Identifier, { name }).filter((ip) =>
      ip.node !== p.node.id && ip.scope?.lookup(name) === scope &&
      !(ip.parent.node.type === 'MemberExpression' && ip.name === 'property' && !ip.parent.node.computed) &&
      !(['ObjectProperty', 'Property'].includes(ip.parent.node.type) && ip.name === 'key' && !ip.parent.node.shorthand)
    ).replaceWith(() => j.booleanLiteral(p.node.init.value));
    const decl = p.parent;
    if (decl.node.declarations.length === 1) decl.prune(); else p.prune();
  }));

  // JSX: {false} renders nothing, {<X/>} is just <X/>.
  root.find(j.JSXExpressionContainer).filter((p) => p.parent.node.type === 'JSXElement' || p.parent.node.type === 'JSXFragment')
    .forEach(mark((p) => {
      const e = p.node.expression;
      if ((isBool(e) && !e.value) || e.type === 'NullLiteral') {
        // Also drop the indentation text before it, so no blank line is left behind.
        const kids = p.parent.node.children;
        const i = kids.indexOf(p.node);
        const blank = (n) => n?.type === 'JSXText' && /^\s*\n\s*$/.test(n.value);
        if (blank(kids[i - 1]) && blank(kids[i + 1])) kids.splice(i - 1, 1);
        return p.prune();
      }
      if (e.type === 'JSXElement' || e.type === 'JSXFragment') return p.replace(e);
      return false;
    }));

  return changed;
}
