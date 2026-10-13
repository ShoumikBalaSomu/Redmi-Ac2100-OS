/**
 * store.mjs — Append-only JSONL persistence + in-memory aggregation for NexInsight.
 *
 * WHY NOT A DATABASE:
 *   The design goal is zero npm dependencies and maximum portability.
 *   An append-only JSONL file per day is trivially inspectable with `jq`,
 *   `grep`, or any text editor. It requires no database driver, no schema
 *   migration, and works identically on Windows, Linux, macOS, and ARM.
 *   For a home-network flow collector processing hundreds of records per
 *   minute, this is more than sufficient.
 *
 * STORAGE LAYOUT:
 *   data/
 *     flows-2024-11-15.jsonl    ← raw flow records, one JSON object per line
 *     flows-2024-11-16.jsonl
 *     summaries/
 *       hosts-2024-11-15.json   ← compacted per-host daily summaries
 *     models/
 *       isolation-forest.json   ← trained ML model artifacts
 *       classifier.json
 *
 * MEMORY BOUNDING:
 *   The conversation tracker uses an LRU cache capped at MAX_CONVERSATIONS.
 *   A busy home network with 30 devices might generate 5,000-20,000 unique
 *   5-tuple conversations per day. We default to 50,000 entries (~30 MB)
 *   which covers several days of typical home traffic. When the cap is hit,
 *   the least-recently-updated conversation is evicted. This prevents
 *   unbounded memory growth during long-running collection sessions.
 *
 * RETENTION:
 *   Raw JSONL files older than `retentionDays` are eligible for compaction.
 *   After compaction, the raw file can be deleted (or kept — configurable).
 *   Default retention: 30 days of raw data, indefinite for summaries.
 */

import { createWriteStream, createReadStream, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(process.cwd(), 'data');
const DEFAULT_RETENTION_DAYS = 30;
const MAX_CONVERSATIONS = 50_000; // LRU cap — see comment above
const MAX_HOSTS = 10_000;         // Per-host aggregator cap

// ─── LRU Map ─────────────────────────────────────────────────────────────────

/**
 * Minimal LRU map with O(1) get/set/evict.
 * Uses a JS Map which maintains insertion order; on access we delete+re-insert
 * to move the entry to the end (most recent). Eviction removes from the front.
 *
 * @template K, V
 */
class LRUCache {
  /** @param {number} maxSize */
  constructor(maxSize) {
    this.maxSize = maxSize;
    /** @type {Map<K, V>} */
    this.map = new Map();
  }

  /** @param {K} key @returns {V|undefined} */
  get(key) {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  /** @param {K} key @param {V} value */
  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  /** @param {K} key @returns {boolean} */
  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }

  /** Iterate all values */
  values() {
    return this.map.values();
  }

  /** Iterate all entries */
  entries() {
    return this.map.entries();
  }

  clear() {
    this.map.clear();
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class FlowStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir] - Directory for JSONL files
   * @param {number} [opts.retentionDays] - Days to keep raw JSONL
   * @param {number} [opts.maxConversations] - LRU cap for conversation state
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || DEFAULT_DATA_DIR;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxConversations = opts.maxConversations ?? MAX_CONVERSATIONS;

    // Ensure directories exist
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(join(this.dataDir, 'summaries'), { recursive: true });
    mkdirSync(join(this.dataDir, 'models'), { recursive: true });

    // In-memory aggregators
    /** @type {Map<string, object>} Per-host counters keyed by IP (or MAC if available) */
    this.hosts = new Map();

    /** @type {LRUCache<string, object>} Per-conversation (5-tuple) counters */
    this.conversations = new LRUCache(this.maxConversations);

    // Current day's write stream
    this._currentDay = null;
    this._stream = null;

    // Stats
    this.stats = {
      totalFlowsReceived: 0,
      totalBytesObserved: 0,
      malformedDatagrams: 0,
      startTime: new Date().toISOString(),
    };
  }

  // ── JSONL Writing ────────────────────────────────────────────────────────

  /**
   * Get or create the write stream for today's JSONL file.
   * Handles daily rotation automatically.
   */
  _getStream() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (this._currentDay !== today) {
      // Close previous stream
      if (this._stream) {
        this._stream.end();
      }
      this._currentDay = today;
      const filePath = join(this.dataDir, `flows-${today}.jsonl`);
      this._stream = createWriteStream(filePath, { flags: 'a' });
      this._stream.on('error', (err) => {
        console.error(`[store] Write stream error: ${err.message}`);
      });
    }
    return this._stream;
  }

  /**
   * Append a parsed flow record to today's JSONL file and update aggregators.
   * @param {object} record - Parsed NetFlow v5 record (from netflow.mjs)
   */
  ingest(record) {
    this.stats.totalFlowsReceived++;
    this.stats.totalBytesObserved += record.dOctets;

    // Write to JSONL
    const stream = this._getStream();
    const line = JSON.stringify({
      ts: record.firstAbsolute,
      src: record.srcaddr,
      dst: record.dstaddr,
      sport: record.srcport,
      dport: record.dstport,
      proto: record.prot,
      pkts: record.dPkts,
      bytes: record.dOctets,
      flags: record.tcp_flags,
      tos: record.tos,
    }) + '\n';
    stream.write(line);

    // Update aggregators
    this._updateHostAgg(record.srcaddr, record, 'out');
    this._updateHostAgg(record.dstaddr, record, 'in');
    this._updateConversationAgg(record);
  }

  // ── Host Aggregation ─────────────────────────────────────────────────────

  /**
   * Update per-host aggregate counters.
   * Tracks: bytes/packets in each direction, connection count, first/last seen,
   * port histogram (top-N), protocol histogram.
   */
  _updateHostAgg(ip, record, direction) {
    let host = this.hosts.get(ip);
    if (!host) {
      if (this.hosts.size >= MAX_HOSTS) {
        // Evict oldest host by lastSeen
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of this.hosts) {
          if (v.lastSeen < oldestTime) {
            oldestTime = v.lastSeen;
            oldestKey = k;
          }
        }
        if (oldestKey) this.hosts.delete(oldestKey);
      }
      host = {
        ip,
        bytesIn: 0,
        bytesOut: 0,
        pktsIn: 0,
        pktsOut: 0,
        connections: 0,
        firstSeen: record.firstAbsolute,
        lastSeen: record.lastAbsolute,
        portHistogram: {},   // port → count
        protoHistogram: {},  // protocol → count
      };
      this.hosts.set(ip, host);
    }

    if (direction === 'in') {
      host.bytesIn += record.dOctets;
      host.pktsIn += record.dPkts;
    } else {
      host.bytesOut += record.dOctets;
      host.pktsOut += record.dPkts;
    }
    host.connections++;
    host.lastSeen = record.lastAbsolute;

    // Port histogram (destination port for outbound, source port for inbound)
    const port = direction === 'out' ? record.dstport : record.srcport;
    if (port > 0) {
      host.portHistogram[port] = (host.portHistogram[port] || 0) + 1;
    }

    // Protocol histogram
    const protoName = PROTO_NAMES[record.prot] || `proto-${record.prot}`;
    host.protoHistogram[protoName] = (host.protoHistogram[protoName] || 0) + 1;
  }

  // ── Conversation Aggregation ─────────────────────────────────────────────

  /**
   * Update per-conversation (5-tuple) counters.
   * Key: "srcip:srcport→dstip:dstport/proto"
   */
  _updateConversationAgg(record) {
    const key = `${record.srcaddr}:${record.srcport}→${record.dstaddr}:${record.dstport}/${record.prot}`;

    let conv = this.conversations.get(key);
    if (!conv) {
      conv = {
        key,
        srcaddr: record.srcaddr,
        dstaddr: record.dstaddr,
        srcport: record.srcport,
        dstport: record.dstport,
        prot: record.prot,
        bytesFwd: 0,
        pktsFwd: 0,
        bytesRev: 0,
        pktsRev: 0,
        connections: 0,
        firstSeen: record.firstAbsolute,
        lastSeen: record.lastAbsolute,
      };
      this.conversations.set(key, conv);
    }

    conv.bytesFwd += record.dOctets;
    conv.pktsFwd += record.dPkts;
    conv.connections++;
    conv.lastSeen = record.lastAbsolute;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Get all host summaries as an array */
  getHosts() {
    return Array.from(this.hosts.values());
  }

  /** Get all conversation summaries as an array */
  getConversations() {
    return Array.from(this.conversations.values());
  }

  /** Get overall stats */
  getStats() {
    return {
      ...this.stats,
      activeHosts: this.hosts.size,
      activeConversations: this.conversations.size,
      maxConversations: this.maxConversations,
    };
  }

  // ── Compaction ───────────────────────────────────────────────────────────

  /**
   * Compact a day's JSONL into a per-host daily summary.
   * Reads the raw file, aggregates by host, writes a summary JSON,
   * and optionally deletes the raw file.
   *
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @param {boolean} [deleteRaw=false] - Whether to delete the raw JSONL after
   */
  async compact(dateStr, deleteRaw = false) {
    const rawPath = join(this.dataDir, `flows-${dateStr}.jsonl`);
    const summaryPath = join(this.dataDir, 'summaries', `hosts-${dateStr}.json`);

    if (!existsSync(rawPath)) {
      console.log(`[compact] No raw file for ${dateStr}`);
      return null;
    }

    // Read and aggregate
    const hostSummary = {};
    const rl = createInterface({
      input: createReadStream(rawPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const src = rec.src;
        const dst = rec.dst;

        // Aggregate source host
        if (!hostSummary[src]) {
          hostSummary[src] = { ip: src, bytesOut: 0, pktsOut: 0, bytesIn: 0, pktsIn: 0, connections: 0, ports: {}, protos: {} };
        }
        hostSummary[src].bytesOut += rec.bytes;
        hostSummary[src].pktsOut += rec.pkts;
        hostSummary[src].connections++;
        const dport = rec.dport;
        if (dport > 0) hostSummary[src].ports[dport] = (hostSummary[src].ports[dport] || 0) + 1;
        const proto = PROTO_NAMES[rec.proto] || `proto-${rec.proto}`;
        hostSummary[src].protos[proto] = (hostSummary[src].protos[proto] || 0) + 1;

        // Aggregate destination host
        if (!hostSummary[dst]) {
          hostSummary[dst] = { ip: dst, bytesOut: 0, pktsOut: 0, bytesIn: 0, pktsIn: 0, connections: 0, ports: {}, protos: {} };
        }
        hostSummary[dst].bytesIn += rec.bytes;
        hostSummary[dst].pktsIn += rec.pkts;
      } catch {
        // Skip malformed lines
      }
    }

    // Write summary
    const summary = {
      date: dateStr,
      generatedAt: new Date().toISOString(),
      hostCount: Object.keys(hostSummary).length,
      hosts: hostSummary,
    };

    const { writeFileSync } = await import('node:fs');
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[compact] Wrote summary for ${dateStr}: ${summary.hostCount} hosts → ${summaryPath}`);

    if (deleteRaw) {
      unlinkSync(rawPath);
      console.log(`[compact] Deleted raw file: ${rawPath}`);
    }

    return summary;
  }

  /**
   * Run retention policy: compact and optionally prune old raw files.
   */
  async enforceRetention(deleteRaw = false) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = readdirSync(this.dataDir).filter(f => f.startsWith('flows-') && f.endsWith('.jsonl'));
    for (const file of files) {
      const dateStr = file.replace('flows-', '').replace('.jsonl', '');
      if (dateStr < cutoffStr) {
        console.log(`[retention] ${file} is older than ${this.retentionDays} days`);
        await this.compact(dateStr, deleteRaw);
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Flush and close the current write stream */
  /**
   * Durably close today's JSONL stream.
   *
   * This MUST be awaited. `createWriteStream()` opens the underlying file
   * asynchronously, and `end()` only *schedules* the final flush — so a
   * synchronous-looking flush() that returns immediately leaves buffered
   * records unwritten. On a SIGTERM shutdown that is silent data loss, and in
   * a test it is a race against the assertion that follows.
   *
   * Resolves once the 'close' event has fired, i.e. the file descriptor is
   * released and every queued write has been handed to the OS.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    const stream = this._stream;
    this._stream = null;
    this._currentDay = null;

    if (!stream) return;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) { settled = true; resolve(); }
      };
      stream.once('close', done);
      stream.once('error', (err) => {
        console.error(`[store] flush error: ${err.message}`);
        done();
      });
      stream.end(done);
    });
  }

  /**
   * Load historical JSONL files into the in-memory aggregators.
   * Called on startup to restore state.
   */
  async loadHistory(daysBack = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = readdirSync(this.dataDir)
      .filter(f => f.startsWith('flows-') && f.endsWith('.jsonl'))
      .sort()
      .filter(f => {
        const dateStr = f.replace('flows-', '').replace('.jsonl', '');
        return dateStr >= cutoffStr;
      });

    let loadedRecords = 0;
    for (const file of files) {
      const filePath = join(this.dataDir, file);
      const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          // Reconstruct a minimal record shape for aggregation
          this._updateHostAgg(rec.src, {
            srcaddr: rec.src,
            dstaddr: rec.dst,
            srcport: rec.sport,
            dstport: rec.dport,
            prot: rec.proto,
            dPkts: rec.pkts,
            dOctets: rec.bytes,
            tcp_flags: rec.flags || 0,
            tos: rec.tos || 0,
            firstAbsolute: rec.ts,
            lastAbsolute: rec.ts,
          }, 'out');
          this._updateHostAgg(rec.dst, {
            srcaddr: rec.src,
            dstaddr: rec.dst,
            srcport: rec.sport,
            dstport: rec.dport,
            prot: rec.proto,
            dPkts: rec.pkts,
            dOctets: rec.bytes,
            tcp_flags: rec.flags || 0,
            tos: rec.tos || 0,
            firstAbsolute: rec.ts,
            lastAbsolute: rec.ts,
          }, 'in');
          this._updateConversationAgg({
            srcaddr: rec.src,
            dstaddr: rec.dst,
            srcport: rec.sport,
            dstport: rec.dport,
            prot: rec.proto,
            dPkts: rec.pkts,
            dOctets: rec.bytes,
            firstAbsolute: rec.ts,
            lastAbsolute: rec.ts,
          });
          loadedRecords++;
        } catch {
          // Skip malformed lines
        }
      }
    }

    console.log(`[store] Loaded ${loadedRecords} records from ${files.length} file(s)`);
    return loadedRecords;
  }
}

// ─── Protocol Name Lookup ────────────────────────────────────────────────────

const PROTO_NAMES = {
  1: 'ICMP',
  6: 'TCP',
  17: 'UDP',
  47: 'GRE',
  50: 'ESP',
  51: 'AH',
  58: 'ICMPv6',
  89: 'OSPF',
  132: 'SCTP',
};

export { LRUCache, PROTO_NAMES };
