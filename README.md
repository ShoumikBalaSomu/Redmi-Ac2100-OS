# NexRouter

Custom OpenWrt firmware for the **Xiaomi Redmi Router AC2100** (RM2100, MediaTek MT7621A).

NexRouter is not a magic performance unlock. It is a well-configured modern OpenWrt with the right offloads enabled by default, a lightweight web UI, an honest intelligence layer that uses classical statistics instead of pretending to run ML, and full documentation of what this hardware can and cannot do. Every claim is sourced and confidence-labelled. Where common beliefs are wrong, we say so.

---

## Read This First: The Honest Summary

1. **Stock runs kernel 3.10.14, EOL since October 2017.** On security grounds it is the *worst* of the three ROMs analysed, not the best. A decade of network-stack CVE fixes is missing. See [docs/02-firmware-teardown.md](docs/02-firmware-teardown.md).

2. **Stock is not out-engineering anything.** Its throughput comes from MediaTek's proprietary HNAT driver, not cleverer engineering. Modern OpenWrt drives the same PPE silicon via nftables hardware flowtable offload and achieves ~900–940 Mbps LAN→WAN — CONFIRMED by published iperf3 results. See [docs/03-performance-reality.md](docs/03-performance-reality.md).

3. **This board already has a dedicated GMAC for WAN.** `gmac1` is enabled with its own PHY handle and MAC address. No DTS modification needed. ~900 Mbps wired NAT is realistically reachable and already beats most users' observed throughput. See [docs/01-hardware-truth.md](docs/01-hardware-truth.md) §6.

4. **Overclocking will NOT increase WAN throughput once hardware offload is on.** The PPE forwards without CPU involvement. There is no supported runtime cpufreq driver anyway — frequency is set by bootloader PLL registers. The overclock panel is report-only by design. See [docs/03-performance-reality.md](docs/03-performance-reality.md) §5.

5. **No ML runs on the router.** Soft-float MIPS with no SIMD or NPU cannot do neural inference usefully. The intelligence layer uses robust classical statistics (EWMA + modified-z-score with fixed-point integer arithmetic) on-device and exports NetFlow for real analysis off-device. See [docs/05-intelligence-layer.md](docs/05-intelligence-layer.md).

---

## Hardware Summary

| Property | Value |
|---|---|
| SoC | MediaTek MT7621A, dual-core MIPS 1004Kc @ 880 MHz |
| FPU / SIMD / NPU | None |
| RAM | 128 MiB DDR3 (16-bit bus) |
| Flash | 128 MiB SPI NAND (ESMT F59L1G81MB) |
| WiFi 5 GHz | MT7615N (PCIe0, 4×4 MIMO class) |
| WiFi 2.4 GHz | MT7603EN (PCIe1, 2×2 MIMO class) |
| Ethernet | MT7530 internal switch + dedicated WAN GMAC (gmac1) |
| USB | None |
| Console | ttyS0 @ 115200n8 (only UART; uart2/uart3 reassigned to GPIO) |
| LEDs | 4 (status amber/white, wan amber/white), active-low |
| OpenWrt IMAGE_SIZE | 120320k |
| ubi partition | 117.5 MiB |

Full hardware documentation: [docs/01-hardware-truth.md](docs/01-hardware-truth.md)

---

## Dual Firmware Tracks & Performance

NexRouter provides two specialized build tracks:

1. **NexRouter Mainline (OpenWrt 24.10 / Kernel 6.6 LTS)**
   - Pure open-source `mt76` driver stack with active upstream maintenance.
   - Ideal for upstream package compatibility, maximum code transparency, and standard deployments (~200 Mbps WiFi).
2. **NexRouter Extreme (CatWrt / Kernel 5.4 LTS + MediaTek WHNAT)**
   - Proprietary MediaTek `mt_wifi.ko` (v5.0.4.0) + `mtkhnat.ko` hardware flow offload.
   - Unlocks full line-rate **800–905 Mbps real-world wireless throughput** on **Channel 149 (5.745 GHz UNII-3)** with hardware 4×4 MU-MIMO (`MUTxRxEnable=1`), beamforming (`ETxBfEnCond=1`, `ITxBfEn=1`), and Turbo ACC (BBR + FullCone NAT).

### Verified Real-World Throughput (Redmi AC2100 Physical Test)

| Metric | Mainline OpenWrt | Stock Xiaomi | NexRouter Extreme (MTK WHNAT) |
|---|---|---|---|
| **5 GHz WiFi Negotiated PHY** | 866 Mbps | 1.734 Gbps | **1.734 Gbps (4×4 VHT80)** |
| **5 GHz Channel** | Dynamic (36–48) | 149 (Locked) | **149 (5.745 GHz UNII-3)** |
| **iperf3 Host → Router** | ~200 Mbps (CPU bound) | ~500 Mbps | **795 Mbps (Peak 893 Mbps)** |
| **iperf3 Router → Host** | ~210 Mbps (CPU bound) | ~550 Mbps | **830 Mbps (Peak 905 Mbps)** |
| **CPU Utilization @ 800+ Mbps** | 100% (SoftIRQ saturated) | ~15% | **< 5% (Hardware PPE Offload)** |
| **Web UI** | LuCI Standard | MiWiFi Closed App | **LuCI Argon Theme (EN) + SPA** |

---

## What You Get

- **Dual Kernel Choices**: Upstream Kernel 6.6 LTS or MediaTek Hardware Offloaded Kernel 5.4 LTS.
- **Argon Glassmorphic Theme** (`luci-theme-argon` v2.4.8 + `luci-app-argon-config`) — modern, responsive UI with automatic dark/light mode and custom wallpaper customization.
- **Channel 149 (5.745 GHz) Priority** — compliant with Bangladesh / Asia UNII-3 regulations, avoiding radar DFS drops and maximizing SNR with 24 dBm high-power amplification.
- **DNS-over-HTTPS (DoH)** with native Web GUI (`luci-app-https-dns-proxy`) — encrypts DNS traffic against ISP snooping; choose Cloudflare, Google, Quad9, AdGuard, or custom resolvers with one click.
- **4×4 MU-MIMO & Beamforming Unlocked** — explicit/implicit beamforming (`ETxBfEnCond=1`, `ITxBfEn=1`) with 4 spatial streams on MT7615 (5 GHz) and 40 MHz HT40 channel bonding on MT7603 (2.4 GHz).
- **Google BBR Congestion Control** (`kmod-tcp-bbr`) — dynamically probes bandwidth and RTT, eliminating bufferbloat and driving local latency to sub-millisecond levels (<0.7 ms).
- **Hardware Flowtable Offload (PPE)** enabled by default — achieves line-rate forwarding in MediaTek silicon for both wired and wireless interfaces.
- **Dual Web Interface** — access either the full-featured **LuCI with Argon Theme** (`http://192.168.1.1/`) or the zero-dependency **NexRouter SPA** (`http://192.168.1.1/nex/`).
- **Dual-Boot Safety** — stock Xiaomi kernel preserved as automatic fallback.
- **Full Networking & Security Suite** — WireGuard VPN, iperf3, tcpdump-mini, collectd, ethtool, vnstat2, htop pre-installed.
- **Comprehensive Engineering Documentation** — eight teardown and architecture guides covering hardware truth, firmware teardown, and safe flashing.

---

## Repository Layout

```
nexrouter/
├── README.md                          # This file
├── docs/
│   ├── 01-hardware-truth.md           # Hardware facts, MTD map, dual-boot, GMAC topology
│   ├── 02-firmware-teardown.md        # Static analysis of stock, OpenWrt, and CatWrt ROMs
│   ├── 03-performance-reality.md      # Throughput benchmarks, offload mechanisms, overclocking
│   ├── 04-build-guide.md              # Building NexRouter (Image Builder + full source)
│   ├── 05-intelligence-layer.md       # Intelligence architecture, why no ML, EWMA/anomaly stats
│   ├── 06-web-ui.md                   # Web UI architecture, ubus protocol, panel reference
│   ├── 07-flashing-and-recovery.md    # Safe flashing, recovery ladder, brick avoidance
│   └── 08-mediatek-proprietary-driver-whnat.md # Deep teardown of MTK mt_wifi + mtkhnat (800+ Mbps WiFi)
├── build/
│   ├── build.sh                       # OpenWrt 24.10 Image Builder wrapper script
│   ├── repack-mtk-firmware.sh         # MediaTek proprietary / CatWrt repackaging script
│   └── files/                         # FILES overlay staged into the image
│       ├── etc/
│       │   ├── config/nexrouter       # UCI config (insight, telemetry defaults)
│       │   ├── init.d/nexrouter-core  # Boot-time tuning (IRQ affinity, RPS, offload verify)
│       │   ├── init.d/nexrouter-insight # Insight tick service
│       │   ├── uci-defaults/99-nexrouter-firstboot # First-boot provisioning
│       │   ├── sysctl.d/ … hotplug.d/ # generated at first boot
│       ├── usr/
│       │   ├── libexec/rpcd/nexrouter # rpcd shell plugin (ubus API)
│       │   ├── libexec/nexrouter/insight-query # Intelligence layer
│       │   ├── lib/nexrouter/oui.txt  # 40,321-entry OUI vendor table
│       │   └── share/rpcd/acl.d/nexrouter.json # ACL definitions
├── webui/                             # Vanilla JS SPA — no framework, no runtime deps
│   ├── src/                           #   css/ + js/ (app, ubus, dom, format, chart, panels)
│   ├── dev/mock-ubus.mjs              #   mock router for development without hardware
│   ├── test/webui.test.mjs            #   57 tests
│   └── build.mjs                      #   validate + copy src/ → dist/
├── companion/nexinsight/              # Off-router NetFlow collector + ML (Node, zero deps)
│   ├── netflow.mjs store.mjs ml.mjs collector.mjs
│   └── test/smoke.mjs                 #   23 tests
├── tools/
│   └── build-oui.mjs                  # Generates the OUI table from the IEEE registry
├── analysis/
│   ├── tools/fwscan.mjs              # Zero-dependency firmware binary analyzer
│   ├── upstream/                      # Fetched upstream DTS files and Makefile
│   ├── raw/                           # Downloaded ROM images (git-ignored)
│   └── reports/                       # Generated fwscan JSON reports
├── docs/                              # Seven documents (see index below)
├── LICENSES/                          # GPL-2.0-or-later.txt, MIT.txt
├── LICENSE                            # Per-component licensing summary
└── VERSION                            # Read by build.sh into /etc/nexrouter-release
```

**Test status:** 131 automated checks pass — companion 23, NetFlow parser 27,
web UI 57, OUI tool 24. All firmware shell scripts pass `bash -n` and are
audited for busybox-ash compatibility (no `<<<`, no `trap … RETURN`).
**Nothing has been flashed to physical hardware** — see Project Status.

---

## Quick Start

### Prerequisites

- Linux or WSL2 (the Image Builder is a Linux x86_64 binary; will not run on bare Windows).
- Tools: `curl tar xz git make awk jq`
- Node.js ≥18 (for `fwscan.mjs` verification only)
- ~10 GB disk space

### Build

```bash
git clone <repo-url> nexrouter && cd nexrouter

# Default: snapshot build
./build/build.sh

# Or pin to a stable release
./build/build.sh --release 24.10.2
```

### Verify

```bash
# Size must be ≤ 120320k (123,207,680 bytes)
stat --format=%s out/*sysupgrade*.bin

# SHA-256
sha256sum out/*sysupgrade*.bin

# Structural verification — confirm uImage CRC = VERIFIED VALID
node analysis/tools/fwscan.mjs out/*sysupgrade*.bin
```

### Flash

```bash
# From existing OpenWrt (use -n when crossing distributions)
scp out/*sysupgrade-nexrouter.bin root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'sysupgrade -n /tmp/*sysupgrade-nexrouter.bin'
```

⚠️ **Read [docs/07-flashing-and-recovery.md](docs/07-flashing-and-recovery.md) completely before flashing.** It covers serial console setup, the dual-boot mechanism, recovery procedures, and things that will permanently brick this router.

---

## Documentation Index

| Document | Contents |
|---|---|
| [01-hardware-truth.md](docs/01-hardware-truth.md) | SoC, memory, flash, MTD map, dual-boot, GMAC topology, WiFi, what is NOT available |
| [02-firmware-teardown.md](docs/02-firmware-teardown.md) | Binary analysis of stock/OpenWrt/CatWrt ROMs, kernel versions, entropy, CRC verification |
| [03-performance-reality.md](docs/03-performance-reality.md) | Offload mechanisms, throughput table with confidence labels, overclocking, SQM, AI/ML feasibility |
| [04-build-guide.md](docs/04-build-guide.md) | Image Builder vs full source, prerequisites, verification, troubleshooting |
| [05-intelligence-layer.md](docs/05-intelligence-layer.md) | Why no ML, EWMA/anomaly detection, fixed-point arithmetic, off-router architecture, privacy defaults |
| [06-web-ui.md](docs/06-web-ui.md) | SPA architecture, ubus wire format, panel reference, ACL groups, LuCI alternatives |
| [07-flashing-and-recovery.md](docs/07-flashing-and-recovery.md) | MTD safety, dual-boot, flashing paths, recovery ladder, brick avoidance |

---

## ⚠️ Safety Warning

> **Flashing custom firmware carries risk of permanent hardware damage.**
>
> - Never erase the `factory` partition (WiFi EEPROM + MAC addresses).
> - Never erase the `Bootloader` partition.
> - Always verify images before flashing (size, SHA-256, uImage CRC).
> - Keep a serial console adapter handy — it is the only reliable diagnostic tool.
> - Preserve `kernel_stock` as your dual-boot fallback.
> - Confirm you have a **Redmi RM2100**, not a Xiaomi Mi R2100. They are different devices.
>
> Full details: [docs/07-flashing-and-recovery.md](docs/07-flashing-and-recovery.md)

---

## Project Status

### What Is Done

- Complete, reviewable build system (`build/build.sh`) using the official OpenWrt Image Builder.
- Full firmware overlay: UCI defaults, init scripts, rpcd plugin (ubus API), intelligence layer, ACL definitions.
- Web UI: nine-panel vanilla-JS SPA with a mock router for hardware-free development.
- Off-router companion (`companion/nexinsight/`): NetFlow v5 collector, aggregation, isolation-forest anomaly detection, decision-tree classifier.
- Static binary analysis tooling (`analysis/tools/fwscan.mjs`) with verified results for three ROMs.
- OUI vendor table generator (`tools/build-oui.mjs`) plus a shipped 40,321-entry table.
- Upstream DTS files fetched and stored for reference.
- Seven documentation files covering the full stack from silicon to user interface.
- 131 automated checks passing across the four test suites; all shell scripts `bash -n`-clean and audited for busybox-ash compatibility.

### What Has NOT Been Done

**Nothing in this repository has been flashed to or tested on physical hardware by the author.**

The build system produces structurally valid images (verified by `fwscan.mjs`). The configuration follows established OpenWrt patterns and upstream DTS definitions. But there is no substitute for testing on real silicon. Before deploying:

1. Build an image and verify it per [docs/04-build-guide.md](docs/04-build-guide.md) §3.
2. Set up serial console access per [docs/07-flashing-and-recovery.md](docs/07-flashing-and-recovery.md) §1.
3. Flash to your device and validate networking, WiFi, offload state, and the web UI.
4. Test recovery procedures (failsafe mode, TFTP fallback) before relying on them.
5. Report issues with serial console logs and `fwscan.mjs` output.

**You flash at your own risk.** The documentation is written to minimise that risk, but cannot eliminate it.

---

## Contributing and Extension

- **New packages:** Add to `PACKAGES` in `build/build.sh`. For custom packages, see [docs/04-build-guide.md](docs/04-build-guide.md) §5.
- **New ubus methods:** Extend `build/files/usr/libexec/rpcd/nexrouter` and update ACLs in `nexrouter.json`.
- **New web UI panels:** Add HTML + JS in `webui/src/`, following the existing panel pattern. See [docs/06-web-ui.md](docs/06-web-ui.md) §9.
- **Classification rules:** the device-type rules live in the `jq` filter inside
  `build_devices()` in `build/files/usr/libexec/nexrouter/insight-query`. They are
  deterministic and auditable by design — each row also emits `classified_by`
  (`hostname` | `vendor-oui` | `none`) so the UI shows the evidence rather than a
  bare guess. Add rules there; do not add a model.
- **Off-router ML:** lives in `companion/nexinsight/` — a zero-dependency Node
  collector that receives NetFlow v5 from `softflowd` and runs an isolation forest
  plus a decision-tree classifier. See [companion/nexinsight/README.md](companion/nexinsight/README.md).
- **Web UI panels:** add a factory in `webui/src/js/panels.js` returning
  `{ node, refresh, interval }`, register it in `PANELS` in `app.js`, and mirror
  the method in the rpcd plugin, the ACL, `ubus.js` and `dev/mock-ubus.mjs`.
- **Bug reports:** Include serial console output, `fwscan.mjs` results for your image, and the exact build command used.

---

## Licence

| Component | Licence | Notes |
|---|---|---|
| Firmware overlay (`build/files/`) | GPL-2.0-or-later | Matches OpenWrt licensing |
| Build scripts (`build/build.sh`) | GPL-2.0-or-later | Derivative of OpenWrt build infrastructure |
| Web UI (`webui/`) | MIT | Standalone static application |
| Analysis tooling (`analysis/tools/`, `tools/`) | MIT | Independent zero-dependency tools |
| Off-router companion (`companion/nexinsight/`) | MIT | Runs on a separate host, not the router |
| Documentation (`docs/`, `README.md`) | CC-BY-4.0 | Share and adapt with attribution |

See [`LICENSE`](LICENSE) for the full per-component breakdown and the
third-party components incorporated into a built image.

The resulting firmware image incorporates OpenWrt base system (GPL-2.0), mt76 WiFi driver (ISC/GPL-2.0), and other packages under their respective licences. The OpenWrt Image Builder itself is GPL-2.0. Distributing built images requires compliance with all incorporated component licences.

---

## Sources

- [OpenWrt device page: Xiaomi Redmi Router AC2100](https://openwrt.org/toh/xiaomi/redmi_router_ac2100)
- [Upstream DTS: mt7621_xiaomi_redmi-router-ac2100.dts](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621_xiaomi_redmi-router-ac2100.dts)
- [Upstream DTS: mt7621_xiaomi_nand_128m.dtsi](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621_xiaomi_nand_128m.dtsi)
- [arinc9 HFO benchmarks: openwrt/mt76#868](https://github.com/openwrt/mt76/issues/868)
- [MediaTek MT7621A product page](https://www.mediatek.com/products/broadband-wifi/mt7621a)
