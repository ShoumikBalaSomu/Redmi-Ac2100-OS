# Complete Silicon & PCB Chip Study, Hardware Modding Guide, and Flagship Router Features (Redmi Router AC2100 / RM2100)

This engineering reference documents every integrated circuit (IC) soldered onto the **Xiaomi Redmi Router AC2100 (`RM2100`)** 110 mm × 90 mm motherboard, details which hardware chips/mods can be physically added to the board, and explains the modern flagship router features (Encrypted DNS-over-HTTPS with AdGuard Ad-Blocking, Wi-Fi 6 MAC backports, and Web UI controls) integrated into **NexRouter v3.2**.

---

## 1. Complete PCB Integrated Circuit (IC) Inventory

| Ref / Location | Exact Chip Marking | Manufacturer & Part | Subsystem Role | Internal Architecture & Hardware Specifications |
|---|---|---|---|---|
| **SoC (`U1`)** | `MT7621AT` | [MediaTek MT7621AT](https://www.scribd.com/document/922673774/MT7621A-Datasheet) | Dual-Core Network Processor SoC | **CPU**: MIPS 1004Kc Dual-Core / **4 Hardware VPEs (Threads)** @ 880 MHz (`L1`: 32 KB I + 32 KB D per core; `L2`: 256 KB 8-way shared).<br>**PPE**: 2 Gbps Hardware Packet Processing Engine (16,384 hardware NAT/flowtable entries in internal SRAM).<br>**DMA**: 16-channel General DMA (`GDMA`) + High-Speed DMA (`HSDMA`).<br>**PCIe**: 3× PCIe 1.1/2.0 Root Complex (`1e140000.pcie`).<br>**Hidden Silicon Blocks**: Integrated USB 3.0 + USB 2.0 `xHCI` controller (`1e1c0000.xhci`), PCM/VoIP, I2S, SDXC, and Crypto Engine (unrouted on RM2100 PCB). |
| **Switch Die (Inside `U1` MCM)** | `MT7530` | MediaTek MT7530 (Multi-Chip Module inside `MT7621AT`) | 7-Port Gigabit Ethernet Switch + 5× PHYs | **WAN (`gmac1`)**: Dedicated RGMII/TRGMII path wired directly to `ethphy0` (own MAC at `factory@0xe006`), bypassing the LAN switch bus.<br>**LAN (`gmac0`)**: 3× Gigabit LAN ports mapped to switch ports 2, 3, and 4 via OpenWrt DSA (`mt7530-dsa`) with hardware VLAN tag offloading. |
| **5 GHz Radio (`PCIe0`)** | `MT7615N` | [MediaTek MT7615N](https://www.acwifi.net/8939.html) | 4×4 MIMO 5 GHz 802.11ac Wave 2 Transceiver + Baseband | **RF Chains**: 4T4R (4 Transmit × 4 Receive spatial streams, `1,733.3 Mbps` PHY @ VHT80 MCS 9 256-QAM).<br>**Internal Dual MCUs**:<br>1. **Andes N9 32-bit RISC MCU** (`mt7615_n9.bin`): Executes 802.11 MAC, Explicit/Implicit Beamforming (`eBF`/`iBF`) CSI matrix sounding, and thermal/PA calibration.<br>2. **ARM Cortex-R4 MCU** (`mt7615_cr4.bin`): Hardware Warp/WA packet aggregation engine.<br>**Front-End**: High-power integrated PA (`iPA`, up to +26 dBm EIRP) + integrated LNA (`iLNA`) calibrated by the 19,880-byte (`0x4DA8`) factory EEPROM cell at `0x8000`. |
| **2.4 GHz Radio (`PCIe1`)** | `MT7603EN` | [MediaTek MT7603EN](https://www.acwifi.net/8939.html) | 2×2 MIMO 2.4 GHz Wi-Fi Transceiver + Baseband | **RF Chains**: 2T2R (`300 Mbps` standard 802.11n HT40 MCS 15; unlocked to **`400 Mbps` PHY** via 256-QAM VHT40 TurboQAM in `NexRouter v3.2`).<br>**Internal MCU**: Andes N9 32-bit RISC MCU (`mt7603_e2.bin`).<br>**Calibration**: 1,024-byte (`0x0400`) factory EEPROM cell at `0x0000`. |
| **2.4 GHz External FEMs (`U10`, `U11`)** | Silkscreen `4200` | **2× Qorvo `QPF4200`** ([Teardown Verified](https://www.acwifi.net/8939.html)) | **Wi-Fi 6 (802.11ax) +5V High-Power PA + LNA Front-End Modules** | **Key Hardware Discovery**: Xiaomi populated two genuine **Wi-Fi 6 (802.11ax HE40 MCS11)** external +5V Front-End Modules on the 2.4 GHz chains:<br>• **TX Power Gain**: `33 dB`<br>• **RX LNA Gain**: `15.5 dB` with ultra-low **`2.1 dB` Noise Figure** & `25 dB` 5 GHz rejection filter<br>• **Linear Output Power**:<br>  - `+19 dBm` @ **MCS11 HE40 (1024-QAM Wi-Fi 6, -43 dB EVM)**<br>  - `+21 dBm` (`128 mW`/chain = `250 mW` 2×2) @ **MCS9 VHT40 (256-QAM TurboQAM, -35 dB EVM)**<br>  - `+22.5 dBm` (`178 mW`/chain = `356 mW` 2×2) @ **MCS7 HT40**<br>  - `+25 dBm` (`316 mW`/chain = `630 mW` 2×2) @ **HT20 MCS0 (Extreme Wall Range)** |
| **DRAM (`U2`)** | `M15T1G1664A` | [ESMT M15T1G1664A](https://myds.cloud/redmi_ac2100/%E5%88%B7%E7%AC%AC%E4%B8%89%E6%96%B9rom) | System Volatile RAM | **Capacity**: 1 Gigabit = **128 MiB** (`64M × 16-bit`) DDR3-1600 SDRAM in 96-ball FBGA package. |
| **Flash (`U3`)** | `F59L1G81MB` | [ESMT F59L1G81MB](https://www.acwifi.net/8939.html) | Non-Volatile Boot & OS Storage | **Capacity**: 1 Gigabit = **128 MiB** 3.3V SPI NAND Flash (JEDEC ID `0xC8 0xD1`, 2 KiB page, 128 KiB erase block). Provides **117.5 MiB (`ubi`)** usable rootfs/overlay + dual 4 MiB kernel slots (`kernel_stock` + `kernel`). |
| **PMIC / DC-DC Buck Rails** | 12V/1.5A Input (`4.0×1.7mm` barrel) | Synchronous Buck Converters (`+5.0V`, `+3.3V`, `+1.5V` DDR3, `+1.1V` Core) | Power Delivery Network | Dedicated `+5.0V` rail powers the dual Qorvo `QPF4200` 2.4 GHz FEMs for high-linearity +25 dBm output; `+3.3V` rail powers `MT7615N` iPA and SPI NAND; `+1.5V` powers DDR3; `+1.1V` powers `MT7621AT` core. |

---

## 2. Can New Chips or Hardware Be Physically Added to the Redmi AC2100?

Yes! Here is the exact hardware modding feasibility matrix for the Redmi AC2100 (`RM2100`) PCB:

| Hardware Mod / Chip Addition | Feasibility | How It Works & What NexRouter v3.2 Supports |
|---|---|---|
| **1. 512 MiB DDR3 RAM Chip Upgrade (96-Ball FBGA Swap)** | **HIGHLY FEASIBLE & PROVEN** ([RM2100 512MB Mod](https://www.right.com.cn/forum/thread-4053917-1-1.html)) | The `MT7621AT` memory controller (`memc@5000`) natively addresses up to **512 MiB (`256M × 16-bit`)** DDR3 SDRAM. By desoldering the stock 128 MiB `ESMT M15T1G1664A` with a hot-air rework station and soldering a **256 MiB (`2Gb`) or 512 MiB (`4Gb`) 96-ball FBGA DDR3-1600 16-bit chip** (such as **Micron `MT41K256M16TW-107`**, **Samsung `K4B4G1646E-BYK0`**, or **SK Hynix `H5TC4G63AFR-PBA`**), the router boots with **512 MiB RAM**! Because OpenWrt's `mt7621` kernel dynamically probes RAM size at boot (`mt7621.dtsi` has no hardcoded `memory@` limit), **NexRouter v3.2 automatically recognizes all 512 MiB of RAM with zero firmware changes required**. |
| **2. 4-Pin 3.3V UART Serial Console Header (`J1`)** | **EASY (Through-Hole / Pads on PCB)** | The PCB exposes the 4-pin `ttyS0` UART interface (`TX`, `RX`, `GND`, `VCC 3.3V` @ `115200 8N1`). Soldering a 4-pin 2.54mm header gives you full U-Boot TFTP recovery, Breed bootloader access, and kernel serial console debugging. *(Never connect the 3.3V VCC pin to your USB-TTL adapter—only connect `TX`, `RX`, and `GND`).* |
| **3. Thermal Pad & Heatsink Contact Mod** | **EASY & HIGH IMPACT** | As shown in the [acwifi.net teardown](https://www.acwifi.net/8939.html), the RM2100 has a massive extruded aluminum heatsink larger than the 11×9 cm PCB itself, but a gap between the RF shield cans (`MT7615N` / `MT7621AT`) and the aluminum plate. Adding a **1.5 mm – 2.0 mm 6 W/mK silicone thermal pad** (or copper shim) between the shield cans and the aluminum heatsink drops `MT7615N` 5 GHz RF junction temperatures by **12–16 °C**, preventing thermal TX power backoff at 26 dBm! |
| **4. USB 2.0 / 3.0 Port Addition (`xHCI` BGA Mod)** | **EXTREME DIFFICULTY (Not Recommended)** ([Forum Discussion](https://www.right.com.cn/forum/thread-4019221-1-1.html)) | Although the `MT7621AT` silicon die contains a built-in USB 3.0 + 2.0 `xHCI` controller, Xiaomi did **not** route the USB `D+`/`D-` or `SSTX`/`SSRX` balls out to solder pads on the RM2100 PCB. Adding USB requires micro-soldering `0.1 mm` magnet wire directly underneath the `MT7621AT` BGA balls plus adding a external 5V buck regulator. Instead of risking PCB trace damage, use network storage (SMB/NFS/NetFlow) over the router's 1 Gbps LAN switch. |
| **5. Adding a Wi-Fi 6 (`MT7915`) Chip** | **NOT POSSIBLE ON RM2100 PCB** | Both `MT7615N` (`PCIe0`) and `MT7603EN` (`PCIe1`) are BGA/QFN chips soldered directly onto the mainboard (not removable Mini-PCIe cards), and `PCIe2` is unrouted. Instead, NexRouter v3.2 backports Wi-Fi 6 `OBSS-PD` Spatial Reuse, Virtual-Time Airtime Fairness (`ATF` + `AQL`), `802.11v WNM` Sleep + `ProxyARP`, `MU-EDCA` priority queues, and `802.11r` `<15 ms` Fast Roaming in software! |

---

## 3. Modern Flagship Router Features Added in NexRouter v3.2

### A. One-Click Encrypted DNS-over-HTTPS (DoH) & Network-Wide Ad-Blocker (`/nex/` Web UI + `rpcd`)
Standard routers leak every domain you visit in plaintext UDP port 53 to your ISP, allowing DNS snooping, throttling, or transparent DNS hijacking.
- **How NexRouter v3.2 Solves It**:
  - Runs `https-dns-proxy` (RFC 8484 HTTP/2 TLS 1.3 DoH client with DSCP EF `46` packet marking) behind `dnsmasq` (configured with a **4,096-entry local RAM cache**, `min_cache_ttl=300`, and DNS-rebind attack protection).
  - Exposes `doh_get` and `doh_set` in `/usr/libexec/rpcd/nexrouter` and renders an interactive **Encrypted DNS-over-HTTPS & Ad-Blocker Switcher** card in the **NexRouter Web UI (`http://192.168.1.1/nex/` → Settings)**:
    1. **Cloudflare `1.1.1.1` DoH (`cloudflare`)**: `https://cloudflare-dns.com/dns-query` — fastest sub-5ms anycast response in Dhaka/South Asia for gaming and low-latency browsing.
    2. **AdGuard Ad & Tracker Blocker DoH (`adguard`)**: `https://dns.adguard-dns.com/dns-query` — **blocks ads, mobile app telemetry, analytics trackers, and phishing domains across every phone, Smart TV, and laptop on your Wi-Fi** using **0 MiB of extra router RAM** (unlike heavy blocklists that OOM a 128 MiB router!).
    3. **Quad9 `9.9.9.9` Security DoH (`quad9`)**: `https://dns.quad9.net/dns-query` — blocks botnet C2, spyware, and malware domains via real-time threat intelligence.
    4. **Google Public DNS DoH (`google`)**: `https://dns.google/dns-query`.
    5. **Cloudflare `1.1.1.3` Family + Malware Filter (`cloudflare_family`)**: `https://family.cloudflare-dns.com/dns-query`.

### B. Dual Modern Web Interfaces (`NexRouter Telemetry SPA` + `LuCI Argon Glassmorphic`)
- **Zero-Dependency NexRouter Instrument Dashboard (`http://192.168.1.1/nex/`)**:
  - Pure ES-module vanilla JavaScript SPA (~35 KB total, zero framework bloat, zero Lua CPU overhead) polling `/ubus` directly:
    - **Overview Panel**: Live per-VPE CPU load, RAM, SoC/RF thermal sensor, PPE hardware flow counter, and the **PCB Silicon & Hardware IC Inventory table**.
    - **Performance Panel**: Live MT7621 PPE hardware flowtable verification (`/proc/net/stat/nf_flowtable`), `fq_codel` vs `CAKE` AQM status, conntrack utilization, and 4-VPE IRQ affinity table.
    - **Wireless Panel**: Live **AI-RF Contextual Bandit & Wi-Fi 6 OBSS-PD Spatial Reuse Controller** card (`PEAK_AGGREGATION_1733M`, `BEAMFORM_BALANCED`, `WALLBREAKER_LONG_RANGE`, `DENSE_OBSS_SPATIAL_REUSE`), per-station distance regime, retry %, and airtime weights.
    - **Settings Panel**: One-click **Encrypted DoH & AdGuard Ad-Block Switcher**, NetFlow v5 export to the `companion/nexinsight` Isolation Forest ML collector, and privacy audit controls.
- **Full OpenWrt LuCI with Argon Theme (`http://192.168.1.1/cgi-bin/luci/`)**:
  - Ships with `luci-theme-argon` v2.4.8, `luci-app-argon-config`, `luci-app-https-dns-proxy`, `luci-app-firewall`, and `luci-app-statistics`.
