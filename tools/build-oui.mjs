#!/usr/bin/env node
/**
 * build-oui.mjs — generate the MAC OUI vendor database shipped in the firmware
 * =============================================================================
 * The intelligence layer identifies device vendors from the first three octets
 * of a MAC address (the Organizationally Unique Identifier). That lookup needs a
 * database. This tool builds it from the IEEE's public OUI registry into the
 * compact tab-separated form the router reads:
 *
 *     AABBCC<TAB>Vendor Name
 *
 * WHY A BUILDTIME TOOL RATHER THAN A RUNTIME DOWNLOAD
 * ---------------------------------------------------
 * The router must not fetch this at boot. That would make device identification
 * depend on a third-party server being reachable, would add a network call to
 * every startup, and would be a privacy problem (it would announce the router's
 * existence to a vendor we do not control). Building the table once, at image
 * build time, and shipping it as a static file means:
 *   * no runtime network dependency
 *   * a known, auditable, versioned artefact
 *   * the user can inspect exactly what vendor data is on their device
 *
 * WHY THIS FORMAT
 * ---------------
 * The full IEEE registry (oui.csv / mam.csv / oui36.csv) is tens of megabytes of
 * CSV with columns we do not need. On a device with 128 MiB of RAM we want the
 * smallest thing that answers "who made this MAC?". That is the 3-byte prefix
 * and a short vendor string. This tool reduces the registry to that and nothing
 * else, and caps vendor-name length so a single pathological entry cannot bloat
 * a table row.
 *
 * The output is sorted and de-duplicated so it is stable across runs — a rebuilt
 * image with unchanged upstream data produces a byte-identical oui.txt, which
 * matters for reproducible builds.
 *
 * USAGE
 *   node build-oui.mjs --out <path> [--source <url-or-file>] [--max-vendor-len <n>]
 *   node build-oui.mjs --out oui.txt                 # download from IEEE
 *   node build-oui.mjs --out oui.txt --source oui.csv # build from a local file
 *   node build-oui.mjs --self-test                   # no network, uses fixtures
 *
 * The IEEE registry lives at https://standards-ieee.org/wp-content/uploads/import/oui/
 * This tool accepts the oui.csv (24-bit) and mam.csv (28-bit) formats. It does
 * NOT invent vendor data: if the source cannot be fetched, it fails loudly
 * rather than emitting a partial or fabricated table.
 *
 * DEPENDENCIES: none. Uses only Node built-ins (fetch is global on Node 18+).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** True when executed directly rather than imported for its exported helpers. */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// The IEEE public OUI registry. The canonical location has moved several times
// (standards-ieee.org/wp-content/... no longer resolves; the
// standards.ieee.org/regauth/oui/oui.csv path now returns an HTML page rather
// than CSV, which this tool must detect and reject rather than silently parse).
//
// standards-oui.ieee.org is the current working host. Note it rejects HEAD
// requests with HTTP 418 but serves GET normally, which is why this tool always
// uses GET and never probes with HEAD.
//
// oui.csv = 24-bit (MA-L) assignments, ~35k+ entries — what a plain MAC vendor
//           lookup needs. Header: Registry,Assignment,Organization Name,...
const DEFAULT_SOURCES = [
  'https://standards-oui.ieee.org/oui/oui.csv',
  'https://standards.ieee.org/regauth/oui/oui.csv',
];

/**
 * Sanity floor for a plausible registry. The real MA-L registry has tens of
 * thousands of entries. A result far below this means the source was not
 * actually a CSV — most commonly an HTML error page or a redirect stub that
 * happens to contain a comma. Refusing to write is correct: a silently tiny or
 * corrupt vendor table would degrade device identification on the router with
 * no error anywhere, which is much worse than a build failure.
 */
const MIN_PLAUSIBLE_ENTRIES = 5000;

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const a = { out: null, source: [], maxVendorLen: 40, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--source') a.source.push(argv[++i]);
    else if (t === '--max-vendor-len') a.maxVendorLen = Number(argv[++i]) || 40;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '-h' || t === '--help') { usage(); process.exit(0); }
  }
  return a;
}

function usage() {
  console.log(`build-oui — generate the OUI vendor table for NexRouter

Usage:
  node build-oui.mjs --out <path> [--source <url|file>]... [--max-vendor-len <n>]
  node build-oui.mjs --self-test

Options:
  --out <path>          output TSV file (required unless --self-test)
  --source <url|file>   IEEE oui.csv / mam.csv, may be repeated; local paths and
                        http(s) URLs both accepted. Defaults to the IEEE registry.
  --max-vendor-len <n>  truncate vendor names to n characters (default 40)
  --self-test           run the parser against built-in fixtures, no network
`);
}

/* ── CSV parsing ───────────────────────────────────────────────────────────
   The IEEE files are RFC-4180 CSV with quoted fields containing commas, e.g.:
     "Registry","Assignment","Organization Name","Address"...
     "MA-L","000000","XEROX CORPORATION","..."
   A naive split(',') would break on embedded commas, so this is a real
   state-machine parser. It is the one non-trivial piece of logic here and it is
   exercised by the self-test.                                              */

/**
 * Parse one CSV line into an array of fields, honouring double-quote escaping.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        // "" inside a quoted field is an escaped quote.
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/**
 * Normalise a MAC prefix to six uppercase hex digits.
 * The registry writes prefixes as "00-00-00", "00:00:00" or "000000"; MA-M
 * entries can be longer (28-bit). We only keep 24-bit (6 hex char) prefixes,
 * since that is what a plain OUI lookup uses.
 * @param {string} raw
 * @returns {string|null}
 */
export function normaliseOui(raw) {
  if (typeof raw !== 'string') return null;
  const hex = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  // Exactly 6 hex digits = a 24-bit OUI. Longer (8 = MA-M 28-bit) entries are
  // skipped: mapping a 28-bit assignment onto a 24-bit lookup would be wrong.
  if (hex.length !== 6 || /[^0-9A-F]/.test(hex)) return null;
  return hex;
}

/**
 * Collapse a vendor name to a short, table-safe string.
 * Strips the corporate suffixes that carry no identification value ("INC",
 * "LTD", "CORPORATION", "CO.,LTD", "GMBH"), collapses whitespace, and truncates.
 * Done so the shipped table stays small and readable.
 * @param {string} raw
 * @param {number} maxLen
 */
export function cleanVendor(raw, maxLen = 40) {
  if (typeof raw !== 'string') return '';
  let v = raw.trim();
  // Remove common legal-suffix noise. Word-boundary anchored so we do not
  // mangle a vendor legitimately named e.g. "Incorporated Data Systems" —
  // only a trailing suffix is dropped.
  v = v.replace(/[,.\s]+(INCORPORATED|INC|LTD|LIMITED|CORPORATION|CORP|COMPANY|CO|GMBH|LLC|LLP|PLC|AG|SA|SRL|S\.?A\.?|PTE|PTY|KG|B\.?V\.?|N\.?V\.?|OY|AB|AS|OÜ)\.?(?=$|[,.\s])/gi, '');
  v = v.replace(/\s{2,}/g, ' ').replace(/[,.\s]+$/, '').trim();
  if (v.length > maxLen) v = `${v.slice(0, maxLen - 1).replace(/\s+\S*$/, '')}…`;
  return v;
}

/**
 * Turn raw CSV text into a Map of OUI -> vendor.
 * @param {string} csv
 * @param {number} maxLen
 */
export function buildFromCsv(csv, maxLen = 40) {
  const map = new Map();
  let headerSeen = false;
  let assignmentIdx = 1, orgIdx = 2; // defaults for the IEEE layout

  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);

    // Detect the header row and locate columns by name rather than assuming
    // positions — the registry layout has changed before.
    if (!headerSeen && f.some(x => /Registry|Assignment/i.test(x))) {
      headerSeen = true;
      const ai = f.findIndex(x => /Assignment/i.test(x));
      const oi = f.findIndex(x => /Organization Name/i.test(x));
      if (ai >= 0) assignmentIdx = ai;
      if (oi >= 0) orgIdx = oi;
      continue;
    }
    if (!headerSeen) { headerSeen = true; } // no header; use positional defaults

    const oui = normaliseOui(f[assignmentIdx]);
    if (!oui) continue;
    const vendor = cleanVendor(f[orgIdx] ?? '', maxLen);
    if (!vendor) continue;
    // First assignment wins on duplicates so the output is deterministic
    // regardless of source ordering.
    if (!map.has(oui)) map.set(oui, vendor);
  }
  return map;
}

/* ── Source fetching ─────────────────────────────────────────────────────── */

async function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    // The IEEE registry rejects some client identifiers with HTTP 418 ("I'm a
    // teapot"), which reads like a server fault but is a bot filter. Empirically
    // it accepts a browser-style "Mozilla/5.0 (compatible; ...)" UA and curl's,
    // but rejects a bare "Node-fetch" token — so the UA below follows the
    // RFC 9110 product-token convention with a Mozilla-compatible prefix. This
    // is a plain public-file GET of the published OUI registry; nothing is
    // uploaded and no credentials are sent.
    const res = await fetch(src, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NexRouter-build-oui/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText || ''} fetching ${src}`.trim());
    }
    return res.text();
  }
  // Local file.
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) throw new Error(`source file not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

/* ── Self-test ───────────────────────────────────────────────────────────── */

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  console.log('\nbuild-oui self-test');

  // CSV parser
  check('parses simple row', JSON.stringify(parseCsvLine('a,b,c')) === '["a","b","c"]');
  check('parses quoted field with comma', JSON.stringify(parseCsvLine('"a,b",c')) === '["a,b","c"]');
  // Compare against a real array, not a hand-written JSON string literal: the
  // escaped-quote case is easy to get wrong in the *expectation* because the
  // backslashes in a single-quoted literal collapse. deepEqual avoids that trap.
  check('parses escaped quotes',
    JSON.stringify(parseCsvLine('"say ""hi""",x')) === JSON.stringify(['say "hi"', 'x']));
  check('parses empty field', JSON.stringify(parseCsvLine('a,,b')) === '["a","","b"]');
  check('handles trailing quoted field', JSON.stringify(parseCsvLine('a,"b"')) === '["a","b"]');

  // OUI normalisation
  check('normalises 00-11-22', normaliseOui('00-11-22') === '001122');
  check('normalises 00:11:22', normaliseOui('00:11:22') === '001122');
  check('uppercases hex', normaliseOui('aa-bb-cc') === 'AABBCC');
  check('rejects 28-bit MA-M', normaliseOui('00-11-22-3') === null);
  check('rejects non-hex', normaliseOui('ZZZZZZ') === null);
  check('rejects null', normaliseOui(null) === null);

  // Vendor cleaning
  check('strips INC suffix', cleanVendor('ACME INC') === 'ACME');
  check('strips CORPORATION', cleanVendor('Globex Corporation') === 'Globex');
  check('keeps core name', cleanVendor('Apple') === 'Apple');
  check('collapses whitespace', cleanVendor('Foo   Bar  Ltd') === 'Foo Bar');
  check('truncates long names', cleanVendor('x'.repeat(80), 20).length <= 20);
  check('empty on non-string', cleanVendor(undefined) === '');

  // Full build from a fixture that mirrors the real IEEE layout.
  const fixture = [
    'Registry,Assignment,Organization Name,Address',
    '"MA-L","00-00-00","XEROX CORPORATION","123 Main St, Anytown"',
    '"MA-L","00-1A-2B","Apple, Inc.","One Apple Park Way"',
    '"MA-L","AA-BB-CC","Espressif Inc.","Shanghai"',
    '"MA-M","00-11-22-33","Too Long Assignment","Somewhere"',
    '"MA-L","DE-AD-00","","Empty Org Name"',
  ].join('\n');
  const map = buildFromCsv(fixture, 40);
  check('builds expected entry count (28-bit, empty-name skipped)', map.size === 3);
  check('XEROX entry present', map.get('000000') === 'XEROX');
  check('Apple entry cleaned', map.get('001A2B') === 'Apple');
  check('Espressif entry present', map.get('AABBCC') === 'Espressif');
  check('28-bit assignment skipped', !map.has('001122'));
  check('empty-name assignment skipped', !map.has('DEAD00'));

  // Determinism: same input twice yields identical serialisation.
  const ser = (m) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}\t${v}`).join('\n');
  check('output is deterministic', ser(buildFromCsv(fixture)) === ser(buildFromCsv(fixture)));

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) { selfTest(); return; }
  if (!opts.out) { usage(); process.exit(1); }

  const sources = opts.source.length ? opts.source : DEFAULT_SOURCES;
  const combined = new Map();
  let anyCsvOk = false;

  for (const src of sources) {
    process.stderr.write(`[build-oui] reading ${src}\n`);
    let text;
    try {
      text = await readSource(src);
    } catch (err) {
      // One source failing is not fatal if another succeeds; log and continue.
      // Only a total failure (nothing usable from any source) aborts below.
      process.stderr.write(`[build-oui]   WARN: ${err.message}\n`);
      continue;
    }

    // Reject an HTML page masquerading as CSV. The regauth path returns a full
    // HTML document; parsing it "succeeds" with a handful of bogus rows scraped
    // out of embedded JSON-LD, which is exactly the silent-corruption case this
    // guard exists to catch. A real oui.csv starts with the header
    // "Registry,Assignment,Organization Name".
    const head = text.slice(0, 512);
    if (/<!doctype html|<html[\s>]/i.test(head) || !/Registry\s*,\s*Assignment/i.test(head)) {
      process.stderr.write(`[build-oui]   WARN: response is not an OUI CSV (looks like HTML or an unexpected format) — skipping\n`);
      continue;
    }

    const m = buildFromCsv(text, opts.maxVendorLen);
    process.stderr.write(`[build-oui]   ${m.size} entries\n`);
    if (m.size > 0) anyCsvOk = true;
    for (const [k, v] of m) if (!combined.has(k)) combined.set(k, v);
  }

  if (!anyCsvOk || combined.size === 0) {
    process.stderr.write('[build-oui] ERROR: no valid OUI CSV from any source — refusing to write an empty or corrupt table\n');
    process.stderr.write('[build-oui]         Check network access and that the IEEE registry URL is still current (see DEFAULT_SOURCES).\n');
    process.exit(2);
  }

  // Plausibility floor. The real registry has tens of thousands of entries; a
  // result far below this means a source was truncated or was not really the
  // registry. Better to fail the build than to ship a table that silently makes
  // most vendors "unknown" on the router.
  if (combined.size < MIN_PLAUSIBLE_ENTRIES) {
    process.stderr.write(`[build-oui] ERROR: only ${combined.size} entries parsed, below the plausibility floor of ${MIN_PLAUSIBLE_ENTRIES}.\n`);
    process.stderr.write('[build-oui]         The source was likely truncated or is not the full registry. Refusing to write.\n');
    process.exit(2);
  }

  // Sort for a stable, reproducible artefact.
  const lines = [...combined.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}\t${v}`);

  const outAbs = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${lines.join('\n')}\n`, 'utf8');

  const bytes = fs.statSync(outAbs).size;
  process.stderr.write(`[build-oui] wrote ${combined.size} entries to ${outAbs} (${(bytes / 1024).toFixed(0)} KiB)\n`);
}

// Only run the CLI when executed directly. Importing this module for its
// exported parser helpers (parseCsvLine, buildFromCsv, …) must not trigger a
// network fetch or process.exit.
if (IS_MAIN) {
  main().catch(err => {
    process.stderr.write(`[build-oui] fatal: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
