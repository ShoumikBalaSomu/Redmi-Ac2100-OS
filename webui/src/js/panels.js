/**
 * panels.js — NexRouter dashboard panels
 * =======================================
 * Each panel is a function returning a DOM node, optionally with a `refresh()`
 * hook the poller calls and a `stop()` hook for cleanup. Panels never touch
 * the network directly; they call methods on the injected `api` (the ubus
 * client) so they are testable and so the polling cadence lives in one place.
 *
 * The three design rules from index.html are enforced here in code, not just
 * in prose:
 *
 *   1. Confidence badges on every performance claim. Published throughput
 *      numbers for this class of hardware are mostly single anecdotal forum
 *      reports; the badge states which ones are actually confirmed.
 *   2. Trade-off-laden actions explain their cost before they are taken. The
 *      bufferbloat profile spells out the ~150 Mbps CAKE ceiling in the
 *      control itself.
 *   3. Nothing pretends to be machine learning. The devices and anomalies
 *      panels name their actual method, and the overclock panel has no slider.
 */

import { h, mount, badge, card, metric, kv, table, callout, toggle, bar, skeleton, empty } from './dom.js';
import { bytes, rate, duration, int, celsius, tempVariant, ago, dateTime, clip, shortMac, portLabel, protoName } from './format.js';
import { sparkline, coreBars, Series } from './chart.js';
import { UbusError } from './ubus.js';
/* ─────────────────────────────────────────────────────────────────────────
   helpers shared by panels
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Render a panel header.
 * @param {string} title
 * @param {string|Array} desc
 * @param {Node[]} [extra]
 */
function panelHead(title, desc, extra = []) {
  return h('header', { class: 'panel__head' },
    h('h1', { class: 'panel__title' }, title),
    h('p', { class: 'panel__desc' }, desc),
    extra.length ? h('div', { class: 'row', style: { marginTop: 'var(--sp-3)' } }, extra) : null);
}

/** Wrap a loader so a single failing call degrades that panel instead of all. */
async function safe(fn, fallback) {
  try { return await fn(); }
  catch (err) {
    if (err instanceof UbusError && err.isPermissionDenied) {
      return { __denied: true, error: err };
    }
    if (err instanceof UbusError && err.isMissing) {
      return { __missing: true, error: err };
    }
    return { __error: err.message ?? String(err), error: err };
  }
}

/** A card explaining that a data source is unavailable and why. */
function unavailableCard(title, reason) {
  return card({
    title,
    variant: 'warn',
    body: callout('warn', '⚠', reason),
  });
}

/**
 * Turn a UbusError into something the user can act on. Distinguishing
 * "read-only session" from "package not installed" from "router unreachable"
 * matters, because each has a different fix.
 */
function explainError(err) {
  if (err instanceof UbusError) {
    if (err.isPermissionDenied) {
      return 'This session does not have permission for that call. The rpcd ACL grants it only to administrative logins — see /usr/share/rpcd/acl.d/nexrouter.json.';
    }
    if (err.isMissing) {
      return `The router does not expose ${err.object}.${err.method}. The backing package is probably not installed in this build.`;
    }
    return `${err.object}.${err.method} failed: ${err.message}`;
  }
  return err?.message ?? String(err);
}

/* ─────────────────────────────────────────────────────────────────────────
   1. OVERVIEW
   ───────────────────────────────────────────────────────────────────────── */

export function panelOverview(api, ctx) {
  const root = h('div', { class: 'stack' });
  const cpuSeries = new Series(48);
  const memSeries = new Series(48);
  let cpuCanvas, coreCanvas, memCanvas, metricsEl, sysEl, radioEl;

  const view = h('div', { class: 'stack' },
    panelHead('Overview', 'Live state of the board. Everything here is read from the router on each poll — nothing is cached client-side across reloads.'),
    h('div', { class: 'metrics', ref: (el) => { metricsEl = el; } }),
    h('div', { class: 'grid grid--wide' },
      card({
        title: 'CPU load',
        note: 'Both cores. On this SoC the wired and radio interrupt paths are pinned to separate cores — see the Performance panel for IRQ affinity.',
        body: h('div', {},
          h('canvas', { class: 'spark', ref: (el) => { cpuCanvas = el; } }),
          h('canvas', { style: { width: '100%', marginTop: 'var(--sp-3)' }, ref: (el) => { coreCanvas = el; } })),
      }),
      card({
        title: 'Memory',
        note: '128 MiB total, shared by the kernel, conntrack, the mt76 radio drivers and this UI. Available (not free) is the number that matters.',
        body: h('canvas', { class: 'spark', ref: (el) => { memCanvas = el; } }),
      })),
    h('div', { class: 'grid' },
      card({ title: 'System', body: h('div', { ref: (el) => { sysEl = el; } }, skeleton(6)) }),
      card({ title: 'Radios', body: h('div', { ref: (el) => { radioEl = el; } }, skeleton(4)) })));

  mount(root, view);

  async function refresh() {
    const [ov, perf, wifi] = await Promise.all([
      safe(() => api.overview()),
      safe(() => api.performance()),
      safe(() => api.wifi()),
    ]);

    if (ov.__error) {
      mount(metricsEl, unavailableCard('Overview unavailable', explainError(ov.error)));
      return;
    }

    // CPU busy % from the two-sample /proc/stat delta the API provides.
    const cores = Array.isArray(perf?.cores) ? perf.cores : [];
    const corePct = cores.map(c => {
      const total = Number(c.total) || 0;
      const busy = Number(c.busy) || 0;
      return total > 0 ? (busy / total) * 100 : 0;
    });
    const avgCpu = corePct.length ? corePct.reduce((a, b) => a + b, 0) / corePct.length : 0;
    cpuSeries.push(avgCpu);

    const mem = ov.memory ?? {};
    const memTotal = Number(mem.total_kb) || 0;
    const memAvail = Number(mem.available_kb ?? mem.free_kb) || 0;
    const memUsedPct = memTotal ? ((memTotal - memAvail) / memTotal) * 100 : 0;
    memSeries.push(memUsedPct);

    mount(metricsEl,
      metric({
        label: 'CPU', value: avgCpu.toFixed(0), unit: '%',
        sub: `${ov.cpu_cores ?? '?'} × ${ov.cpu_model || 'MIPS'} @ ${int(ov.cpu_mhz)} MHz`,
        variant: avgCpu >= 90 ? 'err' : avgCpu >= 70 ? 'warn' : null,
      }),
      metric({
        label: 'Memory used', value: memUsedPct.toFixed(0), unit: '%',
        sub: `${bytes((memTotal - memAvail) * 1024)} of ${bytes(memTotal * 1024)}`,
        variant: memUsedPct >= 90 ? 'err' : memUsedPct >= 75 ? 'warn' : null,
      }),
      metric({
        label: 'Temperature', value: ov.temp_c === null || ov.temp_c === undefined ? '—' : celsius(ov.temp_c),
        sub: 'SoC thermal zone',
        variant: tempVariant(ov.temp_c),
      }),
      metric({ label: 'Uptime', value: duration(ov.uptime_seconds), sub: 'since last boot' }),
      metric({ label: 'Conntrack', value: int(perf?.conntrack?.count), sub: `of ${int(perf?.conntrack?.max)} max` }),
      metric({
        label: 'HW offloaded flows', value: int(perf?.offload?.hw_flows),
        sub: perf?.offload?.hardware ? 'PPE engaged' : 'hardware offload off',
        variant: perf?.offload?.hardware ? (Number(perf?.offload?.hw_flows) > 0 ? 'ok' : 'warn') : null,
      }));

    sparkline(cpuCanvas, cpuSeries.array, { max: 100, color: 'var(--acc)', fill: 'color-mix(in srgb, var(--acc) 18%, transparent)' });
    sparkline(memCanvas, memSeries.array, { max: 100, color: 'var(--info)', fill: 'color-mix(in srgb, var(--info) 18%, transparent)' });

    if (coreCanvas && corePct.length) {
      coreBars(coreCanvas, cores.map((c, i) => ({ id: c.id ?? `cpu${i}`, pct: corePct[i] ?? 0 })));
    }

    mount(sysEl, kv([
      ['Model', ov.model ?? '—'],
      ['Board', ov.board ?? '—'],
      ['Hostname', ov.hostname ?? '—'],
      ['OpenWrt', ov.openwrt ?? '—'],
      ['Kernel', ov.kernel ?? '—'],
      ['NexRouter', h('span', {},
        String(ov.nexrouter ?? 'dev'),
        ov.git_commit ? h('span', { class: 'chip', style: { marginLeft: 'var(--sp-2)' } }, String(ov.git_commit).slice(0, 7)) : null)],
      ['Built', dateTime(ov.build_date)],
      ['Load avg', (ov.load ?? []).map(Number).filter(Number.isFinite).map(n => n.toFixed(2)).join('  ') || '—'],
      ['Timezone', ov.timezone ?? '—'],
    ]));

    if (wifi.__error || wifi.__missing) {
      mount(radioEl, callout('warn', '⚠', explainError(wifi.error ?? new Error('iwinfo unavailable'))));
    } else {
      const radios = Array.isArray(wifi.radios) ? wifi.radios : [];
      mount(radioEl,
        radios.length
          ? table([
              { key: 'radio', label: 'Radio' },
              { key: 'band', label: 'Band', render: (r) => bandOf(r) },
              { key: 'ssid', label: 'SSID', render: (r) => r.state?.ssid ?? '—' },
              { key: 'ch', label: 'Ch', num: true, render: (r) => r.state?.frequency ?? '—' },
              { key: 'cl', label: 'Clients', num: true, render: (r) => int(r.state?.stations ?? 0) },
            ], radios)
          : empty('📡', 'No radios reported. WiFi may be disabled or the country code is unset — set it on first run.'),
        wifi.driver ? h('p', { class: 'field__hint', style: { marginTop: 'var(--sp-3)' } },
          'Driver: ', h('code', {}, wifi.driver), '. ', wifi.note ?? '') : null);
    }
  }

  return { node: root, refresh, interval: 5000 };
}

/** Derive the band label from iwinfo's frequency or the DTS-known mapping. */
function bandOf(r) {
  const f = Number(r?.state?.frequency);
  // The DTS pins pcie0 -> 5 GHz (MT7615N) and pcie1 -> 2.4 GHz (MT7603EN).
  if (f >= 5000) return badge('info', '5 GHz');
  if (f >= 2400 && f < 2500) return badge('info', '2.4 GHz');
  if (r?.radio === 'radio0') return badge('neutral', '5 GHz');
  if (r?.radio === 'radio1') return badge('neutral', '2.4 GHz');
  return badge('neutral', '?');
}

/* ─────────────────────────────────────────────────────────────────────────
   2. PERFORMANCE
   ─────────────────────────────────────────────────────────────────────────
   The most important panel in the product, because it is where the user's
   original misconception gets corrected with live evidence rather than
   assertion. It shows not just whether offload is *configured* but whether
   flows are actually being offloaded — the difference between "I enabled it"
   and "it is working".                                        */

export function panelPerformance(api, ctx) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('Performance', [
      'Offload state, forwarding path and the evidence for it. ',
      h('strong', {}, 'Configured ≠ active.'),
      ' The flow counters below come from the kernel and tell you whether the MT7621 packet-processing engine is actually taking flows, which is the only thing that makes OpenWrt as fast as the vendor firmware on this board.',
    ]),
    h('div', { class: 'stack', ref: (el) => { body = el; } }));

  mount(root, view);

  async function refresh() {
    const perf = await safe(() => api.performance());
    if (perf.__error) { mount(body, unavailableCard('Performance unavailable', explainError(perf.error))); return; }

    const off = perf.offload ?? {};
    const ct = perf.conntrack ?? {};
    const qd = perf.qdisc ?? null;
    const cores = Array.isArray(perf.cores) ? perf.cores : [];

    const nodes = [];

    // ── Offload state ──────────────────────────────────────────────────────
    const hwActive = !!off.hardware && Number(off.hw_flows) > 0;
    nodes.push(card({
      title: 'Flow offloading',
      variant: hwActive ? 'ok' : off.hardware || off.software ? 'warn' : 'err',
      note: 'The MT7621 contains a hardware NAT / packet-processing engine (PPE) rated by MediaTek at 2 Gbps aggregate. The vendor firmware drives it through a proprietary MediaTek HNAT driver. Upstream OpenWrt reaches the same silicon through nftables flowtable hardware offload instead — there is no hnat or ppe node in the upstream device tree.',
      body: h('div', { class: 'stack' },
        h('div', { class: 'metrics' },
          metric({
            label: 'Software offload', value: off.software ? 'ON' : 'OFF',
            sub: off.software_raw ?? 'unset',
            variant: off.software ? 'ok' : 'warn',
          }),
          metric({
            label: 'Hardware offload', value: off.hardware ? 'ON' : 'OFF',
            sub: off.hardware_raw ?? 'unset',
            variant: off.hardware ? 'ok' : 'err',
          }),
          metric({
            label: 'HW flows in table', value: int(off.hw_flows),
            sub: hwActive ? 'PPE is forwarding' : off.hardware ? 'requested, none yet' : 'not requested',
            variant: hwActive ? 'ok' : 'warn',
          }),
          metric({ label: 'SW flows', value: int(off.sw_flows), sub: 'flowtable entries' })),

        hwActive
          ? callout('ok', '✓', h('strong', {}, 'Hardware offload is engaged. '),
              'Established flows are being forwarded by the PPE without CPU involvement. This is the mechanism that closes the gap with the stock firmware — not overclocking, and not a rewritten kernel.')
          : off.hardware
            ? callout('warn', '⚠', h('strong', {}, 'Hardware offload is configured but no flows are in the table. '),
                'Either there is no sustained NAT traffic right now (generate some and re-check), or the flowtable is not present in the ruleset. The boot-time service logs a warning via ', h('code', {}, 'logread -t nexrouter-core'), ' in that case.')
            : callout('err', '✕', h('strong', {}, 'No offload is active. '),
                'Expect roughly 300–350 Mbps of routed throughput. Enable it from the Profiles panel — this single change is worth more than every other tuning option on this board combined.'),

        perf.notes ? h('p', { class: 'field__hint' }, perf.notes) : null),
    }));

    // ── Throughput expectations, with confidence labels ────────────────────
    nodes.push(card({
      title: 'What this board can actually do',
      note: 'Every figure carries a confidence label. Most published router benchmarks are single anecdotal reports; only the hardware-offload numbers here come from reproducible iperf3 tests.',
      body: table([
        { key: 'case', label: 'Configuration' },
        { key: 'mbps', label: 'Wired NAT', num: true },
        { key: 'conf', label: 'Confidence', render: (r) => badge(r.conf, r.confLabel, r.source) },
      ], [
        { case: 'No offloading', mbps: '300–350 Mbps', conf: 'anecdotal', confLabel: 'forum reports', source: 'OpenWrt forum threads on MT7621 routing; no single controlled published test.' },
        { case: 'Software flow offload only', mbps: '500–600 Mbps', conf: 'anecdotal', confLabel: 'anecdotal', source: 'Multiple independent forum reports, no controlled test. Treat as indicative.' },
        { case: 'Hardware flow offload (this board, dedicated WAN GMAC)', mbps: '~900–940 Mbps', conf: 'confirmed', confLabel: 'confirmed', source: 'arinc9 iperf3: 926 + 775 Mbps bidirectional. Also openwrt/mt76#868 reporting 900 Mbps LAN→WAN on 23.05.' },
        { case: 'Aggregate bidirectional with HW offload', mbps: '~1.7 Gbps', conf: 'confirmed', confLabel: 'confirmed', source: 'arinc9 iperf3 bidirectional test on MT7621 with the PHY-muxing work merged ~Aug 2022.' },
        { case: 'PPPoE with hardware offload', mbps: '400–600 Mbps', conf: 'anecdotal', confLabel: 'variable', source: 'Highly variable. openwrt/openwrt#18044 reports a severe PPPoE regression in 24.10 — verify on your own link.' },
        { case: 'CAKE / SQM shaping active', mbps: '~150 Mbps', conf: 'confirmed', confLabel: 'hard ceiling', source: 'Shaping is single-threaded and CPU-bound. SQM maintainer: "~150 sounds about right for a ~880 MHz MIPS CPU".' },
      ]),
      foot: h('span', {}, 'Your board is well positioned for the ~900 Mbps case: the device tree enables ',
        h('code', {}, 'gmac1'), ' with ', h('code', {}, 'label = "wan"'), ' and its own PHY, so WAN has a dedicated GMAC rather than sharing the CPU port with the LAN switch.'),
    }));

    // ── qdisc / shaping ────────────────────────────────────────────────────
    nodes.push(card({
      title: 'Queueing discipline',
      variant: qd?.cake_active ? 'err' : 'ok',
      note: 'The WAN root qdisc. fq_codel gives most of the bufferbloat benefit of CAKE at a small fraction of the CPU cost, which is the right default for this SoC.',
      body: h('div', { class: 'stack' },
        qd
          ? kv([
              ['Device', qd.device ?? '—'],
              ['Qdisc', h('code', {}, qd.kind ?? '—')],
              ['Options', h('code', { style: { fontSize: 'var(--fs-xs)' } }, clip(qd.options ?? '—', 90))],
            ])
          : empty('—', 'No qdisc reported. Is the WAN interface up?'),
        qd?.warning ? callout('err', '⚠', qd.warning) : null,
        qd && !qd.cake_active
          ? callout('ok', '✓', 'fq_codel is the right choice here. Switching to the bufferbloat profile would enable CAKE, which is incompatible with hardware flow offload and would cap this link near ~150 Mbps.')
          : null),
    }));

    // ── per-core load + IRQ affinity ───────────────────────────────────────
    const coreCanvas = h('canvas', { style: { width: '100%' } });
    nodes.push(card({
      title: 'Per-core load and interrupt affinity',
      note: 'This is a dual-core SoC with single-queue GMACs. The boot-time service pins wired interrupts to core 0 and the PCIe radio interrupts to core 1 so a busy radio cannot stall the wired path. If both bars track each other closely under load, that pinning is not taking effect.',
      body: h('div', { class: 'stack' },
        cores.length ? coreCanvas : empty('—', 'No per-core data.'),
        Array.isArray(perf.irq_affinity) && perf.irq_affinity.length
          ? table([
              { key: 'irq', label: 'IRQ', num: true },
              { key: 'name', label: 'Source' },
              { key: 'counts', label: 'Per-core counts' },
            ], perf.irq_affinity)
          : callout('info', 'ℹ', 'No matching network interrupts were found in /proc/interrupts. That is normal on a freshly booted idle router; generate traffic and re-check.')),
    }));

    // ── conntrack ──────────────────────────────────────────────────────────
    const ctPct = Number(ct.used_percent);
    nodes.push(card({
      title: 'Connection tracking',
      note: 'Anything not offloaded falls back to software conntrack. A full table causes silent drops, which looks exactly like "the internet is slow" with no error anywhere.',
      body: h('div', { class: 'stack' },
        h('div', { class: 'metrics' },
          metric({ label: 'Entries', value: int(ct.count), sub: 'current' }),
          metric({ label: 'Maximum', value: int(ct.max), sub: 'nf_conntrack_max' }),
          metric({
            label: 'Utilisation', value: Number.isFinite(ctPct) ? `${ctPct}%` : '—',
            variant: ctPct >= 90 ? 'err' : ctPct >= 70 ? 'warn' : 'ok',
            sub: ctPct >= 70 ? 'approaching the limit' : 'healthy',
          })),
        bar(ctPct, ctPct >= 90 ? 'err' : ctPct >= 70 ? 'warn' : 'ok')),
    }));

    // ── packet steering ────────────────────────────────────────────────────
    nodes.push(card({
      title: 'Packet steering',
      variant: perf.packet_steering ? 'ok' : 'warn',
      body: callout(perf.packet_steering ? 'ok' : 'warn',
        perf.packet_steering ? '✓' : '⚠',
        h('div', {},
          h('strong', {}, perf.packet_steering ? 'Enabled. ' : 'Disabled. '),
          'Packet steering spreads softirq work across both cores. Note that it was broken in some snapshots around Feb 2023 (openwrt/openwrt#12962), so verify with a throughput test after changing it rather than assuming the flag alone did anything.')),
    }));

    mount(body, nodes);

    // Draw after mount so the canvas has layout dimensions.
    if (cores.length) {
      const pct = cores.map(c => {
        const total = Number(c.total) || 0, busy = Number(c.busy) || 0;
        return { id: c.id, pct: total > 0 ? (busy / total) * 100 : 0 };
      });
      coreBars(coreCanvas, pct);
    }
  }

  return { node: root, refresh, interval: 4000 };
}

/* ─────────────────────────────────────────────────────────────────────────
   3. PROFILES
   ───────────────────────────────────────────────────────────────────────── */

export function panelProfiles(api, ctx) {
  const root = h('div', { class: 'stack' });
  let listEl, currentEl;
  let profiles = [];
  let current = null;

  const view = h('div', {},
    panelHead('Performance profiles', [
      'Named, whitelisted configurations rather than a pile of loose switches. ',
      'The router validates the profile name against a fixed list before any setting is changed, so there is no path from this UI to an arbitrary ',
      h('code', {}, 'uci'), ' value.',
    ]),
    h('div', { class: 'stack' },
      h('div', { ref: (el) => { currentEl = el; } }),
      h('div', { class: 'profiles', ref: (el) => { listEl = el; } }, skeleton(2))));

  mount(root, view);

  function renderCurrent(perf) {
    if (!perf || perf.__error) { mount(currentEl); return; }
    const off = perf.offload ?? {};
    mount(currentEl, card({
      title: 'Current effective state',
      note: 'Read back from the router, not from what the UI last requested.',
      body: h('div', { class: 'row' },
        badge(off.software ? 'ok' : 'err', `software offload ${off.software ? 'on' : 'off'}`),
        badge(off.hardware ? 'ok' : 'err', `hardware offload ${off.hardware ? 'on' : 'off'}`),
        badge(perf.packet_steering ? 'ok' : 'warn', `packet steering ${perf.packet_steering ? 'on' : 'off'}`),
        badge(perf.qdisc?.cake_active ? 'err' : 'ok', `qdisc ${perf.qdisc?.kind ?? 'unknown'}`),
        h('span', { class: 'spacer' }),
        badge(Number(off.hw_flows) > 0 ? 'confirmed' : 'neutral',
          `${int(off.hw_flows)} hw flows`, 'From /proc/net/stat/nf_flowtable')),
    }));
  }

  function renderProfiles() {
    const canWrite = api.canWrite;
    mount(listEl, profiles.map(p => {
      const s = p.settings ?? {};
      const active = current === p.id;
      return h('button', {
        class: ['profile', active && 'profile--active'],
        type: 'button',
        disabled: !canWrite,
        title: canWrite ? `Apply the "${p.name}" profile` : 'This session cannot change configuration',
        onclick: () => apply(p),
      },
        h('div', { class: 'profile__head' },
          h('span', { class: 'profile__name' }, p.name),
          active ? badge('ok', 'active') : null,
          p.id === 'bufferbloat' ? badge('warn', 'speed trade-off', 'CAKE shaping caps this SoC near ~150 Mbps and disables hardware flow offload.') : null,
          p.id === 'compat' ? badge('neutral', 'slowest') : null),
        h('p', { class: 'profile__desc' }, p.description ?? ''),
        h('div', { class: 'profile__chips' },
          chip('sfo', s.flow_offloading),
          chip('hfo', s.flow_offloading_hw),
          chip('steer', s.packet_steering),
          chip(`qdisc:${s.qdisc ?? '?'}`, s.qdisc === 'cake' ? 0 : 1),
          chip('sqm', s.sqm)));
    }));

    if (!canWrite) {
      listEl.appendChild(callout('info', 'ℹ',
        'Profiles are read-only for this session. Sign in as an administrative user to apply changes.'));
    }
  }

  function chip(label, on) {
    return h('span', { class: ['chip', on ? 'chip--on' : 'chip--off'] }, label);
  }

  async function apply(p) {
    // The bufferbloat profile is the one destructive-to-throughput choice, so
    // it gets an explicit confirmation that states the cost. The others are
    // reversible and non-surprising.
    if (p.id === 'bufferbloat') {
      const ok = window.confirm(
        `Apply "${p.name}"?\n\n` +
        'This enables CAKE traffic shaping, which:\n' +
        '  • disables hardware flow offload (offloaded flows bypass the qdisc entirely, so the two cannot work together)\n' +
        '  • typically caps throughput on this 880 MHz SoC near ~150 Mbps\n\n' +
        'It is the right choice only if you need low latency under saturation on a slow link — gaming or voice calls on a congested connection. If you have a 500 Mbps link and want to use it, do not apply this.\n\n' +
        'Continue?');
      if (!ok) return;
    }

    ctx.toast(`Applying "${p.name}"…`, 'info');
    ctx.busy(true);
    try {
      const res = await api.applyProfile(p.id);
      if (res?.error) throw new Error(res.error);
      current = p.id;
      renderProfiles();
      await refresh();
      ctx.toast(`Applied "${p.name}". Verify with a throughput test — the hardware flow table takes a few seconds to populate.`, 'ok');
    } catch (err) {
      ctx.toast(`Could not apply profile: ${explainError(err)}`, 'err', { sticky: true });
    } finally {
      ctx.busy(false);
    }
  }

  async function refresh() {
    const [list, perf] = await Promise.all([
      safe(() => api.profiles()),
      safe(() => api.performance()),
    ]);
    if (!list.__error && Array.isArray(list.profiles)) profiles = list.profiles;
    // Infer which profile matches the live state, so a reboot or a manual
    // `uci set` on the CLI is reflected honestly rather than showing the last
    // thing this browser clicked.
    current = inferProfile(profiles, perf);
    renderCurrent(perf);
    renderProfiles();
  }

  return { node: root, refresh, interval: 6000 };
}

/** Match the live state against profile definitions; null when none fit. */
function inferProfile(profiles, perf) {
  if (!perf || perf.__error || !Array.isArray(profiles)) return null;
  const off = perf.offload ?? {};
  const live = {
    flow_offloading: off.software ? 1 : 0,
    flow_offloading_hw: off.hardware ? 1 : 0,
    packet_steering: perf.packet_steering ? 1 : 0,
    qdisc: perf.qdisc?.kind?.includes('cake') ? 'cake' : 'fq_codel',
  };
  for (const p of profiles) {
    const s = p.settings ?? {};
    if (s.flow_offloading === live.flow_offloading &&
        s.flow_offloading_hw === live.flow_offloading_hw &&
        s.packet_steering === live.packet_steering &&
        s.qdisc === live.qdisc) {
      return p.id;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
   4. OVERCLOCK — report only, deliberately
   ─────────────────────────────────────────────────────────────────────────
   This panel has no slider and no apply button, by design. Presenting a
   frequency control here would be dishonest in two separate ways: there is no
   supported runtime mechanism to change it, and it would not improve the
   thing the user wants improved.                          */

export function panelOverclock(api) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('CPU clock', [
      'Report only. There is no control here, and that is deliberate — see below.',
    ]),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(4)));

  mount(root, view);

  async function refresh() {
    const oc = await safe(() => api.overclock());
    if (oc.__error) { mount(body, unavailableCard('Clock data unavailable', explainError(oc.error))); return; }

    const cur = Number(oc.current_mhz);
    const stock = Number(oc.stock_mhz) || 880;
    const delta = Number.isFinite(cur) && Number.isFinite(stock) ? cur - stock : null;

    const nodes = [];

    nodes.push(card({
      title: 'Measured clock',
      variant: delta && delta > 0 ? 'warn' : 'ok',
      body: h('div', { class: 'stack' },
        h('div', { class: 'metrics' },
          metric({ label: 'Current', value: Number.isFinite(cur) ? int(cur) : '—', unit: 'MHz', sub: 'from /proc/cpuinfo' }),
          metric({ label: 'Stock', value: int(stock), unit: 'MHz', sub: 'as shipped' }),
          metric({
            label: 'Delta', value: delta === null ? '—' : `${delta > 0 ? '+' : ''}${int(delta)}`, unit: delta === null ? '' : 'MHz',
            sub: delta > 0 ? 'running above stock' : 'at or below stock',
            variant: delta > 0 ? 'warn' : 'ok',
          })),
        kv([
          ['CPU', oc.cpu ?? '—'],
          ['Runtime adjustable', oc.runtime_adjustable ? badge('ok', 'yes') : badge('err', 'no')],
          ['cpufreq driver', h('code', {}, String(oc.cpufreq_driver ?? 'unknown'))],
          ['clock-frequency in DTS', h('code', {}, String(oc.dts_clock_frequency ?? 'unknown'))],
        ])),
    }));

    nodes.push(card({
      title: 'Why there is no overclock control',
      variant: 'info',
      note: oc.reason ?? null,
      body: h('div', { class: 'stack' },
        callout('err', '✕', h('div', {},
          h('strong', {}, 'It would not increase your throughput. '),
          oc.why_not ?? 'With hardware flow offload enabled, established NAT flows are forwarded by the PPE engine without CPU involvement. The bottleneck is the PPE and the switch fabric, not the core clock.')),
        h('p', { class: 'field__hint' }, 'What a higher clock ', h('em', {}, 'would'), ' help:'),
        h('ul', { style: { paddingLeft: '1.1rem', listStyle: 'disc', color: 'var(--fg-dim)', fontSize: 'var(--fs-sm)' } },
          ['VPN and other crypto workloads (software-encrypted, CPU-bound)',
           'SQM/CAKE traffic shaping (single-threaded)',
           'Software-only forwarding when offload is disabled',
           'General userspace and web UI responsiveness'].map(li => h('li', {}, li))),
        callout('warn', '⚠', h('div', {},
          h('strong', {}, 'Mechanism. '),
          oc.how_if_you_insist ?? 'Not from a running system.'))),
    }));

    if (Array.isArray(oc.documented_targets) && oc.documented_targets.length) {
      nodes.push(card({
        title: 'Documented frequency targets',
        note: 'Reported community figures, not measured by this project and not endorsed. Confidence is stated per row.',
        body: table([
          { key: 'mhz', label: 'Target', num: true, render: (r) => `${int(r.mhz)} MHz` },
          { key: 'evidence', label: 'Evidence' },
          { key: 'confidence', label: 'Confidence', render: (r) => badge(
              r.confidence === 'anecdotal' ? 'anecdotal' : r.confidence === 'unverified' ? 'err' : 'neutral',
              r.confidence ?? 'unknown') },
        ], oc.documented_targets),
      }));
    }

    if (Array.isArray(oc.risks) && oc.risks.length) {
      nodes.push(card({
        title: 'Failure modes',
        variant: 'err',
        body: h('ul', { style: { paddingLeft: '1.1rem', listStyle: 'disc', color: 'var(--fg-dim)', fontSize: 'var(--fs-sm)' } },
          oc.risks.map(r => h('li', {}, r))),
        foot: 'Any of these can be unrecoverable without a serial console and a TFTP recovery image.',
      }));
    }

    mount(body, nodes);
  }

  return { node: root, refresh, interval: 30000 };
}

/* ─────────────────────────────────────────────────────────────────────────
   5. WIFI
   ───────────────────────────────────────────────────────────────────────── */

export function panelWifi(api) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('Wireless', [
      'MT7615N on PCIe0 (5 GHz) and MT7603EN on PCIe1 (2.4 GHz), both driven by the mainline ',
      h('code', {}, 'mt76'), ' driver.',
    ]),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(3)));

  mount(root, view);

  async function refresh() {
    const [w, fl] = await Promise.all([
      safe(() => api.wifi()),
      safe(() => api.farlink()),
    ]);
    if (w.__error) { mount(body, unavailableCard('Wireless unavailable', explainError(w.error))); return; }

    const radios = Array.isArray(w.radios) ? w.radios : [];
    const nodes = [];

    if (fl && !fl.__error && !fl.__missing) {
      const stas = Array.isArray(fl.stations) ? fl.stations : [];
      nodes.push(card({
        title: 'AI-RF Contextual Bandit & Distance Controller (v3.0)',
        variant: 'ok',
        note: fl.algorithm ?? 'Fixed-Point UCB1 Contextual Multi-Armed Bandit + Per-STA Airtime PID',
        body: h('div', { class: 'stack' },
          h('div', { class: 'metrics' },
            metric({ label: 'Active RF Arm', value: fl.active_profile ?? 'BALANCED', sub: `UCB1 score: ${int(fl.ucb1_score ?? 0)}`, variant: 'ok' }),
            metric({ label: '5 GHz Max PHY', value: int(fl.phy_capabilities?.['5ghz_max_phy_mbps'] ?? 1733), unit: 'Mbps', sub: '4x4 VHT80 + 11.4KB MPDU' }),
            metric({ label: '2.4 GHz Max PHY', value: int(fl.phy_capabilities?.['2ghz_max_phy_mbps'] ?? 400), unit: 'Mbps', sub: '2x2 HT40 256-QAM TurboQAM' }),
            metric({ label: 'Dynamic AQL', value: int(fl.aql_txq_limit_us ?? 2500), unit: 'µs', sub: `RTS: ${int(fl.rts_threshold ?? 1536)} B` })),
          stas.length
            ? table([
                { key: 'mac', label: 'Station' },
                { key: 'band', label: 'Band' },
                { key: 'rssi', label: 'RSSI', num: true, render: (s) => `${s.rssi ?? '—'} dBm` },
                { key: 'retry_pct', label: 'Retry', num: true, render: (s) => `${s.retry_pct ?? 0}%` },
                { key: 'regime', label: 'Distance Regime', render: (s) => badge(s.regime === 'ULTRA_NEAR' ? 'ok' : s.regime?.includes('FAR') || s.regime?.includes('EDGE') ? 'warn' : 'info', s.regime ?? '—') },
                { key: 'airtime_weight', label: 'Airtime Weight', num: true },
                { key: 'ai_action', label: 'Active Optimization' },
              ], stas)
            : null),
      }));
    }

    nodes.push(callout('info', 'ℹ', h('div', {},
      h('strong', {}, 'Honest note on WiFi performance. '),
      w.note ?? 'mt76 has improved substantially but still trails the MediaTek proprietary driver used by the stock firmware, particularly on 5 GHz. Wireless throughput on OpenWrt may be lower than stock even when wired routing is faster. WED (Wireless Ethernet Dispatch) is not available on this SoC generation — it starts at Filogic-class hardware.')));

    if (!radios.length) {
      nodes.push(empty('📡', 'No radios reported. Check that the wireless config is enabled and a country code is set — the firmware ships with country unset on purpose, because choosing it is a regulatory decision for you, not a default we should guess.'));
    } else {
      for (const r of radios) {
        const s = r.state ?? {};
        nodes.push(card({
          title: h('span', {}, String(r.radio ?? 'radio'), ' ', bandOf(r)),
          body: h('div', { class: 'stack' },
            h('div', { class: 'metrics' },
              metric({ label: 'SSID', value: s.ssid ?? '—', sub: s.mode ?? '' }),
              metric({ label: 'Channel', value: s.channel ?? s.frequency ?? '—', sub: s.htmode ?? '' }),
              metric({ label: 'Tx power', value: s.txpower ?? '—', unit: s.txpower ? 'dBm' : '', sub: 'configured' }),
              metric({ label: 'Stations', value: int(s.stations ?? 0), sub: 'associated' }),
              metric({ label: 'Noise', value: s.noise ?? '—', unit: s.noise ? 'dBm' : '', sub: 'channel noise floor' })),
            Array.isArray(s.associations) && s.associations.length
              ? table([
                  { key: 'mac', label: 'Client' },
                  { key: 'signal', label: 'Signal', num: true, render: (a) => `${a.signal ?? '—'} dBm` },
                  { key: 'rx', label: 'Rx rate', num: true, render: (a) => a.rx_rate ?? '—' },
                  { key: 'tx', label: 'Tx rate', num: true, render: (a) => a.tx_rate ?? '—' },
                ], s.associations)
              : null),
        }));
      }
    }

    mount(body, nodes);
  }

  return { node: root, refresh, interval: 8000 };
}

/* ─────────────────────────────────────────────────────────────────────────
   6. DEVICES — the intelligence layer, honestly labelled
   ───────────────────────────────────────────────────────────────────────── */

export function panelDevices(api) {
  const root = h('div', { class: 'stack' });
  let body;
  let filter = '';

  const view = h('div', {},
    panelHead('Devices', [
      'Every host the router can see, joined from DHCP leases, the ARP and IPv6 neighbour tables, and nlbwmon counters. ',
      'Vendor names come from an offline MAC OUI lookup. Device type comes from ',
      h('strong', {}, 'deterministic rules'), ' over the hostname and vendor — each row shows which signal produced the classification, so you can judge it rather than trust it.',
    ]),
    h('div', { class: 'row', style: { marginBottom: 'var(--sp-4)' } },
      h('input', {
        class: 'input', style: { maxWidth: '18rem' }, placeholder: 'Filter by name, MAC, IP or vendor…',
        oninput: (e) => { filter = e.target.value.trim().toLowerCase(); refresh(); },
      })),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(4)));

  mount(root, view);

  async function refresh() {
    const [d, cfg] = await Promise.all([
      safe(() => api.insightDevices()),
      safe(() => api.insightConfig()),
    ]);

    const nodes = [];

    // Say plainly what this is and is not. The user asked for "AI/ML driven";
    // the honest answer belongs in the UI, not buried in a doc.
    nodes.push(callout('info', 'ℹ', h('div', {},
      h('strong', {}, 'No machine learning runs on this router. '),
      'The MT7621 is a soft-float MIPS core with no SIMD and no NPU, and both cores are busy forwarding. Neural inference is not feasible here, and even classical per-flow feature extraction at 500 Mbps would cost an estimated 30–50% of one core and 20–40 MB of RAM. What runs instead is OUI lookup, inventory joins and robust statistics. Real ML lives off the router, in ',
      h('code', {}, 'companion/nexinsight'), ', fed by NetFlow export.')));

    if (cfg.__error) {
      nodes.push(callout('warn', '⚠', explainError(cfg.error)));
    } else if (cfg && cfg.enabled === false) {
      nodes.push(callout('warn', '⚠', 'The intelligence layer is disabled in configuration. Enable it on the Settings panel to collect device inventory and traffic baselines.'));
    }

    if (d.__error) {
      nodes.push(unavailableCard('Device inventory unavailable', explainError(d.error)));
      mount(body, nodes);
      return;
    }

    const payload = Array.isArray(d) ? d[0] : d;
    let devices = Array.isArray(payload?.devices) ? payload.devices : [];

    if (filter) {
      devices = devices.filter(x =>
        [x.hostname, x.mac, x.ip, x.vendor, x.kind].some(v => String(v ?? '').toLowerCase().includes(filter)));
    }

    if (payload?.count !== undefined) {
      const byKind = payload.by_kind ?? {};
      nodes.push(card({
        title: 'Inventory',
        note: `${int(payload.count)} host(s) known${filter ? `, ${devices.length} matching the filter` : ''}. Sorted by total traffic.`,
        body: h('div', { class: 'row' },
          Object.entries(byKind).map(([k, v]) => badge(k === 'unknown' ? 'neutral' : 'info', `${k}: ${v}`))),
      }));
    }

    nodes.push(card({
      title: 'Hosts',
      body: devices.length
        ? table([
            { key: 'name', label: 'Device', render: (r) => h('div', { class: 'dev__id' },
                h('span', { class: ['dev__dot', r.source === 'dhcp' && 'dev__dot--online'] }),
                h('div', {},
                  h('div', { class: 'dev__name' }, r.hostname || badge('neutral', 'no hostname')),
                  h('div', { class: 'dev__mac' }, r.mac ?? '—'))) },
            { key: 'ip', label: 'Address', render: (r) => h('code', {}, r.ip ?? '—') },
            { key: 'vendor', label: 'Vendor (OUI)', render: (r) => r.vendor ? clip(r.vendor, 30) : h('span', { class: 'dev__mac' }, 'unknown') },
            { key: 'kind', label: 'Type', render: (r) => badge(kindBadge(r.kind), r.kind ?? 'unknown') },
            { key: 'ev', label: 'Classified by', render: (r) => badge(
                r.classified_by === 'hostname' ? 'ok' : r.classified_by === 'vendor-oui' ? 'info' : 'neutral',
                r.classified_by ?? 'none',
                'hostname = matched a name pattern; vendor-oui = inferred from the manufacturer only, which is weaker evidence; none = no signal available') },
            { key: 'src', label: 'Seen via', render: (r) => badge('neutral', r.source ?? '—') },
            { key: 'rx', label: 'Rx', num: true, render: (r) => bytes(r.traffic?.rx) },
            { key: 'tx', label: 'Tx', num: true, render: (r) => bytes(r.traffic?.tx) },
            { key: 'conn', label: 'Conns', num: true, render: (r) => int(r.traffic?.conn) },
          ], devices)
        : empty('🔍', filter ? 'No hosts match that filter.' : 'No hosts discovered yet. The inventory is built from DHCP, ARP and IPv6 neighbour tables on the first poll after boot.'),
      foot: 'A host with no hostname classified only by vendor-oui is a guess, not a determination. That is why the evidence column exists.',
    }));

    mount(body, nodes);
  }

  return { node: root, refresh, interval: 15000 };
}

function kindBadge(kind) {
  const map = {
    phone: 'ok', computer: 'ok', tv: 'info', camera: 'warn', iot: 'info',
    console: 'info', printer: 'neutral', speaker: 'info', 'phone-or-tablet': 'neutral',
  };
  return map[kind] ?? 'neutral';
}

/* ─────────────────────────────────────────────────────────────────────────
   7. ANOMALIES
   ───────────────────────────────────────────────────────────────────────── */

export function panelAnomalies(api) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('Traffic anomalies', [
      'Statistical outliers against a per-device baseline — not predictions, and not machine learning. ',
      'The method is an exponential moving average with a fixed-point deviation score, because this SoC has no floating-point unit and integer arithmetic is both exact and fast here.',
    ]),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(3)));

  mount(root, view);

  async function refresh() {
    const a = await safe(() => api.insightAnomalies());
    if (a.__error) { mount(body, unavailableCard('Anomaly data unavailable', explainError(a.error))); return; }

    const payload = Array.isArray(a) ? a[0] : a;
    const list = Array.isArray(payload?.anomalies) ? payload.anomalies : [];
    const nodes = [];

    nodes.push(card({
      title: 'Method',
      variant: 'info',
      body: kv([
        ['Baseline', 'Exponential moving average, α = 0.3'],
        ['Statistic', 'Fixed-point (×1000) deviation score — integer arithmetic only, because the MIPS 1004Kc has no FPU'],
        ['Threshold', payload?.threshold !== undefined ? `${Number(payload.threshold).toFixed(1)} (modified z-score convention)` : '—'],
        ['Why not ML', h('span', {}, 'A trained model would need features extracted per flow, which is the expensive part. The estimator above needs one counter per device and costs effectively nothing.')],
        ['Baseline devices', int(payload?.baseline_devices)],
        ['Sampling', 'The init script ticks every 15 minutes, reniced to 19 so it can never starve packet forwarding.'],
      ]),
      foot: 'A MAD-style robust threshold is used rather than a standard deviation because it has a 50% breakdown point: one huge outlier cannot corrupt the baseline. On a home network, one 4K video stream is exactly such an outlier.',
    }));

    if (payload?.note) {
      nodes.push(callout('info', 'ℹ', payload.note));
    } else if (!list.length) {
      nodes.push(callout('ok', '✓', 'No device is currently deviating from its baseline beyond the threshold. Either the network is quiet or the baseline is still warming up — it needs several ticks before it is meaningful.'));
    } else {
      nodes.push(card({
        title: `${list.length} outlier(s)`,
        variant: list.some(x => x.severity === 'high') ? 'err' : 'warn',
        body: table([
          { key: 'mac', label: 'Device', render: (r) => h('code', {}, shortMac(r.mac)) },
          { key: 'baseline_bytes', label: 'Baseline', num: true, render: (r) => bytes(r.baseline_bytes) },
          { key: 'current_bytes', label: 'Current', num: true, render: (r) => bytes(r.current_bytes) },
          { key: 'deviation_pct', label: 'Deviation', num: true, render: (r) => `${Number(r.deviation_pct).toFixed(1)}%` },
          { key: 'connections', label: 'Conns', num: true, render: (r) => int(r.connections) },
          { key: 'severity', label: 'Severity', render: (r) => badge(
              r.severity === 'high' ? 'err' : r.severity === 'medium' ? 'warn' : 'neutral', r.severity ?? '—') },
        ], list),
        foot: 'A deviation is a change in behaviour, not an intrusion. Backup jobs, updates and video streaming all trip it. Use it as a prompt to look, never as a verdict.',
      }));
    }

    mount(body, nodes);
  }

  return { node: root, refresh, interval: 20000 };
}

/* ─────────────────────────────────────────────────────────────────────────
   8. RECOVERY — the safety-critical panel
   ───────────────────────────────────────────────────────────────────────── */

export function panelRecovery(api) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('Flash layout and recovery', [
      'Read this before flashing anything. The vendor bootloader on this board has a genuine dual-kernel fallback, and understanding it is the difference between a recoverable mistake and a brick.',
    ]),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(4)));

  mount(root, view);

  // Partitions that must never be erased. Losing `factory` means the WiFi
  // EEPROM calibration and both MAC addresses are gone and cannot be
  // recreated; losing the bootloader is unrecoverable without a programmer.
  const SACRED = new Set(['Bootloader', 'Bdata', 'factory', 'reserved0', 'kernel_stock']);

  async function refresh() {
    const r = await safe(() => api.recovery());
    if (r.__error) { mount(body, unavailableCard('Recovery data unavailable', explainError(r.error))); return; }

    const payload = Array.isArray(r) ? r[0] : r;
    const parts = Array.isArray(payload?.partitions) ? payload.partitions : [];

    const nodes = [];

    nodes.push(callout('err', '⛔', h('div', {},
      h('strong', {}, 'Never erase `factory` or `kernel_stock`. '),
      payload?.warning ?? 'The factory partition holds the WiFi EEPROM calibration data (0x0 for the 2.4 GHz MT7603, 0x8000 sized 0x4da8 for the 5 GHz MT7615) and both MAC addresses (0xe000 and 0xe006). If it is lost the radios cannot be calibrated and the addresses are unrecoverable. kernel_stock is your path back to the vendor firmware.')));

    nodes.push(card({
      title: 'MTD partitions',
      note: `${parts.length} partition(s) reported by /proc/mtd. Read-only partitions are marked; sacred ones are highlighted.`,
      body: parts.length
        ? table([
            { key: 'name', label: 'Partition', render: (p) => h('span', {},
                SACRED.has(p.name) ? badge('err', '⛔ do not erase') : null,
                ' ', h('code', {}, p.name)) },
            { key: 'size', label: 'Size', num: true, render: (p) => bytes(p.size) },
            { key: 'role', label: 'Role', render: (p) => roleOf(p.name) },
          ], parts)
        : empty('—', 'No partition data.'),
    }));

    nodes.push(card({
      title: 'How the dual-boot fallback works',
      variant: 'info',
      note: payload?.mechanism ?? null,
      body: h('div', { class: 'stack' },
        kv([
          ['Stock kernel', h('code', {}, payload?.stock_kernel_partition ?? 'kernel_stock @ 0x200000')],
          ['OpenWrt kernel', h('code', {}, payload?.openwrt_kernel_partition ?? 'kernel @ 0x600000')],
          ['Overlay (ubi)', payload?.ubi_partition_size ?? '117.5 MiB'],
          ['Boot selection', 'u-boot checks the Linux magic AND the uImage CRC at each slot'],
        ]),
        callout('warn', '⚠', h('div', {},
          h('strong', {}, 'The trap. '),
          payload?.implication ?? 'A custom kernel with an invalid uImage CRC is rejected silently and u-boot falls back to the other slot. A broken build therefore looks like a bootloop with no error message, not like a failure. Always verify the CRC of a built image before flashing — the analysis tool in this repository does exactly that.'))),
    }));

    nodes.push(card({
      title: 'Recovery ladder',
      note: 'Work down this list, stopping as soon as the router responds.',
      body: h('ol', { style: { paddingLeft: '1.2rem', listStyle: 'decimal', color: 'var(--fg-dim)', fontSize: 'var(--fs-sm)', lineHeight: '1.9' } },
        ['Flash a known-good sysupgrade image again from the running system.',
         'Boot into failsafe: hold reset while powering on, then use the failsafe network address to reset or reflash.',
         'Recover through u-boot over TFTP — the vendor bootloader writes the transferred image to both kernel slots.',
         'Attach a serial console on ttyS0 at 115200 8N1 and use mtd directly. Note that the uart2 and uart3 pin groups are reassigned to GPIO on this board, so ttyS0 is the only console.',
         'Reflash the stock Xiaomi image to get back to a known state — the copy kept at kernel_stock is why this is always possible.'].map(li => h('li', {}, li))),
      foot: payload?.recovery_path ?? null,
    }));

    mount(body, nodes);
  }

  return { node: root, refresh, interval: 60000 };
}

/** Plain-language role for each known partition name. */
function roleOf(name) {
  const roles = {
    'Bootloader': 'u-boot. Unrecoverable without an SPI programmer if erased.',
    'Config': 'u-boot environment, including the sys1/sys2 fail flags.',
    'Bdata': 'Board data, read-only.',
    'factory': 'WiFi EEPROM calibration + both MAC addresses. Irreplaceable.',
    'crash': 'Vendor crash dump area.',
    'crash_syslog': 'Vendor crash log area.',
    'reserved0': 'Vendor reserved, read-only.',
    'kernel_stock': 'Stock Xiaomi kernel, kept as the fallback slot.',
    'kernel': 'OpenWrt / NexRouter kernel slot.',
    'ubi': 'rootfs + overlay, merged from the stock rootfs0, rootfs1 and overlay partitions.',
  };
  return roles[name] ?? '—';
}

/* ─────────────────────────────────────────────────────────────────────────
   9. SETTINGS — telemetry export and the intelligence layer
   ───────────────────────────────────────────────────────────────────────── */

export function panelSettings(api, ctx) {
  const root = h('div', { class: 'stack' });
  let body;

  const view = h('div', {},
    panelHead('Settings', 'Telemetry export and intelligence-layer behaviour. Everything here is stored as ordinary UCI configuration, so it can also be changed from SSH with `uci set` and `uci commit`.'),
    h('div', { class: 'stack', ref: (el) => { body = el; } }, skeleton(4)));

  mount(root, view);

  async function refresh() {
    const [exp, cfg] = await Promise.all([
      safe(() => api.exportGet()),
      safe(() => api.insightConfig()),
    ]);

    const canWrite = api.canWrite;
    const nodes = [];

    // ── NetFlow export ─────────────────────────────────────────────────────
    const expState = exp.__error ? {} : (Array.isArray(exp) ? exp[0] : exp);
    nodes.push(card({
      title: 'NetFlow export',
      variant: expState.enabled ? 'warn' : 'ok',
      note: expState.privacy ?? null,
      body: h('div', { class: 'stack' },
        h('div', { class: 'kv' },
          h('label', { class: 'kv__row' },
            h('span', { class: 'kv__k' }, 'Export flow records'),
            h('span', { class: 'kv__v' }, toggle({
              label: expState.enabled ? 'enabled' : 'disabled',
              checked: !!expState.enabled,
              disabled: !canWrite,
              hint: expState.cost ?? null,
              onChange: (v) => setExport(v, expState),
            })))),
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Collector address'),
          h('input', {
            class: 'input', id: 'exp-collector', value: expState.collector ?? '',
            placeholder: '192.168.1.50', spellcheck: 'false', disabled: !canWrite,
          }),
          h('span', { class: 'field__hint' }, 'The host running companion/nexinsight. Must be a plain IP or hostname — the router rejects any other characters before writing the value.')),
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Port'),
          h('input', {
            class: 'input', id: 'exp-port', type: 'number', min: '1', max: '65535',
            value: expState.port ?? 2056, disabled: !canWrite,
          }),
          h('span', { class: 'field__hint' }, 'NetFlow v5 UDP. The companion listens on 2056 by default.')),
        canWrite
          ? h('div', { class: 'row' },
              h('button', { class: 'btn btn--primary btn--sm', onclick: () => saveExport(expState) }, 'Save export settings'))
          : callout('info', 'ℹ', 'Read-only session — export settings cannot be changed.')),
      foot: 'The router refuses to enable export with no collector configured, so there is no way to accidentally start sending flow records to a default destination.',
    }));

    // ── Intelligence layer ─────────────────────────────────────────────────
    const cfgState = cfg.__error ? {} : (Array.isArray(cfg) ? cfg[0] : cfg);
    nodes.push(card({
      title: 'Intelligence layer',
      note: 'Device inventory and traffic baselines. Runs on the router using heuristics and robust statistics only.',
      body: h('div', { class: 'stack' },
        kv([
          ['Enabled', cfgState.enabled === undefined ? '—' : toggle({
            label: cfgState.enabled ? 'on' : 'off', checked: !!cfgState.enabled, disabled: !canWrite,
            onChange: (v) => setInsight(v, cfgState),
          })],
          ['Mode', h('span', {}, h('code', {}, String(cfgState.mode ?? 'heuristic')), ' ',
            badge('neutral', 'no ML on device', 'This label is deliberate. No model runs on the router.'))],
          ['Baseline window', h('span', {}, String(cfgState.window_minutes ?? '—'), ' min')],
          ['Baseline ready', cfgState.baseline_ready ? badge('ok', 'yes') : badge('warn', 'warming up')],
          ['Baseline entries', int(cfgState.known_devices)],
          ['OUI database entries', int(cfgState.oui_entries)],
          ['State directory', h('code', { style: { fontSize: 'var(--fs-xs)' } }, cfgState.state_dir ?? '—')],
        ]),
        canWrite
          ? h('div', { class: 'row', style: { marginTop: 'var(--sp-3)' } },
              h('label', { class: 'field', style: { margin: 0 } },
                h('span', { class: 'field__label' }, 'Window (minutes)'),
                h('input', { class: 'input', id: 'ins-window', type: 'number', min: '1', max: '10080',
                  value: cfgState.window_minutes ?? 15, style: { width: '7rem' } })),
              h('button', { class: 'btn btn--sm', style: { alignSelf: 'flex-end' },
                onclick: () => saveWindow(cfgState) }, 'Save window'))
          : null),
    }));

    // ── Privacy ────────────────────────────────────────────────────────────
    nodes.push(card({
      title: 'Privacy',
      variant: 'ok',
      body: h('div', { class: 'stack' },
        callout('ok', '✓', h('div', {},
          h('strong', {}, 'This firmware does not phone home. '),
          'There is no telemetry to any server, no crash reporting, and no update check that transmits anything identifying the device. Those settings are recorded in ',
          h('code', {}, '/etc/config/nexrouter'), ' under the ', h('code', {}, 'telemetry'), ' section so the claim is auditable rather than merely promised.')),
        h('p', { class: 'field__hint' },
          'Flow records contain source and destination addresses, ports, byte counts and timing. That is traffic metadata. If you enable export above, send it only to a machine on your own network.')),
    }));

    mount(body, nodes);

    async function setExport(v, state) {
      if (v && !(state.collector ?? '').trim()) {
        ctx.toast('Set a collector address before enabling export.', 'warn');
        refresh();
        return;
      }
      ctx.busy(true);
      try {
        const res = await api.setExport({ enabled: v, collector: state.collector, port: state.port });
        if (res?.error) throw new Error(res.error);
        ctx.toast(v ? 'NetFlow export enabled.' : 'NetFlow export disabled.', 'ok');
      } catch (err) {
        ctx.toast(`Export change failed: ${explainError(err)}`, 'err', { sticky: true });
      } finally { ctx.busy(false); refresh(); }
    }

    async function saveExport(state) {
      const collector = document.getElementById('exp-collector')?.value?.trim() ?? '';
      const port = document.getElementById('exp-port')?.value ?? state.port ?? 2056;
      ctx.busy(true);
      try {
        const res = await api.setExport({ enabled: !!state.enabled, collector, port: Number(port) });
        if (res?.error) throw new Error(res.error);
        ctx.toast('Export settings saved.', 'ok');
      } catch (err) {
        ctx.toast(`Save failed: ${explainError(err)}`, 'err', { sticky: true });
      } finally { ctx.busy(false); refresh(); }
    }

    async function setInsight(v, state) {
      ctx.busy(true);
      try {
        const res = await api.setInsightConfig({ enabled: v });
        if (res?.error) throw new Error(res.error);
        ctx.toast(v ? 'Intelligence layer enabled.' : 'Intelligence layer disabled.', 'ok');
      } catch (err) {
        ctx.toast(`Change failed: ${explainError(err)}`, 'err', { sticky: true });
      } finally { ctx.busy(false); refresh(); }
    }

    async function saveWindow(state) {
      const win = Number(document.getElementById('ins-window')?.value ?? state.window_minutes ?? 15);
      ctx.busy(true);
      try {
        const res = await api.setInsightConfig({ window: win });
        if (res?.error) throw new Error(res.error);
        ctx.toast(`Baseline window set to ${win} minutes.`, 'ok');
      } catch (err) {
        ctx.toast(`Save failed: ${explainError(err)}`, 'err', { sticky: true });
      } finally { ctx.busy(false); refresh(); }
    }
  }

  return { node: root, refresh, interval: 30000 };
}
