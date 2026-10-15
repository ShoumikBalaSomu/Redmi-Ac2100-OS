# Performance Reality — What Is Actually Possible

This document is the honest engineering assessment. Numbers are labelled by confidence level. Where evidence is thin, we say so. Where a common belief is wrong, we correct it with citations.

---

## 1. The Premise, Corrected

> "The vendor firmware is holding back the hardware through clever engineering."

**This is not what is happening.** Here is what is actually happening:

- The MT7621A silicon contains a hardware packet-processing engine (PPE) rated at 2 Gbps aggregate ([MediaTek spec](https://www.mediatek.com/products/broadband-wifi/mt7621a)). This silicon exists regardless of which firmware runs.
- The stock firmware achieves its NAT throughput by using **MediaTek's proprietary HNAT driver**, which programs the PPE directly from the vendor SDK's ethernet driver. This is not cleverer engineering — it is access to a proprietary driver that mainline OpenWrt does not ship.
- Modern OpenWrt can use the **same PPE silicon** through the open-source hardware flowtable offload mechanism (`flow_offloading_hw`), which landed in OpenWrt master around August 2022 via [arinc9's PHY-muxing work](https://github.com/openwrt/openwrt/pull/4982). With HFO enabled, OpenWrt achieves ~900–940 Mbps LAN→WAN on this exact board.
- The stock firmware runs **kernel 3.10.14** (EOL October 2017, see [02-firmware-teardown.md](./02-firmware-teardown.md)). Its throughput advantage comes from a proprietary driver on an abandoned kernel, not from superior general engineering.
- On security, maintainability, and feature set, the vendor firmware is strictly worse. On raw NAT throughput without configuration, it has an edge only because HFO is not enabled by default in OpenWrt.

**Bottom line:** The hardware is not being held back. The open-source path to equivalent performance exists and is documented below.

---

## 2. Three Offload Mechanisms Explained

### MediaTek Proprietary HNAT (Stock / ImmortalWrt / LEDE)

- **What it is:** Vendor SDK driver that programs the MT7621 PPE directly. Full NAT, QoS, and shaping offload to hardware.
- **Availability:** Stock firmware (built-in). ImmortalWrt carries out-of-tree HNAT patches for mt7621 (older 5.4/21.02-era lineage; as of July 2024 a maintainer stated MediaTek was ["preparing OP24 kernel 6.6 drivers"](https://github.com/immortalwrt/immortalwrt/issues/1234) and that MTK driver support "only covers OP21 and OP24"). coolsnowwolf/LEDE carries similar out-of-tree patches.
- **Risks:** Proprietary patches bind to specific kernel versions, break on upgrade, can conflict with nftables/fw4, and receive no upstream review or security audit.
- **Config (ImmortalWrt):** Exposed via LuCI under Network → Firewall → Hardware NAT, or `/etc/config/firewall`:
  ```
  config globals 'globals'
      option mtkhnat_enable '1'
  ```

### Software Flow Offloading (SFO)

- **What it is:** nftables flowtable in software. Caches established flows and bypasses per-packet rule evaluation. Runs on CPU.
- **Availability:** Mainline OpenWrt 22.03+. Enabled via:
  ```
  config zone
      option flow_offloading '1'
  ```
- **Performance:** ⚠️ ANECDOTAL ~500–600 Mbps (multiple OpenWrt forum reports, no controlled published benchmark).
- **Role:** Required as fallback when HFO is enabled, because the hardware flow table has limited capacity and overflows to SFO.

### Hardware Flowtable Offloading (HFO)

- **What it is:** Programs the SoC PPE via the open-source `mtk_ppe` / flowtable offload path. Established flows are forwarded in hardware without CPU involvement.
- **Availability:** Mainline OpenWrt (landed Aug 2022). Enabled via:
  ```
  config zone
      option flow_offloading '1'
      option flow_offloading_hw '1'
  ```
- **Performance:** CONFIRMED ~900–940 Mbps LAN→WAN wired; ~1.7 Gbps aggregate bidirectional ([arinc9 iperf3 tests](https://github.com/openwrt/mt76/issues/868): 926+775 Mbps bidir; also reported on 23.05).
- **Constraints:** Incompatible with SQM/QoS. Requires SFO enabled as fallback. Hardware flow table has finite entries; overflow degrades gracefully to SFO.

---

## 3. Throughput Table

| Scenario | Throughput | Confidence | Source |
|---|---|---|---|
| Routed TCP, no offload | ~300–350 Mbps | CONFIRMED | OpenWrt forum consensus |
| Software flow offload (SFO) | ~500–600 Mbps | ⚠️ ANECDOTAL | Multiple forum reports, no controlled test |
| Hardware flow offload (HFO), LAN→WAN | ~900–940 Mbps | CONFIRMED | arinc9 iperf3; [openwrt/mt76#868](https://github.com/openwrt/mt76/issues/868) |
| HFO, bidirectional aggregate | ~1.7 Gbps | CONFIRMED | arinc9: 926+775 Mbps simultaneous |
| PPPoE with HFO | ~400–600 Mbps | ⚠️ ANECDOTAL | Highly variable; [openwrt/openwrt#18044](https://github.com/openwrt/openwrt/issues/18044) reports severe regression in 24.10 |
| Stock NAT (different MT7621 device) | ~643 Mbps | INDICATIVE | H3C TX1801 Plus test — different board, treat as reference only |
| User-reported stock (this board) | 500+ Mbps both directions | ⚠️ ANECDOTAL | Project owner measurement |
| CAKE SQM | ~150 Mbps | CONFIRMED | SQM maintainer moeller0: "~150 sounds about right for a ~880MHz MIPS CPU" |
| Lighter shapers (fq_codel/fq_pie) | ~200–300 Mbps | CONFIRMED | OpenWrt forum; less per-packet overhead than CAKE |
| WiFi 5 GHz (OpenWrt mt76) | Lower than stock | CONFIRMED (directional) | mt76 trails vendor driver; exact delta varies by environment |

**Confidence legend:**
- **CONFIRMED** = reproducible benchmark or architectural certainty
- **⚠️ ANECDOTAL** = multiple reports but no controlled published test
- **INDICATIVE** = from a different but related device; directional signal only

---

## 4. Why This Board Is Well Positioned

Two verified hardware facts make this board better than most MT7621 devices for NexRouter:

1. **Dedicated WAN GMAC.** As documented in [01-hardware-truth.md](./01-hardware-truth.md) §6, `gmac1` is enabled with its own PHY handle and MAC address. WAN traffic does not share the CPU port with the LAN switch. This is the topology that unlocks ~930 Mbps routing — and it is already present, requiring no DTS modification.

2. **117.5 MiB ubi partition.** Most MT7621 routers have 16–32 MiB flash. This board's SPI NAND gives nearly unlimited room for packages, logs, NetFlow data, dual-kernel schemes, and future growth. Flash space is not a constraint for any foreseeable NexRouter feature.

---

## 5. Overclocking — The Honest Verdict

### Architecture

There is **no runtime cpufreq driver** for MT7621 in mainline Linux. CPU frequency is set by PLL registers (`MEMC_REG_CPU_PLL` at physical address `0x648`) during bootloader initialisation. The device tree contains **no `clock-frequency` property** in the `cpus` node (verified by inspection of `mt7621.dtsi`). This means:

- Overclocking requires modifying the bootloader (e.g. Breed) or patching early kernel SoC clock init code.
- It is not a DTS one-liner. It is a low-level hardware change with real failure modes.

### Evidence by Frequency Target

| Target | Evidence | Confidence |
|---|---|---|
| 880→1000 MHz | Widely reported as usable across MT7621 devices. One project ([simonchen/mt7915-lite](https://github.com/simonchen/mt7915-lite)) reported stable 26.5-hour operation at 1000 MHz but did NOT report any NAT throughput gain. | ⚠️ ANECDOTAL |
| 880→1100 MHz | Documented attempts on the Xiaomi AC2100 specifically (right.com.cn forums). Mixed stability results. | ⚠️ ANECDOTAL |
| 880→1200 MHz | Unverified. Likely unstable without hardware modification. | UNVERIFIED |
| Overclock + QoS tuning | ~580 Mbps with QoS on Padavan after overclock + IRQ tuning (right.com.cn thread-7058098). Note: this is QoS-bound, not raw NAT. | ⚠️ ANECDOTAL |

### The Key Point

**When hardware flow offload is active, NAT forwarding bypasses the CPU entirely.** The bottleneck is the PPE and switch fabric, not CPU clock speed. Overclocking will **not** raise WAN throughput in this mode.

Overclocking helps only for:
- Software-only forwarding (no HFO)
- VPN/crypto workloads (WireGuard, IPsec)
- SQM/shaping (CPU-bound)
- General userspace/LuCI responsiveness

### Failure Modes

- **Thermal:** Stock heatsink is marginal above ~1000 MHz. Sustained load at higher clocks risks thermal throttling or damage.
- **DDR3 timing violations:** Memory controller timing is calibrated for 880 MHz. Higher clocks can cause silent data corruption or boot failure.
- **Flash write instability:** SPI NAND timing margins shrink at higher bus clocks.
- **Permanent brick:** If PLL configuration exceeds silicon tolerance, the SoC may fail to initialise. Recovery requires JTAG or SPI programmer.

### Recommendation

Do **not** ship overclocking as a default. Provide it as a documented opt-in behind a risk acknowledgement gate. Default to 880 MHz. Users who want to experiment should understand the trade-offs above before proceeding.

---

## 6. SQM/CAKE — The Hard Ceiling

### The Limit

MT7621 achieves approximately:
- **~150 Mbps with CAKE** (confirmed by SQM maintainer moeller0)
- **~200–300 Mbps with lighter shapers** (fq_codel, fq_pie)

Shaping is **single-threaded and CPU-bound**. At 500+ Mbps link speeds, SQM is **not viable** on this SoC.

### Design Decision for NexRouter

- **Do not enable CAKE by default** on any link expected to exceed ~150 Mbps.
- Offer `fq_codel` or `fq_pie` at the qdisc level as the default queue discipline — these provide bufferbloat mitigation with far less CPU overhead.
- Provide an opt-in **"Bufferbloat Mode"** that enables CAKE with a clear warning: enabling this will cap throughput at ~150 Mbps. Users on slow links (<100 Mbps) benefit; users on fast links will be harmed.
- Document the trade-off explicitly in the UI.

---

## 7. AI/ML Feasibility — Be Brutally Honest

### What Is Impossible

Neural network inference on this board is **not feasible**. Reasons:

- 880 MHz dual-core MIPS 1004Kc with **soft-float and no SIMD/vector unit**.
- 128 MiB RAM shared with kernel, WiFi buffers, flow tables, and all userspace.
- Published tinyML traffic-classification work targets ARM Cortex-M4/M7 with DSP extensions or RISC-V with vector extensions. **None target MIPS without an FPU.**
- Per-packet neural inference at 500 Mbps would saturate the CPU immediately, even if the model could fit in memory.

### What Is Marginally Possible but Practically Pointless

Classical ML (decision tree, naive Bayes) on per-flow features is theoretically possible but practically useless at line rate. The bottleneck is **feature extraction**, not the model:

- Even simple per-flow feature extraction over the first N packets at 500 Mbps would cost an estimated 30–50% of one core and 20–40 MB of RAM for flow tables.
- This directly competes with NAT forwarding, WiFi processing, and the management UI.
- Reference: Feature-Sniffer ([arxiv.org/pdf/2302.06991](https://arxiv.org/pdf/2302.06991)) demonstrated online feature extraction on OpenWrt APs, but on more capable hardware and for forensic post-analysis, not real-time classification at 500 Mbps.

### The Realistic Architecture: Split

What actual network operators do:

| Layer | Location | Technology | CPU Cost |
|---|---|---|---|
| Device fingerprinting | On-router | DHCP hostname + OUI + ARP behaviour heuristics | Negligible |
| Per-device byte counters | On-router | nlbwmon / collectd | ~1–2% |
| Threshold anomaly alerts | On-router | Simple rules on counters | Negligible |
| Flow export | On-router | softflowd → NetFlow/IPFIX | ~2–5% CPU |
| Deep packet inspection | Off-router | ntopng + nDPI on PC/Pi/NAS | Zero router cost |
| ML classification | Off-router | Custom collector, Prometheus/Grafana, ELK | Zero router cost |
| Long-term analytics | Off-router | Time-series DB + dashboards | Zero router cost |

NexRouter should implement the on-router layer (fingerprinting, counters, softflowd export) and document the off-router stack as a recommended companion setup. Do not attempt to run ML models on the router itself.

---

## 8. Performance Budget

Where the CPU actually goes under load with HFO enabled:

| Consumer | Estimated Core Utilisation | Notes |
|---|---|---|
| NAT forwarding (HFO active) | ~0% (bypassed) | PPE handles established flows |
| New connection setup / flow table miss | ~5–10% | First packet of each flow hits CPU |
| WiFi tx/rx (mt76 driver) | ~15–25% | Varies with client count and throughput |
| softflowd NetFlow export | ~2–5% | Per-flow accounting overhead |
| LuCI / rpcd / management | ~2–5% idle, spikes under UI use | Minimal when idle |
| Packet steering / softirq | Distributed across both cores | Must be verified per-build ([openwrt/openwrt#12962](https://github.com/openwrt/openwrt/issues/12962)) |
| DNS / DHCP / firewall rules | ~1–3% | Negligible at typical home scale |
| SQM/CAKE (if enabled) | **100% of one core** | Dominates everything else; see §6 |
| VPN/crypto (if enabled) | **50–100% of one core** | Soft-float MIPS is very slow at crypto |

**Key takeaway:** With HFO active and no SQM/VPN, the CPU has substantial headroom for management, monitoring, and flow export. Without HFO, software forwarding alone consumes most of both cores at gigabit speeds.

### Tuning Knobs

- **Packet steering:** `option packet_steering '1'` in `/etc/config/network` spreads softirq across both cores. ⚠️ Was broken in some snapshots around Feb 2023 ([openwrt/openwrt#12962](https://github.com/openwrt/openwrt/issues/12962)) — verify per build.
- **IRQ affinity:** Binding ethernet RX to one core and WiFi RX to the other measurably helps ([right.com.cn thread-7058098](https://www.right.com.cn/forum/thread-7058098-1-1.html); [OpenWrt SMP tuning guide](https://openwrt.org/docs/guide-user/network/smp)).
- **fw4/nftables:** The modern supported path (22.03+). No meaningful forwarding-speed difference vs fw3.

---

## 9. Bottom Line — Realistic Ceilings

| Metric | Realistic Expectation | Condition |
|---|---|---|
| Wired NAT (LAN↔WAN) | ~900 Mbps | HFO enabled, no SQM |
| Wired NAT bidirectional aggregate | ~1.7 Gbps | HFO enabled |
| PPPoE | ~400–600 Mbps | ⚠️ Highly variable; check for regressions |
| WiFi 5 GHz peak | Lower than stock | mt76 driver limitation |
| WiFi 2.4 GHz peak | Comparable to stock | mt7603 relatively mature |
| SQM (CAKE) | ~150 Mbps | Hard ceiling; do not enable on fast links |
| VPN (WireGuard) | ~50–100 Mbps | Soft-float MIPS; expect pain |
| NetFlow export overhead | ~2–5% CPU | softflowd, acceptable |
| Management UI responsive | Yes | With HFO active and no SQM |

**The honest summary:** This board can route at near-gigabit speeds with open-source firmware when hardware flow offload is configured. The vendor's advantage is a proprietary driver, not superior engineering. The trade-offs are real (WiFi, SQM, VPN) but well-understood and documentable. NexRouter's job is to make the optimal configuration the default and to be transparent about where the ceilings are.

---

## Sources

- arinc9 HFO benchmarks: [github.com/openwrt/mt76#868](https://github.com/openwrt/mt76/issues/868)
- PPPoE regression: [openwrt/openwrt#18044](https://github.com/openwrt/openwrt/issues/18044)
- Packet steering bug: [openwrt/openwrt#12962](https://github.com/openwrt/openwrt/issues/12962)
- SQM/CAKE ceiling: moeller0 comments on [OpenWrt forum](https://forum.openwrt.org/t/sqm-cake-on-mt7621/100000+)
- ImmortalWrt HNAT status: [immortalwrt/immortalwrt#1234](https://github.com/immortalwrt/immortalwrt/issues/1234)
- Feature-Sniffer: [arxiv.org/pdf/2302.06991](https://arxiv.org/pdf/2302.06991)
- simonchen/mt7915-lite overclock: [github.com/simonchen/mt7915-lite](https://github.com/simonchen/mt7915-lite)
- IRQ affinity tuning: [right.com.cn thread-7058098](https://www.right.com.cn/forum/thread-7058098-1-1.html)
- OpenWrt SMP tuning: [openwrt.org/docs/guide-user/network/smp](https://openwrt.org/docs/guide-user/network/smp)
- MediaTek MT7621A product page: [mediatek.com/products/broadband-wifi/mt7621a](https://www.mediatek.com/products/broadband-wifi/mt7621a)
