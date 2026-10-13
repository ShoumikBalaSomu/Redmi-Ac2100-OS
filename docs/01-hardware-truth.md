# Hardware Truth — Redmi Router AC2100

> **Device identity:** Xiaomi **Redmi** Router AC2100, model RM2100, OpenWrt device id `xiaomi,redmi-router-ac2100`.
> This is a **different device** from the "Xiaomi Mi Router AC2100" (R2100). They have separate DTS files and different hardware layouts. Do not confuse them.

---

## 1. At a Glance

| Property | Value | Source |
|---|---|---|
| SoC | MediaTek MT7621A | DTS `compatible = "mediatek,mt7621"` |
| CPU | MIPS 1004Kc, dual-core, 880 MHz | DTS cpu nodes + vendor u-boot bootlog |
| L2 Cache | 256 KiB, 8-way, 32-byte lines | MT7621 datasheet |
| FPU / SIMD | **None** (soft-float, no NEON/vector) | MIPS 1004Kc ISA |
| RAM | 128 MiB DDR3, 16-bit bus | Vendor spec + runtime probe |
| Flash | 128 MiB SPI NAND (ESMT F59L1G81MB, NAND ID C8 D1) | DTS + vendor bootlog |
| WiFi 5 GHz | MT7615N on PCIe0, 4×4 MIMO class | DTS pcie0 node |
| WiFi 2.4 GHz | MT7603EN on PCIe1, 2×2 MIMO class | DTS pcie1 node |
| Ethernet | MT7530 internal switch + dedicated WAN GMAC | DTS gmac0/gmac1 |
| USB | **None** | Physical inspection + DTS absence |
| LEDs | 4 (status amber/white, wan amber/white), active-low | DTS leds node |
| Console | ttyS0 @ 115200n8 | DTS chosen stdout-path |
| OpenWrt IMAGE_SIZE | 120320k | Device Makefile |

---

## 2. SoC and CPU

### MIPS 1004Kc: What You Actually Have

The MT7621A integrates two MIPS 1004Kc cores. This is an **in-order, single-issue** microarchitecture from the early 2010s. Key constraints that affect everything in this project:

- **No hardware FPU.** All floating-point operations use soft-float emulation. Any code path that touches `float` or `double` pays a 10–50× penalty versus an equivalent integer path. This eliminates neural-network inference as a realistic on-router workload (see §AI/ML in [03-performance-reality.md](./03-performance-reality.md)).
- **No SIMD / vector unit.** There is no NEON, no MSA, no AltiVec. Packet-processing loops cannot be vectorised. Throughput optimisation must come from algorithmic choices and offload engines, not wider datapaths.
- **Dual-core, not quad-core.** Two hardware threads total. SMP helps with packet steering and parallel softirq processing, but there is no spare core to dedicate to monitoring, ML, or management tasks without directly competing with forwarding.
- **880 MHz fixed clock.** The CPU frequency is set by the bootloader via PLL registers (`MEMC_REG_CPU_PLL` at physical address `0x648`). It is **not** expressed in the device tree — the `cpus` node in `mt7621.dtsi` contains no `clock-frequency` property. There is no runtime cpufreq driver in mainline Linux for this SoC. Overclocking requires modifying bootloader PLL setup (e.g. Breed) or patching early kernel clock init. See [03-performance-reality.md](./03-performance-reality.md) §Overclocking for the honest assessment.

### Why This Matters Downstream

Every architectural decision in NexRouter flows from these constraints:

- Crypto (IPsec, WireGuard) is CPU-bound and slow relative to ARM/RISC-V routers at similar price points.
- SQM/shaping is single-threaded and caps at ~150 Mbps with CAKE.
- Per-packet feature extraction for traffic classification competes directly with NAT forwarding for CPU time.
- The web UI must be lightweight — not because of flash space (we have plenty), but because LuCI's Lua/runtime overhead consumes RAM and CPU that forwarding needs under load.

---

## 3. Memory and Flash

### RAM: 128 MiB DDR3

128 MiB shared across kernel, WiFi buffers, flow tables, userspace, and any packages you install. The 16-bit bus limits memory bandwidth. At 500+ Mbps line rate with software forwarding, buffer pressure is real.

### Flash: 128 MiB SPI NAND — Not NOR

This is the single most important enabler for NexRouter. Most consumer routers ship 16–32 MiB of SPI NOR flash. This board has **128 MiB of SPI NAND**, which means:

- The `ubi` partition is **117.5 MiB** — enough for a full OpenWrt rootfs plus extensive custom packages, logs, and overlay data.
- No need to strip packages or compress aggressively to fit.
- Room for dual-kernel fallback, A/B sysupgrade schemes, and persistent analytics data.
- NAND wear levelling is handled by UBI/UBIFS, which manages erase-block tracking transparently.

⚠️ **Common misconception corrected:** If you assumed this was a "16 MB router," it is not. The 128 MiB NAND changes the entire packaging calculus. You can ship a rich default profile without fear of running out of space.

---

## 4. MTD Partition Map

Verbatim from `mt7621_xiaomi_nand_128m.dtsi`:

| Offset | Size | Name | Flags | Notes |
|---|---|---|---|---|
| `0x000000` | 512 KiB | Bootloader | read-only | u-boot |
| `0x080000` | 256 KiB | Config | — | u-boot environment |
| `0x0C0000` | 256 KiB | Bdata | read-only | Board calibration |
| `0x100000` | 256 KiB | factory | read-only | WiFi EEPROM + MAC addresses |
| `0x140000` | 256 KiB | crash | — | Crash dump |
| `0x180000` | 256 KiB | crash_syslog | — | Crash syslog |
| `0x1C0000` | 256 KiB | reserved0 | read-only | Reserved |
| `0x200000` | 4 MiB | kernel_stock | — | Stock Xiaomi kernel (system 1 fallback) |
| `0x600000` | 4 MiB | kernel | — | OpenWrt kernel (system 2) |
| `0xA00000` | 117.5 MiB | ubi | — | Root filesystem (merged rootfs0+rootfs1+overlay) |

### Factory Partition NVMEM Layout

The `factory` partition at `0x100000` holds critical per-device calibration data exposed via nvmem cells:

| Cell | Offset | Size | Purpose |
|---|---|---|---|
| `eeprom@0` | `0x0000` | `0x0400` | MT7603 2.4 GHz WiFi EEPROM |
| `eeprom@8000` | `0x8000` | `0x4DA8` | MT7615 5 GHz WiFi EEPROM (overridden size) |
| `macaddr@e000` | `0xE000` | 6 bytes | LAN/base MAC address |
| `macaddr@e006` | `0xE006` | 6 bytes | WAN MAC address |

⚠️ **Never overwrite the factory partition.** Loss of EEPROM calibration data means degraded WiFi performance that cannot be recovered without vendor-specific recalibration tools.

---

## 5. Dual-Boot Mechanism

The vendor u-boot implements a genuine dual-boot safety mechanism. From the upstream DTS comment:

> u-boot expects kernels at `0x200000` ("system 1") and `0x600000` ("system 2"). A kernel is booted if its **Linux magic exists AND its uImage CRC is correct**. If either check fails, a `sys'n'_fail` flag is set in the u-boot env and it restarts to try the other kernel. If BOTH fail, system 2 is booted anyway. u-boot's TFTP flash install writes the image to BOTH kernel partitions.

### What This Means for Custom Kernel Development

This is both a **safety net and a trap**:

- **Safety net:** If your custom OpenWrt kernel has a valid uImage header with a correct CRC, u-boot will boot it. If it fails to start (bad entry point, missing DTB, panic), the next reboot falls back to `kernel_stock` automatically — assuming the stock kernel partition is intact.
- **Trap:** If you build a kernel with a **bad or missing uImage CRC**, u-boot will reject it immediately and fall back to stock. This is not a bug — it is the designed behaviour. Always verify your uImage CRC before flashing. The `mkimage` tool computes this automatically; do not hand-edit the header.
- **Recovery implication:** As long as you preserve the `kernel_stock` partition, you always have a fallback to the vendor firmware. Never zero it out unless you are certain your OpenWrt build is stable.
- **TFTP note:** Vendor u-boot TFTP recovery writes to *both* kernel partitions. If you use TFTP recovery after running OpenWrt, it will overwrite your OpenWrt kernel with the stock image.

---

## 6. Networking Architecture

### GMAC Topology

```
                    ┌─────────────┐
   WAN port ───────►│ gmac1 (WAN) │◄── Dedicated GMAC, own MAC from factory@0xe006
                    ├─────────────┤
                    │   MT7621A   │
                    ├─────────────┤
   LAN1 ─┐         │             │
   LAN2 ─┼─switch─►│ gmac0 (CPU) │◄── Carries MT7530 switch traffic
   LAN3 ─┘  ports  │             │
              2,3,4 └─────────────┘
```

**Key verified fact:** On this board, `gmac1` is enabled with `label = "wan"` and `phy-handle = <&ethphy0>`, with its own MAC address from `factory@0xe006`. The WAN port has a **dedicated GMAC** — it does not share the CPU port with the LAN switch. This is significant because:

- Independent WAN/LAN paths unlock ~930 Mbps routed throughput when hardware flow offload is active.
- No contention between WAN and LAN traffic at the MAC level.
- This is already the optimal arrangement — no DTS modification needed.

`gmac0` carries the internal MT7530 switch (`switch0: switch@1f`, `mediatek,mcm`) with LAN ports mapped to switch ports 2, 3, and 4. Modern OpenWrt uses **DSA** (not swconfig) for this target.

### WAN PHY Interrupt Removal

```dts
&ethphy0 {
    /delete-property/ interrupts;
};
```

The WAN PHY interrupt is deliberately removed in the DTS. The driver polls instead. This trades a small amount of latency and CPU overhead for simpler interrupt routing. In practice the impact is negligible at gigabit speeds, but it is worth noting for anyone debugging PHY link-state issues.

---

## 7. WiFi Radios

### 5 GHz: MT7615N (PCIe0)

```dts
&pcie0 {
    wifi@0,0 {
        compatible = "mediatek,mt76";
        reg = <0x0000 0 0 0 0>;
        nvmem-cells = <&eeprom_factory_8000>;
        ieee80211-freq-limit = <5000000 6000000>;
    };
};
```

- 4×4 MIMO class chip
- EEPROM loaded from factory partition offset `0x8000`, size `0x4DA8` (overridden from default)
- Frequency limited to 5000–6000 MHz range

### 2.4 GHz: MT7603EN (PCIe1)

```dts
&pcie1 {
    wifi@0,0 {
        compatible = "mediatek,mt76";
        reg = <0x0000 0 0 0 0>;
        nvmem-cells = <&eeprom_factory_0>;
        ieee80211-freq-limit = <2400000 2500000>;
    };
};
```

- 2×2 MIMO class chip
- EEPROM loaded from factory partition offset `0x0000`, size `0x0400`
- Frequency limited to 2400–2500 MHz range

### mt76 vs Vendor Driver

Be honest about this: the open-source `mt76` driver has had historical stability problems with both MT7603 and MT7615. It has improved substantially over recent years, but it **still trails the vendor proprietary driver** in some areas, particularly on 5 GHz throughput and connection stability under load. Users migrating from stock firmware should expect:

- Possibly lower peak WiFi throughput on OpenWrt.
- Occasional stability differences under heavy multi-client load.
- Better long-term support and security updates (the vendor driver targets kernel 3.10 and receives no patches).

This is the standard trade-off for open-source WiFi drivers on MediaTek silicon. The wired routing performance advantage of OpenWrt with HFO typically outweighs the WiFi delta for most use cases.

---

## 8. What Is NOT Available

It is as important to document what this board lacks as what it has:

| Feature | Status | Detail |
|---|---|---|
| USB port | **Absent** | No USB controller exposed on this board variant |
| WED (Wireless Ethernet Dispatch) | **Not available** | WED starts at Filogic-class SoCs (MT7986+); MT7621 predates it |
| HNAT/PPE in upstream DTS | **Not described** | The silicon contains a PPE engine, but `mt7621.dtsi` has no `hnat` or `ppe` node. Mainline OpenWrt uses nftables flowtable offloading instead |
| Runtime cpufreq driver | **Not available** | Clock is set by bootloader PLL; no `clock-frequency` in DTS; no mainline cpufreq support |
| DTS `clock-frequency` | **Absent** | Verified: the `cpus` node in `mt7621.dtsi` declares no clock property |
| DTS `memory@` node | **Absent** | RAM size is probed at runtime by the kernel, not declared in DT |
| FPU / SIMD / Vector | **Absent** | Soft-float only; no hardware acceleration for FP or vector workloads |
| Second UART console | **Repurposed** | uart2/uart3 pins reassigned to GPIO via `state_default`; only ttyS0 (uartlite) is available as console |

### Console Configuration

Only `ttyS0` is usable as a serial console. The SoC-level default baud rate in `mt7621.dtsi` is 57600, but this board overrides it:

```
console=ttyS0,115200n8
```

The `state_default` node reassigns uart2, uart3, and wdt pin groups to GPIO function:

```dts
&state_default {
    gpio {
        groups = "uart2", "uart3", "wdt";
        function = "gpio";
    };
};
```

---

## 9. What This Means for NexRouter

1. **Flash is abundant.** 117.5 MiB of ubi space means NexRouter can ship a rich default package set, include diagnostic tools, store NetFlow data locally, and support A/B upgrades without any gymnastics.
2. **CPU is the hard constraint.** Every feature that touches packets in software competes with forwarding. Design decisions must prioritise offload and minimise per-packet CPU work.
3. **WAN is already optimised.** The dedicated GMAC1 for WAN means the board is already in the best possible topology for high-throughput routing. No DTS surgery needed.
4. **Dual-boot is a genuine safety feature.** Preserve `kernel_stock` as a fallback. Validate uImage CRCs before flashing.
5. **WiFi will be "good enough," not best-in-class.** The mt76 driver is functional and improving, but users coming from stock should be told upfront that WiFi throughput may decrease while wired routing increases.
6. **No ML on-router.** The CPU architecture makes this non-negotiable. Offload intelligence to external collectors.
7. **No overclocking as default.** It helps only in specific scenarios and carries real risk. Ship behind a documented opt-in gate.
8. **Modern OpenWrt is the right base.** Kernel 6.x, nftables/fw4, DSA, and active security maintenance are all things the vendor firmware cannot offer.

---

## Sources

- Upstream DTS: [`mt7621_xiaomi_redmi-router-ac2100.dts`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621_xiaomi_redmi-router-ac2100.dts)
- Shared NAND partition layout: [`mt7621_xiaomi_nand_128m.dtsi`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621_xiaomi_nand_128m.dtsi)
- SoC base DTS: [`mt7621.dtsi`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621.dtsi)
- OpenWrt device page: [Xiaomi Redmi Router AC2100](https://openwrt.org/toh/xiaomi/redmi_router_ac2100)
- OpenWrt device Makefile: [`target/linux/ramips/image/mt7621.mk`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/image/mt7621.mk)
- arinc9 HFO benchmarks: [github.com/openwrt/mt76 issue #868](https://github.com/openwrt/openwrt/issues/868)
- MIPS 1004Kc architecture: [MIPS Technologies 1004Kc Core Family](https://www.mips.com/products/processors/)
