# The Intelligence Layer — What It Is and What It Refuses To Be

**There is no machine learning running on this router.**

This is not a limitation to be worked around. It is an architectural fact that follows directly from the hardware. This document explains why, what the layer does instead, and how the design keeps the door open for real analysis off-device.

---

## 1. Why No ML On-Router

### Hardware Constraints

The MT7621A has two MIPS 1004Kc cores at 880 MHz (see [01-hardware-truth.md](./01-hardware-truth.md) §2):

| Constraint | Impact on ML |
|---|---|
| **No hardware FPU** | All floating-point is soft-float emulation. A single FP multiply costs 10–50× more cycles than an integer multiply. Neural network inference is dominated by FP matrix operations. |
| **No SIMD / vector unit** | No NEON, no MSA, no AltiVec. Cannot vectorise dot products, convolutions, or batched feature extraction. Every element is processed sequentially. |
| **No NPU / DSP** | No dedicated inference accelerator. Everything runs on the general-purpose CPU that is also forwarding packets. |
| **128 MiB shared RAM** | Kernel, WiFi buffers, flow tables, conntrack, userspace, and any model weights all compete for the same pool. A useful traffic-classification model needs 20–40 MB just for flow state. |
| **Both cores forwarding** | There is no spare core for inference. Any ML workload competes directly with NAT, WiFi, DNS, DHCP, and management. |

Published tinyML traffic-classification work targets ARM Cortex-M4/M7 with DSP extensions or RISC-V with vector extensions. **None target FPU-less MIPS.** The architecture is categorically wrong for this workload.

### Classical ML Is Not Free Either

Even a decision tree or naive Bayes classifier requires **feature extraction** as a prerequisite. At 500 Mbps:

- Simple per-flow feature extraction (packet sizes, inter-arrival times, direction ratios over the first N packets) costs an estimated **30–50% of one core** and **20–40 MB of RAM** for flow tables.
- This estimate comes from Feature-Sniffer ([arxiv.org/pdf/2302.06991](https://arxiv.org/pdf/2302.06991)), which demonstrated online feature extraction on OpenWrt APs — but on more capable hardware and for forensic post-analysis, not real-time classification at line rate.
- The bottleneck is feature extraction, not the model. Adding a classifier on top of already-extracted features is cheap; getting those features in the first place is what kills you.

With both cores needed for forwarding at gigabit speeds (even with HFO, new connections and non-offloaded traffic hit the CPU), there is no headroom for per-packet feature extraction without measurable throughput degradation.

### The Design Decision

NexRouter uses **deterministic, auditable heuristics** for on-device intelligence and exports raw flow data for real analysis elsewhere. This is not a compromise — it is the correct architecture for this hardware class.

---

## 2. What the Layer Actually Implements

All intelligence lives in `build/files/usr/libexec/nexrouter/insight-query`. It is a shell script invoked by the `nexrouter-insight` init service (see [04-build-guide.md](./04-build-guide.md) for build integration).

### Device Inventory (`devices` command)

Joins four data sources into a unified device list:

| Source | Data |
|---|---|
| `ubus call dhcp ipv4leases` | Active DHCP leases: IP, MAC, hostname, lease expiry |
| `/proc/net/arp` | ARP table: IP↔MAC mapping including static entries |
| `ip -6 neigh` | IPv6 NDP neighbours |
| `nlbwmon` per-host counters | Per-device byte/packet counters (rx/tx, protocol breakdown) |

Each device record includes:

- **MAC OUI → vendor lookup** via a built-in OUI database.
- **Device type classification** via deterministic rules on hostname and vendor OUI.
- **`classified_by` field**: `hostname`, `vendor-oui`, or `none` — so the UI shows *evidence*, not a bare guess.

Classification rules are explicit and auditable:

```
hostname contains "tv"|"smart-tv"|"bravia"|"fire-tv"     → tv
hostname contains "iphone"|"android"|"galaxy"|"pixel"     → phone
hostname contains "macbook"|"desktop"|"laptop"|"pc"       → computer
vendor OUI matches known camera manufacturer              → camera
vendor OUI matches known IoT manufacturer                 → iot
hostname contains "xbox"|"playstation"|"switch"           → console
...
no match                                                  → unknown
```

No probabilistic model. No black box. Every classification can be traced to a specific rule and input field.

### Anomaly Detection (`anomalies` command)

Uses an **Exponentially Weighted Moving Average (EWMA)** baseline with a modified-z-score threshold.

#### EWMA Baseline

For each metric (bytes/sec, packets/sec, connection count per device):

```
baseline[t] = α × observation[t] + (1 - α) × baseline[t-1]
```

Where **α = 0.3** (fixed). This gives a responsive but stable baseline that adapts to diurnal patterns over the configured window (default 15 minutes).

#### Modified Z-Score

Standard z-score `(x - μ) / σ` assumes normality and is corrupted by outliers. The modified z-score uses the **Median Absolute Deviation (MAD)**:

```
modified_z = 0.6745 × (x - median) / MAD
```

MAD has a **50% breakdown point** — up to half the observations can be arbitrarily wrong before the statistic breaks. Standard deviation has a 0% breakdown point: one huge outlier corrupts σ completely. For network traffic with bursty spikes and occasional measurement artefacts, MAD-style robust statistics are strictly superior.

Threshold: **3.5** (standard for modified-z-score anomaly detection, per Iglewicz & Hoaglin 1993).

#### Fixed-Point Arithmetic

The SoC has no FPU. All arithmetic uses **×1000 fixed-point integers**:

```
# Instead of: baseline = 0.3 * x + 0.7 * baseline
# We compute: baseline = (300 * x + 700 * baseline) / 1000
```

Division by 1000 is a constant divisor that the compiler optimises to a multiply-shift sequence on MIPS. No floating-point instructions are emitted.

The trade-off: precision is limited to 0.001 units, which is more than sufficient for byte-rate and packet-rate baselines where natural variance dwarfs sub-unit differences.

### Sampling Trade

The `tick` command runs on a configurable interval (default 15 minutes, clamped 1–1440 min via UCI). It is **reniced to 19** so it can never starve forwarding.

This is a deliberate choice:

| Approach | CPU Cost | Granularity | Suitability |
|---|---|---|---|
| Packet-level monitoring | 30–50% of one core | Per-packet | Not viable at 500+ Mbps on this SoC |
| Flow-level sampling (softflowd) | 2–5% of one core | Per-flow | Viable; exported off-device |
| Periodic polling (insight tick) | Negligible | 15-min windows | Viable; sufficient for trend/baseline |

The 15-minute window captures macro-level anomalies (device suddenly saturating the link, new device appearing, traffic pattern shift) without competing with forwarding. Per-packet analysis belongs off-device.

---

## 3. Off-Router Architecture

The realistic intelligence split:

| Layer | Location | Technology | CPU Cost |
|---|---|---|---|
| Device fingerprinting | Router | DHCP hostname + OUI + deterministic rules | Negligible |
| Per-device byte counters | Router | nlbwmon | ~1–2% |
| Threshold anomaly alerts | Router | EWMA + modified-z-score on counters | Negligible |
| Flow export | Router | softflowd → NetFlow v5/v9/IPFIX | ~2–5% |
| Deep packet inspection | Off-router | ntopng + nDPI | Zero |
| ML classification | Off-router | Custom collector, Prometheus+Grafana, ELK | Zero |
| Long-term analytics | Off-router | Time-series DB + dashboards | Zero |

### softflowd Export

`softflowd` is included in the default package list but **disabled by default**. Enable it via the web UI or UCI:

```
config nexrouter 'export'
    option enabled '1'
    option collector '192.168.1.100:2055'
    option version '9'
```

The `export_set` rpcd method validates the collector address against `[A-Za-z0-9._:-]` before enabling — no shell injection, no arbitrary commands.

Recommended off-router stack:

- **ntopng + nDPI** — DPI classification, flow visualisation, historical analysis. Runs on a PC, NAS, or Raspberry Pi.
- **Prometheus + Grafana** — Time-series metrics from a custom NetFlow collector. Good for alerting and dashboards.
- **Custom collector** — For research or specialised analysis. Accepts NetFlow/IPFIX and applies whatever models you want.

The router's job is to be a **sensor**, not an analyst.

---

## 4. Privacy Defaults

Every privacy-relevant setting is stated explicitly in UCI config (`/etc/config/nexrouter`) so it is auditable rather than merely promised:

```
config insight
    option enabled '1'
    option mode 'heuristic'        # Explicit: no ML model
    option window '15'             # Polling interval in minutes
    option export '0'              # NetFlow export OFF by default
    option retention_days '30'

config telemetry
    option phone_home '0'          # No phoning home
    option crash_reporting '0'     # No crash reporting
```

Design rules enforced in code:

- **Export is OFF by default.** Nothing leaves the device unless the user enables it.
- **Collector required before enabling.** `config-set` refuses to enable NetFlow export unless a valid collector address is configured.
- **No phone home.** No telemetry endpoint is hardcoded or contacted.
- **No crash reporting.** No automatic upload of diagnostics.
- **Mode is explicit.** `mode='heuristic'` is kept in config so the UI can state plainly that no ML model runs on the router. If someone adds ML later, this field changes and the UI reflects it.

---

## 5. What Would Have to Change for Real On-Device ML

Be candid: this board is not that device. Real on-device ML for traffic classification requires:

| Requirement | MT7621A | Minimum Viable |
|---|---|---|
| FPU or DSP | None | ARM NEON / RISC-V vector / dedicated DSP |
| NPU | None | Dedicated inference accelerator (e.g. MediaTek APU in Filogic 830+) |
| RAM | 128 MiB shared | 512 MiB+ with dedicated model memory |
| WED | Not available | Filogic-class SoCs (MT7986+) |
| Clock | 880 MHz, no cpufreq | 1.5+ GHz with DVFS |
| ISA | MIPS (legacy) | ARMv8-A or RISC-V with vector extensions |

A Filogic 830 (MT7986A) or better would be the minimum platform for meaningful on-device inference. That is a different project. NexRouter is designed for the hardware it actually runs on.

---

## 6. How to Extend

### Classification Rules

Edit `build/files/usr/libexec/nexrouter/insight-query`, function `classify_device()`. The rules are plain shell case statements matching hostname patterns and OUI prefixes. Add new patterns, test with `insight-query devices`, verify the `classified_by` field reflects your change.

### EWMA Parameters

In the same file, the EWMA alpha (0.3) and anomaly threshold (3.5) are constants at the top of the anomaly detection section. Adjust based on your environment:

- Lower alpha → slower adaptation, fewer false positives on gradual changes.
- Higher alpha → faster adaptation, more sensitive to sudden shifts.
- Lower threshold → more alerts, more false positives.
- Higher threshold → fewer alerts, may miss subtle anomalies.

### New Metrics

Add collection in `tick`, storage in the JSON cache, and exposure via the `anomalies` or `devices` command. Keep computations in fixed-point integer arithmetic. Profile with `time` before deploying — anything above a few hundred milliseconds per tick is too expensive.

### Off-Device Collector

The companion collector is outside this repo's scope, but the interface contract is standard NetFlow v5/v9/IPFIX via UDP. Any collector that speaks these protocols works. Document your collector setup separately.

---

## Sources

- Feature-Sniffer: [arxiv.org/pdf/2302.06991](https://arxiv.org/pdf/2302.06991)
- Modified z-score / MAD: Iglewicz, B. & Hoaglin, D.C. (1993). *How to Detect and Handle Outliers*. ASQC Quality Press.
- EWMA: Roberts, S.W. (1959). "Control Chart Tests Based on Geometric Moving Averages". *Technometrics*.
- softflowd: [github.com/irino/softflowd](https://github.com/irino/softflowd)
- ntopng: [ntop.org/products/traffic-analysis/ntop/](https://www.ntop.org/products/traffic-analysis/ntop/)
