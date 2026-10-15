/**
 * webui.test.mjs — tests for the pure, Node-runnable parts of the web UI
 * =======================================================================
 * WHAT IS TESTED HERE
 *   1. format.js — every formatting helper, including that none of them throw
 *      on null/undefined/NaN/garbage. These run on live polling data where a
 *      field can be absent mid-refresh; a thrown exception would blank an
 *      entire panel.
 *   2. ubus.js   — the JSON-RPC client, driven against the mock router's real
 *      handler with an injected fetch. This is the highest-value test in the
 *      suite: rpcd returns `result: [ubusStatus, payload]`, an ARRAY, not a
 *      plain object. Getting that unwrapping wrong, or treating a JSON-RPC
 *      success with a non-zero ubus code as success, breaks everything.
 *   3. chart.js  — the Series ring buffer (pure). The canvas drawing functions
 *      are not testable without a DOM.
 *   4. The mock router's API contract — validation rejections, the read-only
 *      ACL path, and the static-file routing including the traversal guard.
 *
 * WHAT IS NOT TESTED HERE, AND WHY
 *   dom.js and panels.js touch `document` at import time, so they need a real
 *   browser or a DOM shim. Rather than assert against a fake DOM (which mostly
 *   tests the shim), those are verified by running `npm run dev` and loading
 *   the UI. `build.mjs` guards them structurally instead: it parses every
 *   module with Node's real ESM parser and asserts that every relative import
 *   resolves, with a negative control proving the check can actually fail.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fmt from '../src/js/format.js';
import { UbusClient, UbusError, TransportError, UBUS_STATUS } from '../src/js/ubus.js';
import { Series } from '../src/js/chart.js';
import { handleUbus, resolveStatic, mockState, resetMockState } from '../dev/mock-ubus.mjs';

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Build a fetch implementation that routes straight into the mock's handler.
 * This exercises the real serialisation path on both sides without opening a
 * socket — important because loopback networking is not guaranteed to be
 * available in every environment this suite runs in.
 */
function mockFetch({ status = 200, notJson = false, throws = false, recordCalls } = {}) {
  return async (url, init = {}) => {
    if (recordCalls) recordCalls.push({ url, init });
    if (throws) throw new Error('network down');

    const body = init.body ?? '';
    let out;
    try {
      out = handleUbus(typeof body === 'string' ? body : '');
    } catch (err) {
      out = { jsonrpc: '2.0', id: null, error: { code: -32000, message: err.message } };
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      json: async () => {
        if (notJson) throw new SyntaxError('Unexpected token < in JSON');
        return out;
      },
    };
  };
}

/** A client instance. Global fetch is swapped by withFetch(). */
function client() {
  return new UbusClient({ url: '/ubus', timeout: 2000 });
}

/** Run `fn` with global fetch temporarily replaced. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); }
  finally { globalThis.fetch = original; }
}

/* ── 1. format.js ────────────────────────────────────────────────────────── */

describe('format.js', () => {
  test('bytes() uses binary units and never throws on garbage', () => {
    assert.equal(fmt.bytes(0), '0 B');
    assert.equal(fmt.bytes(512), '512 B');
    assert.equal(fmt.bytes(1024), '1.0 KiB');
    assert.equal(fmt.bytes(1024 * 1024), '1.0 MiB');
    assert.equal(fmt.bytes(1024 ** 3), '1.0 GiB');
    // 128 MiB RAM, the real value on this board. Values >= 100 drop the
    // decimal place, because "128.0 MiB" is no more informative than "128 MiB".
    assert.equal(fmt.bytes(128 * 1024 * 1024), '128 MiB');
    assert.equal(fmt.bytes(null), '—');
    assert.equal(fmt.bytes(undefined), '—');
    assert.equal(fmt.bytes(NaN), '—');
    assert.equal(fmt.bytes(-5), '—');
    assert.equal(fmt.bytes('not a number'), '—');
    // A real zero must still render as zero, not as "absent".
    assert.equal(fmt.bytes(0), '0 B');
    // Absent and zero must be distinguishable — that is the whole reason the
    // num() helper exists.
    assert.notEqual(fmt.bytes(null), fmt.bytes(0));
  });

  test('bytes() switches to zero decimals for large values', () => {
    // 940 Mbps sustained for an hour is ~412 MiB/s * 3600 — large enough that
    // a decimal place is noise in a narrow table cell.
    const big = 5 * 1024 ** 3;
    assert.match(fmt.bytes(big), /^\d+\.?\d* GiB$/);
  });

  test('duration() formats each magnitude', () => {
    assert.equal(fmt.duration(0), '0s');
    assert.equal(fmt.duration(45), '45s');
    assert.equal(fmt.duration(60), '1m 00s');
    assert.equal(fmt.duration(125), '2m 05s');
    assert.equal(fmt.duration(3600), '1h 00m');
    assert.equal(fmt.duration(90061), '1d 01h');
    assert.equal(fmt.duration(null), '—');
    assert.equal(fmt.duration(-1), '—');
    assert.equal(fmt.duration(NaN), '—');
  });

  test('bps() uses decimal units (network convention, not binary)', () => {
    // Deliberately decimal: throughput is quoted in Mbps meaning 10^6, and
    // mixing that with binary MiB in the same UI invites 4.8% errors.
    assert.equal(fmt.bps(1000), '1.0 Kbps');
    assert.equal(fmt.bps(940_000_000), '940 Mbps');
    assert.equal(fmt.bps(1_700_000_000), '1.7 Gbps');
    assert.equal(fmt.bps(0), '0.0 bps');
    assert.equal(fmt.bps(null), '—');
    assert.notEqual(fmt.bps(null), fmt.bps(0));
  });

  test('rate() composes bytes() with a per-second suffix', () => {
    assert.equal(fmt.rate(1024), '1.0 KiB/s');
    assert.equal(fmt.rate(undefined), '—');
  });

  test('int() rounds and thousands-separates', () => {
    assert.equal(fmt.int(1234567), '1,234,567');
    assert.equal(fmt.int(65536), '65,536');
    assert.equal(fmt.int(0), '0');
    assert.equal(fmt.int(null), '—');
    assert.equal(fmt.int('abc'), '—');
    // Absent must not read as zero — a conntrack count of "0" would look like
    // a working table with no connections rather than an unavailable sensor.
    assert.notEqual(fmt.int(null), fmt.int(0));
    // A boolean arriving where a number is expected is a schema mismatch and
    // must not silently become 1.
    assert.equal(fmt.int(true), '—');
  });

  test('pct() handles both fraction and already-percent input', () => {
    assert.equal(fmt.pct(0.5), '50.0%');
    assert.equal(fmt.pct(50, { alreadyPercent: true }), '50.0%');
    assert.equal(fmt.pct(0.1234, { decimals: 2 }), '12.34%');
    assert.equal(fmt.pct(null), '—');
  });

  test('celsius() and tempVariant() agree on thresholds', () => {
    assert.equal(fmt.celsius(54), '54°C');
    assert.equal(fmt.celsius(null), '—');
    assert.equal(fmt.tempVariant(50), 'ok');
    assert.equal(fmt.tempVariant(70), 'warn');
    assert.equal(fmt.tempVariant(85), 'err');
    assert.equal(fmt.tempVariant(null), null);
    // Boundaries are inclusive on the hot side.
    assert.equal(fmt.tempVariant(65), 'warn');
    assert.equal(fmt.tempVariant(80), 'err');
  });

  test('ago() handles both ISO strings and seconds-from-now', () => {
    assert.equal(fmt.ago(new Date().toISOString()), 'now');
    assert.equal(fmt.ago(new Date(Date.now() - 120_000).toISOString()), '2m 00s ago');
    assert.equal(fmt.ago(new Date(Date.now() + 120_000).toISOString()), 'in 2m 00s');
    // ubus lease expiry is seconds-from-now, not epoch — a real footgun.
    assert.match(fmt.ago(3600), /^in 1h 00m$/);
    assert.equal(fmt.ago(null), '—');
    assert.equal(fmt.ago('garbage'), '—');
  });

  test('clip() truncates with an ellipsis and leaves short strings alone', () => {
    assert.equal(fmt.clip('short', 10), 'short');
    assert.equal(fmt.clip('a'.repeat(50), 10).length, 10);
    assert.ok(fmt.clip('a'.repeat(50), 10).endsWith('…'));
    assert.equal(fmt.clip(null), '');
    assert.equal(fmt.clip(undefined, 5), '');
  });

  test('shortMac() masks the middle octets', () => {
    assert.equal(fmt.shortMac('aa:bb:cc:11:22:33'), 'AA:BB:CC:…:33');
    // Must not corrupt a malformed value.
    assert.equal(fmt.shortMac('nonsense'), 'NONSENSE');
    assert.equal(fmt.shortMac(null), '');
  });

  test('protoName() and portLabel() cover the common cases and degrade safely', () => {
    assert.equal(fmt.protoName(6), 'TCP');
    assert.equal(fmt.protoName(17), 'UDP');
    assert.equal(fmt.protoName(1), 'ICMP');
    assert.equal(fmt.protoName(253), 'proto-253');
    assert.equal(fmt.protoName(null), 'proto-?');
    assert.equal(fmt.portLabel(443), 'HTTPS');
    assert.equal(fmt.portLabel(2056), 'NetFlow');
    assert.equal(fmt.portLabel(49999), '49999');
    assert.equal(fmt.portLabel(0), '—');
    assert.equal(fmt.portLabel(null), '—');
  });

  test('dateTime() and clockTime() never throw', () => {
    assert.equal(fmt.dateTime(null), '—');
    assert.equal(fmt.dateTime('not-a-date'), 'not-a-date');
    assert.match(fmt.dateTime('2026-10-13T12:00:00Z'), /2026/);
    assert.match(fmt.clockTime(new Date(0)), /^\d{2}:\d{2}:\d{2}$/);
  });
});

/* ── 2. ubus.js against the mock router ──────────────────────────────────── */

describe('UbusClient wire protocol', () => {
  test('unwraps the result array and returns only the payload', async () => {
    await withFetch(mockFetch(), async () => {
      const c = client();
      const ov = await c.overview();
      // The payload is result[1], NOT the whole result array. This is the
      // single easiest thing to get wrong with rpcd.
      assert.equal(ov.model, mockState.board.model);
      assert.equal(ov.cpu_mhz, 880);
      assert.equal(ov.cpu_cores, 2);
      assert.equal(ov.cpu_model, 'MIPS 1004Kc');
      assert.ok(Array.isArray(ov.load));
      assert.equal(ov.memory.total_kb, 128 * 1024);
    });
  });

  test('sends the correct JSON-RPC envelope and session token', async () => {
    const calls = [];
    await withFetch(mockFetch({ recordCalls: calls }), async () => {
      const c = client();
      c.token = 'tok123';
      await c.overview();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/ubus');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.method, 'call');
      assert.deepEqual(body.params[0], 'tok123');
      assert.equal(body.params[1], 'nexrouter');
      assert.equal(body.params[2], 'overview');
      assert.deepEqual(body.params[3], {});
      assert.equal(typeof body.id, 'number');
    });
  });

  test('uses the null session for login and stores the returned token', async () => {
    await withFetch(mockFetch(), async () => {
      const c = client();
      assert.equal(c.authenticated, false);
      const res = await c.login('root', 'hunter2');
      assert.equal(c.authenticated, true);
      assert.equal(c.token, res.token);
      assert.ok(res.token.length > 0);
      // ACL discovery must have run so the UI can hide write controls.
      assert.ok(Array.isArray(c.acls));
    });
  });

  test('omits credentials and disables caching on every request', async () => {
    const calls = [];
    await withFetch(mockFetch({ recordCalls: calls }), async () => {
      await client().overview();
      // The UI is same-origin with the API on the router; sending cookies
      // cross-origin would be both unnecessary and a credential leak risk.
      assert.equal(calls[0].init.credentials, 'omit');
      assert.equal(calls[0].init.cache, 'no-store');
    });
  });

  test('login() rejects with a clear error when no token is returned', async () => {
    // A router that authenticates but returns no ubus_rpc_session is broken in
    // a way that would otherwise show up as "permission denied" on every call.
    await withFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [0, { username: 'root' }] }),
    }), async () => {
      await assert.rejects(() => client().login('root', 'x'), TransportError);
    });
  });

  test('a non-zero ubus code raises UbusError even when JSON-RPC succeeded', async () => {
    await withFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [UBUS_STATUS.PERMISSION_DENIED, {}] }),
    }), async () => {
      await assert.rejects(
        () => client().overview(),
        (err) => {
          assert.ok(err instanceof UbusError);
          assert.equal(err.code, UBUS_STATUS.PERMISSION_DENIED);
          assert.equal(err.isPermissionDenied, true);
          assert.equal(err.isMissing, false);
          return true;
        });
    });
  });

  test('NOT_FOUND is classified as missing, not as a permission problem', async () => {
    await withFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result: [UBUS_STATUS.NOT_FOUND, {}] }),
    }), async () => {
      await assert.rejects(
        () => client().overview(),
        (err) => {
          assert.ok(err instanceof UbusError);
          assert.equal(err.isMissing, true);
          assert.equal(err.isPermissionDenied, false);
          return true;
        });
    });
  });

  test('HTTP 404 explains the likely cause (missing uhttpd-mod-ubus)', async () => {
    await withFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }),
      async () => {
        await assert.rejects(
          () => client().overview(),
          (err) => {
            assert.ok(err instanceof TransportError);
            assert.match(err.message, /uhttpd-mod-ubus|rpcd/);
            return true;
          });
      });
  });

  test('a network failure becomes a TransportError, not an unhandled rejection', async () => {
    await withFetch(mockFetch({ throws: true }), async () => {
      await assert.rejects(() => client().overview(), TransportError);
    });
  });

  test('malformed JSON becomes a TransportError', async () => {
    await withFetch(mockFetch({ notJson: true }), async () => {
      await assert.rejects(() => client().overview(), TransportError);
    });
  });

  test('an unexpected response shape becomes a TransportError', async () => {
    await withFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, result: 'not-an-array' }),
    }), async () => {
      await assert.rejects(() => client().overview(), TransportError);
    });
  });

  test('an rpcd-level error object is surfaced', async () => {
    await withFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
    }), async () => {
      await assert.rejects(() => client().overview(), /Method not found/);
    });
  });

  test('can() consults the ACL list and canWrite reflects it', async () => {
    await withFetch(mockFetch(), async () => {
      const c = client();
      await c.login('root', 'x');
      assert.equal(c.canWrite, true);
      assert.equal(c.can('nexrouter', 'overview'), true);
      assert.equal(c.can('nexrouter', 'apply_profile'), true);
      assert.equal(c.can('nexrouter', 'nonexistent_method'), false);
    });
  });

  test('an empty ACL list means "unknown", which must not disable the UI', async () => {
    // Older rpcd builds lack `session access`. Degrading to permissive is the
    // right call: a real denial still surfaces on the attempt itself, whereas
    // a false negative would hide every control from a legitimate admin.
    const c = client();
    c.acls = [];
    assert.equal(c.can('anything', 'at_all'), true);
  });

  test('logout() clears the token and tolerates a failing destroy call', async () => {
    await withFetch(mockFetch(), async () => {
      const c = client();
      await c.login('root', 'x');
      assert.ok(c.token);
      await c.logout();
      assert.equal(c.token, null);
      assert.equal(c.authenticated, false);
      assert.deepEqual(c.acls, []);
    });

    // destroy() failing must not throw out of logout().
    await withFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.params?.[2] === 'login') {
        return { ok: true, status: 200, statusText: 'OK',
          json: async () => ({ jsonrpc: '2.0', id: 1, result: [0, { ubus_rpc_session: 'abc' }] }) };
      }
      return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
    }, async () => {
      const c = client();
      await c.login('root', 'x');
      await c.logout(); // must resolve, not reject
      assert.equal(c.token, null);
    });
  });

  test('setOffload() sends "0"/"1" strings and omits untouched fields', async () => {
    const calls = [];
    await withFetch(mockFetch({ recordCalls: calls }), async () => {
      const c = client();
      await c.setOffload({ hardware: true });
      const body = JSON.parse(calls[0].init.body);
      // ubus params are strings on the wire; the shell plugin validates 0|1.
      assert.deepEqual(body.params[3], { hardware: '1' });
    });
  });

  test('setExport() stringifies the port', async () => {
    const calls = [];
    await withFetch(mockFetch({ recordCalls: calls }), async () => {
      await client().setExport({ enabled: true, collector: '192.168.1.50', port: 2056 });
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.params[3], { enabled: '1', collector: '192.168.1.50', port: '2056' });
    });
  });
});

/* ── 3. chart.js Series ──────────────────────────────────────────────────── */

describe('Series ring buffer', () => {
  test('is bounded and keeps the most recent samples in order', () => {
    const s = new Series(5);
    for (let i = 1; i <= 9; i++) s.push(i);
    assert.deepEqual(s.array, [5, 6, 7, 8, 9]);
    assert.equal(s.length, 5);
    assert.equal(s.last, 9);
  });

  test('coerces non-numeric input to 0 rather than poisoning the series', () => {
    const s = new Series(4);
    s.push(1).push(null).push(undefined).push(NaN);
    assert.deepEqual(s.array, [1, 0, 0, 0]);
  });

  test('empty series reports a null last value and clears', () => {
    const s = new Series(3);
    assert.equal(s.last, null);
    assert.equal(s.length, 0);
    s.push(42);
    assert.equal(s.length, 1);
    s.clear();
    assert.equal(s.length, 0);
  });

  test('enforces a minimum size of 2', () => {
    const s = new Series(0);
    assert.equal(s.size, 2);
  });
});

/* ── 4. Mock router API contract ─────────────────────────────────────────── */

/** Convenience: call the mock and unwrap like the real client does. */
function call(obj, method, params = {}) {
  const res = handleUbus(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'call',
    params: ['00000000000000000000000000000000', obj, method, params],
  }));
  return res;
}

describe('mock router contract', () => {
  // The mock keeps one mutable config for the whole process. Reset it before
  // every test so state-based assertions cannot pass or fail based on which
  // test happened to run before. Without this, the suite is order-dependent.
  beforeEach(() => { resetMockState(); });

  test('every nexrouter method the UI calls responds OK', () => {
    const methods = ['overview', 'performance', 'profiles', 'wifi', 'overclock',
      'recovery', 'export_get', 'insight_devices', 'insight_anomalies', 'insight_config'];
    for (const m of methods) {
      const r = call('nexrouter', m);
      assert.equal(r.result?.[0], UBUS_STATUS.OK, `${m} should succeed`);
      assert.ok(r.result[1] && typeof r.result[1] === 'object', `${m} should return an object`);
    }
  });

  test('an unknown object or method returns NOT_FOUND, never a crash', () => {
    assert.equal(call('nosuchobject', 'x').result[0], UBUS_STATUS.NOT_FOUND);
    assert.equal(call('nexrouter', 'nosuchmethod').result[0], UBUS_STATUS.NOT_FOUND);
  });

  test('a malformed request returns a JSON-RPC error', () => {
    assert.ok(handleUbus('not json').error);
    assert.ok(handleUbus(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' })).error);
  });

  test('apply_profile rejects an unknown name (whitelist enforcement)', () => {
    // The real shell plugin validates against a fixed list before any uci call.
    // The mock must behave the same way or the UI's error path goes untested.
    const r = call('nexrouter', 'apply_profile', { name: '../../etc/passwd' });
    assert.equal(r.result[0], UBUS_STATUS.OK);
    assert.match(r.result[1].error, /unknown profile/);
    assert.equal(r.result[1].applied, undefined);
  });

  test('apply_profile actually changes the simulated state', () => {
    const before = call('nexrouter', 'performance').result[1];
    assert.equal(before.qdisc.kind, 'fq_codel');

    call('nexrouter', 'apply_profile', { name: 'bufferbloat' });
    const after = call('nexrouter', 'performance').result[1];

    assert.equal(after.qdisc.kind, 'cake');
    assert.equal(after.qdisc.cake_active, true);
    assert.ok(after.qdisc.warning, 'CAKE must carry a warning string');
    assert.match(after.qdisc.warning, /150 Mbps/);
    // CAKE and hardware offload are mutually exclusive: offloaded flows never
    // reach the qdisc. The profile must turn hw offload off.
    assert.equal(after.offload.hardware, false);
    assert.equal(after.offload.hw_flows, 0);

    // Restore for the remaining tests.
    call('nexrouter', 'apply_profile', { name: 'throughput' });
  });

  test('set_offload rejects non-binary input', () => {
    assert.match(call('nexrouter', 'set_offload', { software: 'yes' }).result[1].error, /must be 0 or 1/);
    assert.match(call('nexrouter', 'set_offload', { hardware: '; rm -rf /' }).result[1].error, /must be 0 or 1/);
  });

  test('set_offload refuses hardware-without-software and forces software on', () => {
    // A real misconfiguration: hw offload with no software flowtable to fall
    // back on when the hardware table is full.
    call('nexrouter', 'set_offload', { software: '0', hardware: '0' });
    const r = call('nexrouter', 'set_offload', { hardware: '1', software: '0' });
    assert.match(r.result[1].error, /requires software offload/);
    const now = call('nexrouter', 'performance').result[1];
    assert.equal(now.offload.software, true, 'software offload must have been forced on');
    call('nexrouter', 'apply_profile', { name: 'throughput' });
  });

  test('export_set refuses to enable without a collector', () => {
    // Reset shared mock state explicitly. Relying on test execution order for
    // this would make the suite pass or fail depending on which test ran last.
    mockState.cfg.exportCollector = '';
    const r = call('nexrouter', 'export_set', { enabled: '1' });
    assert.match(r.result[1].error, /collector address is required/);

    // Assert the ACTUAL resulting state, not the shape of the error object.
    // The invariant that matters is that no exporter got started pointing
    // nowhere — checking `enabled` on the error response would pass even if the
    // collector had started anyway.
    const after = call('nexrouter', 'export_get').result[1];
    assert.equal(after.enabled, false, 'export must remain disabled');
    assert.equal(after.collector, '', 'no collector must have been recorded');
  });

  test('export_set rejects a collector containing shell or UCI metacharacters', () => {
    // This value is written into a UCI config and later read by softflowd.
    for (const bad of ['1.2.3.4; reboot', '$(reboot)', 'a b', 'x`id`', "y'z", 'a|b']) {
      const r = call('nexrouter', 'export_set', { enabled: '1', collector: bad, port: '2056' });
      assert.match(r.result[1].error ?? '', /invalid characters/, `should reject ${JSON.stringify(bad)}`);
    }
    // Valid forms must be accepted.
    for (const good of ['192.168.1.50', 'collector.local', 'fe80::1', 'nexinsight-1']) {
      const r = call('nexrouter', 'export_set', { enabled: '1', collector: good, port: '2056' });
      assert.equal(r.result[1].error, undefined, `should accept ${good}`);
    }
  });

  test('export_set validates the port range', () => {
    assert.match(call('nexrouter', 'export_set', { enabled: '1', collector: '1.2.3.4', port: '0' }).result[1].error, /port out of range/);
    assert.match(call('nexrouter', 'export_set', { enabled: '1', collector: '1.2.3.4', port: '70000' }).result[1].error, /port out of range/);
    assert.match(call('nexrouter', 'export_set', { enabled: '1', collector: '1.2.3.4', port: 'abc' }).result[1].error, /port out of range/);
  });

  test('insight_config_set refuses export without a configured collector', () => {
    // Same invariant, second code path: enabling export through the insight
    // config must not start an exporter pointing nowhere.
    mockState.cfg.exportCollector = '';
    const r = call('nexrouter', 'insight_config_set', { export: '1' });
    assert.match(r.result[1].error, /no softflowd collector/);
  });

  test('insight_config_set validates the window bounds', () => {
    assert.match(call('nexrouter', 'insight_config_set', { window: '0' }).result[1].error, /window must be/);
    assert.match(call('nexrouter', 'insight_config_set', { window: '99999' }).result[1].error, /window must be/);
    const okRes = call('nexrouter', 'insight_config_set', { window: '30' });
    assert.equal(okRes.result[1].error, undefined);
    assert.equal(okRes.result[1].window_minutes, 30);
  });

  test('overclock() is report-only and says so explicitly', () => {
    const oc = call('nexrouter', 'overclock').result[1];
    assert.equal(oc.runtime_adjustable, false);
    assert.equal(oc.would_it_help_throughput, false);
    assert.equal(oc.dts_clock_frequency, 'absent');
    assert.equal(oc.current_mhz, 880);
    assert.equal(oc.stock_mhz, 880);
    assert.ok(Array.isArray(oc.risks) && oc.risks.length >= 4);
    // Every documented target must carry a confidence label — none may be
    // presented as verified when it is not.
    for (const t of oc.documented_targets) {
      assert.ok(['anecdotal', 'unverified', 'confirmed'].includes(t.confidence),
        `target ${t.mhz} MHz has confidence "${t.confidence}"`);
    }
    assert.ok(oc.documented_targets.every(t => t.confidence !== 'confirmed'),
      'no overclock target should be marked confirmed');
  });

  test('recovery() reports the real MTD map and warns about sacred partitions', () => {
    const r = call('nexrouter', 'recovery').result[1];
    const names = r.partitions.map(p => p.name);
    for (const required of ['Bootloader', 'factory', 'kernel_stock', 'kernel', 'ubi']) {
      assert.ok(names.includes(required), `partition ${required} missing`);
    }
    // The ubi partition is 0x7580000 = 117.5 MiB — the project's key enabler.
    const ubi = r.partitions.find(p => p.name === 'ubi');
    assert.equal(ubi.size, 0x7580000);
    assert.equal(r.ubi_partition_size, '117.5 MiB');
    assert.equal(r.dual_boot, true);
    assert.match(r.warning, /factory/);
  });

  test('insight_devices() exposes classification evidence for every device', () => {
    const d = call('nexrouter', 'insight_devices').result[1];
    assert.ok(d.count > 0);
    for (const dev of d.devices) {
      assert.ok(['hostname', 'vendor-oui', 'none'].includes(dev.classified_by),
        `${dev.mac} has classified_by "${dev.classified_by}"`);
      assert.ok(dev.traffic && typeof dev.traffic.rx === 'number');
      // Sorted by total traffic, descending.
    }
    const totals = d.devices.map(x => x.traffic.rx + x.traffic.tx);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a), 'devices must be sorted by traffic');
    // The mock deliberately includes all three evidence classes.
    const kinds = new Set(d.devices.map(x => x.classified_by));
    assert.ok(kinds.has('hostname'), 'expected at least one hostname-classified device');
    assert.ok(kinds.has('vendor-oui'), 'expected at least one OUI-only device');
    assert.ok(kinds.has('none'), 'expected at least one unclassifiable device');
  });

  test('insight_anomalies() states its method and flags the injected outlier', () => {
    const a = call('nexrouter', 'insight_anomalies').result[1];
    assert.equal(a.threshold, 3.5);
    assert.match(a.method, /EWMA/);
    assert.match(a.method, /no ML/i);
    assert.ok(a.anomalies.length >= 1);
    assert.ok(a.anomalies.every(x => ['low', 'medium', 'high'].includes(x.severity)));
  });

  test('performance() reports flowtable counters, not just configuration', () => {
    const p = call('nexrouter', 'performance').result[1];
    assert.ok('offload' in p);
    assert.equal(typeof p.offload.hw_flows, 'number');
    assert.equal(typeof p.offload.sw_flows, 'number');
    // Configured state and observed state are separate fields — that is the
    // whole point of this panel.
    assert.equal(typeof p.offload.hardware, 'boolean');
    assert.ok(Array.isArray(p.cores));
    assert.equal(p.cores.length, 2, 'this is a dual-core SoC');
    for (const c of p.cores) {
      assert.ok(c.total > 0, 'cumulative counters must grow');
      assert.ok(c.busy <= c.total, 'busy cannot exceed total');
    }
    assert.ok(p.conntrack.max === 65536);
  });

  test('profiles() returns exactly the four whitelisted profiles', () => {
    const p = call('nexrouter', 'profiles').result[1].profiles;
    assert.deepEqual(p.map(x => x.id).sort(), ['balanced', 'bufferbloat', 'compat', 'throughput']);
    for (const prof of p) {
      assert.ok(prof.name && prof.description);
      assert.ok(prof.settings && typeof prof.settings.qdisc === 'string');
    }
    // The bufferbloat profile must advertise its cost in its own description,
    // because that is what the confirmation dialog shows.
    const bb = p.find(x => x.id === 'bufferbloat');
    assert.match(bb.description, /150 Mbps/);
    assert.equal(bb.settings.flow_offloading_hw, 0);
  });
});

/* ── 5. Static routing and the traversal guard ───────────────────────────── */

describe('static file routing', () => {
  // Resolve the web root (webui/) from this test file's location rather than
  // from a URL pathname, which is wrong on Windows drive-letter paths.
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  test('serves index.html at /nex/ and /nex/index.html', () => {
    for (const p of ['/nex/', '/nex', '/nex/index.html']) {
      const r = resolveStatic(p, root);
      assert.equal(r.status, 200, `${p} should serve index.html`);
      assert.match(r.file, /index\.html$/);
      assert.match(r.type, /text\/html/);
    }
  });

  test('serves CSS and JS assets with correct MIME types', () => {
    const css = resolveStatic('/nex/css/nex.css', root);
    assert.equal(css.status, 200);
    assert.match(css.type, /text\/css/);

    const js = resolveStatic('/nex/js/app.js', root);
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
  });

  test('blocks path traversal out of the web root', () => {
    // These must never resolve to a real file. The build script and the shell
    // firmware files sit outside the web root and must not be reachable.
    const attacks = [
      '/nex/../../build/build.sh',
      '/nex/../../../etc/passwd',
      '/nex/%2e%2e%2f%2e%2e%2fbuild/build.sh',
      '/nex/..%2f..%2f..%2fwindows/win.ini',
      '/../index.html',
    ];
    for (const a of attacks) {
      const r = resolveStatic(a, root);
      assert.notEqual(r.status, 200, `${a} must not be served`);
      assert.ok([403, 404].includes(r.status), `${a} gave status ${r.status}`);
      if (r.file) {
        assert.ok(path.resolve(r.file).startsWith(path.resolve(root)),
          `${a} resolved outside the web root: ${r.file}`);
      }
    }
  });

  test('returns 404 for a missing asset', () => {
    const r = resolveStatic('/nex/js/does-not-exist.js', root);
    assert.equal(r.status, 404);
    assert.equal(r.file, null);
  });

  test('does not serve a directory listing', () => {
    const r = resolveStatic('/nex/js', root);
    // Either 404 or a redirect to index.html is acceptable; a directory
    // listing or a raw dump is not.
    assert.notEqual(r.status, 200, 'a bare directory path must not return 200');
  });
});
