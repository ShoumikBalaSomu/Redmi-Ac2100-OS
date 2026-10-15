#!/usr/bin/env node
/**
 * mock-ubus.mjs — development stand-in for a real Redmi AC2100
 * =============================================================
 * Serves the web UI and a fake /ubus endpoint that implements every method the
 * dashboard calls, returning realistic values for THIS board (MT7621, 880 MHz,
 * 128 MiB RAM, MT7615N + MT7603EN, the verified MTD map).
 *
 * WHY THIS EXISTS
 * ---------------
 * Developing a router dashboard against a real router is miserable: every
 * change means rebuilding or copying files over SSH, and a mistake can leave
 * the device unreachable. This mock lets the whole UI run in a browser on a
 * laptop. It is also the only way to exercise the error paths — a read-only
 * ACL, a missing package, a denied permission — which are exactly the paths
 * that never get tested against real hardware.
 *
 * WHAT IT SIMULATES
 * -----------------
 *   * live-moving CPU, memory, temperature and traffic counters
 *   * the four performance profiles, including applying one and reading the
 *     changed state back
 *   * hardware flow offload that is configured-but-not-yet-engaged, so the UI's
 *     "requested, none yet" path is visible
 *   * the CAKE warning path when the bufferbloat profile is selected
 *   * a device inventory with a deliberate mix of classification evidence:
 *     hostname-matched, vendor-OUI-only, and unclassifiable
 *   * an anomaly outlier
 *   * the real MTD partition map from the upstream device tree
 *
 * It is NOT a simulator of router behaviour. It returns plausible data so the
 * UI can be exercised; it makes no claim to model the hardware.
 *
 * USAGE
 *   node dev/mock-ubus.mjs [--port 8080] [--readonly] [--no-offload] [--cake]
 *
 *     --readonly    simulate a session whose ACL grants read only, so write
 *                   controls must hide themselves
 *     --no-offload  start with flow offload disabled (the ~350 Mbps case)
 *     --cake        start with CAKE active, to see the warning path
 *
 * Then open http://127.0.0.1:8080/nex/ and sign in with any credentials
 * (or root / an empty password, which is the OpenWrt first-boot default).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');

/** True when this file was executed directly rather than imported by a test. */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = IS_MAIN ? process.argv.slice(2) : [];
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : (args[i + 1] ?? dflt);
};
const PORT = Number(argVal('--port', 8080));
const READONLY = args.includes('--readonly');
const START_NO_OFFLOAD = args.includes('--no-offload');
const START_CAKE = args.includes('--cake');

/* ── Simulated board state ───────────────────────────────────────────────── */

const BOOT_TIME = Date.now();

const board = {
  model: 'Xiaomi Redmi Router AC2100',
  board_name: 'xiaomi,redmi-router-ac2100',
  kernel: `6.18.55`,
  hostname: 'nexrouter',
  cpu_mhz: 880,
  cpu_cores: 2,
  cpu_model: 'MIPS 1004Kc',
  // MT7621 reports millidegrees through its thermal zone; the rpcd plugin
  // normalises to whole degrees, so the mock already reports degrees.
  temp_c: 54,
};

const cfg = {
  softwareOffload: !START_NO_OFFLOAD,
  hardwareOffload: !START_NO_OFFLOAD && !START_CAKE,
  packetSteering: !START_NO_OFFLOAD,
  qdisc: START_CAKE ? 'cake' : 'fq_codel',
  insightEnabled: true,
  exportEnabled: false,
  exportCollector: '',
  exportPort: 2056,
  windowMinutes: 15,
  dohEnabled: true,
  dohProvider: 'cloudflare',
};

const PROFILES = {
  throughput:  { software: true,  hardware: true,  steering: true,  qdisc: 'fq_codel' },
  balanced:    { software: true,  hardware: true,  steering: true,  qdisc: 'fq_codel' },
  bufferbloat: { software: true,  hardware: false, steering: true,  qdisc: 'cake' },
  compat:      { software: false, hardware: false, steering: false, qdisc: 'fq_codel' },
};

let hwFlows = 0;
let swFlows = 0;

/* ── Counter simulation ────────────────────────────────────────────────────
   Random walks bounded to plausible ranges. The point is that values MOVE, so
   the sparklines, the flow counters and the anomaly view can be seen working.
   A static mock would hide every bug in the refresh path.                  */

function walk(current, min, max, step) {
  const next = current + (Math.random() - 0.5) * 2 * step;
  return Math.max(min, Math.min(max, next));
}

const sim = {
  cpu0: 12, cpu1: 9,
  memAvailKb: 74_000,
  temp: 54,
  wanRx: 4_812_334_000,
  wanTx: 1_204_556_000,
  ctCount: 412,
};

const MEM_TOTAL_KB = 128 * 1024; // 128 MiB, per the verified hardware

function tickSim() {
  sim.cpu0 = walk(sim.cpu0, 3, 92, 7);
  sim.cpu1 = walk(sim.cpu1, 2, 88, 7);
  sim.memAvailKb = walk(sim.memAvailKb, 48_000, 92_000, 1400);
  sim.temp = walk(sim.temp, 47, 71, 0.7);
  sim.wanRx += Math.floor(Math.random() * 9_000_000);
  sim.wanTx += Math.floor(Math.random() * 2_500_000);
  sim.ctCount = Math.max(80, Math.min(9000, sim.ctCount + Math.floor((Math.random() - 0.5) * 90)));

  // Flow counters only move when offload is actually on — mirroring reality,
  // where "configured but not engaging" is indistinguishable from "off" in the
  // counters and that is precisely why the UI reports both separately.
  if (cfg.hardwareOffload) {
    hwFlows = Math.max(0, Math.min(64, hwFlows + Math.floor((Math.random() - 0.45) * 9)));
    // A cold start should be visible: leave it at 0 for the first few ticks.
    if (hwFlows === 0 && Math.random() < 0.5) hwFlows = 0;
  } else {
    hwFlows = 0;
  }
  swFlows = cfg.softwareOffload
    ? Math.max(0, Math.min(4096, swFlows + Math.floor((Math.random() - 0.4) * 140)))
    : 0;
}
// /proc/stat-style cumulative counters. The UI computes a percentage from the
// busy/total pair, so the pair must grow monotonically.
//
// Seeded non-zero: on a real router these counters reflect everything since
// boot, and a UI reading them on first poll would otherwise compute a
// percentage from a delta of zero. Starting at zero hid a real division-by-zero
// path in the panel code.
const cpuCounters = [
  { id: 'cpu0', busy: 41_000, total: 400_000 },
  { id: 'cpu1', busy: 33_000, total: 400_000 },
];
function advanceCpuCounters() {
  for (const c of cpuCounters) {
    const pct = c.id === 'cpu0' ? sim.cpu0 : sim.cpu1;
    c.total += 1000;
    c.busy += Math.round(pct * 10);
  }
}

/**
 * Advance the simulation one step. Exported so tests can move the state
 * deterministically instead of depending on wall-clock timers.
 */
export function stepSimulation() {
  tickSim();
  advanceCpuCounters();
}

// Only run the timers when executed directly. Importing this module for tests
// must not leave background intervals holding the event loop open, and must not
// make assertions depend on how long the suite takes to run.
if (IS_MAIN) {
  setInterval(tickSim, 2000);
  setInterval(advanceCpuCounters, 1000);
} else {
  // Warm the flow counters a little so an imported mock is not stuck in the
  // "configured but zero flows" state for every single test.
  for (let i = 0; i < 6; i++) stepSimulation();
}

/* ── Device inventory ──────────────────────────────────────────────────────
   Deliberately mixed evidence quality, because the UI's `classified_by`
   column exists to expose exactly that difference.                        */

const DEVICES = [
  { mac: 'AA:BB:CC:11:22:33', ip: '192.168.1.101', hostname: 'iPhone-of-Sam', vendor: 'Apple, Inc.', kind: 'phone', classified_by: 'hostname', source: 'dhcp', rx: 1_240_000_000, tx: 88_000_000, conn: 41, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:34', ip: '192.168.1.102', hostname: 'living-room-tv', vendor: 'LG Electronics', kind: 'tv', classified_by: 'hostname', source: 'dhcp', rx: 9_880_000_000, tx: 42_000_000, conn: 12, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:35', ip: '192.168.1.103', hostname: 'thinkpad-x1', vendor: 'Lenovo', kind: 'computer', classified_by: 'hostname', source: 'dhcp', rx: 640_000_000, tx: 210_000_000, conn: 88, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:36', ip: '192.168.1.104', hostname: '', vendor: 'Espressif Inc.', kind: 'iot', classified_by: 'vendor-oui', source: 'arp', rx: 1_200_000, tx: 900_000, conn: 3, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:37', ip: '192.168.1.105', hostname: '', vendor: null, kind: 'unknown', classified_by: 'none', source: 'arp', rx: 48_000_000, tx: 2_100_000, conn: 7, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:38', ip: '192.168.1.106', hostname: 'front-door-cam', vendor: 'Hangzhou Hikvision', kind: 'camera', classified_by: 'hostname', source: 'dhcp', rx: 300_000, tx: 3_400_000_000, conn: 4, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:39', ip: '192.168.1.107', hostname: 'ps5', vendor: 'Sony Interactive Entertainment', kind: 'console', classified_by: 'hostname', source: 'dhcp', rx: 2_200_000_000, tx: 140_000_000, conn: 23, iface: 'br-lan' },
  { mac: 'AA:BB:CC:11:22:3a', ip: '192.168.1.108', hostname: '', vendor: 'TP-Link Technologies', kind: 'iot', classified_by: 'vendor-oui', source: 'ndp', rx: 900_000, tx: 400_000, conn: 2, iface: 'br-lan' },
];

function devicesPayload() {
  const devices = DEVICES
    .map(d => ({
      mac: d.mac,
      ip: d.ip,
      hostname: d.hostname,
      vendor: d.vendor,
      oui_prefix: d.mac.replace(/:/g, '').slice(0, 6),
      source: d.source,
      iface: d.iface,
      lease_expires: d.source === 'dhcp' ? 3600 : null,
      traffic: { rx: d.rx, tx: d.tx, packets: Math.floor((d.rx + d.tx) / 900), conn: d.conn },
      kind: d.kind,
      classified_by: d.classified_by,
    }))
    .sort((a, b) => (b.traffic.rx + b.traffic.tx) - (a.traffic.rx + a.traffic.tx));

  const byKind = {};
  for (const d of devices) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;

  return { count: devices.length, by_kind: byKind, devices };
}

/* ── The verified MTD map for this board ─────────────────────────────────── */

const MTD = [
  { name: 'Bootloader',   size: 0x80000 },
  { name: 'Config',       size: 0x40000 },
  { name: 'Bdata',        size: 0x40000 },
  { name: 'factory',      size: 0x40000 },
  { name: 'crash',        size: 0x40000 },
  { name: 'crash_syslog', size: 0x40000 },
  { name: 'reserved0',    size: 0x40000 },
  { name: 'kernel_stock', size: 0x400000 },
  { name: 'kernel',       size: 0x400000 },
  { name: 'ubi',          size: 0x7580000 },
];

/* ── ubus method implementations ─────────────────────────────────────────── */

const nexrouter = {
  overview() {
    return {
      model: board.model,
      board: board.board_name,
      openwrt: 'OpenWrt SNAPSHOT r29000-abcdef0',
      kernel: board.kernel,
      nexrouter: '0.1.0',
      build_date: '2026-10-13T00:00:00Z',
      git_commit: 'mock0000',
      uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000) + 86400,
      load: [Number((sim.cpu0 / 200).toFixed(2)), Number((sim.cpu1 / 260).toFixed(2)), 0.09],
      cpu_mhz: board.cpu_mhz,
      cpu_cores: board.cpu_cores,
      cpu_model: board.cpu_model,
      temp_c: Math.round(sim.temp),
      memory: {
        total_kb: MEM_TOTAL_KB,
        free_kb: Math.round(sim.memAvailKb * 0.55),
        available_kb: Math.round(sim.memAvailKb),
        cached_kb: Math.round(sim.memAvailKb * 0.3),
      },
      hostname: board.hostname,
      timezone: 'UTC',
    };
  },

  performance() {
    return {
      offload: {
        software: cfg.softwareOffload,
        hardware: cfg.hardwareOffload,
        software_raw: cfg.softwareOffload ? '1' : '0',
        hardware_raw: cfg.hardwareOffload ? '1' : '0',
        hw_flows: hwFlows,
        sw_flows: swFlows,
      },
      packet_steering: cfg.packetSteering,
      conntrack: {
        count: sim.ctCount,
        max: 65536,
        used_percent: Math.round((sim.ctCount / 65536) * 100),
      },
      wan: { device: 'wan', rx_bytes: sim.wanRx, tx_bytes: sim.wanTx },
      qdisc: {
        device: 'wan',
        kind: cfg.qdisc,
        options: cfg.qdisc === 'cake'
          ? 'bandwidth 0bit diffserv4 dual-srchost nat wash ack-filter-aggressive'
          : 'limit 10240 flows 1024 quantum 3028b target 5ms interval 100ms memory_limit 32Mb ecn',
        cake_active: cfg.qdisc === 'cake',
        warning: cfg.qdisc === 'cake'
          ? 'CAKE is active. On an 880 MHz MIPS core it typically caps throughput near ~150 Mbps. Disable bufferbloat mode if you need full speed.'
          : null,
      },
      cores: cpuCounters.map(c => ({ id: c.id, busy: c.busy, total: c.total })),
      irq_affinity: [
        { irq: 18, name: 'mt7621-eth', counts: '1024, 0' },
        { irq: 22, name: 'pcie0-mt7615', counts: '0, 3891' },
        { irq: 23, name: 'pcie1-mt7603', counts: '0, 1204' },
      ],
      notes: 'Hardware flow offload routes established flows through the MT7621 PPE without CPU involvement. If hw_flows stays at 0 under load, offload is configured but not engaging — see docs/03-performance-reality.md.',
    };
  },

  profiles() {
    return {
      profiles: [
        { id: 'throughput', name: 'Maximum throughput',
          description: 'Software + hardware flow offload on, fq_codel on WAN, no shaping. Best raw speed (~900 Mbps wired NAT reported on MT7621 with a dedicated WAN GMAC). Incompatible with QoS.',
          settings: { flow_offloading: 1, flow_offloading_hw: 1, packet_steering: 1, qdisc: 'fq_codel', sqm: 0 } },
        { id: 'balanced', name: 'Balanced (default)',
          description: 'Flow offload on with fq_codel AQM. Keeps latency reasonable under load without the CAKE CPU cost.',
          settings: { flow_offloading: 1, flow_offloading_hw: 1, packet_steering: 1, qdisc: 'fq_codel', sqm: 0 } },
        { id: 'bufferbloat', name: 'Bufferbloat mode',
          description: 'CAKE shaping for the lowest latency under saturation. WARNING: typically caps this SoC near ~150 Mbps and disables hardware offload. Only worth it on a slow link or for gaming/voice.',
          settings: { flow_offloading: 1, flow_offloading_hw: 0, packet_steering: 1, qdisc: 'cake', sqm: 1 } },
        { id: 'compat', name: 'Maximum compatibility',
          description: 'All offload disabled. Slowest (~300-350 Mbps routed) but every packet traverses the full firewall, which is what you want while debugging rules or running per-flow logging.',
          settings: { flow_offloading: 0, flow_offloading_hw: 0, packet_steering: 0, qdisc: 'fq_codel', sqm: 0 } },
      ],
    };
  },

  apply_profile({ name } = {}) {
    const p = PROFILES[name];
    if (!p) return { error: `unknown profile: ${name} (valid: ${Object.keys(PROFILES).join(' ')})` };
    cfg.softwareOffload = p.software;
    cfg.hardwareOffload = p.hardware;
    cfg.packetSteering = p.steering;
    cfg.qdisc = p.qdisc;
    if (!p.hardware) hwFlows = 0;
    return { applied: name, restarted: true,
      note: 'Verify with a throughput test. Hardware flow offload takes a few seconds to populate its flow table.' };
  },

  set_offload({ software, hardware } = {}) {
    if (software !== undefined) {
      if (!/^[01]$/.test(software)) return { error: 'software must be 0 or 1' };
      cfg.softwareOffload = software === '1';
    }
    if (hardware !== undefined) {
      if (!/^[01]$/.test(hardware)) return { error: 'hardware must be 0 or 1' };
      cfg.hardwareOffload = hardware === '1';
    }
    // The real plugin refuses hardware-without-software and forces SFO on.
    if (cfg.hardwareOffload && !cfg.softwareOffload) {
      cfg.softwareOffload = true;
      return { error: 'hardware offload requires software offload as fallback; software offload was forced on' };
    }
    return { software: cfg.softwareOffload, hardware: cfg.hardwareOffload };
  },

  wifi() {
    return {
      radios: [
        { radio: 'radio0', state: {
            ssid: 'NexRouter-5G', mode: 'Master', frequency: 5180, channel: 36,
            htmode: 'VHT80', txpower: 20, noise: -95, stations: 3,
            associations: [
              { mac: 'AA:BB:CC:11:22:33', signal: -48, rx_rate: '866.7 MBit/s', tx_rate: '866.7 MBit/s' },
              { mac: 'AA:BB:CC:11:22:35', signal: -55, rx_rate: '433.3 MBit/s', tx_rate: '433.3 MBit/s' },
              { mac: 'AA:BB:CC:11:22:39', signal: -41, rx_rate: '866.7 MBit/s', tx_rate: '866.7 MBit/s' },
            ] } },
        { radio: 'radio1', state: {
            ssid: 'NexRouter-2G', mode: 'Master', frequency: 2437, channel: 6,
            htmode: 'HT20', txpower: 20, noise: -88, stations: 2,
            associations: [
              { mac: 'AA:BB:CC:11:22:36', signal: -62, rx_rate: '72.2 MBit/s', tx_rate: '65.0 MBit/s' },
              { mac: 'AA:BB:CC:11:22:3a', signal: -71, rx_rate: '28.9 MBit/s', tx_rate: '21.7 MBit/s' },
            ] } },
      ],
      driver: 'mt76',
      note: 'mt76 is the mainline driver. It has improved substantially but still trails the MediaTek proprietary driver used by stock firmware, particularly on 5 GHz (MT7615N). WED is not available on this SoC generation.',
    };
  },

  doh_get() {
    const map = {
      cloudflare: { url: 'https://cloudflare-dns.com/dns-query', boot: '1.1.1.1,1.0.0.1' },
      adguard: { url: 'https://dns.adguard-dns.com/dns-query', boot: '94.140.14.14,94.140.15.15' },
      quad9: { url: 'https://dns.quad9.net/dns-query', boot: '9.9.9.9,149.112.112.112' },
      google: { url: 'https://dns.google/dns-query', boot: '8.8.8.8,8.8.4.4' },
      cloudflare_family: { url: 'https://family.cloudflare-dns.com/dns-query', boot: '1.1.1.3,1.0.0.3' },
    };
    const cur = map[cfg.dohProvider] ?? map.cloudflare;
    return {
      enabled: cfg.dohEnabled,
      active_provider: cfg.dohProvider,
      resolver_url: cur.url,
      bootstrap_dns: cur.boot,
      dnsmasq_cache_size: 4096,
      rebind_protection: true,
      providers: [
        { id: 'cloudflare', name: 'Cloudflare 1.1.1.1 (Fastest)', url: 'https://cloudflare-dns.com/dns-query', bootstrap: '1.1.1.1,1.0.0.1', adblock: false, note: 'Lowest latency anycast DoH resolver for gaming and general browsing.' },
        { id: 'adguard', name: 'AdGuard DNS (Ad & Tracker Blocker)', url: 'https://dns.adguard-dns.com/dns-query', bootstrap: '94.140.14.14,94.140.15.15', adblock: true, note: 'Blocks ads, analytics trackers, and phishing domains network-wide with zero router RAM overhead.' },
        { id: 'quad9', name: 'Quad9 9.9.9.9 (Malware & Threat Protection)', url: 'https://dns.quad9.net/dns-query', bootstrap: '9.9.9.9,149.112.112.112', adblock: false, note: 'Blocks known malware, botnet C2, and phishing domains using threat intelligence feeds.' },
        { id: 'google', name: 'Google Public DNS 8.8.8.8', url: 'https://dns.google/dns-query', bootstrap: '8.8.8.8,8.8.4.4', adblock: false, note: 'High-availability global DoH resolver.' },
        { id: 'cloudflare_family', name: 'Cloudflare 1.1.1.3 (Malware + Family Filter)', url: 'https://family.cloudflare-dns.com/dns-query', bootstrap: '1.1.1.3,1.0.0.3', adblock: false, note: 'Blocks malware and adult content at the DNS layer.' },
      ],
    };
  },

  doh_set({ provider, enabled } = {}) {
    const valid = ['cloudflare', 'adguard', 'quad9', 'google', 'cloudflare_family'];
    if (enabled !== undefined) {
      if (!/^[01]$/.test(String(enabled))) return { error: 'enabled must be 0 or 1' };
      cfg.dohEnabled = String(enabled) === '1';
    }
    if (provider !== undefined && provider !== '') {
      if (!valid.includes(provider)) return { error: `unknown DoH provider: ${provider}` };
      cfg.dohProvider = provider;
    }
    return this.doh_get();
  },

  hardware_chips() {
    return {
      board: 'Xiaomi Redmi Router AC2100 (RM2100)',
      pcb_dimensions: '110 mm x 90 mm (Full-board extruded aluminum heatsink)',
      chips: [
        { part: 'MediaTek MT7621AT', role: 'SoC / Network Processor', bus: 'MIPS 1004Kc Dual-Core (4 VPEs) @ 880 MHz', spec: '2 Gbps PPE Hardware NAT (16K flows), 16-ch GDMA, 3x PCIe 1.1/2.0', moddable: 'Supports 512 MiB DDR3 BGA swap' },
        { part: 'MediaTek MT7530 (MCM)', role: '7-Port Gigabit Switch + PHYs', bus: 'Internal RGMII/TRGMII + Dedicated GMAC1 WAN', spec: '1x Gigabit WAN (GMAC1) + 3x Gigabit LAN (GMAC0 DSA Ports 2,3,4)', moddable: 'Hardware VLAN / DSA tag offload enabled' },
        { part: 'MediaTek MT7615N', role: '5 GHz 4x4 MIMO Wi-Fi Radio', bus: 'PCIe0 (0000:01:00.0)', spec: '4T4R 802.11ac Wave 2, VHT80 MCS9 (1733.3 Mbps PHY), Andes N9 + Cortex-R4 MCUs, 26 dBm iPA', moddable: 'Patched for 11,454B MPDU, 4x4 SU/MU-TxBF, Virtual-Time ATF & OBSS-PD' },
        { part: 'MediaTek MT7603EN', role: '2.4 GHz 2x2 MIMO Wi-Fi Radio', bus: 'PCIe1 (0000:02:00.0)', spec: '2T2R 802.11b/g/n + Patched 256-QAM VHT40 TurboQAM (400 Mbps PHY), Andes N9 MCU', moddable: 'Patched for 256-QAM VHT40 (400 Mbps PHY) & -98 dBm sensitivity' },
        { part: '2x Qorvo QPF4200 (4200)', role: '2.4 GHz Wi-Fi 6 External PA/LNA FEMs', bus: 'RF Chain 0 & Chain 1 (+5V)', spec: '33 dB TX Gain, 2.1 dB NF, 15.5 dB RX LNA Gain, +21 dBm @ 256-QAM VHT40', moddable: 'Hardware Wi-Fi 6 (HE40 MCS11) rated FEMs' },
        { part: 'ESMT M15T1G1664A', role: 'System DRAM', bus: '16-bit DDR3-1600 (64M x 16)', spec: '128 MiB DDR3 SDRAM (96-ball FBGA)', moddable: 'UPGRADEABLE: BGA-swap to 256 MiB or 512 MiB DDR3-1600' },
        { part: 'ESMT F59L1G81MB', role: 'Boot & Rootfs Flash', bus: 'SPI NAND (ID 0xC8 0xD1)', spec: '128 MiB SPI NAND (117.5 MiB usable UBI)', moddable: 'Dual-kernel fallback partitions' },
      ],
    };
  },

  farlink() {
    return {
      engine: 'NexRouter v3.0 AI-RF Contextual Bandit & Distance Controller',
      status: 'running',
      timestamp: Math.floor(Date.now() / 1000),
      algorithm: 'Fixed-Point UCB1 Contextual Multi-Armed Bandit + Per-STA Airtime PID',
      active_arm_id: 1,
      active_profile: 'BEAMFORM_BALANCED',
      aql_txq_limit_us: 2500,
      rts_threshold: 1536,
      ucb1_score: 96420,
      worst_rssi_dbm: -71,
      avg_retry_pct: 4,
      phy_capabilities: {
        '5ghz_max_phy_mbps': 1733,
        '5ghz_features': '4x4 VHT80 MCS9, 11454B MPDU, 16-frag HW A-MSDU, eBF/iBF Phased Array, 26 dBm PA',
        '2ghz_max_phy_mbps': 400,
        '2ghz_features': '2x2 HT40 256-QAM TurboQAM, -98 dBm Long-Range CCA, LDPC+STBC, 23 dBm PA',
      },
      dual_band_rrm_active: true,
      stations: [
        { mac: 'AA:BB:CC:11:22:39', band: '5GHz', rssi: -41, retry_pct: 1, expected_mbps: 866.7, regime: 'ULTRA_NEAR', airtime_weight: 256, ai_action: '4x4-11K-AMSDU' },
        { mac: 'AA:BB:CC:11:22:33', band: '5GHz', rssi: -58, retry_pct: 3, expected_mbps: 780.0, regime: 'MID_BEAMFORM', airtime_weight: 320, ai_action: '4x4-eBF/iBF-Sounding' },
        { mac: 'AA:BB:CC:11:22:3a', band: '2.4GHz', rssi: -71, retry_pct: 6, expected_mbps: 216.7, regime: 'FAR_WALLBREAKER', airtime_weight: 512, ai_action: '256QAM-STBC-CCA-98dBm' },
      ],
    };
  },

  overclock() {
    return {
      current_mhz: 880,
      stock_mhz: 880,
      cpu: 'MIPS 1004Kc',
      runtime_adjustable: false,
      cpufreq_driver: 'absent',
      dts_clock_frequency: 'absent',
      reason: 'The MT7621 CPU clock comes from bootloader PLL setup and is not exposed in the device tree or via a cpufreq driver, so it cannot be changed safely from a running system.',
      would_it_help_throughput: false,
      why_not: 'With hardware flow offload enabled, established NAT flows are forwarded by the PPE engine without CPU involvement. The bottleneck is the PPE and switch fabric, not core clock. Overclocking helps VPN/crypto, SQM shaping, software-only forwarding and UI responsiveness.',
      documented_targets: [
        { mhz: 1000, evidence: 'widely reported usable', confidence: 'anecdotal' },
        { mhz: 1100, evidence: 'attempted on this model', confidence: 'anecdotal' },
        { mhz: 1200, evidence: 'no verified report', confidence: 'unverified' },
      ],
      risks: [
        'thermal - stock heatsink marginal above ~1000 MHz',
        'DDR3 timing violation -> silent corruption or boot failure',
        'NAND write instability',
        'permanent brick if PLL exceeds silicon tolerance',
      ],
      how_if_you_insist: 'Not from this firmware. It requires changing PLL setup in the bootloader (e.g. Breed) or patching SoC clock init in a full source build. Do it only with a serial console attached and a TFTP recovery image ready.',
    };
  },

  recovery() {
    return {
      partitions: MTD,
      dual_boot: true,
      stock_kernel_partition: 'kernel_stock (0x200000, 4 MiB)',
      openwrt_kernel_partition: 'kernel (0x600000, 4 MiB)',
      mechanism: 'u-boot validates Linux magic + uImage CRC at each kernel slot. A failing kernel is flagged in u-boot env and the other slot is booted. If both fail, system 2 boots anyway.',
      implication: 'A custom kernel with an invalid uImage CRC will be REJECTED and u-boot will fall back to the other slot. That is a safety net, but it also means a bad build can look like a silent bootloop instead of an error.',
      ubi_partition_size: '117.5 MiB',
      recovery_path: 'Hold reset during power-on for the failsafe/uboot recovery, or TFTP an image. Keep the stock kernel_stock partition intact — it is your way back.',
      warning: 'Never erase kernel_stock or factory. factory holds the WiFi EEPROM and MAC addresses; losing it means the radios cannot be calibrated and the MACs are gone.',
    };
  },

  export_get() {
    return {
      enabled: cfg.exportEnabled,
      collector: cfg.exportCollector,
      port: cfg.exportPort,
      proto: 'udp',
      cost: '~2-5% CPU',
      privacy: 'Flow records contain source/destination IPs, ports, byte counts and timing. That is traffic metadata leaving the device. Only enable it toward a collector you control.',
    };
  },

  export_set({ enabled, collector, port } = {}) {
    if (enabled !== undefined && !/^[01]$/.test(enabled)) return { error: 'enabled must be 0 or 1' };
    if (port !== undefined) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: 'port out of range' };
      cfg.exportPort = p;
    }
    if (enabled === '1') {
      const c = (collector ?? cfg.exportCollector ?? '').trim();
      if (!c) return { error: 'collector address is required before enabling export' };
      if (/[^A-Za-z0-9._:-]/.test(c)) return { error: 'collector contains invalid characters' };
      cfg.exportCollector = c;
    }
    if (enabled !== undefined) cfg.exportEnabled = enabled === '1';
    return nexrouter.export_get();
  },

  insight_devices() { return devicesPayload(); },

  insight_anomalies() {
    // One deliberate outlier so the anomalies panel is demonstrably populated.
    const cam = DEVICES.find(d => d.hostname === 'front-door-cam');
    const base = Math.floor(cam.tx * 0.31);
    return {
      threshold: 3.5,
      baseline_devices: DEVICES.length,
      method: 'EWMA baseline with fixed-point deviation scoring; MAD-style robust thresholds, no ML',
      anomalies: [
        { mac: cam.mac, baseline_bytes: base, current_bytes: cam.tx,
          connections: cam.conn,
          deviation_pct: Number((((cam.tx - base) / base) * 100).toFixed(1)),
          severity: 'high' },
      ],
    };
  },

  insight_config() {
    return {
      enabled: cfg.insightEnabled,
      export: cfg.exportEnabled,
      mode: 'heuristic',
      window_minutes: cfg.windowMinutes,
      baseline_ready: true,
      known_devices: DEVICES.length,
      oui_entries: 32118,
      state_dir: '/usr/lib/nexrouter/state',
    };
  },

  insight_config_set({ enabled, export: exp, window: win } = {}) {
    if (enabled !== undefined) {
      if (!/^[01]$/.test(enabled)) return { error: 'enabled must be 0 or 1' };
      cfg.insightEnabled = enabled === '1';
    }
    if (exp !== undefined) {
      if (!/^[01]$/.test(exp)) return { error: 'export must be 0 or 1' };
      if (exp === '1' && !cfg.exportCollector) {
        return { error: 'export enabled but no softflowd collector is configured; refusing to start an exporter with no destination' };
      }
      cfg.exportEnabled = exp === '1';
    }
    if (win !== undefined) {
      const w = Number(win);
      if (!Number.isInteger(w) || w < 1 || w > 10080) return { error: 'window must be 1..10080 minutes' };
      cfg.windowMinutes = w;
    }
    return nexrouter.insight_config();
  },
};

/** session methods — login always succeeds in the mock, for any credentials. */
const session = {
  login({ username } = {}) {
    return { ubus_rpc_session: 'mocksession0000000000000000000000', username: username ?? 'root',
      data: { username: username ?? 'root' },
      // Mirrors what rpcd returns for the ACL groups this user belongs to.
      acls: { 'nexrouter-readonly': {}, ...(READONLY ? {} : { 'nexrouter-write': {} }) } };
  },
  access({ scope } = {}) {
    const read = {
      nexrouter: { overview: {}, performance: {}, profiles: {}, wifi: {}, overclock: {},
        recovery: {}, export_get: {}, insight_devices: {}, insight_anomalies: {}, insight_config: {} },
      system: { board: {}, info: {} },
    };
    if (!READONLY) {
      read.nexrouter.apply_profile = {};
      read.nexrouter.set_offload = {};
      read.nexrouter.export_set = {};
      read.nexrouter.insight_config_set = {};
    }
    return scope === 'ubus' ? { ubus: read } : read;
  },
  destroy() { return {}; },
};

const OBJECTS = { nexrouter, session };

/* ── ubus status codes (libubus/common.h) ────────────────────────────────── */
const UBUS_OK = 0;
const UBUS_PERMISSION_DENIED = 6;
const UBUS_NOT_FOUND = 4;

export function handleUbus(body) {
  let req;
  try { req = JSON.parse(body); }
  catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }

  const id = req.id ?? null;
  if (req.method !== 'call' || !Array.isArray(req.params) || req.params.length < 3) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
  }

  const [, objName, methodName, params] = req.params;
  const obj = OBJECTS[objName];
  if (!obj) return { jsonrpc: '2.0', id, result: [UBUS_NOT_FOUND, {}] };

  const fn = obj[methodName];
  if (typeof fn !== 'function') return { jsonrpc: '2.0', id, result: [UBUS_NOT_FOUND, {}] };

  // Enforce the same ACL gate rpcd enforces, so --readonly actually exercises
  // the UI's read-only code path rather than just hiding buttons cosmetically.
  if (READONLY && objName === 'nexrouter' &&
      ['apply_profile', 'set_offload', 'export_set', 'insight_config_set'].includes(methodName)) {
    return { jsonrpc: '2.0', id, result: [UBUS_PERMISSION_DENIED, {}] };
  }

  try {
    return { jsonrpc: '2.0', id, result: [UBUS_OK, fn(params ?? {}) ?? {}] };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
  }
}

/* ── Static file serving ─────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Resolve and serve a static asset.
 *
 * Exported so the test suite can exercise the routing and the traversal guard
 * without opening a socket. Returns true when the request was handled.
 *
 * @param {string} urlPath  raw request path, e.g. "/nex/css/nex.css"
 * @param {string} webRoot
 * @returns {{status:number, file:string|null, type:string, body?:string}}
 */
export function resolveStatic(urlPath, webRoot = WEB_ROOT) {
  // /nex/ and /nex/anything both map into the source tree, matching how
  // uhttpd aliases /nex -> /www/nex on the device.
  let rel = decodeURIComponent(String(urlPath).split('?')[0]);
  if (rel.startsWith('/nex')) rel = rel.slice(4) || '/';
  if (rel === '/' || rel === '') rel = '/index.html';

  const root = path.resolve(webRoot);
  const target = path.resolve(root, `.${rel}`);

  // Path traversal guard. decodeURIComponent runs BEFORE this check, so
  // %2e%2e%2f is already normalised into ".." and cannot slip past. The
  // resolved path must be strictly inside the web root.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { status: 403, file: null, type: 'text/plain', body: 'forbidden\n' };
  }

  // Prefer src/ so edits are visible without rebuilding; fall back to dist/.
  let file = target;
  if (!fs.existsSync(file)) {
    const alt = target
      .replace(path.join(root, 'css'), path.join(root, 'src', 'css'))
      .replace(path.join(root, 'js'), path.join(root, 'src', 'js'));
    if (fs.existsSync(alt)) file = alt;
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return { status: 404, file: null, type: 'text/plain', body: `not found: ${rel}\n` };
  }
  return { status: 200, file, type: MIME[path.extname(file)] ?? 'application/octet-stream' };
}

function serveStatic(req, res) {
  const r = resolveStatic(req.url, WEB_ROOT);
  if (r.status !== 200 || !r.file) {
    res.writeHead(r.status, { 'Content-Type': r.type });
    res.end(r.body ?? '');
    return;
  }
  res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
  fs.createReadStream(r.file).pipe(res);
}

/* ── Server ──────────────────────────────────────────────────────────────── */

/**
 * Build the request handler without binding a socket.
 * Exported so the test suite can drive the full HTTP path in-process, which
 * avoids depending on loopback networking being available in the sandbox.
 */
export function createHandler() {
  return (req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/ubus')) {
      let body = '';
      req.on('data', c => {
        body += c;
        // Bound the request size; a real rpcd does too.
        if (body.length > 1_000_000) { req.destroy(); }
      });
      req.on('end', () => {
        const out = handleUbus(body);
        const json = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
        res.end(json);
        const [, o, m] = (() => { try { return JSON.parse(body).params; } catch { return []; } })();
        console.log(`  ubus  ${o ?? '?'}.${m ?? '?'} -> ${out.result?.[0] ?? 'err'}`);
      });
      return;
    }
    serveStatic(req, res);
  };
}

/** Exposed for tests that need to inspect or reset simulated state. */
export const mockState = { board, cfg, PROFILES, MTD, devicesPayload };

/**
 * Restore the simulated configuration to a known baseline.
 *
 * The mock keeps ONE mutable config object for the whole process, so tests that
 * change it leak into later tests. Without this, an assertion about state (as
 * opposed to about a returned error object) passes or fails depending on
 * execution order — which is exactly the kind of thing that makes a suite
 * untrustworthy. Every contract test calls this first.
 */
export function resetMockState() {
  cfg.softwareOffload = true;
  cfg.hardwareOffload = true;
  cfg.packetSteering = true;
  cfg.qdisc = 'fq_codel';
  cfg.insightEnabled = true;
  cfg.exportEnabled = false;
  cfg.exportCollector = '';
  cfg.exportPort = 2056;
  cfg.windowMinutes = 15;
  cfg.dohEnabled = true;
  cfg.dohProvider = 'cloudflare';
  hwFlows = 0;
  swFlows = 0;
  return cfg;
}

// Only listen when executed directly. Importing this module for tests must not
// open a port or start the simulation intervals as an import side effect.
if (IS_MAIN) {
  const server = http.createServer(createHandler());

  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  NexRouter mock router');
    console.log('  ---------------------------------------------');
    console.log(`  UI      http://127.0.0.1:${PORT}/nex/`);
    console.log(`  ubus    http://127.0.0.1:${PORT}/ubus`);
    console.log('  Login   any username / any password');
    console.log('');
    console.log(`  Simulated board : ${board.model}`);
    console.log(`                    ${board.cpu_cores}x ${board.cpu_model} @ ${board.cpu_mhz} MHz, 128 MiB RAM`);
    console.log(`  Offload at start: software=${cfg.softwareOffload} hardware=${cfg.hardwareOffload} qdisc=${cfg.qdisc}`);
    console.log(`  ACL             : ${READONLY ? 'READ-ONLY (write calls return PERMISSION_DENIED)' : 'administrative'}`);
    console.log('');
    console.log('  This is a UI development mock. It returns plausible data; it does not');
    console.log('  model router behaviour. Nothing here touches real hardware.');
    console.log('  Ctrl-C to stop.');
    console.log('');
  });

  process.on('SIGINT', () => { console.log('\n  stopping.'); server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}
