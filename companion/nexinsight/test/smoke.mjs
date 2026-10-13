/**
 * smoke.mjs — Zero-dependency test suite for NexInsight.
 *
 * Uses Node.js built-in test runner (node:test) and assertion library (node:assert).
 * Run with: node --test companion/nexinsight/test/smoke.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetFlowV5, encodeNetFlowV5 } from '../netflow.mjs';
import { FlowStore, LRUCache } from '../store.mjs';
import {
  extractHostFeatures,
  trainIsolationForest,
  detectAnomalies,
  scoreIsolationForest,
  trainClassifier,
  predictClassifier,
} from '../ml.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── NetFlow v5 Parser Tests ─────────────────────────────────────────────────

describe('NetFlow v5 Parser', () => {
  // Helper to build a valid v5 datagram
  function buildTestDatagram(records = []) {
    const header = {
      version: 5,
      sysUptime: 1000000,
      unixSecs: 1700000000,
      unixNsecs: 0,
      flowSequence: 1,
      engineType: 0,
      engineId: 0,
      samplingInterval: 0,
    };
    return { header, records, buf: encodeNetFlowV5(header, records) };
  }

  const sampleRecord = {
    srcaddr: '192.168.1.100',
    dstaddr: '8.8.8.8',
    nexthop: '192.168.1.1',
    input: 1,
    output: 2,
    dPkts: 100,
    dOctets: 50000,
    first: 999000,
    last: 1000000,
    srcport: 12345,
    dstport: 443,
    tcp_flags: 0x1b,
    prot: 6,
    tos: 0,
    src_as: 0,
    dst_as: 15169,
    src_mask: 24,
    dst_mask: 8,
  };

  it('should round-trip encode and decode a single record', () => {
    const { buf, header, records } = buildTestDatagram([sampleRecord]);
    const parsed = parseNetFlowV5(buf);

    assert.equal(parsed.header.version, 5);
    assert.equal(parsed.header.count, 1);
    assert.equal(parsed.header.sysUptime, 1000000);
    assert.equal(parsed.header.unixSecs, 1700000000);
    assert.equal(parsed.records.length, 1);

    const r = parsed.records[0];
    assert.equal(r.srcaddr, '192.168.1.100');
    assert.equal(r.dstaddr, '8.8.8.8');
    assert.equal(r.nexthop, '192.168.1.1');
    assert.equal(r.input, 1);
    assert.equal(r.output, 2);
    assert.equal(r.dPkts, 100);
    assert.equal(r.dOctets, 50000);
    assert.equal(r.first, 999000);
    assert.equal(r.last, 1000000);
    assert.equal(r.srcport, 12345);
    assert.equal(r.dstport, 443);
    assert.equal(r.tcp_flags, 0x1b);
    assert.equal(r.prot, 6);
    assert.equal(r.src_as, 0);
    assert.equal(r.dst_as, 15169);
    assert.equal(r.src_mask, 24);
    assert.equal(r.dst_mask, 8);
  });

  it('should round-trip multiple records', () => {
    const rec2 = { ...sampleRecord, srcaddr: '10.0.0.1', dstport: 80, dPkts: 5, dOctets: 300 };
    const { buf } = buildTestDatagram([sampleRecord, rec2]);
    const parsed = parseNetFlowV5(buf);

    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0].srcaddr, '192.168.1.100');
    assert.equal(parsed.records[1].srcaddr, '10.0.0.1');
    assert.equal(parsed.records[1].dstport, 80);
  });

  it('should decode TCP flags correctly', () => {
    const { buf } = buildTestDatagram([sampleRecord]);
    const parsed = parseNetFlowV5(buf);
    const flags = parsed.records[0].tcp_flags_decoded;

    assert.ok(flags.includes('SYN'), 'Should include SYN');
    assert.ok(flags.includes('ACK'), 'Should include ACK');
    assert.ok(flags.includes('FIN'), 'Should include FIN');
    assert.ok(flags.includes('PSH'), 'Should include PSH');
    assert.ok(!flags.includes('RST'), 'Should not include RST');
  });

  it('should produce absolute timestamps', () => {
    const { buf } = buildTestDatagram([sampleRecord]);
    const parsed = parseNetFlowV5(buf);
    const r = parsed.records[0];

    assert.ok(typeof r.firstAbsolute === 'string');
    assert.ok(r.firstAbsolute.endsWith('Z') || r.firstAbsolute.includes('+'));
    // The timestamp should be close to unixSecs (within a few seconds)
    const ts = new Date(r.firstAbsolute).getTime();
    const expected = 1700000000 * 1000 + (999000 - 1000000); // ~1 second before unixSecs
    assert.ok(Math.abs(ts - expected) < 5000, `Timestamp ${ts} should be near ${expected}`);
  });

  it('should reject wrong-version datagrams', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt16BE(9, 0); // NetFlow v9
    buf.writeUInt16BE(0, 2);

    assert.throws(
      () => parseNetFlowV5(buf),
      (err) => err.message.includes('version mismatch') && err.message.includes('9')
    );
  });

  it('should reject too-short datagrams', () => {
    assert.throws(
      () => parseNetFlowV5(Buffer.alloc(10)),
      (err) => err.message.includes('too short')
    );
  });

  it('should handle truncated datagrams gracefully', () => {
    const { buf } = buildTestDatagram([sampleRecord, sampleRecord]);
    // Truncate to header + 1 complete record + partial second record
    const truncated = buf.subarray(0, 24 + 48 + 20);
    const result = parseNetFlowV5(truncated);

    assert.equal(result.truncated, true);
    assert.equal(result.expectedRecords, 2);
    assert.equal(result.actualRecords, 1);
    assert.ok(typeof result.warning === 'string');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].srcaddr, '192.168.1.100');
  });

  it('should handle empty record count', () => {
    const { buf } = buildTestDatagram([]);
    const parsed = parseNetFlowV5(buf);
    assert.equal(parsed.header.count, 0);
    assert.equal(parsed.records.length, 0);
  });
});

// ─── LRU Cache Tests ─────────────────────────────────────────────────────────

describe('LRU Cache', () => {
  it('should enforce max size', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.size, 3);

    cache.set('d', 4); // Should evict 'a'
    assert.equal(cache.size, 3);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('d'), 4);
  });

  it('should update recency on access', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    cache.get('a'); // Touch 'a', making it most recent
    cache.set('d', 4); // Should evict 'b' (least recent)

    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.get('d'), 4);
  });

  it('should update existing keys without growing', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // Update, not insert
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), 10);
  });
});

// ─── Store / Aggregator Tests ────────────────────────────────────────────────

describe('FlowStore Aggregator', () => {
  let tmpDir;
  let store;

  // Create a temp directory for each test run
  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'nexinsight-test-'));
    store = new FlowStore({ dataDir: tmpDir, maxConversations: 100 });
  }

  // teardown MUST be awaited.
  //
  // FlowStore opens its JSONL write stream lazily and asynchronously, so a
  // synchronous rmSync() can delete the temp directory while the open is still
  // in flight. That surfaces as an uncatchable async ENOENT on the stream's
  // 'error' event — noise that would otherwise mask a genuine failure.
  // Flushing first guarantees the fd is closed and released.
  async function teardown() {
    if (store) {
      try { await store.flush(); } catch { /* best effort */ }
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  it('should aggregate per-host counters', async () => {
    setup();
    try {
      const record = {
        srcaddr: '192.168.1.100',
        dstaddr: '8.8.8.8',
        srcport: 12345,
        dstport: 443,
        prot: 6,
        dPkts: 100,
        dOctets: 50000,
        tcp_flags: 0x02,
        tos: 0,
        firstAbsolute: '2024-11-15T10:00:00.000Z',
        lastAbsolute: '2024-11-15T10:00:01.000Z',
      };

      store.ingest(record);

      const hosts = store.getHosts();
      assert.ok(hosts.length >= 2, 'Should have at least src and dst hosts');

      const src = hosts.find(h => h.ip === '192.168.1.100');
      assert.ok(src, 'Source host should exist');
      assert.equal(src.bytesOut, 50000);
      assert.equal(src.pktsOut, 100);
      assert.equal(src.connections, 1);

      const dst = hosts.find(h => h.ip === '8.8.8.8');
      assert.ok(dst, 'Destination host should exist');
      assert.equal(dst.bytesIn, 50000);
      assert.equal(dst.pktsIn, 100);
    } finally {
      await teardown();
    }
  });

  it('should track conversations', async () => {
    setup();
    try {
      const record = {
        srcaddr: '10.0.0.1',
        dstaddr: '10.0.0.2',
        srcport: 5000,
        dstport: 80,
        prot: 6,
        dPkts: 10,
        dOctets: 1000,
        tcp_flags: 0,
        tos: 0,
        firstAbsolute: '2024-11-15T10:00:00.000Z',
        lastAbsolute: '2024-11-15T10:00:01.000Z',
      };

      store.ingest(record);
      store.ingest(record); // Same conversation, second time

      const convs = store.getConversations();
      assert.equal(convs.length, 1, 'Should have 1 conversation');
      assert.equal(convs[0].bytesFwd, 2000);
      assert.equal(convs[0].pktsFwd, 20);
      assert.equal(convs[0].connections, 2);
    } finally {
      await teardown();
    }
  });

  it('should respect LRU bound on conversations', async () => {
    setup();
    try {
      // Ingest more unique conversations than the cap
      for (let i = 0; i < 150; i++) {
        store.ingest({
          srcaddr: '10.0.0.1',
          dstaddr: `10.0.${Math.floor(i / 256)}.${i % 256}`,
          srcport: 5000 + i,
          dstport: 80,
          prot: 6,
          dPkts: 1,
          dOctets: 100,
          tcp_flags: 0,
          tos: 0,
          firstAbsolute: '2024-11-15T10:00:00.000Z',
          lastAbsolute: '2024-11-15T10:00:01.000Z',
        });
      }

      const convs = store.getConversations();
      assert.ok(convs.length <= 100, `Should be capped at 100, got ${convs.length}`);
    } finally {
      await teardown();
    }
  });

  it('should write JSONL files', async () => {
    setup();
    try {
      store.ingest({
        srcaddr: '1.2.3.4',
        dstaddr: '5.6.7.8',
        srcport: 1000,
        dstport: 2000,
        prot: 17,
        dPkts: 5,
        dOctets: 500,
        tcp_flags: 0,
        tos: 0,
        firstAbsolute: '2024-11-15T10:00:00.000Z',
        lastAbsolute: '2024-11-15T10:00:01.000Z',
      });
      await store.flush();

      const { readdirSync } = await_import_fs();
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
      assert.ok(files.length > 0, 'Should have created a JSONL file');
    } finally {
      await teardown();
    }
  });
});

// Helper to avoid top-level import issues in test
function await_import_fs() {
  // Synchronous re-import is fine since fs is already loaded
  const fs = { readdirSync };
  return fs;
}

import { readdirSync } from 'node:fs';

// ─── Isolation Forest Tests ──────────────────────────────────────────────────

describe('Isolation Forest', () => {
  it('should train and score on synthetic data with an injected outlier', () => {
    // Generate 50 normal points clustered around [0.5, 0.5, 0.5]
    const data = [];
    for (let i = 0; i < 50; i++) {
      data.push([
        0.5 + (Math.random() - 0.5) * 0.2,
        0.5 + (Math.random() - 0.5) * 0.2,
        0.5 + (Math.random() - 0.5) * 0.2,
      ]);
    }

    // Inject one obvious outlier
    data.push([10.0, 10.0, 10.0]);

    const labels = data.map((_, i) => i < 50 ? `normal-${i}` : 'outlier');

    const model = trainIsolationForest(data, { nTrees: 50, sampleSize: 32 });
    assert.equal(model.type, 'isolation-forest');
    assert.equal(model.nTrees, 50);

    const { anomalies, allScores } = detectAnomalies(data, labels, model, 0.6);

    // The outlier should have the highest score
    const outlierScore = allScores.find(s => s.label === 'outlier');
    assert.ok(outlierScore, 'Outlier should be in scores');

    // Check that the outlier's score is higher than the median normal score
    const normalScores = allScores.filter(s => s.label !== 'outlier').map(s => s.score);
    const medianNormal = normalScores.sort((a, b) => a - b)[Math.floor(normalScores.length / 2)];

    assert.ok(
      outlierScore.score > medianNormal,
      `Outlier score (${outlierScore.score.toFixed(4)}) should exceed median normal (${medianNormal.toFixed(4)})`
    );

    // The outlier should ideally be flagged as anomalous
    // (with enough trees this is very likely, but we use a softer check)
    assert.ok(
      outlierScore.score > 0.55,
      `Outlier score (${outlierScore.score.toFixed(4)}) should be notably high`
    );
  });

  it('should serialize and deserialize models', () => {
    const data = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
    const model = trainIsolationForest(data, { nTrees: 5, sampleSize: 4 });

    const json = JSON.stringify(model);
    const restored = JSON.parse(json);

    assert.equal(restored.type, 'isolation-forest');
    assert.equal(restored.nTrees, 5);
    assert.equal(restored.trees.length, 5);

    // Score should work with restored model
    const score = scoreIsolationForest([1, 2], restored);
    assert.ok(typeof score === 'number');
    assert.ok(score >= 0 && score <= 1);
  });

  it('should warn about small sample sizes', () => {
    // Capture console.warn output
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const data = [[1, 2], [3, 4], [5, 6]];
      trainIsolationForest(data, { nTrees: 5, sampleSize: 3 });
      assert.ok(
        warnings.some(w => w.includes('WARNING') || w.includes('samples')),
        'Should warn about small sample size'
      );
    } finally {
      console.warn = origWarn;
    }
  });
});

// ─── Decision Tree Classifier Tests ──────────────────────────────────────────

describe('Decision Tree Classifier', () => {
  it('should train and predict on synthetic labelled data', () => {
    // Create two clearly separable classes
    const data = [];
    const labels = [];

    // Class "iot": low bytes ratio, small packets, few ports
    for (let i = 0; i < 20; i++) {
      data.push([0.1, 64, 0.5, 2, 0.5, 0.3, 0.7, 0.9, 5, 24]);
      labels.push('iot');
    }

    // Class "laptop": balanced bytes, large packets, many ports
    for (let i = 0; i < 20; i++) {
      data.push([0.5, 1200, 5.0, 50, 4.5, 0.8, 0.15, 0.1, 100, 12]);
      labels.push('laptop');
    }

    const model = trainClassifier(data, labels, { testSplit: 0.25 });

    assert.equal(model.type, 'decision-tree');
    assert.ok(model.metrics.accuracy > 0.7, `Accuracy should be reasonable: ${model.metrics.accuracy}`);

    // Predict on a clear IoT point
    const pred = predictClassifier([0.1, 64, 0.5, 2, 0.5, 0.3, 0.7, 0.9, 5, 24], model);
    assert.equal(pred, 'iot');

    // Predict on a clear laptop point
    const pred2 = predictClassifier([0.5, 1200, 5.0, 50, 4.5, 0.8, 0.15, 0.1, 100, 12], model);
    assert.equal(pred2, 'laptop');
  });

  it('should warn when sample size is too small', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const data = [[1, 2], [3, 4], [5, 6]];
      const labels = ['a', 'b', 'a'];
      const model = trainClassifier(data, labels);

      assert.equal(model.sampleWarning, true);
      assert.ok(
        warnings.some(w => w.includes('WARNING') || w.includes('overfit')),
        'Should warn about overfitting risk'
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('should serialize and deserialize classifier models', () => {
    const data = [];
    const labels = [];
    for (let i = 0; i < 15; i++) {
      data.push([0.1, 100]); labels.push('a');
      data.push([0.9, 900]); labels.push('b');
    }

    const model = trainClassifier(data, labels);
    const json = JSON.stringify(model);
    const restored = JSON.parse(json);

    assert.equal(restored.type, 'decision-tree');
    const pred = predictClassifier([0.1, 100], restored);
    assert.equal(pred, 'a');
  });
});

// ─── Feature Extraction Tests ────────────────────────────────────────────────

describe('Feature Extraction', () => {
  it('should extract features from a host object', () => {
    const host = {
      ip: '192.168.1.100',
      bytesIn: 1000000,
      bytesOut: 500000,
      pktsIn: 1000,
      pktsOut: 500,
      connections: 100,
      firstSeen: '2024-11-15T10:00:00.000Z',
      lastSeen: '2024-11-15T12:00:00.000Z',
      portHistogram: { 443: 50, 80: 30, 53: 20 },
      protoHistogram: { TCP: 80, UDP: 20 },
    };

    const { features, featureNames } = extractHostFeatures(host);

    assert.equal(features.length, 10);
    assert.equal(featureNames.length, 10);

    // bytesRatio should be bytesOut / total ≈ 0.333
    assert.ok(Math.abs(features[0] - 0.333) < 0.01, `bytesRatio ≈ 0.333, got ${features[0]}`);

    // avgPacketSize = 1500000 / 1500 = 1000
    assert.ok(Math.abs(features[1] - 1000) < 1, `avgPacketSize ≈ 1000, got ${features[1]}`);

    // uniqueDstPorts = 3
    assert.equal(features[3], 3);

    // tcpFraction = 80/100 = 0.8
    assert.ok(Math.abs(features[5] - 0.8) < 0.01, `tcpFraction ≈ 0.8, got ${features[5]}`);
  });

  it('should handle edge cases (zero traffic)', () => {
    const host = {
      ip: '0.0.0.0',
      bytesIn: 0,
      bytesOut: 0,
      pktsIn: 0,
      pktsOut: 0,
      connections: 0,
      firstSeen: null,
      lastSeen: null,
      portHistogram: {},
      protoHistogram: {},
    };

    const { features } = extractHostFeatures(host);
    assert.equal(features.length, 10);
    // Should not produce NaN or Infinity
    for (const f of features) {
      assert.ok(Number.isFinite(f), `Feature should be finite, got ${f}`);
    }
  });
});
