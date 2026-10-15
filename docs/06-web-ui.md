# The Web Interface

NexRouter ships its own single-page application instead of a LuCI theme. This document explains why, how it works, and what each panel shows.

---

## 1. Why Not LuCI

LuCI is OpenWrt's default web interface. It is functional but has structural problems for this project:

- **Server-rendered Lua.** Every page hit executes Lua on the router, parses UCI configs, and generates HTML server-side. On a 128 MiB RAM target with both cores forwarding, this overhead matters under load.
- **Dated visual design.** The default themes look like 2010-era admin panels. Modern alternatives exist (see §7) but add their own dependencies.
- **Framework coupling.** LuCI is a framework, not just a UI. Customising it means learning its Lua MVC layer, its ACL system, and its template engine — three layers of abstraction between you and the data.
- **ubus is already the API.** OpenWrt exposes all system state via ubus JSON-RPC. A static SPA calling `/ubus` directly gets the same data as LuCI with zero server-side rendering overhead.

The NexRouter SPA talks to ubus natively. No second framework, no Lua runtime per request, no template engine. Just static files served by uhttpd and JSON-RPC calls to rpcd.

---

## 2. Architecture

### Serving

uhttpd serves the SPA from `/www/nex/` via an alias configured in the first-boot script:

```
config uhttpd 'nex'
    option listen_http '0'          # Shares the main listener
    option alias '/nex=/www/nex'
    option index_page 'index.html'
```

The SPA is accessible at `http://<router-ip>/nex/`. The standard LuCI interface remains available at `/cgi-bin/luci/` if installed (it is removed by default in NexRouter builds).

### Authentication

The SPA uses the existing rpcd session mechanism:

1. User submits credentials via the login form.
2. SPA calls `ubus call session login '{"username":"root","password":"..."}' `.
3. rpcd returns a session token (`ubus_rpc_session`).
4. SPA stores the token in memory (never in localStorage or cookies).
5. All subsequent ubus calls include `"jsonrpc":"2.0"` with the token in the auth header.
6. Session timeout is 3600 seconds (configured in first-boot). Logout invalidates the token server-side.

No custom auth layer. No JWT. No cookie management. The existing rpcd session infrastructure handles everything.

### Same-Origin, No CORS

The SPA is served from the same origin as `/ubus`. There are no cross-origin requests, no CORS headers, no preflight OPTIONS. This simplifies deployment and eliminates a class of security concerns.

---

## 3. ubus Wire Format

All communication uses JSON-RPC 2.0 over HTTP POST to `/ubus`.

### Request Format

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "call",
    "params": [
        "<session-token>",
        "<object>",
        "<method>",
        { /* arguments */ }
    ]
}
```

### Response Format

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "result": [
        0,
        { /* return data */ }
    ]
}
```

The `result` array's first element is the status code (0 = success). The second element is the method's return value.

### Worked Example: Overview

Request:

```bash
curl -s http://192.168.1.1/ubus -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "call",
    "params": ["abc123token", "nexrouter", "overview", {}]
}'
```

Response:

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "result": [0, {
        "hostname": "nexrouter",
        "uptime": 86412,
        "loadavg": [0.15, 0.10, 0.08],
        "kernel": "6.18.55",
        "release": "nexrouter-snapshot-r20261012",
        "board": "xiaomi_redmi-router-ac2100"
    }]
}
```

### Worked Example: Performance

Request:

```bash
curl -s http://192.168.1.1/ubus -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "call",
    "params": ["abc123token", "nexrouter", "performance", {}]
}'
```

Response (abbreviated):

```json
{
    "jsonrpc": "2.0",
    "id": 2,
    "result": [0, {
        "offload": {
            "software": true,
            "hardware": true,
            "flowtable_entries": 142,
            "flowtable_found": 3891,
            "flowtable_inserted": 3887
        },
        "conntrack": {
            "count": 287,
            "max": 65536,
            "percent": 0.44
        },
        "wan": {
            "rx_bytes": 1073741824,
            "tx_bytes": 536870912
        },
        "qdisc": {
            "type": "fq_codel",
            "cake_warning": null
        },
        "cores": [
            {"busy": 12400, "total": 892000},
            {"busy": 8900, "total": 891500}
        ],
        "irq_affinity": {
            "ethernet": "core0",
            "wifi": "core1"
        }
    }]
}
```

Key detail: the `offload.flowtable_*` counters come from `/proc/net/stat/nf_flowtable`. These show whether offload is **actually engaging**, not just configured. If `flowtable_found` stays at zero while `hardware` is true, something is wrong with your firewall rules or zone configuration.

---

## 4. ACL Groups and UI Capability

Three ACL groups defined in `build/files/usr/share/rpcd/acl.d/nexrouter.json`:

| Group | Access | UI Behaviour |
|---|---|---|
| `nexrouter-readonly` | All read methods: `overview`, `performance`, `profiles`, `wifi`, `overclock`, `recovery`, `export_get`, `insight_devices`, `insight_anomalies`, `insight_config`. Plus system/network/iwinfo/file/nlbwmon/hostapd/luci-rpc reads. | Full dashboard visibility. No write controls rendered. |
| `nexrouter-write` | Four mutating methods: `apply_profile`, `set_offload`, `export_set`, `insight_config_set`. | Write controls appear: profile selector, offload toggles, export config form. |
| `nexrouter-admin` | Wildcard access to all nexrouter methods plus system administration. | Full access including recovery operations. |

A read-only session sees everything but cannot change anything. The SPA checks available permissions on login and conditionally renders write controls.

---

## 5. Panel Inventory

| Panel | Data Source | Purpose |
|---|---|---|
| **Overview** | `nexrouter.overview` + `system.board` + `system.info` | Hostname, uptime, kernel version, release tag, load average. Landing page. |
| **Performance** | `nexrouter.performance` | Offload state with live flowtable counters, conntrack utilisation, WAN throughput, current qdisc, per-core busy%, IRQ affinity. CAKE warning surfaced prominently when detected. |
| **Profiles** | `nexrouter.profiles` + `nexrouter.apply_profile` | Four whitelisted profiles: throughput, balanced (default), bufferbloat, compat. Profile switch validates against whitelist before any UCI change. Bufferbloat profile explicitly disables HW offload and warns about the ~150 Mbps cap. |
| **WiFi** | `iwinfo` + `hostapd` ubus objects | Radio status, channel, width, client list, signal levels. Country code shown as unset until configured (deliberate — see [01-hardware-truth.md](./01-hardware-truth.md)). |
| **Devices** | `nexrouter.insight_devices` | Device inventory with IP, MAC, vendor, type, byte counters. Each entry shows `classified_by` evidence (hostname / vendor-oui / none). No bare guesses. |
| **Anomalies** | `nexrouter.insight_anomalies` | Active anomalies with metric, baseline, current value, z-score. Timestamped. Sorted by severity. |
| **Recovery** | `nexrouter.recovery` | MTD partition map, dual-boot status explanation, stock kernel availability. Read-only reference panel. |
| **Settings / Export** | `nexrouter.export_get/set` + `nexrouter.insight_config_get/set` | NetFlow export toggle (requires collector address), insight window/retention config, telemetry opt-in/out (all off by default). |

---

## 6. Deliberate UI Decisions

### Confidence Badges

Every performance number carries a confidence badge: CONFIRMED, ⚠️ ANECDOTAL, or INDICATIVE. Most published router benchmarks are anecdotal forum posts. Surfacing confidence level prevents users from treating a single iperf3 run as gospel. See [03-performance-reality.md](./03-performance-reality.md) §3 for the full table.

### CAKE Warning

When CAKE is detected as the active qdisc, the Performance panel displays a prominent warning: "CAKE active — throughput capped at ~150 Mbps." This is not subtle. Users who enable the bufferbloat profile need to see this immediately, not buried in a tooltip.

### Overclock Panel Is Report-Only

The overclock panel shows current frequency, stock frequency, architectural constraints, and risk information. **There is no slider, no button, no setter.** This is by design. Overclocking requires bootloader modification or a full source build with serial console access. Exposing a frequency input in the UI would imply it is safe and reversible. It is neither. See [03-performance-reality.md](./03-performance-reality.md) §5.

### Device Classification Evidence

The Devices panel shows `classified_by` for every device. If a device is classified by hostname, the user sees "hostname: iphone-14". If by OUI, they see "vendor: Apple". If unclassified, they see "none" — not a misleading guess. Transparency over polish.

### "No ML on This Device" Label

The intelligence/anomaly panels carry an explicit label: "Heuristic analysis — no machine learning model runs on this device." This is stated in the UCI config (`mode='heuristic'`) and reflected in the UI. Users deserve to know what is and is not happening. See [05-intelligence-layer.md](./05-intelligence-layer.md).

---

## 7. Zero-Dependency Rationale

The SPA is vanilla JavaScript with no framework, no bundler, and no build step required to view it. A build step exists (`webui/dist`) for minification, but the source is directly servable.

Why:

- **128 MiB RAM target.** Every dependency is RAM at runtime. React, Vue, or Angular pull in runtime libraries that consume megabytes of heap during DOM reconciliation. Vanilla JS does not.
- **No supply chain.** No npm audit, no node_modules, no transitive dependency vulnerabilities. The attack surface is the browser's native DOM API.
- **Auditability.** Any competent developer can read the source and understand exactly what it does. No JSX compilation, no virtual DOM diffing, no framework magic.
- **Longevity.** Frameworks churn. Vanilla JS against stable browser APIs does not break when a maintainer abandons a project.

The trade-off is developer ergonomics. For a management UI with ~8 panels and ~20 ubus endpoints, this is acceptable. For a larger application, reconsider.

---

## 8. Local Development

To develop against a real router without deploying after every change:

```bash
# In webui/ directory, start a dev server with proxy
# (example using Python's http.server + socat/nginx reverse proxy)

# Option A: nginx reverse proxy
server {
    listen 8080;
    location /nex/ {
        alias /path/to/nexrouter/webui/src/;
        try_files $uri $uri/ /nex/index.html;
    }
    location /ubus {
        proxy_pass http://192.168.1.1/ubus;
    }
}

# Option B: simple approach — SSH tunnel + local file server
ssh -L 8081:localhost:80 root@192.168.1.1
# Then serve webui/src/ locally and point /ubus calls at localhost:8081
```

The SPA's `/ubus` calls use relative paths, so any same-origin proxy works. No CORS configuration needed.

---

## 9. Extending with a New Panel

1. Add an HTML section in `webui/src/index.html` (or the appropriate template file).
2. Add a JS module in `webui/src/panels/` that calls the relevant ubus method.
3. If new ubus methods are needed, add them to the rpcd plugin (`build/files/usr/libexec/rpcd/nexrouter`) and update the ACL definitions.
4. Test against a live router using the local dev setup above.
5. Run the build step to produce `webui/dist/` for deployment.

The pattern is consistent across all existing panels: fetch data via ubus, render into DOM, handle errors gracefully.

---

## 10. LuCI Theme Alternatives

For users who prefer to stay on LuCI rather than use the NexRouter SPA:

| Theme | Licence | Notes |
|---|---|---|
| **luci-theme-argon** | Apache-2.0 | Most popular modern LuCI theme. Needs version matching for 22.03+. Active development. |
| **luci-theme-aurora** | MIT | Vite + Tailwind CSS. Genuinely modern stack. v0.11.0 (Feb 2026), ~318 stars. Best visual quality. |
| **luci-theme-material** | Apache-2.0 | Official OpenWrt theme. Conservative design, well-maintained. |

### Flash Cost Comparison

| Component | Size |
|---|---|
| LuCI + theme + dependencies | ~2–4 MB |
| NexRouter SPA (vanilla JS) | ~1–2 MB |
| Difference | ~1–2 MB |

On this board, the flash argument is nearly moot. The ubi partition is **117.5 MiB** — both options fit trivially. The real constraint is **RAM at runtime**. LuCI's Lua runtime and template engine consume more memory per request than a static SPA's one-time JS parse. Under heavy forwarding load with 128 MiB total, every megabyte of avoidable runtime overhead matters.

If flash were 16 MiB, the choice would be harder. At 128 MiB, choose based on runtime behaviour and maintenance philosophy, not storage.

---

## Sources

- [OpenWrt ubus documentation](https://openwrt.org/docs/techref/ubus)
- [rpcd session management](https://openwrt.org/docs/techref/rpcd)
- [uhttpd configuration](https://openwrt.org/docs/guide-user/services/webserver/uhttpd)
- luci-theme-argon: [github.com/jerrykuku/luci-theme-argon](https://github.com/jerrykuku/luci-theme-argon)
- luci-theme-aurora: [github.com/nickspaargaren/luci-theme-aurora](https://github.com/nickspaargaren/luci-theme-aurora)
