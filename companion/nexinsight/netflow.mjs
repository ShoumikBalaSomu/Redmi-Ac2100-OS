/**
 * netflow.mjs — Dependency-free NetFlow v5 parser for NexInsight.
 *
 * WHY THIS MATTERS:
 *   The router (Xiaomi Redmi AC2100, MT7621 MIPS) exports flow records via
 *   softflowd using NetFlow v5 over UDP. This parser is the ingestion point
 *   for all traffic metadata that feeds the off-router ML pipeline. If this
 *   parser is wrong, every downstream analysis is garbage.
 *
 * NETFLOW V5 WIRE FORMAT (all fields BIG-ENDIAN / network byte order):
 *
 *   Header (24 bytes):
 *     Offset  Size  Field
 *     0       2     version        (must be 5)
 *     2       2     count          (number of flow records in this datagram)
 *     4       4     sysUptime      (ms since device boot)
 *     8       4     unix_secs      (seconds since epoch)
 *     12      4     unix_nsecs     (residual nanoseconds)
 *     16      4     flow_sequence  (cumulative flow counter)
 *     20      1     engine_type    (routing engine type)
 *     21      1     engine_id      (routing engine ID)
 *     22      2     sampling_interval (sampling mode + interval)
 *
 *   Each Record (48 bytes):
 *     Offset  Size  Field
 *     0       4     srcaddr        (source IPv4 address)
 *     4       4     dstaddr        (destination IPv4 address)
 *     8       4     nexthop        (next-hop router IPv4)
 *     12      2     input          (SNMP index of input interface)
 *     14      2     output         (SNMP index of output interface)
 *     16      4     dPkts          (packets in flow)
 *     20      4     dOctets        (bytes in flow)
 *     24      4     first          (sysUptime at start of flow, ms)
 *     28      4     last           (sysUptime at end of flow, ms)
 *     32      2     srcport        (source port / ICMP type+code)
 *     34      2     dstport        (destination port / ICMP type+code)
 *     36      1     pad1           (unused)
 *     37      1     tcp_flags      (OR of all TCP flags seen)
 *     38      1     prot           (IP protocol number)
 *     39      1     tos            (Type of Service)
 *     40      2     src_as         (source AS number)
 *     42      2     dst_as         (destination AS number)
 *     44      1     src_mask       (source prefix length)
 *     45      1     dst_mask       (destination prefix length)
 *     46      2     pad2           (unused)
 *
 * PRIVACY NOTE:
 *   Flow records contain IP addresses, ports, byte counts and timing.
 *   This is traffic metadata — it reveals who talked to whom, when, and
 *   how much. It does NOT contain payload content. Nevertheless, this
 *   data must stay on the user's own machine or LAN. NexInsight never
 *   transmits anything externally.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const HEADER_SIZE = 24;
const RECORD_SIZE = 48;
const NETFLOW_V5 = 5;

// TCP flag bit masks (RFC 793)
const TCP_FLAGS = {
  0x01: 'FIN',
  0x02: 'SYN',
  0x04: 'RST',
  0x08: 'PSH',
  0x10: 'ACK',
  0x20: 'URG',
  0x40: 'ECE',
  0x80: 'CWR',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a 4-byte big-endian IPv4 address to dotted-quad string.
 * @param {Buffer} buf - Buffer containing the full datagram
 * @param {number} offset - Byte offset of the 4-byte IP
 * @returns {string} e.g. "192.168.1.1"
 */
function ipToString(buf, offset) {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

/**
 * Decode TCP flags byte into a human-readable set.
 * @param {number} flags - Single byte with OR'd TCP flag bits
 * @returns {string[]} Array of flag names, e.g. ["SYN", "ACK"]
 */
function decodeTcpFlags(flags) {
  const result = [];
  for (const [bit, name] of Object.entries(TCP_FLAGS)) {
    if (flags & Number(bit)) {
      result.push(name);
    }
  }
  return result;
}

/**
 * Convert a 4-byte big-endian unsigned integer from a Buffer.
 */
function readU32(buf, offset) {
  return buf.readUInt32BE(offset);
}

/**
 * Convert a 2-byte big-endian unsigned integer from a Buffer.
 */
function readU16(buf, offset) {
  return buf.readUInt16BE(offset);
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a raw NetFlow v5 UDP datagram.
 *
 * @param {Buffer} buf - Raw UDP payload
 * @returns {{ header: object, records: object[] }}
 * @throws {Error} If version != 5 or datagram is structurally invalid
 *
 * DESIGN DECISIONS:
 *   - We REJECT non-v5 datagrams with a clear error rather than silently
 *     mis-parsing. Softflowd on OpenWrt sends v5, but if someone points
 *     a v9 exporter at us we want to know immediately.
 *   - Truncated datagrams are reported with as many complete records as
 *     possible plus a warning field, rather than crashing. UDP is lossy
 *     and routers under load may send partial datagrams.
 *   - Timestamps are converted from sysUptime-relative to absolute
 *     ISO 8601 strings using the header's unix_secs/unix_nsec fields.
 */
export function parseNetFlowV5(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) {
    throw new Error(
      `NetFlow v5 parse error: datagram too short (${buf?.length ?? 0} bytes, need >= ${HEADER_SIZE})`
    );
  }

  // ── Validate version ───────────────────────────────────────────────────
  const version = readU16(buf, 0);
  if (version !== NETFLOW_V5) {
    throw new Error(
      `NetFlow version mismatch: expected ${NETFLOW_V5}, got ${version}. ` +
      `This parser only handles NetFlow v5. Check your softflowd configuration.`
    );
  }

  // ── Parse header ───────────────────────────────────────────────────────
  const count = readU16(buf, 2);
  const sysUptime = readU32(buf, 4);
  const unixSecs = readU32(buf, 8);
  const unixNsecs = readU32(buf, 12);
  const flowSequence = readU32(buf, 16);
  const engineType = buf[20];
  const engineId = buf[21];
  const samplingInterval = readU16(buf, 22);

  const header = {
    version,
    count,
    sysUptime,
    unixSecs,
    unixNsecs,
    flowSequence,
    engineType,
    engineId,
    samplingInterval,
  };

  // ── Validate record count vs actual datagram length ────────────────────
  const expectedLength = HEADER_SIZE + count * RECORD_SIZE;
  let truncated = false;
  let actualCount = count;

  if (buf.length < expectedLength) {
    // Datagram is truncated — parse what we can
    actualCount = Math.floor((buf.length - HEADER_SIZE) / RECORD_SIZE);
    truncated = true;
  }

  // ── Parse records ──────────────────────────────────────────────────────
  const records = [];
  for (let i = 0; i < actualCount; i++) {
    const off = HEADER_SIZE + i * RECORD_SIZE;

    // Absolute timestamps:
    //   first/last are in sysUptime milliseconds.
    //   Absolute time = unix_secs + (field_value - sysUptime) / 1000
    //   But more precisely: the flow started at
    //     unix_secs - (sysUptime - first) / 1000
    //   which simplifies to:
    //     unix_secs + (first - sysUptime) / 1000
    const firstMs = readU32(buf, off + 24);
    const lastMs = readU32(buf, off + 28);

    // Compute absolute timestamps. Handle wrap-around:
    // if first > sysUptime, the flow started before the current uptime
    // window (counter wrapped). Use signed delta.
    const firstDelta = (firstMs - sysUptime) | 0; // force signed 32-bit
    const lastDelta = (lastMs - sysUptime) | 0;

    const firstAbsMs = unixSecs * 1000 + Math.floor(unixNsecs / 1e6) + firstDelta;
    const lastAbsMs = unixSecs * 1000 + Math.floor(unixNsecs / 1e6) + lastDelta;

    const tcpFlagsByte = buf[off + 37];

    records.push({
      srcaddr: ipToString(buf, off),
      dstaddr: ipToString(buf, off + 4),
      nexthop: ipToString(buf, off + 8),
      input: readU16(buf, off + 12),
      output: readU16(buf, off + 14),
      dPkts: readU32(buf, off + 16),
      dOctets: readU32(buf, off + 20),
      first: firstMs,
      last: lastMs,
      firstAbsolute: new Date(firstAbsMs).toISOString(),
      lastAbsolute: new Date(lastAbsMs).toISOString(),
      srcport: readU16(buf, off + 32),
      dstport: readU16(buf, off + 34),
      tcp_flags: tcpFlagsByte,
      tcp_flags_decoded: decodeTcpFlags(tcpFlagsByte),
      prot: buf[off + 38],
      tos: buf[off + 39],
      src_as: readU16(buf, off + 40),
      dst_as: readU16(buf, off + 42),
      src_mask: buf[off + 44],
      dst_mask: buf[off + 45],
    });
  }

  const result = { header, records };
  if (truncated) {
    result.truncated = true;
    result.expectedRecords = count;
    result.actualRecords = actualCount;
    result.warning =
      `Datagram claims ${count} records but only ${actualCount} complete ` +
      `records fit in ${buf.length} bytes (expected ${expectedLength}). ` +
      `Partial datagram — possibly truncated in transit.`;
  }

  return result;
}

// ─── Encoder (for self-test) ─────────────────────────────────────────────────

/**
 * Encode a NetFlow v5 datagram from structured data.
 * Used exclusively by the self-test to verify round-trip correctness.
 *
 * @param {object} header - Header fields
 * @param {object[]} records - Array of record objects
 * @returns {Buffer}
 */
export function encodeNetFlowV5(header, records) {
  const buf = Buffer.alloc(HEADER_SIZE + records.length * RECORD_SIZE);

  // Header
  buf.writeUInt16BE(header.version, 0);
  buf.writeUInt16BE(records.length, 2);
  buf.writeUInt32BE(header.sysUptime, 4);
  buf.writeUInt32BE(header.unixSecs, 8);
  buf.writeUInt32BE(header.unixNsecs, 12);
  buf.writeUInt32BE(header.flowSequence, 16);
  buf[20] = header.engineType;
  buf[21] = header.engineId;
  buf.writeUInt16BE(header.samplingInterval, 22);

  // Records
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const off = HEADER_SIZE + i * RECORD_SIZE;

    writeIP(buf, off, r.srcaddr);
    writeIP(buf, off + 4, r.dstaddr);
    writeIP(buf, off + 8, r.nexthop);
    buf.writeUInt16BE(r.input, off + 12);
    buf.writeUInt16BE(r.output, off + 14);
    buf.writeUInt32BE(r.dPkts, off + 16);
    buf.writeUInt32BE(r.dOctets, off + 20);
    buf.writeUInt32BE(r.first, off + 24);
    buf.writeUInt32BE(r.last, off + 28);
    buf.writeUInt16BE(r.srcport, off + 32);
    buf.writeUInt16BE(r.dstport, off + 34);
    buf[off + 36] = 0; // pad1
    buf[off + 37] = r.tcp_flags;
    buf[off + 38] = r.prot;
    buf[off + 39] = r.tos;
    buf.writeUInt16BE(r.src_as, off + 40);
    buf.writeUInt16BE(r.dst_as, off + 42);
    buf[off + 44] = r.src_mask;
    buf[off + 45] = r.dst_mask;
    buf.writeUInt16BE(0, off + 46); // pad2
  }

  return buf;
}

/**
 * Write a dotted-quad IP string into a buffer as 4 big-endian bytes.
 */
function writeIP(buf, offset, ipStr) {
  const parts = ipStr.split('.').map(Number);
  buf[offset] = parts[0];
  buf[offset + 1] = parts[1];
  buf[offset + 2] = parts[2];
  buf[offset + 3] = parts[3];
}

// ─── Self-test ───────────────────────────────────────────────────────────────

/**
 * Run a comprehensive self-test of the parser.
 * Builds synthetic datagrams, encodes them, decodes them, and asserts
 * round-trip equality. Also tests error paths (wrong version, truncation).
 */
function selfTest() {
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  console.log('NetFlow v5 Parser Self-Test');
  console.log('===========================\n');

  // ── Test 1: Round-trip encoding/decoding ───────────────────────────────
  console.log('Test 1: Round-trip encode → decode');
  const testHeader = {
    version: 5,
    sysUptime: 123456789,
    unixSecs: 1700000000,
    unixNsecs: 500000000,
    flowSequence: 42,
    engineType: 0,
    engineId: 0,
    samplingInterval: 0,
  };

  const testRecords = [
    {
      srcaddr: '192.168.1.100',
      dstaddr: '8.8.8.8',
      nexthop: '192.168.1.1',
      input: 1,
      output: 2,
      dPkts: 150,
      dOctets: 98765,
      first: 123450000,
      last: 123456000,
      srcport: 54321,
      dstport: 443,
      tcp_flags: 0x1b, // SYN+ACK+FIN+PSH
      prot: 6, // TCP
      tos: 0,
      src_as: 0,
      dst_as: 15169,
      src_mask: 24,
      dst_mask: 8,
    },
    {
      srcaddr: '10.0.0.5',
      dstaddr: '172.16.0.1',
      nexthop: '0.0.0.0',
      input: 0,
      output: 0,
      dPkts: 1,
      dOctets: 64,
      first: 123456700,
      last: 123456700,
      srcport: 0,
      dstport: 0,
      tcp_flags: 0,
      prot: 1, // ICMP
      tos: 0,
      src_as: 0,
      dst_as: 0,
      src_mask: 0,
      dst_mask: 0,
    },
  ];

  const encoded = encodeNetFlowV5(testHeader, testRecords);
  const decoded = parseNetFlowV5(encoded);

  assert(decoded.header.version === 5, 'Version is 5');
  assert(decoded.header.count === 2, 'Record count is 2');
  assert(decoded.header.sysUptime === 123456789, 'sysUptime matches');
  assert(decoded.header.unixSecs === 1700000000, 'unixSecs matches');
  assert(decoded.header.flowSequence === 42, 'flowSequence matches');
  assert(decoded.records.length === 2, 'Parsed 2 records');

  const r0 = decoded.records[0];
  assert(r0.srcaddr === '192.168.1.100', `srcaddr = ${r0.srcaddr}`);
  assert(r0.dstaddr === '8.8.8.8', `dstaddr = ${r0.dstaddr}`);
  assert(r0.nexthop === '192.168.1.1', `nexthop = ${r0.nexthop}`);
  assert(r0.dPkts === 150, `dPkts = ${r0.dPkts}`);
  assert(r0.dOctets === 98765, `dOctets = ${r0.dOctets}`);
  assert(r0.srcport === 54321, `srcport = ${r0.srcport}`);
  assert(r0.dstport === 443, `dstport = ${r0.dstport}`);
  assert(r0.prot === 6, `prot = ${r0.prot} (TCP)`);
  assert(r0.tcp_flags === 0x1b, `tcp_flags = 0x${r0.tcp_flags.toString(16)}`);
  assert(
    r0.tcp_flags_decoded.includes('SYN') &&
    r0.tcp_flags_decoded.includes('ACK') &&
    r0.tcp_flags_decoded.includes('FIN') &&
    r0.tcp_flags_decoded.includes('PSH'),
    `tcp_flags_decoded = [${r0.tcp_flags_decoded.join(', ')}]`
  );
  assert(r0.dst_as === 15169, `dst_as = ${r0.dst_as}`);
  assert(r0.src_mask === 24, `src_mask = ${r0.src_mask}`);

  const r1 = decoded.records[1];
  assert(r1.srcaddr === '10.0.0.5', `record[1].srcaddr = ${r1.srcaddr}`);
  assert(r1.prot === 1, `record[1].prot = ${r1.prot} (ICMP)`);

  // Verify absolute timestamps are reasonable
  assert(
    typeof r0.firstAbsolute === 'string' && r0.firstAbsolute.endsWith('Z'),
    `firstAbsolute is ISO string: ${r0.firstAbsolute}`
  );

  // ── Test 2: Wrong version rejection ────────────────────────────────────
  console.log('\nTest 2: Wrong version rejection');
  const wrongVersionBuf = Buffer.alloc(HEADER_SIZE);
  wrongVersionBuf.writeUInt16BE(9, 0); // NetFlow v9
  try {
    parseNetFlowV5(wrongVersionBuf);
    assert(false, 'Should have thrown for version 9');
  } catch (err) {
    assert(
      err.message.includes('version mismatch') && err.message.includes('9'),
      `Correct error: "${err.message}"`
    );
  }

  // ── Test 3: Truncated datagram ─────────────────────────────────────────
  console.log('\nTest 3: Truncated datagram handling');
  const truncatedBuf = encoded.subarray(0, HEADER_SIZE + RECORD_SIZE + 20);
  const truncatedResult = parseNetFlowV5(truncatedBuf);
  assert(truncatedResult.truncated === true, 'Truncation detected');
  assert(
    truncatedResult.expectedRecords === 2,
    `Expected 2 records, got header count = ${truncatedResult.expectedRecords}`
  );
  assert(
    truncatedResult.actualRecords === 1,
    `Actually parsed ${truncatedResult.actualRecords} complete record(s)`
  );
  assert(
    typeof truncatedResult.warning === 'string',
    `Warning present: "${truncatedResult.warning.substring(0, 60)}..."`
  );

  // ── Test 4: Too-short datagram ─────────────────────────────────────────
  console.log('\nTest 4: Too-short datagram rejection');
  try {
    parseNetFlowV5(Buffer.alloc(10));
    assert(false, 'Should have thrown for 10-byte datagram');
  } catch (err) {
    assert(
      err.message.includes('too short'),
      `Correct error: "${err.message}"`
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n===========================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Run self-test when invoked directly with --selftest flag
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('netflow.mjs') || process.argv[1].endsWith('netflow'));

if (isMainModule && process.argv.includes('--selftest')) {
  selfTest();
}
