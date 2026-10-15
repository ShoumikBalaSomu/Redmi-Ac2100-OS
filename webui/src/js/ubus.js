/**
 * ubus.js — minimal JSON-RPC client for OpenWrt's rpcd
 * ====================================================
 * OpenWrt exposes ubus over HTTP through uhttpd at the path `/ubus`. This is
 * the same API LuCI uses; NexRouter talks to it directly, which means no
 * second web framework and no server-side rendering layer.
 *
 * WIRE FORMAT
 * -----------
 * Request  POST /ubus   Content-Type: application/json
 *   { "jsonrpc": "2.0", "id": <n>, "method": "call",
 *     "params": [ "<session-id>", "<object>", "<method>", { ...args } ] }
 *
 * Response
 *   { "jsonrpc": "2.0", "id": <n>,
 *     "result": [ <ubus-status-code>, { ...payload } ] }
 *
 * The critical detail that trips people up: `result` is an ARRAY whose first
 * element is a *ubus* status code (0 = success), and whose second element is
 * the actual payload. A JSON-RPC-level "success" with a non-zero ubus code is
 * still a failure — most notably UBUS_STATUS_PERMISSION_DENIED (6) when the
 * rpcd ACL does not grant the caller that method, and UBUS_STATUS_NOT_FOUND
 * (4) when the object does not exist. Both must be surfaced distinctly: a
 * permission denial means "your session is read-only", not "the router is
 * broken", and conflating them produces confusing UI.
 *
 * AUTHENTICATION
 * --------------
 * `call session login` with {username,password} returns a ubus-rpc token in
 * the payload's `ubus_rpc_session` field. Subsequent calls pass that token as
 * the first param. We keep it in memory only — never localStorage or a cookie
 * — so it disappears on tab close and cannot be lifted from disk.
 *
 * SECURITY
 * --------
 * Access control is enforced server-side by rpcd against the ACL groups in
 * /usr/share/rpcd/acl.d/nexrouter.json. This client never assumes it can do
 * something; it attempts the call and handles UBUS_STATUS_PERMISSION_DENIED.
 * Hiding write controls for read-only sessions is a UX convenience, not a
 * security boundary.
 */

/** ubus status codes we care about. Full list is in libubus/common.h. */
export const UBUS_STATUS = Object.freeze({
  OK: 0,
  INVALID_COMMAND: 1,
  INVALID_ARGUMENT: 2,
  METHOD_NOT_FOUND: 3,
  NOT_FOUND: 4,
  NO_DATA: 5,
  PERMISSION_DENIED: 6,
  TIMEOUT: 7,
  NOT_SUPPORTED: 8,
  UNKNOWN_ERROR: 9,
  CONNECTION_FAILED: 10,
});

/** Human-readable text for the codes above, used in error messages. */
const STATUS_TEXT = Object.freeze({
  [UBUS_STATUS.INVALID_COMMAND]: 'invalid command',
  [UBUS_STATUS.INVALID_ARGUMENT]: 'invalid argument',
  [UBUS_STATUS.METHOD_NOT_FOUND]: 'method not found',
  [UBUS_STATUS.NOT_FOUND]: 'object not found',
  [UBUS_STATUS.NO_DATA]: 'no data',
  [UBUS_STATUS.PERMISSION_DENIED]: 'permission denied',
  [UBUS_STATUS.TIMEOUT]: 'timeout',
  [UBUS_STATUS.NOT_SUPPORTED]: 'not supported',
  [UBUS_STATUS.UNKNOWN_ERROR]: 'unknown error',
  [UBUS_STATUS.CONNECTION_FAILED]: 'connection failed',
});

/** Raised for any non-success ubus result. Carries the numeric code. */
export class UbusError extends Error {
  constructor(code, object, method, detail) {
    const text = STATUS_TEXT[code] ?? `ubus status ${code}`;
    super(`${object}.${method}: ${text}`);
    this.name = 'UbusError';
    this.code = code;
    this.object = object;
    this.method = method;
    this.detail = detail ?? null;
  }

  /** True when the server refused because of ACL, not because it is broken. */
  get isPermissionDenied() {
    return this.code === UBUS_STATUS.PERMISSION_DENIED;
  }

  /** True when the object/method is absent — e.g. a package is not installed. */
  get isMissing() {
    return this.code === UBUS_STATUS.NOT_FOUND ||
           this.code === UBUS_STATUS.METHOD_NOT_FOUND ||
           this.code === UBUS_STATUS.NOT_SUPPORTED;
  }
}

/** Raised when the HTTP layer itself fails (router down, DNS, CORS, 502…). */
export class TransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TransportError';
    this.cause = cause;
  }
}

export class UbusClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]      RPC endpoint. Defaults to `/ubus`, i.e.
   *                                  same-origin, so no CORS is involved when
   *                                  served by the router's own uhttpd.
   * @param {number} [opts.timeout]  Per-request timeout in ms.
   */
  constructor({ url = '/ubus', timeout = 15000 } = {}) {
    this.url = url;
    this.timeout = timeout;
    this.token = null;
    this._id = 0;
    /** True once `session login` has succeeded. */
    this.authenticated = false;
    /** Access groups reported by `session access`, used to gate write UI. */
    this.acls = [];
  }

  // ── low level ───────────────────────────────────────────────────────────

  /**
   * Perform one JSON-RPC call.
   * @param {string} object  ubus object, e.g. "nexrouter"
   * @param {string} method  ubus method, e.g. "overview"
   * @param {object} [params] method arguments
   * @param {object} [opts]
   * @param {string|null} [opts.session] override the session token
   * @returns {Promise<object>} the payload (second element of result)
   */
  async call(object, method, params = {}, { session } = {}) {
    const sid = session !== undefined ? session : (this.token ?? '00000000000000000000000000000000');
    const body = {
      jsonrpc: '2.0',
      id: ++this._id,
      method: 'call',
      params: [sid, object, method, params],
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        // Same-origin by default. When the UI is served from the router this
        // matters for nothing; when developing against a remote router over
        // the dev proxy it keeps cookies/credentials out of the request.
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new TransportError(`request to ${object}.${method} timed out after ${this.timeout} ms`, err);
      }
      throw new TransportError(
        `cannot reach the router at ${this.url} (${err.message}). Is it powered on and reachable?`, err);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // 404 usually means uhttpd-mod-ubus is missing or /ubus is not aliased;
      // 502/504 usually means rpcd is not running. Say which.
      if (res.status === 404) {
        throw new TransportError(
          `HTTP 404 from ${this.url} — is uhttpd-mod-ubus installed and rpcd running?`, null);
      }
      throw new TransportError(`HTTP ${res.status} ${res.statusText} from ${this.url}`, null);
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new TransportError(`malformed JSON from ${this.url}`, err);
    }

    if (json.error) {
      throw new TransportError(`rpcd error: ${json.error.message ?? JSON.stringify(json.error)}`, null);
    }

    const result = json.result;
    if (!Array.isArray(result)) {
      throw new TransportError(`unexpected rpcd response shape from ${this.url}`, null);
    }

    const [code, payload] = result;
    if (code !== UBUS_STATUS.OK) {
      throw new UbusError(code, object, method, payload ?? null);
    }
    return payload ?? {};
  }

  // ── session ─────────────────────────────────────────────────────────────

  /**
   * Authenticate. On success stores the session token in memory.
   * @param {string} username
   * @param {string} password
   */
  async login(username, password) {
    // The login call is made on the null session ('0'*32).
    const payload = await this.call('session', 'login', { username, password },
      { session: '00000000000000000000000000000000' });

    const token = payload.ubus_rpc_session;
    if (!token) {
      throw new TransportError('login succeeded but no session token was returned', null);
    }
    this.token = token;
    this.authenticated = true;

    // Discover what this session may actually do. rpcd returns a map of
    // object -> {method: {}}; we flatten it to "object.method" strings so
    // panels can ask `can('nexrouter.apply_profile')`.
    try {
      const acc = await this.call('session', 'access', { scope: 'ubus' });
      this.acls = this._flattenAcl(acc);
    } catch {
      // Older rpcd builds lack `session access`. Degrade to assuming the
      // read set works and letting write attempts fail visibly.
      this.acls = [];
    }
    return { token, username: payload.username ?? username, acls: this.acls };
  }

  _flattenAcl(acc) {
    const out = [];
    const scope = acc?.ubus ?? acc ?? {};
    for (const [obj, methods] of Object.entries(scope)) {
      if (!methods || typeof methods !== 'object') continue;
      for (const m of Object.keys(methods)) {
        out.push(m === '*' ? obj : `${obj}.${m}`);
      }
    }
    return out;
  }

  /**
   * Whether this session is permitted to call `object.method`.
   * Returns true when the ACL is unknown (older rpcd) so the UI stays usable
   * and any real denial surfaces as an error on the attempt itself.
   */
  can(object, method) {
    if (!this.acls.length) return true;
    return this.acls.includes(object) ||
           this.acls.includes(`${object}.${method}`) ||
           this.acls.includes(`${object}.*`);
  }

  /** True when the session may mutate NexRouter configuration. */
  get canWrite() {
    return this.can('nexrouter', 'apply_profile') ||
           this.can('nexrouter', 'set_offload') ||
           this.can('nexrouter', 'export_set');
  }

  /** End the session server-side so the token stops being valid. */
  async logout() {
    if (!this.token) return;
    try {
      await this.call('session', 'destroy', { session: this.token });
    } catch {
      // Best effort: if the router already dropped it there is nothing to do.
    }
    this.token = null;
    this.authenticated = false;
    this.acls = [];
  }

  // ── NexRouter object sugar ──────────────────────────────────────────────
  // Thin wrappers so panels read naturally and the object name is not
  // repeated (and therefore not typo'd) in a dozen places.

  overview()          { return this.call('nexrouter', 'overview'); }
  performance()       { return this.call('nexrouter', 'performance'); }
  profiles()          { return this.call('nexrouter', 'profiles'); }
  wifi()              { return this.call('nexrouter', 'wifi'); }
  farlink()           { return this.call('nexrouter', 'farlink'); }
  overclock()         { return this.call('nexrouter', 'overclock'); }
  recovery()          { return this.call('nexrouter', 'recovery'); }
  exportGet()         { return this.call('nexrouter', 'export_get'); }
  insightDevices()    { return this.call('nexrouter', 'insight_devices'); }
  insightAnomalies()  { return this.call('nexrouter', 'insight_anomalies'); }
  insightConfig()     { return this.call('nexrouter', 'insight_config'); }

  applyProfile(name) {
    return this.call('nexrouter', 'apply_profile', { name });
  }

  setOffload({ software, hardware }) {
    return this.call('nexrouter', 'set_offload', {
      ...(software === undefined ? {} : { software: software ? '1' : '0' }),
      ...(hardware === undefined ? {} : { hardware: hardware ? '1' : '0' }),
    });
  }

  setExport({ enabled, collector, port }) {
    return this.call('nexrouter', 'export_set', {
      enabled: enabled ? '1' : '0',
      ...(collector === undefined ? {} : { collector }),
      ...(port === undefined ? {} : { port: String(port) }),
    });
  }

  setInsightConfig({ enabled, export: exp, window }) {
    return this.call('nexrouter', 'insight_config_set', {
      ...(enabled === undefined ? {} : { enabled: enabled ? '1' : '0' }),
      ...(exp === undefined ? {} : { export: exp ? '1' : '0' }),
      ...(window === undefined ? {} : { window: String(window) }),
    });
  }

  // ── standard OpenWrt objects used by the UI ─────────────────────────────

  systemBoard()  { return this.call('system', 'board'); }
  systemInfo()   { return this.call('system', 'info'); }
  dhcpLeases()   { return this.call('dhcp', 'ipv4leases'); }
  networkDeviceStatus(dev) { return this.call('network.device', 'status', { name: dev }); }
  interfaceStatus(name)    { return this.call('network.interface', 'status', { interface: name }); }
  conntrack()              { return this.call('luci-rpc', 'getConntrackList'); }
}

/** Singleton used by the app. Same-origin by default. */
export const ubus = new UbusClient();
