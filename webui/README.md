# NexRouter Web UI

A dependency-free single-page dashboard for NexRouter, served by the router's
own `uhttpd` and backed by `rpcd`/`ubus` JSON-RPC.

**149 KiB total, zero runtime dependencies, no build step required to run it.**

---

## Why this is not a LuCI theme

LuCI is a server-rendered Lua framework. Theming it only restyles markup you do
not control, and its request model is a full page transition per action. But
OpenWrt already exposes a first-class JSON-RPC API through `rpcd` at `/ubus` —
the very API LuCI itself consumes. Talking to that directly means:

- **One origin.** The SPA and the API are both served by the router at
  `http://<router>/nex/`, so there is no CORS, no second listener, and `rpcd`'s
  session authentication applies unchanged. Access control lives in
  `/usr/share/rpcd/acl.d/nexrouter.json`, not in the client.
- **No framework.** Zero dependencies, no vendor bundle to parse on a device
  with 128 MiB of RAM where both CPU cores are needed for packet forwarding.
- **Real state.** The UI polls ubus objects and renders live counters. That is
  how it can show whether flow offload is *actually engaging* (kernel flowtable
  counters) rather than merely *configured* — the distinction that matters most
  on this hardware.

For the full architecture and the comparison against LuCI themes (Argon, Aurora,
Material), see [`docs/06-web-ui.md`](../docs/06-web-ui.md).

---

## Layout

```
webui/
├── index.html          # shell: login gate, topbar vitals, nav, panel host
├── package.json        # scripts only; no dependencies
├── build.mjs           # validate + copy src/ → dist/
├── src/
│   ├── css/nex.css     # design tokens + all component styles (~30 KB)
│   └── js/
│       ├── app.js      # entry: login, panel router, polling lifecycle
│       ├── ubus.js     # JSON-RPC client (session auth, ACL, error classes)
│       ├── dom.js      # h() element builder — XSS-safe by construction
│       ├── format.js   # telemetry formatters (bytes, rate, duration, …)
│       ├── chart.js    # canvas sparklines + Series ring buffer
│       └── panels.js   # the nine panels
├── dev/
│   └── mock-ubus.mjs   # development stand-in for a real AC2100
├── test/
│   └── webui.test.mjs  # 57 tests: wire protocol, formatters, contract
└── dist/               # build output (git-ignored); shipped to /www/nex
```

---

## Development

Run the whole UI against a simulated router — no hardware needed:

```sh
node dev/mock-ubus.mjs            # http://127.0.0.1:8080/nex/
node dev/mock-ubus.mjs --port 9000
node dev/mock-ubus.mjs --readonly     # simulate a read-only ACL session
node dev/mock-ubus.mjs --no-offload   # start with offload disabled
node dev/mock-ubus.mjs --cake         # start with CAKE active
```

Sign in with **any** username and password (or `root` + empty).

The mock implements every `nexrouter.*` method against the real board's
verified values — 880 MHz, 2 cores, 128 MiB RAM, the real MTD map — and simulates
live-moving counters, the four performance profiles, a device inventory with
deliberately mixed classification evidence, and an anomaly outlier. It is a UI
development aid; it does **not** model router behaviour.

> **Developing against a real router instead:** serve `webui/` from any static
> server and point the ubus client's `url` at the router (`new UbusClient({ url:
> 'http://192.168.1.1/ubus' })`). You will need the router to send CORS headers,
> which is why the on-device deployment uses same-origin serving instead.

---

## Build & test

```sh
node build.mjs            # validate, then copy src/ → dist/
node build.mjs --check    # validate only, write nothing
node build.mjs --clean    # remove dist/

node --test test/webui.test.mjs
```

`build.mjs` does no transpiling or bundling. It:

1. Parses every module with Node's real ESM parser (`node --check`) and verifies
   every relative import resolves — a typo'd import is otherwise a silent blank
   page. A **negative control** asserts the check can actually fail, because a
   validator that always passes is worse than none.
2. Checks `index.html` tag balance, that referenced assets exist, and that the
   element ids the app looks up are present.
3. Copies into `dist/` and reports total transfer size.

The router build (`build/build.sh`) uses `dist/` if present, otherwise runs
`npm run build` first.

---

## Design decisions worth knowing

**Security.** `dom.js`'s `h()` builds elements through the DOM API and inserts
data as text nodes — never `innerHTML`. This UI renders network-derived strings
(DHCP hostnames, mDNS names, OUI vendor text). Assigning those via `innerHTML`
would be a stored-XSS vulnerability on a device whose admin UI is reachable from
the LAN, which on a router means an attacker could reconfigure the network.

**Honesty in the UI, enforced in code.** Every performance figure carries a
confidence badge (`confirmed` / `anecdotal` / `indicative`), because most
published router throughput numbers are single forum reports. The overclock panel
is report-only with no slider — see [`docs/03-performance-reality.md`](../docs/03-performance-reality.md).
The CAKE warning is shown in the control itself before you can enable it. The
devices panel states plainly that no ML runs on the router and shows the
`classified_by` evidence for each guess.

**Polling.** Only the active panel polls, on its own interval, with an in-flight
guard so a slow call can't queue up unboundedly. Polling pauses when the tab is
hidden. On a device where both cores forward packets, a dashboard polling six
panels in the background is stealing cycles from the network.

**Absent vs. zero.** `format.js` distinguishes a missing value (em dash) from a
real zero, because `Number(null) === 0` and a telemetry UI that renders an
unavailable sensor as "0°C" is actively misleading. This is unit-tested.

---

## Panels

| Panel | ubus methods | Notes |
|-------|-------------|-------|
| Overview | `overview`, `performance`, `wifi` | vitals, per-core load, radios |
| Performance | `performance` | offload state **and** live flowtable counters |
| Profiles | `profiles`, `apply_profile` | 4 whitelisted profiles |
| CPU clock | `overclock` | report-only by design |
| Wireless | `wifi` | mt76 radios, per-station rates |
| Devices | `insight_devices`, `insight_config` | inventory + classification evidence |
| Anomalies | `insight_anomalies` | EWMA + robust deviation, method shown |
| Settings | `export_*`, `insight_config_*` | NetFlow export, privacy |
| Recovery | `recovery` | MTD map, dual-boot, brick warnings |

Keyboard: press `g` then `o`/`p`/`r`/`c`/`w`/`d`/`a`/`s`/`f` to jump to a panel.

---

## Adding a panel

1. Add a factory function in `src/js/panels.js` returning
   `{ node, refresh, interval }`. Use `dom.js` helpers; never `innerHTML`.
2. Register it in the `PANELS` array in `src/js/app.js` (group + id + icon).
3. If it calls a new ubus method, add it to the rpcd plugin
   (`build/files/usr/libexec/rpcd/nexrouter`), the ACL
   (`build/files/usr/share/rpcd/acl.d/nexrouter.json`), the client
   (`src/js/ubus.js`) and the mock (`dev/mock-ubus.mjs`).
4. Run `node build.mjs --check` and `node --test test/webui.test.mjs`.

---

## Licence

MIT — see [`../LICENSES/MIT.txt`](../LICENSES/MIT.txt). The UI is a standalone
static app that talks to the router over the public ubus API; it is not linked
with the GPL'd firmware overlay at build or run time.
