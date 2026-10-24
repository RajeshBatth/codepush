// Builds two JS "unit" bundles (v1, v2) from real npm package sources, Metro-style: every file is wrapped in
// __d(function(global, require, module, exports){...}, <id>, []);
// v2 applies small, realistic source edits. Used to measure how well Hermes BYTECODE diffs.
//   node make_hbc_corpus.mjs <outdir> <scenario: tweak|feature|big> <srcDir>...
// Deterministic (no randomness beyond a fixed LCG).
import fs from 'node:fs';
import path from 'node:path';

const [, , outDir, scenario, ...srcDirs] = process.argv;
if (!outDir || !scenario || srcDirs.length === 0) {
  console.error('usage: node make_hbc_corpus.mjs <outdir> <tweak|feature|big> <srcDir>...');
  process.exit(2);
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js') && !p.includes('/esm/') && !p.includes('/locale/')) acc.push(p);
  }
  return acc;
}

let files = srcDirs.flatMap((d) => walk(d));
const mods = files.map((f) => ({ f, src: fs.readFileSync(f, 'utf8') })).filter((m) => m.src.length > 200 && m.src.length < 400000 && !/^\s*(import\s[^(]*from\s|import\s*['"]|export\s)/m.test(m.src)); // CJS only

let seed = 12345;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);

function edit(src, idx, kind) {
  if (kind === 'tweak') {
    // change one number literal (same or different digit count) and one string literal
    let done = 0;
    return src
      .replace(/\b(\d{2,4})\b/, (m) => (done++ === 0 ? String(Number(m) + 7) : m))
      .replace(/(['"])([a-zA-Z ]{4,20})\1/, (m, q, s) => `${q}${s}x${q}`);
  }
  // feature: append a new function with new strings, tweak a condition
  const fn = `\nfunction __ota_feature_${idx}(a, b) {\n  var label = 'feature-${idx}-label';\n  if (a && b) { return label + ':' + (a.length || 0) + ':' + (b.length || 0) + ':new-flag-${idx}'; }\n  var out = [];\n  for (var i = 0; i < 3; i++) { out.push('row-' + i + '-${idx}'); }\n  return out.join(',');\n}\nif (typeof module !== 'undefined' && module.exports) { module.exports.__ota_feature_${idx} = __ota_feature_${idx}; }\n`;
  return src.replace(/===/, '!==').replace(/\b(\d{2,4})\b/, (m) => String(Number(m) + 1)) + fn;
}

const nChanged = scenario === 'big' ? Math.max(1, Math.floor(mods.length * 0.05)) : 5;
const kind = scenario === 'tweak' ? 'tweak' : 'feature';
const changed = new Set();
// only pick modules the edit actually changes (some files have no matching literal)
while (changed.size < nChanged) {
  const i = rnd(mods.length);
  if (edit(mods[i].src, i, kind) !== mods[i].src) changed.add(i);
}

function bundle(apply) {
  return mods
    .map((m, i) => {
      const body = apply && changed.has(i) ? edit(m.src, i, kind) : m.src;
      return `__d(function(global, require, module, exports) {${body}\n}, ${1000 + i}, []);\n`;
    })
    .join('');
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'v1.js'), bundle(false));
fs.writeFileSync(path.join(outDir, 'v2.js'), bundle(true));
console.log(`${mods.length} modules, ${changed.size} changed (${scenario}); v1.js ${fs.statSync(path.join(outDir, 'v1.js')).size} bytes`);
