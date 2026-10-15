#!/usr/bin/env node
'use strict';

/**
 * fwscan.mjs — NexRouter firmware image scanner
 * ---------------------------------------------
 * A zero-dependency Node.js binary-structure analyzer for router firmware
 * images. Written specifically for the Xiaomi Redmi Router AC2100 project
 * (MediaTek MT7621, NAND flash, OpenWrt ramips/mt7621 target) but generic
 * enough for most MIPS/ARM vendor images.
 *
 * WHAT IT DOES
 *   1. Streams the image and indexes every occurrence of a known container /
 *      filesystem / bootloader magic signature.
 *   2. Computes a Shannon-entropy profile over fixed windows so that
 *      plaintext, compressed and encrypted regions can be told apart.
 *   3. Deep-parses the structures it recognises: uImage headers, Flattened
 *      Device Trees / FIT images, squashfs superblocks, gzip members.
 *   4. Attempts vendor-header decoding (Xiaomi "HDR1"/"MIWF"-family and
 *      generic length-prefixed wrappers).
 *   5. Emits a human report and (optionally) a machine-readable JSON report
 *      that the rest of the NexRouter tooling consumes.
 *
 * WHAT IT DOES NOT DO
 *   It never writes to flash, never touches a device, and never decrypts
 *   signed payloads. This is a read-only static analysis tool.
 *
 * USAGE
 *   node fwscan.mjs <image> [--json <out.json>] [--strings] [--window <MiB>]
 *   node fwscan.mjs --compare a.bin b.bin [--json out.json]
 *
 * EXIT CODES
 *   0 success, 1 usage/IO error, 2 no recognisable structure found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Signature table
 * ------------------------------------------------------------------ */

const MAGIC = [
  { name: 'gzip',            hex: '1f8b08',                kind: 'compression', note: 'gzip deflate member' },
  { name: 'xz',              hex: 'fd377a585a00',          kind: 'compression', note: 'XZ / LZMA2 stream' },
  { name: 'zstd',            hex: '28b52ffd',              kind: 'compression', note: 'Zstandard frame' },
  { name: 'bzip2',           hex: '425a68',                kind: 'compression', note: 'bzip2 stream' },
  { name: 'lzma-alone',      hex: '5d0000',                kind: 'compression', note: 'LZMA alone (weak signal, many false positives)', weak: true },
  { name: 'squashfs-le',     hex: '68737173',              kind: 'filesystem',  note: "squashfs superblock 'hsqs' little-endian", parse: 'squashfs' },
  { name: 'squashfs-be',     hex: '73717368',              kind: 'filesystem',  note: "squashfs superblock 'sqsh' big-endian" },
  { name: 'fdt-fit',         hex: 'd00dfeed',              kind: 'devicetree',  note: 'Flattened Device Tree / FIT image', parse: 'fdt' },
  { name: 'uimage',          hex: '27051956',              kind: 'bootloader',  note: 'U-Boot legacy uImage', parse: 'uimage' },
  { name: 'jffs2-le',        hex: '1985',                  kind: 'filesystem',  note: 'JFFS2 node (LE)', weak: true },
  { name: 'ubi-ec',          hex: '55424923',              kind: 'flash',       note: "UBI erase-count header 'UBI#'" },
  { name: 'ubifs-node',      hex: '23554249',              kind: 'flash',       note: "UBIFS superblock/node '#UBI'" },
  { name: 'cpio-newc',       hex: '303730373031',          kind: 'archive',     note: 'cpio newc (ASCII "070701")' },
  { name: 'cpio-odc',        hex: '303730373037',          kind: 'archive',     note: 'cpio odc (ASCII "070707")' },
  { name: 'elf',             hex: '7f454c46',              kind: 'binary',      note: 'ELF object' },
  { name: 'xz-embedded',     hex: 'fd377a58',              kind: 'compression', note: 'XZ (short match)', weak: true },
  { name: 'tar-ustar',       hex: '7573746172',            kind: 'archive',     note: "POSIX tar 'ustar' at +257", special: 'tar' },
  { name: 'cramfs-le',       hex: '453dcd28',              kind: 'filesystem',  note: 'CramFS superblock' },
  { name: 'yaffs-obj',       hex: '03000000010000000000',  kind: 'flash',       note: 'YAFFS2 object header (heuristic)', weak: true },
  { name: 'mi-hdr1',         hex: '48445231',              kind: 'vendor',      note: "Xiaomi 'HDR1' vendor container header", parse: 'xiaomi' },
  { name: 'mi-miwf',         hex: '4d495746',              kind: 'vendor',      note: "Xiaomi 'MIWF' marker", parse: 'xiaomi' },
  { name: 'mi-xqimg',        hex: '5851494d47',            kind: 'vendor',      note: "Xiaomi 'XQIMG' marker", parse: 'xiaomi' },
  { name: 'mtk-boot',        hex: '4d544b42',              kind: 'vendor',      note: "'MTKB' MediaTek vendor marker", weak: true },
  { name: 'rsa-sig-ish',     hex: '308202',                kind: 'crypto',      note: 'DER SEQUENCE, common in signature blocks', weak: true }
];

const UIMAGE_ARCH = { 0:'Invalid',2:'ARM',3:'I386',4:'IA64',5:'MIPS',6:'MIPS64',7:'PPC',8:'S390',9:'SH',10:'SPARC',11:'SPARC64',15:'AVR32',22:'X86_64',23:'MICROBLAZE' };
const UIMAGE_OS   = { 0:'Invalid',1:'OpenBSD',3:'NetBSD',4:'FreeBSD',5:'Linux',14:'VxWorks',17:'QNX',18:'U-Boot',21:'RTEMS' };
const UIMAGE_TYPE = { 0:'Invalid',1:'Standalone',2:'Kernel',3:'RAMDisk',4:'Multi',5:'Firmware',6:'Script',7:'Filesystem',8:'FlatDeviceTree',9:'KMultiImage' };
const UIMAGE_COMP = { 0:'none',1:'gzip',2:'bzip2',3:'lzma',4:'lzo',5:'lz4',6:'zstd' };

const SQFS_COMP = { 1:'gzip', 2:'lzma', 3:'lzo', 4:'xz', 5:'lz4', 6:'zstd' };

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const a = { positional: [], json: null, strings: false, window: 1, compare: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = argv[++i];
    else if (t === '--window') a.window = Number(argv[++i]) || 1;
    else if (t === '--strings') a.strings = true;
    else if (t === '--compare') a.compare = true;
    else if (t === '--help' || t === '-h') { usage(); process.exit(0); }
    else a.positional.push(t);
  }
  return a;
}

function usage() {
  console.log(`fwscan — NexRouter firmware image scanner

Usage:
  node fwscan.mjs <image> [--json out.json] [--strings] [--window <MiB>]
  node fwscan.mjs --compare <a.bin> <b.bin> [--json out.json]

Options:
  --json <path>   also write a machine-readable report
  --strings       include extracted printable strings from header regions
  --window <MiB>  entropy window size in MiB (default 1)
  --compare       compare two images side by side
  -h, --help      this message
`);
}

/* ------------------------------------------------------------------ *
 * IO helpers
 * ------------------------------------------------------------------ */

function openImage(p) {
  const fd = fs.openSync(p, 'r');
  const st = fs.fstatSync(fd);
  return { fd, size: st.size, path: p };
}

function readAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

function hex(buf, sep = ' ') {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(sep);
}

function human(n) {
  if (!Number.isFinite(n)) return String(n);
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function off(n) {
  return `0x${n.toString(16).padStart(8, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Magic scan (streamed, bounded memory)
 * ------------------------------------------------------------------ */

const PREPARED = MAGIC.map(m => ({ ...m, buf: Buffer.from(m.hex, 'hex') }))
  .filter(m => !m.weak || process.env.FWSCAN_WEAK === '1');

function scanMagics(img, capPerSig = 64) {
  const CHUNK = 8 * 1024 * 1024;
  const OVERLAP = 16;
  const hits = [];
  const counts = new Map();
  let pos = 0;
  let prev = Buffer.alloc(0);

  while (pos < img.size) {
    const len = Math.min(CHUNK, img.size - pos);
    const buf = readAt(img.fd, pos, len);
    const hay = prev.length ? Buffer.concat([prev, buf]) : buf;
    const base = pos - prev.length;

    for (const sig of PREPARED) {
      let from = 0;
      let guard = 0;
      while (guard++ < 4096) {
        const idx = hay.indexOf(sig.buf, from);
        if (idx === -1) break;
        const abs = base + idx;
        if (sig.special === 'tar') {
          // 'ustar' lives at +257 inside a tar header; real record starts there.
          if (idx % 512 !== 257) { from = idx + 1; continue; }
        }
        const c = counts.get(sig.name) || 0;
        if (c < capPerSig) {
          hits.push({ sig: sig.name, kind: sig.kind, offset: abs, note: sig.note });
        }
        counts.set(sig.name, c + 1);
        from = idx + 1;
      }
    }

    prev = buf.subarray(Math.max(0, buf.length - OVERLAP));
    pos += len;
  }

  hits.sort((a, b) => a.offset - b.offset);
  return { hits, counts: Object.fromEntries(counts) };
}

/* ------------------------------------------------------------------ *
 * Entropy profile
 * ------------------------------------------------------------------ */

function entropyProfile(img, windowMiB) {
  const win = Math.max(1, windowMiB) * 1024 * 1024;
  const out = [];
  for (let p = 0; p < img.size; p += win) {
    const len = Math.min(win, img.size - p);
    const buf = readAt(img.fd, p, len);
    const freq = new Uint32Array(256);
    for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
    let H = 0;
    const N = buf.length;
    for (let i = 0; i < 256; i++) {
      const c = freq[i];
      if (!c) continue;
      const pr = c / N;
      H -= pr * Math.log2(pr);
    }
    const zeroRun = freq[0] / N;
    out.push({
      offset: p,
      size: len,
      entropy: Number(H.toFixed(4)),
      zeroFraction: Number(zeroRun.toFixed(4)),
      classify: classifyEntropy(H, zeroRun)
    });
  }
  return out;
}

function classifyEntropy(H, zeroFrac) {
  if (zeroFrac > 0.9) return 'erased/empty';
  if (H >= 7.9) return 'compressed-or-encrypted';
  if (H >= 7.0) return 'compressed';
  if (H >= 5.0) return 'binary-mixed';
  if (H >= 3.0) return 'structured-binary';
  return 'text-or-sparse';
}

/* ------------------------------------------------------------------ *
 * Deep parsers
 * ------------------------------------------------------------------ */

function parseUImage(img, o) {
  const b = readAt(img.fd, o, 64);
  if (b.length < 64) return null;
  const be = b.readUInt32BE.bind(b);
  const r = {
    magic: '0x' + be(0).toString(16),
    headerCrc: '0x' + be(4).toString(16),
    timestamp: new Date(be(8) * 1000).toISOString(),
    dataSize: be(12),
    loadAddr: '0x' + be(16).toString(16),
    entryPoint: '0x' + be(20).toString(16),
    dataCrc: '0x' + be(24).toString(16),
    arch: UIMAGE_ARCH[b[28]] ?? b[28],
    os: UIMAGE_OS[b[29]] ?? b[29],
    type: UIMAGE_TYPE[b[30]] ?? b[30],
    comp: UIMAGE_COMP[b[31]] ?? b[31],
    name: b.subarray(32, 64).toString('latin1').replace(/\0.*$/, '')
  };
  // Verify the header CRC (U-Boot excludes the crc field itself).
  const hdr = Buffer.from(b);
  hdr.writeUInt32BE(0, 4);
  r.headerCrcValid = crc32(hdr) === Number.parseInt(r.headerCrc.slice(2), 16);
  return r;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseFdt(img, o) {
  const b = readAt(img.fd, o, 40);
  if (b.length < 40) return null;
  const be = b.readUInt32BE.bind(b);
  const r = {
    magic: '0x' + be(0).toString(16),
    totalsize: be(4),
    offDtStruct: be(8),
    offDtStrings: be(12),
    offMemRsvmap: be(16),
    version: be(20),
    lastCompVersion: be(24),
    bootCpu: be(28),
    sizeDtStrings: be(32),
    sizeDtStruct: be(36)
  };
  const isFit = /FIT|U-Boot|fitImage|OpenWrt/i.test(
    readAt(img.fd, o + r.offDtStrings, Math.min(r.sizeDtStrings, 8192)).toString('latin1')
  );
  r.imageType = isFit ? 'FIT image' : 'plain DTB';
  // Pull the strings block and surface the interesting identifiers.
  const strs = readAt(img.fd, o + r.offDtStrings, Math.min(r.sizeDtStrings, 65536)).toString('latin1');
  const toks = strs.split('\0').filter(Boolean);
  r.model    = firstMatch(toks, /^(model|.*\bmodel\b)$/i);
  r.compatible = toks.filter(t => /,/i.test(t) && !/\s/.test(t)).slice(0, 12);
  r.interesting = toks.filter(t =>
    /compatible|model|bootargs|chosen|cpus|clock-frequency|nand|nor|pcie|mediatek|xiaomi|redmi|hnat|ppe|ethernet|memory|serial/i.test(t)
  ).slice(0, 40);
  return r;
}

function firstMatch(arr, re) { return arr.find(x => re.test(x)) ?? null; }

function parseSquashfs(img, o) {
  const b = readAt(img.fd, o, 96);
  if (b.length < 96) return null;
  const magic = b.toString('latin1', 0, 4);
  const le = magic === 'hsqs';
  const u16 = le ? b.readUInt16LE.bind(b) : b.readUInt16BE.bind(b);
  const u32 = le ? b.readUInt32LE.bind(b) : b.readUInt32BE.bind(b);
  const u64 = le ? b.readBigUInt64LE.bind(b) : b.readBigUInt64BE.bind(b);
  // On-disk layout (struct squashfs_super_block), all offsets verified against
  // the kernel header. u64 fields are 8-byte aligned.
  //   0 magic | 4 inodes | 8 mkfs_time | 12 block_size | 16 fragments
  //  20 compression | 22 block_log | 24 flags | 26 no_ids
  //  28 s_major | 30 s_minor | 32 root_inode | 40 bytes_used
  //  48 id_table | 56 xattr_table | 64 inode_table | 72 dir_table
  //  80 frag_table | 88 lookup_table
  const compId = u16(20);
  const blockSize = u32(12);
  const bytesUsed = u64(40);
  return {
    endian: le ? 'little' : 'big',
    version: `${u16(28)}.${u16(30)}`,
    compression: SQFS_COMP[compId] ?? `unknown(${compId})`,
    blockSize,
    blockSizeReadable: human(blockSize),
    blockLog: u16(22),
    uncompressed: !!(u16(24) & 0x0001),
    checkType: (u16(24) & 0x0002) ? 'md5' : 'none',
    fragments: u32(16),
    fragmentTableStart: Number(u64(80)),
    inodes: u32(4),
    noIds: u16(26),
    bytesUsed: Number(bytesUsed),
    bytesUsedReadable: human(Number(bytesUsed)),
    inodeTableStart: Number(u64(64)),
    directoryTableStart: Number(u64(72)),
    mkfsTime: new Date(Number(u32(8)) * 1000).toISOString()
  };
}

function parseGzip(img, o) {
  const b = readAt(img.fd, o, 10);
  if (b.length < 10) return null;
  const FLG = b[3];
  const MTIME = b.readUInt32LE(4);
  return {
    method: b[2] === 8 ? 'deflate' : `unknown(${b[2]})`,
    flags: FLG,
    hasName: !!(FLG & 0x08),
    hasComment: !!(FLG & 0x10),
    xfl: b[8],
    os: b[9],
    mtime: MTIME ? new Date(MTIME * 1000).toISOString() : 'zeroed',
    // If FNAME is set, the original filename follows the 10-byte header.
    origName: (FLG & 0x08)
      ? readAt(img.fd, o + 10, 128).toString('latin1').replace(/\0[\s\S]*$/, '').replace(/[^\x20-\x7e]/g, '')
      : null
  };
}

function parseXiaomi(img, o) {
  // Vendor containers on MT7621 Xiaomi devices vary by model and firmware
  // generation. We do not guess field semantics; we dump the neighbourhood
  // so the report can be interpreted against real bytes.
  const b = readAt(img.fd, o, 512);
  const printable = b.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  return {
    offset: o,
    firstBytes: hex(b.subarray(0, 64)),
    asciiPreview: printable.slice(0, 256),
    le32Candidates: Array.from({ length: 8 }, (_, i) => ({
      at: i * 4, value: '0x' + b.readUInt32LE(i * 4).toString(16)
    })),
    interpretation: 'UNVERIFIED — vendor header layout is model/firmware specific; fields below are candidates only.'
  };
}

/* ------------------------------------------------------------------ *
 * Strings extraction from selected regions
 * ------------------------------------------------------------------ */

function extractStrings(img, offsets, span = 4096, minLen = 6) {
  const out = [];
  for (const o of offsets) {
    const b = readAt(img.fd, Math.max(0, o - 256), span);
    const found = b.toString('latin1').match(/[\x20-\x7e]{6,}/g) || [];
    const keep = found.filter(s =>
      /version|uboot|u-boot|boot|linux|openwrt|xiaomi|redmi|ac2100|mt76|mt75|hnat|ppe|kernel|rootfs|squashfs|ubi|nand|miwifi|build|date|release/i.test(s)
    ).slice(0, 24);
    if (keep.length) out.push({ near: o, strings: [...new Set(keep)] });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Region synthesis
 * ------------------------------------------------------------------ */

const PARSERS = { uimage: parseUImage, fdt: parseFdt, squashfs: parseSquashfs, gzip: parseGzip, xiaomi: parseXiaomi };

function analyze(img, opts) {
  const t0 = Date.now();
  const { hits, counts } = scanMagics(img);
  const entropy = entropyProfile(img, opts.window);

  // Keep only structurally meaningful hits: drop gzip/lzma hits that occur
  // thousands of times inside an already-compressed rootfs, keep the first
  // few plus any that start a plausible region.
  const byName = new Map();
  for (const h of hits) {
    const arr = byName.get(h.sig) || [];
    arr.push(h);
    byName.set(h.sig, arr);
  }

  const notable = [];
  for (const [sig, arr] of byName) {
    const meta = MAGIC.find(m => m.name === sig);
    const take = (meta?.parse || ['squashfs-le', 'fdt-fit', 'uimage'].includes(sig)) ? arr.slice(0, 12) : arr.slice(0, 4);
    for (const h of take) notable.push(h);
  }
  notable.sort((a, b) => a.offset - b.offset);

  // Deep-parse the first occurrence of each parseable signature.
  const parsed = [];
  const seen = new Set();
  for (const h of notable) {
    const meta = MAGIC.find(m => m.name === h.sig);
    if (!meta?.parse) continue;
    const key = `${meta.parse}@${h.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let detail = null;
    try { detail = PARSERS[meta.parse](img, h.offset); }
    catch (e) {
      detail = {
        error: e.message,
        stack: String(e.stack ?? '').split('\n').slice(1, 4).map(s => s.trim()).join(' <- ')
      };
    }
    if (detail) parsed.push({ signature: h.sig, offset: h.offset, type: meta.parse, detail });
  }

  const headerStrings = opts.strings
    ? extractStrings(img, [0, 64, 256, 4096, 0x10000, ...notable.slice(0, 8).map(n => n.offset)])
    : [];

  return {
    file: path.resolve(img.path),
    size: img.size,
    sizeReadable: human(img.size),
    sha256: sha256(img),
    signatureCounts: counts,
    notableOffsets: notable.slice(0, 120),
    parsed,
    entropy,
    strings: headerStrings,
    scannedInMs: Date.now() - t0
  };
}

function sha256(img) {
  // Streaming hash, bounded memory.
  const h = createHash('sha256');
  const CHUNK = 4 * 1024 * 1024;
  for (let p = 0; p < img.size; p += CHUNK) {
    h.update(readAt(img.fd, p, Math.min(CHUNK, img.size - p)));
  }
  return h.digest('hex');
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function report(a) {
  const L = [];
  const bar = '='.repeat(78);
  L.push(bar);
  L.push(`NexRouter fwscan report`);
  L.push(bar);
  L.push(`File        : ${a.file}`);
  L.push(`Size        : ${a.sizeReadable} (${a.size} bytes)`);
  L.push(`SHA-256     : ${a.sha256}`);
  L.push(`Scan time   : ${a.scannedInMs} ms`);
  L.push('');

  L.push('-- Signature census ' + '-'.repeat(59));
  const census = Object.entries(a.signatureCounts).sort((x, y) => y[1] - x[1]);
  if (!census.length) L.push('   (none)');
  for (const [k, v] of census) L.push(`   ${k.padEnd(16)} ${String(v).padStart(7)} occurrence(s)`);
  L.push('');

  L.push('-- Notable structures ' + '-'.repeat(57));
  if (!a.parsed.length) L.push('   (no recognised parseable structures)');
  for (const p of a.parsed) {
    L.push(`   ${off(p.offset)}  ${p.signature}  [${p.type}]`);
    for (const [k, v] of Object.entries(p.detail)) {
      if (k === 'le32Candidates' || k === 'interesting' || k === 'compatible' || k === 'strings') continue;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      L.push(`       ${String(k).padEnd(20)} ${s.slice(0, 160)}`);
    }
    if (p.detail.compatible?.length) {
      L.push(`       compatible         ${p.detail.compatible.join(', ')}`);
    }
    if (p.detail.interesting?.length) {
      L.push(`       dt-strings         ${p.detail.interesting.slice(0, 14).join(' | ')}`);
    }
    L.push('');
  }

  L.push('-- Entropy map ' + '-'.repeat(66));
  L.push('   offset        size       entropy  zeros   classification');
  for (const e of a.entropy) {
    L.push(`   ${off(e.offset)}  ${human(e.size).padStart(9)}   ${e.entropy.toFixed(3).padStart(6)}  ${(e.zeroFraction * 100).toFixed(1).padStart(5)}%  ${e.classify}`);
  }
  L.push('');

  if (a.strings?.length) {
    L.push('-- Header strings ' + '-'.repeat(61));
    for (const s of a.strings) {
      L.push(`   near ${off(s.near)}:`);
      for (const x of s.strings) L.push(`       ${x.slice(0, 140)}`);
    }
    L.push('');
  }

  L.push('-- Interpretation notes ' + '-'.repeat(55));
  for (const n of interpret(a)) L.push(`   • ${n}`);
  L.push('');
  L.push(bar);
  return L.join('\n');
}

function interpret(a) {
  const n = [];
  const has = s => (a.signatureCounts[s] || 0) > 0;

  if (has('fdt-fit')) {
    const fit = a.parsed.find(p => p.type === 'fdt');
    n.push(`Contains a Flattened Device Tree${fit?.detail.imageType ? ' (' + fit.detail.imageType + ')' : ''}. ` +
      `This is how OpenWrt describes the board; the DTS is where partition layout, PCIe WiFi, ` +
      `the MT7530 switch and CPU/DDR clock hints live.`);
    if (fit?.detail.compatible?.length) n.push(`DT compatible strings: ${fit.detail.compatible.slice(0, 6).join(', ')}`);
  }
  if (has('squashfs-le')) {
    const sq = a.parsed.find(p => p.type === 'squashfs');
    if (sq) n.push(`squashfs rootfs at ${off(sq.offset)}, ${sq.detail.bytesUsedReadable} used, ` +
      `${sq.detail.compression} compression, ${sq.detail.inodes} inodes, built ${sq.detail.mkfsTime}. ` +
      `Read-only squashfs + a writable UBI/overlay volume is the standard OpenWrt NAND layout.`);
  }
  if (has('ubi-ec') || has('ubifs-node')) {
    n.push('UBI/UBIFS markers present — consistent with the 128 MiB NAND layout used by the ' +
      'Redmi AC2100, where rootfs and overlay live inside one "ubi" MTD partition.');
  }
  if (has('uimage')) {
    const ui = a.parsed.find(p => p.type === 'uimage');
    if (ui) n.push(`Legacy uImage at ${off(ui.offset)}: ${ui.detail.type} for ${ui.detail.arch}, ` +
      `${ui.detail.comp} compressed, image name "${ui.detail.name}", ` +
      `load ${ui.detail.loadAddr} entry ${ui.detail.entryPoint}. Header CRC valid: ${ui.detail.headerCrcValid}.`);
  }
  if (has('mi-hdr1') || has('mi-miwf') || has('mi-xqimg')) {
    n.push('Xiaomi vendor container marker(s) found. The stock image wraps the payload in a ' +
      'vendor header plus a signature block; field semantics are model- and firmware-specific, ' +
      'so they are reported as raw candidates rather than asserted.');
  }
  const encrypted = a.entropy.filter(e => e.entropy >= 7.95).length;
  const total = a.entropy.length || 1;
  if (encrypted / total > 0.85) {
    n.push(`${((encrypted / total) * 100).toFixed(0)}% of the image has near-maximum entropy. ` +
      `Either the whole payload is compressed (normal for squashfs/xz) or it is encrypted/signed ` +
      `(normal for a vendor stock image). No plaintext filesystem structures would survive either way.`);
  }
  const zeros = a.entropy.filter(e => e.classify === 'erased/empty');
  if (zeros.length) {
    n.push(`${zeros.length} window(s) are all-zero / erased — padding or unused flash reserve.`);
  }
  if (!a.parsed.length) {
    n.push('WARNING: no recognisable container structures. The image is either encrypted, ' +
      'wrapped in an undocumented vendor format, or the scan signature table needs extending.');
  }
  return n;
}

function compareReport(a, b) {
  const L = [];
  L.push('='.repeat(78));
  L.push('NexRouter fwscan — image comparison');
  L.push('='.repeat(78));
  const cols = [a, b];
  L.push(`${''.padEnd(20)}${path.basename(a.file).padEnd(28)}${path.basename(b.file)}`);
  L.push(`${'size'.padEnd(20)}${a.sizeReadable.padEnd(28)}${b.sizeReadable}`);
  L.push(`${'sha256'.padEnd(20)}${a.sha256.slice(0, 24) + '…'.padEnd(28)}${b.sha256.slice(0, 24) + '…'}`);
  const sigs = new Set([...Object.keys(a.signatureCounts), ...Object.keys(b.signatureCounts)]);
  L.push('');
  L.push('signature census:');
  for (const s of [...sigs].sort()) {
    L.push(`   ${s.padEnd(18)}${String(a.signatureCounts[s] || 0).padEnd(28)}${String(b.signatureCounts[s] || 0)}`);
  }
  L.push('');
  L.push('mean entropy:');
  const mean = x => (x.entropy.reduce((s, e) => s + e.entropy, 0) / (x.entropy.length || 1)).toFixed(4);
  L.push(`   ${''.padEnd(18)}${mean(a).padEnd(28)}${mean(b)}`);
  L.push('='.repeat(78));
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.positional.length) { usage(); process.exit(1); }

  const results = [];
  for (const p of opts.positional) {
    if (!fs.existsSync(p)) { console.error(`error: no such file: ${p}`); process.exit(1); }
    const img = openImage(p);
    console.error(`[fwscan] scanning ${path.basename(p)} (${human(img.size)}) …`);
    const a = analyze(img, opts);
    fs.closeSync(img.fd);
    results.push(a);
  }

  let text;
  if (opts.compare && results.length >= 2) text = compareReport(results[0], results[1]);
  else text = results.map(report).join('\n\n');

  console.log(text);

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    console.error(`[fwscan] wrote ${path.resolve(opts.json)}`);
  }

  if (!results.some(r => r.parsed.length)) process.exit(2);
}

main();
