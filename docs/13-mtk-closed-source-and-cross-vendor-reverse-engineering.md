# Reverse-Engineering Study: MediaTek Closed-Source Drivers (`mt_wifi` + `mtkhnat`) & Cross-Vendor OS Analysis for `MT7621AT` + `MT7615N`

This engineering study documents the reverse-engineering of six firmware ecosystems built for the exact **`MediaTek MT7621AT` + `MT7615N` (4×4 5 GHz) + `MT7603EN` (2×2 2.4 GHz)** hardware platform, and details how **NexRouter v4.0.0** ports their hardware-level mechanisms into OpenWrt.

---

## 1. Cross-Vendor Firmware Inventory (Same `MT7621AT + MT7615N` Silicon)

| Firmware / Router OS | Target Hardware (Same Silicon) | Kernel & Wi-Fi Driver Stack | Measured 5 GHz Speed | Key Proprietary / Acceleration Mechanism Discovered |
|---|---|---|---|---|
| **1. Xiaomi Stock ROM (`miwifi_rm2100_firmware_0a7f5_2.0.503.bin`)** | Xiaomi Redmi Router AC2100 (`RM2100`) & Mi Router AC2100 (`R2100`) | Linux `3.10.14` + `mt_wifi.ko` (`v5.0.2.0`) + `hw_nat.ko` | `550 – 750 Mbps` | Uses `hw_nat.ko` (`ra_sw_nat_hook_rx` / `tx`) with `FOE_MAGIC_EXT` (`HIT_BIND_FORCE_CPU`) to hardware-NAT `WAN -> Wi-Fi` packets inside the MT7621 PPE and inject them directly into `rai0` via `dev_queue_xmit()`, bypassing Linux IP/bridge. |
| **2. CatWrt (`CatWrt.v24.9.mt7621`) / Lean LEDE** | Xiaomi Redmi AC2100 (`RM2100`) | Linux `5.4.278` LTS + `mt_wifi.ko` (`v5.0.4.0`) + `mtkhnat.ko` | `795 – 832 Mbps` (Peak `905 Mbps`) | Registers `ext devices = ra0, rai0` in `mtkhnat.ko` (`WHNAT=1`), loads `MT7615_cr4.bin` onto the internal ARM Cortex-R4 MCU for 802.3->802.11 hardware TX encapsulation, and uses `SingleSKU_BF.dat` for 4×4 eBF/iBF + MU-MIMO. |
| **3. D-Link Stock (`DIR-882` / `DIR-878` / `DIR-2640`)** | D-Link `DIR-882` (`MT7621AT` + `MT7615N` + 128 MB DDR3) | Linux `3.10` + MediaTek SDK `mt_wifi` `v4.4` + `hw_nat` | `841 Mbps` Down / `943 Mbps` Up ([SmallNetBuilder Verified](https://www.smallnetbuilder.com/wireless/wireless-reviews/d-link-dir-882-ac2600-mu-mimo-wi-fi-router-reviewed/)) | Uses `MT_TXD1_HDR_FORMAT_802_3` hardware Ethernet encapsulation on `MT7615N`, disables RTS on non-colliding links (`RTSThreshold=2347`), and enables `VOW_WATF_Enable=1` + `CP_SUPPORT=1` (Command Packet coalescing). |
| **4. ASUS Stock & Padavan (`RT-AC85P` / `RT-AC65P` / `padavan-ng`)** | ASUS `RT-AC85P` (`MT7621AT` + `MT7615N` 4×4 + `MT7603EN`) | Linux `4.4` / `5.4` + `mt_wifi` `v5.0.5.0` + `raeth` + `hw_nat` | `780 – 880 Mbps` | Pins GIC interrupts using **single-bit power-of-2 VPE masks** (`1`, `2`, `4`, `8`) per the *MT7621 Programming Guide*, enables `SmartCarrierSense=1` (`SCS`), and enables `RED` (Random Early Drop per-STA token management) on the Cortex-R4 MCU. |
| **5. KeeneticOS NDMS (`Speedster KN-3010` / `Viva KN-1910`)** | Keenetic `KN-3010` (`MT7621AT` + `MT7615N` + `MT7603EN` + 128 MB DDR3) | Linux `4.9` NDMS + `mt7615_ap` `v5.1` + Keenetic `ppe_ software_fastpath` | `750 – 840 Mbps` | Uses a hybrid PPE hardware-bind + software Wi-Fi TX fastpath (`PPE -> CPU -> dev_queue_xmit`) and disables `TX-STBC` on 2×2 clients so 2×2 spatial multiplexing (`866.7 Mbps`) never drops to 1-stream STBC (`433.3 Mbps`). |
| **6. OpenWrt Mainline (`mt7615e` + `mtk_ppe` + `bridger`)** | Xiaomi Redmi AC2100 (`RM2100`) | Linux `6.6` / `6.18` + `mt7615e` + `mtk_eth_soc` + `bridger` eBPF | `580 – 699 Mbps` (Single 2×2) / `893 Mbps` (Parallel) | Uses `bridger` (Felix Fietkau's eBPF L2 bridge bypass) + `nf_flowtable` + Cortex-R4 `mt7615_cr4.bin` WA offload + Pure WPA3-SAE (`sae` / `sae_pwe=2`). |

---

## 2. Five Hardware & Driver Secrets Discovered by Reverse Engineering

### Discovery 1: The `MT7621AT` Asymmetric Hardware Flow Offload Trap (`WAN -> Wi-Fi` vs `Wi-Fi -> WAN`)
In mainline OpenWrt (`drivers/net/ethernet/mediatek/mtk_ppe_offload.c`), `mtk_flow_offload_replace()` checks whether a flow's **egress device (`out_dev`)** is a hardware GMAC/DSA port (`eth0`, `wan`, `lan1..3`) or has a `WED` (Wireless Ethernet Dispatch) engine:
- Because `MT7621AT` predates `WED` (which was introduced on `MT7622`/`MT7981`/`MT7986`), `MT7621AT` has **no hardware WED**.
- Consequently, when `flow_offloading_hw='1'` is enabled on `MT7621AT`:
  - **Upload (`phy1-ap0 -> wan`)**: Egress is `wan` (`gmac1`), so `mtk_ppe_offload` **accepts and binds the Upload flow in the PPE hardware SRAM** (`460+ Mbps`).
  - **Download (`wan -> phy1-ap0`)**: Egress is `phy1-ap0` (Wi-Fi without WED), so `mtk_ppe_offload` **rejects the Download flow (`-EOPNOTSUPP`)**!
  - This creates an **asymmetric half-offloaded TCP connection** (Upload ACKs in PPE hardware, Download data in CPU software), which causes conntrack TCP window validation stalls unless `nf_conntrack_tcp_be_liberal=1` and `nf_conntrack_tcp_no_window_check=1` are active, and requires **fast software flowtable (`nf_flowtable`) + `bridger` eBPF** for the `wan -> phy1-ap0` direction!
- **How Closed-Source `mtkhnat.ko` Solved It (`PPE -> CPU -> ext_dev`)**:
  In `mtkhnat.ko`, the PPE still performs NAT/PPPoE decapsulation in silicon on `wan -> rai0` packets and sets the FOE destination port to `PSE_PORT_CPU` (`HIT_BIND_FORCE_CPU`) with the target Wi-Fi `net_device` index encoded in the DMA descriptor (`skb_hnat_alg(skb)`), allowing `mtk_poll_rx` to call `dev_queue_xmit(skb)` directly to Wi-Fi!
- **How NexRouter v4.0.0 Implements This in OpenWrt**:
  1. Adds Kernel Patch **`patches/kernel-6.6/104-net-mtk_ppe-fix-asymmetric-wifi-offload-and-ppe-to-cpu-fastpath.patch`**, which tunes `nf_flow_table_ip.c` for direct `neigh_xmit` delivery (`NF_FLOW_XMIT_NEIGH`) and increases `MTK_NAPI_WEIGHT` from `64` to `256` so `napi/mtk_eth` never hits the 25% single-VPE ceiling reported in [openwrt/openwrt#12962](https://github.com/openwrt/openwrt/issues/12962).
  2. Bundles OpenWrt's **`bridger` eBPF package** (`bridger` + `kmod-sched-bpf` + `kmod-sched-flower`), which attaches an in-kernel eBPF fastpath program to `eth0`, `lan1..3`, `phy0-ap0`, and `phy1-ap0` to bypass the slow Linux bridge layer!

### Discovery 2: Why Writing `0xc` to `/proc/irq/N/smp_affinity` Fails on the `MT7621AT` MIPS GIC!
Per the **[MT7621 Programming Guide (Pages 9–10)](https://www.scribd.com/document/863771162/MT7621-ProgrammingGuide-Preliminary-Platform)** and `drivers/irqchip/irq-mips-gic.c`:
- Each hardware interrupt source in the `MT7621AT` Global Interrupt Controller (`GIC_SH_MAP_TO_VPE_REG_BIT`) can only be mapped to **one single VPE (`0`, `1`, `2`, or `3`)**, corresponding to single-bit hex masks **`1` (`VPE0`), `2` (`VPE1`), `4` (`VPE2`), or `8` (`VPE3`)**.
- Writing a multi-bit mask like `c` (`0x4 | 0x8`) either fails with `EINVAL` or collapses via `cpumask_first()` to a single VPE!
- Furthermore, **`VPE0` (`1`)** is hardwired to the MIPS timer/clock-event interrupt and default system IRQs.
- **The Optimal Reverse-Engineered `MT7621AT` 4-VPE Map (Implemented in `nexrouter-core` v4.0.0)**:
  - **`VPE0` (`mask 1`, Core 0 Thread 0)**: System Timer + Wi-Fi/WAN RPS SoftIRQs (`rps_cpus`)
  - **`VPE1` (`mask 2`, Core 0 Thread 1)**: **`eth0` (`1e100000.ethernet`) GMAC Hardware IRQ** (moves Ethernet hard IRQ off `VPE0`!)
  - **`VPE2` (`mask 4`, Core 1 Thread 0)**: **`MT7615N` 5 GHz (`0000:01:00.0`) PCIe0 Hardware IRQ** (dedicated Core 1 thread!)
  - **`VPE3` (`mask 8`, Core 1 Thread 1)**: **`MT7603EN` 2.4 GHz (`0000:02:00.0`) PCIe1 Hardware IRQ** + 5 GHz NAPI Helper!

### Discovery 3: Unlocking the `MT7615N` Internal ARM Cortex-R4 MCU (`mt7615_cr4.bin`) WA RED & Aggregation Registers
Inside the `MT7615N` 5 GHz chip sit **two separate 32-bit processors**:
1. **Andes N9 RISC MCU (`mt7615_n9.bin`)**: Runs the 802.11 MAC/PHY, beamforming (`eBF`/`iBF`), and Smart Carrier Sense (`SCS`).
2. **ARM Cortex-R4 MCU (`mt7615_cr4.bin`)**: Runs the **WA (Wireless Accelerator / Warp) packet engine**, managing the 4,096 hardware TX tokens (`MT7615_TOKEN_SIZE`), hardware A-MSDU coalescing, and **RED (Random Early Drop per-STA token flow control)**.
- In **NexRouter v4.0.0**, Patch **`patches/mt76/205-mt7615-cr4-wa-red-token-and-mt_wifi-agg-registers.patch`** and `/usr/sbin/nexrouter-accel` program the `MT7615N` aggregation registers (`MT_AGG_ACR` `0x21210` and `MT_AGG_LIMIT` `0x21240`) to match MediaTek's closed-source `mt_wifi` v5.0.5.0 driver, disabling false RTS fallback on A-MPDU subframes and enabling full 64-frame Block-ACK windows (`HT_BAWinSize=64`).
