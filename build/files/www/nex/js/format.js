/**
 * format.js — formatting helpers for telemetry display
 * =====================================================
 * These exist so that panels never hand-roll number formatting. Consistency
 * matters in a telemetry UI: if "1.2 MB" appears next to "1,200,000 B" the
 * user cannot compare them, and inconsistent rounding makes trends invisible.
 *
 * All functions are pure and total — they never throw on null/undefined/NaN,
 * because live polling means a field can be absent mid-refresh and a thrown
 * exception would blank the whole panel.
 */

/** Byte counter thresholds. Binary units (KiB/MiB) because that is what
 *  every other tool on the router reports and mixing units invites errors. */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Placeholder for "no value". An em dash rather than an empty string, so a
 *  blank cell never looks like a rendering bug. */
const NONE = '—';

/**
 * Coerce to a finite number, or null when the value is ABSENT.
 *
 * This helper exists because `Number(null) === 0`. The naive pattern
 * `const v = Number(n); if (!isFinite(v)) return '—'` renders an absent value
 * as zero — which in a telemetry dashboard is worse than useless. A board with
 * no thermal zone would display "0°C", an unreported CPU counter would display
 * "0%", and both look exactly like legitimate readings. Absent must be visually
 * distinguishable from zero.
 *
 * A real numeric zero is preserved: `0 B` and `0%` are meaningful and must
 * render as such.
 *
 * Note that booleans are rejected. `Number(true)` is 1, and a boolean field
 * arriving where a number was expected is a schema mismatch that should show
 * as unknown rather than silently becoming 1.
 *
 * @param {*} v
 * @returns {number|null}
 */
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a byte count with binary units.
 * @param {number|null|undefined} n
 * @param {number} [decimals]
 */
export function bytes(n, decimals = 1) {
  const v = num(n);
  if (v === null || v < 0) return NONE;
  if (v < 1024) return `${v} B`;
  let i = 0, x = v;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++; }
  // Drop the decimal once the value reaches 100: "128.0 MiB" carries no more
  // information than "128 MiB" and costs width in a narrow metric tile.
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(decimals)} ${BYTE_UNITS[i]}`;
}

/**
 * Format a byte count as a rate.
 * @param {number|null|undefined} bytesPerSec
 */
export function rate(bytesPerSec) {
  const v = num(bytesPerSec);
  if (v === null || v < 0) return NONE;
  return `${bytes(v)}/s`;
}

/** Bits per second, for throughput where the user thinks in Mbps. */
export function bps(bitsPerSec) {
  const v = num(bitsPerSec);
  if (v === null || v < 0) return NONE;
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let i = 0, x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

/**
 * Humanise a duration in seconds.
 * Deliberately compact ("3d 4h", "12m 05s") because it lives in a topbar pill.
 */
export function duration(seconds) {
  const n = num(seconds);
  if (n === null || n < 0) return NONE;
  const s = Math.floor(n);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${String(hr % 24).padStart(2, '0')}h`;
}

/** A number with thousands separators, or an em dash when absent. */
export function int(n) {
  const v = num(n);
  if (v === null) return NONE;
  return Math.round(v).toLocaleString('en-US');
}

/** A percentage from a 0..1 fraction, or from an already-0..100 value. */
export function pct(value, { alreadyPercent = false, decimals = 1 } = {}) {
  const v = num(value);
  if (v === null) return NONE;
  const p = alreadyPercent ? v : v * 100;
  return `${p.toFixed(decimals)}%`;
}

/** Celsius, or an em dash when the board has no thermal zone. */
export function celsius(c) {
  const v = num(c);
  if (v === null) return NONE;
  return `${v.toFixed(0)}°C`;
}

/** Temperature severity thresholds for this SoC. MT7621 has no published
 *  Tjmax, so these are conservative operational bands, not silicon limits. */
export function tempVariant(c) {
  const v = num(c);
  if (v === null) return null;
  if (v >= 80) return 'err';
  if (v >= 65) return 'warn';
  return 'ok';
}

/** Relative time ("3 min ago"), used for last-seen and lease-expiry columns. */
export function ago(isoOrSeconds) {
  let then;
  if (typeof isoOrSeconds === 'number') {
    const n = num(isoOrSeconds);
    if (n === null) return NONE;
    // ubus reports lease expiry as seconds-from-now, not as an epoch time.
    then = Date.now() + n * 1000;
  } else {
    then = Date.parse(isoOrSeconds);
  }
  if (!Number.isFinite(then)) return NONE;
  const diff = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const label = duration(abs);
  if (abs < 5) return 'now';
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

/** ISO timestamp to a short local string. */
export function dateTime(iso) {
  if (!iso) return NONE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** Time only, for the status bar clock. */
export function clockTime(d = new Date()) {
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Truncate long strings for table cells without breaking words badly.
 * Used on vendor names from the OUI database, which can be very long.
 */
export function clip(s, max = 42) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Mask the middle of a MAC for display where the full value is not needed.
 * Not a privacy control — the full MAC is still on the wire and in the API.
 * It just reduces visual noise in dense tables.
 */
export function shortMac(mac) {
  const m = String(mac ?? '').toUpperCase();
  const parts = m.split(':');
  if (parts.length !== 6) return m;
  return `${parts[0]}:${parts[1]}:${parts[2]}:…:${parts[5]}`;
}

/** Protocol number -> name. Mirrors the subset this dashboard cares about. */
const PROTO_NAMES = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6' };
export function protoName(n) {
  return PROTO_NAMES[Number(n)] ?? `proto-${n ?? '?'}`;
}

/** Well-known port -> service label. Used to make flow tables readable. */
const PORT_NAMES = {
  20: 'FTP-D', 21: 'FTP', 22: 'SSH', 23: 'telnet', 53: 'DNS', 67: 'DHCP', 68: 'DHCP',
  80: 'HTTP', 123: 'NTP', 443: 'HTTPS', 445: 'SMB', 554: 'RTSP', 993: 'IMAPS',
  1883: 'MQTT', 3389: 'RDP', 5060: 'SIP', 5353: 'mDNS', 7000: 'AirPlay',
  8008: 'HTTP-alt', 8009: 'ajp', 8080: 'HTTP-proxy', 8443: 'HTTPS-alt',
  1900: 'SSDP', 5201: 'iperf', 2056: 'NetFlow', 514: 'syslog',
};
export function portLabel(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return PORT_NAMES[n] ?? String(n);
}
