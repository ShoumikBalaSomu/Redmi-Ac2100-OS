#!/usr/bin/env node
/**
 * build.mjs — NexRouter web UI build
 * ===================================
 * There is intentionally NO bundler, NO transpiler and NO framework here.
 *
 * WHY
 * ---
 * This UI runs on a router with 128 MiB of RAM where both CPU cores are needed
 * for packet forwarding, and it is served over what may be a slow WiFi link.
 * A framework plus bundler would ship several hundred kilobytes of JavaScript
 * that has to be parsed on that device, to render nine panels of tables and
 * gauges. Hand-written ES modules and ~15 KB of CSS do the same job.
 *
 * It also means the source you read is the code that ships. There is no build
 * artefact to distrust and no generated output that diverges from the source.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 *   1. Validates the module graph: parses every .js file as an ES module and
 *      verifies that every relative import resolves to a file that exists. A
 *      typo'd import is a silent blank page in the browser, so catching it
 *      here is worth more than any minification.
 *   2. Checks for balanced HTML tags in index.html and that every referenced
 *      asset exists.
 *   3. Copies index.html, src/css and src/js into dist/ with a flat layout
 *      (index.html, css/, js/) matching what index.html expects.
 *   4. Reports the total transfer size, because on this device that number is
 *      a real design constraint rather than a curiosity.
 *
 * USAGE
 *   node build.mjs            build into dist/
 *   node build.mjs --check    validate only, write nothing
 *   node build.mjs --clean    remove dist/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const SRC_JS = path.join(HERE, 'src', 'js');
const SRC_CSS = path.join(HERE, 'src', 'css');
const INDEX = path.join(HERE, 'index.html');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const doClean = args.includes('--clean');

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

/* ── clean ───────────────────────────────────────────────────────────────── */

if (doClean) {
  fs.rmSync(DIST, { recursive: true, force: true });
  console.log(`removed ${path.relative(HERE, DIST)}/`);
  process.exit(0);
}

/* ── module graph validation ─────────────────────────────────────────────── */

function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('\nvalidating module graph');

/**
 * Syntax-check one ES module with Node's real parser.
 *
 * `node --check` parses without executing, so it is safe for browser-only
 * modules that reference `document` at import time. It resolves ESM vs CJS
 * from the nearest package.json ("type": "module"), which is why it accepts
 * `export` in a .js file here.
 *
 * This is a genuine gate, not a formality: a syntax error in a module that is
 * imported by app.js blanks the entire dashboard with only a console message
 * to show for it — which on a router accessed over flaky WiFi is a poor
 * debugging experience.
 */
function syntaxCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').split('\n')
      .filter(l => l.trim() && !l.startsWith('Node.js v'))
      .slice(0, 4).join('\n    ');
    return { ok: false, detail };
  }
  return { ok: true };
}

const jsFiles = walkJs(SRC_JS);
if (!jsFiles.length) fail(`no .js files under ${path.relative(HERE, SRC_JS)}`);

for (const file of jsFiles) {
  const rel = path.relative(HERE, file);
  const src = fs.readFileSync(file, 'utf8');

  const sc = syntaxCheck(file);
  if (!sc.ok) {
    fail(`${rel}: syntax error\n    ${sc.detail}`);
    continue;
  }
  ok(`${rel} parses as an ES module`);

  // Every relative import must resolve. This is the single most common cause
  // of a silently blank SPA.
  const importRe = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  const sideEffectRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  const specs = new Set();
  for (const re of [importRe, sideEffectRe]) {
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  let unresolved = 0;
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      fail(`${rel}: unresolved import '${spec}'`);
      unresolved++;
    }
  }
  if (specs.size && !unresolved) ok(`${rel}: ${specs.size} import specifier(s) resolve`);
}

/* ── Negative control ──────────────────────────────────────────────────────
   Verify the syntax check above can actually FAIL. A validator that always
   passes is worse than no validator, because it creates false confidence. We
   write a deliberately broken module to a temp file, assert that syntaxCheck
   rejects it, then remove it.                                              */

console.log('\nvalidating the validator');
{
  const probe = path.join(HERE, '.build-probe.mjs');
  fs.writeFileSync(probe, 'export const broken = ;\n', 'utf8');
  try {
    const r = syntaxCheck(probe);
    if (r.ok) fail('negative control: syntaxCheck accepted deliberately invalid code — the validator is not working');
    else ok('negative control rejects invalid syntax');
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/* ── index.html validation ───────────────────────────────────────────────── */

console.log('\nvalidating index.html');

if (!fs.existsSync(INDEX)) {
  fail('index.html is missing');
} else {
  const html = fs.readFileSync(INDEX, 'utf8');

  // Referenced local assets must exist.
  const assetRe = /(?:href|src)="([^"]+)"/g;
  let m;
  let assets = 0;
  while ((m = assetRe.exec(html))) {
    const ref = m[1];
    if (/^(https?:|data:|#|\/)/.test(ref)) continue;
    assets++;
    const target = path.resolve(HERE, ref);
    // index.html references css/ and js/ which only exist after the copy into
    // dist; map them back to src for validation.
    const srcTarget = path.resolve(HERE, 'src', ref);
    if (!fs.existsSync(target) && !fs.existsSync(srcTarget)) {
      fail(`index.html references missing asset: ${ref}`);
    }
  }
  ok(`${assets} local asset reference(s) resolve`);

  // Rough tag balance for the elements that actually matter. A stray </div>
  // in a hand-written template produces a broken layout with no error.
  for (const tag of ['div', 'section', 'header', 'main', 'nav', 'template', 'form']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) fail(`unbalanced <${tag}>: ${open} open, ${close} close`);
  }
  if (!failures) ok('tag balance');

  // The SPA mounts into these ids; app.js looks them up unconditionally.
  for (const id of ['gate', 'app', 'login-form', 'nav', 'main', 'toasts',
                    'status-msg', 'v-offload-wrap']) {
    if (!html.includes(`id="${id}"`)) fail(`index.html is missing #${id}`);
  }
  ok('required element ids present');
}

if (failures) {
  console.error(`\n✗ ${failures} problem(s) — not writing dist/`);
  process.exit(1);
}

if (checkOnly) {
  console.log('\n--check passed; nothing written.');
  process.exit(0);
}

/* ── copy into dist/ ─────────────────────────────────────────────────────── */

console.log('\nbuilding dist/');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

const copied = [];

fs.copyFileSync(INDEX, path.join(DIST, 'index.html'));
copied.push(['index.html', fs.statSync(path.join(DIST, 'index.html')).size]);

for (const f of fs.readdirSync(SRC_CSS)) {
  if (!f.endsWith('.css')) continue;
  fs.copyFileSync(path.join(SRC_CSS, f), path.join(DIST, 'css', f));
  copied.push([`css/${f}`, fs.statSync(path.join(DIST, 'css', f)).size]);
}

function copyJs(srcDir, destDir, prefix) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const sp = path.join(srcDir, e.name);
    const dp = path.join(destDir, e.name);
    if (e.isDirectory()) copyJs(sp, dp, `${prefix}${e.name}/`);
    else if (e.name.endsWith('.js')) {
      fs.copyFileSync(sp, dp);
      copied.push([`${prefix}${e.name}`, fs.statSync(dp).size]);
    }
  }
}
copyJs(SRC_JS, path.join(DIST, 'js'), 'js/');

const total = copied.reduce((s, [, n]) => s + n, 0);
console.log('');
for (const [name, size] of copied.sort()) {
  console.log(`  ${name.padEnd(24)} ${String(size).padStart(7)} B`);
}
console.log(`  ${'─'.repeat(24)} ${'─'.repeat(7)}`);
console.log(`  ${'total (uncompressed)'.padEnd(24)} ${String(total).padStart(7)} B  (${(total / 1024).toFixed(1)} KiB)`);
console.log(`\n  → ${path.relative(HERE, DIST)}/  (${copied.length} files)`);
console.log('  uhttpd serves this at /www/nex, reachable at http://<router>/nex/');
console.log('\n✓ build complete');
