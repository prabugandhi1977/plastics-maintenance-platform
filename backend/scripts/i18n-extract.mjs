// Moves hard-coded UI text into the translation catalogue. Usage:
//   node extract.mjs <out-catalogue.json> <namespace=file.js> ...
// Writes the rewritten files and a JSON catalogue {key: english}. Prints a review list of skipped sentence-like text.
import { readFileSync, writeFileSync } from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';

const [outFile, ...specs] = process.argv.slice(2);
const DISPLAY_PARAMS = new Set(['text', 'title', 'sub', 'subtitle', 'note', 'message', 'label', 'help', 'hint', 'placeholder', 'empty', 'caption', 'heading', 'headers', 'description', 'desc', 'confirmLabel', 'submitLabel', 'tooltip', 'question', 'legend', 'msg', 'what', 'who', 'intro', 'lead']);
const DISPLAY_PROPS = new Set([...DISPLAY_PARAMS, 'unitLabel', 'emptyText', 'placeholderText', 'helpText', 'okLabel', 'cancelLabel']);
const DISPLAY_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'data-confirm', 'data-tip']);
const DOM_PROPS = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel']);
const BUILTINS = { alert: [0], confirm: [0], prompt: [0] };
const catalogue = {}, review = [], stats = {};

const files = specs.map((s) => { const [ns, file] = s.split('='); const src = readFileSync(file, 'utf8'); return { ns, file, src, ast: acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) }; });

// 1. Display parameter positions of every function defined anywhere (by name).
const displayArgs = { ...BUILTINS };
for (const { ast } of files) {
  walk.ancestor(ast, { Function(fn, _s, anc) {
    const p = anc[anc.length - 2];
    const name = fn.id?.name ?? (p?.type === 'VariableDeclarator' ? p.id.name : null);
    if (!name) return;
    const idx = []; fn.params.forEach((prm, i) => { const id = prm.type === 'AssignmentPattern' ? prm.left : prm; if (id.type === 'Identifier' && DISPLAY_PARAMS.has(id.name)) idx.push(i); });
    if (idx.length) displayArgs[name] = [...new Set([...(displayArgs[name] ?? []), ...idx])];
  } });
}

// 2. Helpers
const cook = (raw) => { try { return Function('return `' + raw + '`')(); } catch { return raw; } };
const isSentence = (v) => /[A-Za-z]{2,}/.test(v) && /^[A-Z]/.test(v.trim()) && /[a-z]/.test(v) && (/\s/.test(v.trim()) || /^[A-Z][a-z]{2,}$/.test(v.trim()));
const isTextish = (v) => /[A-Za-z]{2,}/.test(v) && !/^\s*(https?:|\/|\.\/|#[\w-]+$|[a-z]+:\/\/)/.test(v) && !/^[\w.-]+=$/.test(v.trim());
const camel = (s) => { const w = s.replace(/\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&\w+;/g, ' ').match(/[A-Za-z0-9]+/g) ?? ['text'];
  return w.slice(0, 5).map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('').slice(0, 40) || 'text'; };
function keyFor(ns, english) {
  for (const [k, v] of Object.entries(catalogue)) if (k.startsWith(ns + '.') && v === english) return k;
  let base = `${ns}.${camel(english)}`, k = base, n = 2; while (catalogue[k] !== undefined) k = base + n++;
  catalogue[k] = english; stats[ns] = (stats[ns] ?? 0) + 1; return k;
}
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
function varName(e, used) {
  let n = 'value';
  const pick = (x) => x.type === 'Identifier' ? x.name : x.type === 'MemberExpression' && !x.computed ? x.property.name : x.type === 'CallExpression' && x.arguments[0] ? pick(x.arguments[0]) : x.type === 'ChainExpression' ? pick(x.expression) : x.type === 'AwaitExpression' ? pick(x.argument) : null;
  n = (pick(e) ?? 'value').replace(/\W/g, '') || 'value';
  let m = n, i = 2; while (used.has(m)) m = n + i++; used.add(m); return m;
}

for (const F of files) {
  const { ns, file, src, ast } = F;
  const ms = new MagicString(src);
  const done = new Set();
  const wrapLiteral = (lit, moduleLevel, viaProp) => {
    if (done.has(lit.start) || typeof lit.value !== 'string' || !isTextish(lit.value)) return;
    if (/^[a-z][\w-]*$/.test(lit.value) && !viaProp) return; // single lowercase token: likely a code, not text
    done.add(lit.start);
    const k = keyFor(ns, lit.value);
    if (moduleLevel && viaProp) { viaProp.getter = k; return; }
    if (moduleLevel) { review.push(`${file}:${lit.loc.start.line} module-level text kept English: ${JSON.stringify(lit.value).slice(0, 80)}`); delete catalogue[k]; return; }
    ms.overwrite(lit.start, lit.end, `t(${q(k)})`);
  };
  // Leaves of a display expression: literals through ternaries / logicals / parens.
  const leaves = (e, moduleLevel, prop) => {
    if (!e) return;
    if (e.type === 'Literal') return wrapLiteral(e, moduleLevel, prop);
    if (e.type === 'ConditionalExpression') { leaves(e.consequent, moduleLevel); leaves(e.alternate, moduleLevel); }
    if (e.type === 'LogicalExpression') { leaves(e.left, moduleLevel); leaves(e.right, moduleLevel); }
    if (e.type === 'ArrayExpression') e.elements.forEach((x) => leaves(x, moduleLevel));
    if (e.type === 'TemplateLiteral' && !e.expressions.length && !/</.test(e.quasis[0].value.raw)) {
      const v = cook(e.quasis[0].value.raw); if (isTextish(v)) { const k = keyFor(ns, v); if (moduleLevel) { review.push(`${file}:${e.loc.start.line} module-level template kept English`); delete catalogue[k]; } else ms.overwrite(e.start, e.end, `t(${q(k)})`); }
    }
    if (e.type === 'TemplateLiteral' && !/</.test(e.quasis.map((x) => x.value.raw).join(''))) displayTemplates.add(e);
  };
  const displayTemplates = new Set();
  const isModuleLevel = (anc) => !anc.some((a) => /Function/.test(a.type));

  // 3. Display positions: helper args, props, DOM assignments
  walk.ancestor(ast, {
    CallExpression(c, _s, anc) {
      const name = c.callee.type === 'Identifier' ? c.callee.name : null;
      if (name === 't' || name === 'label') return;
      const ml = isModuleLevel(anc);
      if (name && displayArgs[name]) for (const i of displayArgs[name]) leaves(c.arguments[i], ml);
      if (c.callee.type === 'MemberExpression' && ['toast', 'confirm', 'alert'].includes(c.callee.property.name)) leaves(c.arguments[0], ml);
    },
    Property(p, _s, anc) {
      const key = p.key.name ?? p.key.value;
      if (!DISPLAY_PROPS.has(key) || p.kind !== 'init' || p.method) return;
      const ml = isModuleLevel(anc);
      if (ml && p.value.type === 'Literal') { const holder = {}; leaves(p.value, true, holder); if (holder.getter) ms.overwrite(p.start, p.end, `get ${p.computed ? `[${src.slice(p.key.start, p.key.end)}]` : src.slice(p.key.start, p.key.end)}(){ return t(${q(holder.getter)}); }`); return; }
      leaves(p.value, ml);
    },
    AssignmentExpression(a, _s, anc) {
      if (a.left.type === 'MemberExpression' && DOM_PROPS.has(a.left.property.name)) leaves(a.right, isModuleLevel(anc));
    },
  });

  // 4. Template literals: HTML-aware runs
  walk.ancestor(ast, { TemplateLiteral(tl, _s, anc) {
    const parent = anc[anc.length - 2];
    if (parent?.type === 'TaggedTemplateExpression') return;
    const raws = tl.quasis.map((x) => x.value.raw);
    const hasTags = /<[a-zA-Z/!]/.test(raws.join(''));
    const isDisplay = displayTemplates.has(tl);
    if (!hasTags && !isDisplay) {
      const plain = cook(raws.join('{}'));
      if (isSentence(plain.replace(/\{\}/g, 'X'))) review.push(`${file}:${tl.loc.start.line} template not in a known display position: ${JSON.stringify(plain).slice(0, 90)}`);
      return;
    }
    const ml = isModuleLevel(anc);
    // state machine
    let state = hasTags ? 'TEXT' : 'TEXT', attr = '', quote = '', run = null;
    const runs = [];
    const startRun = (kind, qi, off, attrName) => { run = { kind, attrName, parts: [], start: { qi, off } }; };
    const endRun = (qi, off) => { if (run) { run.end = { qi, off }; runs.push(run); run = null; } };
    for (let qi = 0; qi < raws.length; qi++) {
      const raw = raws[qi];
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (state === 'TEXT') {
          if (ch === '<' && /[a-zA-Z/!]/.test(raw[i + 1] ?? '')) { endRun(qi, i); state = 'TAG'; attr = ''; continue; }
          if (!run) startRun('text', qi, i);
          run.parts.push({ qi, i });
        } else if (state === 'TAG') {
          if (ch === '>') { state = 'TEXT'; continue; }
          if (/[a-zA-Z:-]/.test(ch)) { attr = /[a-zA-Z:-]/.test(raw[i - 1] ?? '') ? attr + ch : ch; continue; }
          if (ch === '"' || ch === "'") { quote = ch; state = 'ATTR'; if (DISPLAY_ATTRS.has(attr.toLowerCase())) startRun('attr', qi, i + 1, attr); continue; }
        } else if (state === 'ATTR') {
          if (ch === quote) { if (run?.kind === 'attr') endRun(qi, i); state = 'TAG'; attr = ''; continue; }
          if (run?.kind === 'attr') run.parts.push({ qi, i });
        }
      }
      if (qi < tl.expressions.length) { // expression boundary
        if (state === 'TEXT') { if (!run) startRun('text', qi, raw.length); run.parts.push({ expr: qi }); }
        else if (state === 'ATTR' && run?.kind === 'attr') run.parts.push({ expr: qi });
      }
    }
    endRun(raws.length - 1, raws[raws.length - 1].length);

    for (const r of runs) {
      // literal text and trimmed bounds
      const items = []; // sequence of {lit:string, from, to} or {expr:index}
      for (const p of r.parts) {
        if (p.expr !== undefined) { items.push({ expr: p.expr }); continue; }
        const last = items[items.length - 1];
        const pos = tl.quasis[p.qi].start + p.i;
        if (last && last.lit !== undefined && last.to === pos) { last.lit += raws[p.qi][p.i]; last.to = pos + 1; }
        else items.push({ lit: raws[p.qi][p.i], from: pos, to: pos + 1, qi: p.qi });
      }
      // trim whitespace at both ends (it stays outside the call)
      while (items.length && items[0].lit !== undefined && !items[0].lit.trim()) items.shift();
      while (items.length && items[items.length - 1].lit !== undefined && !items[items.length - 1].lit.trim()) items.pop();
      if (!items.length) continue;
      if (items[0].lit !== undefined) { const m = items[0].lit.match(/^\s*/)[0].length; items[0].lit = items[0].lit.slice(m); items[0].from += m; }
      const L = items[items.length - 1]; if (L.lit !== undefined) { const m = L.lit.match(/\s*$/)[0].length; L.lit = L.lit.slice(0, L.lit.length - m); L.to -= m; }
      const litText = items.filter((x) => x.lit !== undefined).map((x) => x.lit).join('');
      if (!isTextish(cook(litText))) {
        // no words of its own: still translate literal leaves inside its expressions (e.g. ${ok?'Yes':'No'})
        items.filter((x) => x.expr !== undefined).forEach((x) => leaves(tl.expressions[x.expr], ml));
        continue;
      }
      if (ml) { review.push(`${file}:${tl.loc.start.line} module-level HTML text kept English: ${JSON.stringify(cook(litText)).slice(0, 70)}`); continue; }
      const used = new Set(); const names = {};
      let english = '';
      for (const it of items) {
        if (it.lit !== undefined) english += cook(it.lit);
        else { const nm = varName(tl.expressions[it.expr], used); names[it.expr] = nm; english += `{${nm}}`; }
      }
      const k = keyFor(r.kind === 'attr' ? ns : ns, english);
      // rewrite delimiters only; expressions stay where they are
      const exprs = items.filter((x) => x.expr !== undefined);
      const start = items[0].lit !== undefined ? items[0].from : tl.quasis[items[0].expr].end;      // '${' of first expr
      const end = L.lit !== undefined ? L.to : tl.quasis[L.expr + 1].start;                        // after '}' of last expr
      if (!exprs.length) { ms.overwrite(start, end, '${t(' + q(k) + ')}'); continue; }
      let cursor = start, first = true;
      for (const e of exprs) {
        const ex = tl.expressions[e.expr];
        ms.overwrite(cursor, ex.start, (first ? '${t(' + q(k) + ',{' : ',') + names[e.expr] + ':');
        first = false; cursor = ex.end;
        leaves(ex, ml); // literal leaves inside the expression are display text too
      }
      ms.overwrite(cursor, end, '})}');
    }
  } });

  // 5. Ensure t is imported
  let out = ms.toString();
  if (out !== src && !/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*i18n\.js'/.test(out)) {
    const m = /import\s*\{([^}]*)\}\s*from\s*'([^']*i18n\.js)';/.exec(out);
    if (m) out = out.replace(m[0], `import { ${m[1].split(',').map((s) => s.trim()).filter(Boolean).concat('t').join(', ')} } from '${m[2]}';`);
    else review.push(`${file}: needs an import of t from i18n.js`);
  }
  writeFileSync(file, out);
}
writeFileSync(outFile, JSON.stringify(catalogue, null, 1));
console.log('new keys per namespace', stats, 'total', Object.keys(catalogue).length);
console.log(`\nREVIEW (${review.length}):\n` + review.join('\n'));
