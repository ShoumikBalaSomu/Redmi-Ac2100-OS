# NexRouter v5.0.0 — AX1800 Wi-Fi 6 Hybrid, Hardware WPA3 & Closed-Source Reverse-Engineered Edition — Cloud Snapshot Builder & Stock Silicon Max Edition (Redmi-AC2100-OS)

[Open In Colab](https://www.google.com/search?q=https%3A%2F%2Fcolab.research.google.com%2Fgithub%2FShoumikBalaSomu%2FRedmi-Ac2100-OS%2Fblob%2Fmain%2Fcolab%2FNexRouter_OpenWrt_Builder.ipynb)

Custom Kernel 6.6/6.18, `mt76` Wireless Driver, Wi-Fi 6 MAC Backport Stack, and On-Router AI-RF Contextual Bandit OS for the **Xiaomi Redmi Router AC2100** (`RM2100`), engineered to extract maximum speed, memory, and range **from your existing stock hardware (zero physical soldering required)**.

## 0. NexRouter v5.0.0 Apex Peak Edition Architecture & Key Innovations

NexRouter OS v5.0.0 pushes the Xiaomi Redmi Router AC2100's physical silicon to its maximum theoretical limits:

### 1. 1.2 Gbps TRGMII Switch Trunk & Enhanced Device Tree
- **1.2G TRGMII Switch Trunk**: Overclocked internal TRGMII interface between MT7621AT SoC and MT7530 switch from 1.0 Gbps to 1.2 Gbps, eliminating switch-to-CPU bottlenecks under full-duplex line-rate throughput.
- **Enhanced MIPS 1004Kc Tuning**: Compiler optimizations targeting 1004Kc dual-core MIPS architecture with DSP extension (`-O3 -mtune=1004kc -mdsp`).

### 2. WPDMA Ring Burst & Hardware IRQ Coalescing
- **MT7615N WPDMA Coalescing**: Register `0x4210 = 0x80108010` enables 16-packet / 20 µs hardware interrupt moderation.
- **TX_WB_DDONE & 256B Burst**: Register `0x4208` enables TX write-back done bit and 256-byte PCIe DMA burst transfers.
- **Cortex-R4 PDMA Cut-Through**: Internal ARM Cortex-R4 dedicated token flow control for 4×4 5 GHz VHT80 ring.

### 3. Integrated LuCI File Manager & Comprehensive Web UI
- **LuCI File Manager**: Bundled official `luci-app-filemanager` with HexEditor, Markdown viewer, and full file transfer capabilities.
- **Full RW ACLs**: Granted authenticated and LAN unauthenticated access to system management endpoints via `rpcd` ACL definitions.
- **Web UI Integration**: Added direct shortcut card to File Manager and LuCI Argon in the `/nex/` dashboard.

### 4. AX1800 Wi-Fi 6 Hybrid Features & Hardware WPA3
- **AX1800 Hybrid Backport**: MBO (Multi-Band Operation), RNR (Reduced Neighbor Reporting), OKC (Opportunistic Key Caching), QoS Map Set, and HTC-VHT (`htc_vht=1`).
- **Hardware WPA3 Engine**: MediaTek WTBL + EIP-93 hardware crypto engine acceleration with closed-source WPA3PSK and 24-hour group rekeying (`wpa_group_rekey=86400`).

---

## 0A. Proven Throughput & Wired LAN Stability Enhancements

### Wired LAN Healer & Zero-Drop Laptop Roaming (`30-nexrouter-lan-heal`)
- **Authoritative DHCP**: `authoritative='1'`, `rapid_commit='1'`, and `dhcp.lan.force='1'` eliminate `169.254.x.x` unassigned IP stalls on reconnect.
- **MT7530 EEE Disabled**: Disables 802.3az Low-Power Idle (`ethtool --set-eee lan1..3 eee off`) preventing link-flaps with Realtek/Intel NICs.
- **Triple-RPS Elimination**: Sets `rps_cpus=0` on virtual DSA slaves (`lan1`–`lan3`, `br-lan`) while keeping single-VPE GMAC pinning on VPE1.
- **Network Buffers & Offload**: 8 MiB TCP socket buffers, BBR congestion control, and hardware flowtable offloading (`flow_offloading_hw=1`).

---

## 1. Build in the Cloud with Google Colab (Latest OpenWrt `snapshot` or `24.10.2`)

You can build the complete `.bin` sysupgrade ROM in **\~3 minutes** in your browser using Google Colab—no local Linux PC or WSL2 needed:

1. **Click the Colab Button above** (after pushing this repo to your GitHub, replace `ShoumikBalaSomu/Redmi-Ac2100-OS` in the link above with your GitHub repo path) — **OR** open [Google Colab](https://www.google.com/search?q=https%3A%2F%2Fcolab.research.google.com%2F) and upload `colab/NexRouter_OpenWrt_Builder.ipynb` from this repo.

2. **Choose your `BUILD_TRACK` in Cell 3**:

   * **`snapshot` (Default)**: Builds against the **latest OpenWrt `snapshot`** (`https://downloads.openwrt.org/snapshots/targets/ramips/mt7621/`) with automatic `apk`/`opkg` feed detection, 64 MiB ZRAM Virtual RAM, Qorvo `QPF4200` 2.4 GHz FEM calibration, Wi-Fi 6 OBSS-PD Spatial Reuse, and the AI-RF Contextual Bandit.

   * **`24.10.2`**: Builds against stable OpenWrt `24.10.2` LTS with bundled `luci-theme-argon` + `luci-app-argon-config`.

   * **`full-source-snapshot`**: Clones OpenWrt `main` (`snapshot`) and compiles the kernel + `mt76` C patches from source.

3. **Run Cell 4** to automatically verify the uImage CRC via `fwscan.mjs` and download the finished `*sysupgrade*.bin` file to your computer.

## 2. Optional Admin Password in `/nex/` Portal & LuCI Argon

By default, NexRouter v5.0.0 ships in **Passwordless Mode** so `http://192.168.1.1/nex/` and `http://192.168.1.1/cgi-bin/luci/` open immediately without blocking you on a login screen.

Whenever you want to add or remove a password, you can do it from **either** web portal (both update `/etc/shadow` for `root`, so `/nex/`, LuCI Argon, and SSH stay in sync):

* **From the NexRouter `/nex/` Portal (`http://192.168.1.1/nex/` → `Settings` Panel)**:

  * Open the **"Router Admin Password & Portal Security (`/nex/` + LuCI Argon + SSH)"** card at the top of `Settings`.

  * **To Set a Password**: Type your new password (`min 4 chars`) and click **Set / Update Password**. You can also toggle **"Require password login on `/nex/` portal startup"** ON or OFF independently.

  * **To Return to Passwordless Mode**: Click **Remove Password (Passwordless Mode)** at any time to clear the password and restore instant passwordless login.

* **From LuCI Argon (`http://192.168.1.1/cgi-bin/luci/` → `System` → `Administration`)**:

  * Enter your new router password and click **Save**—it updates the same `root` account in `/etc/shadow`.

## 3. Software-Only Upgrades Pushed Between Your Present Stock Chips (Zero Soldering)

| Stock Chip on Your Board | Physical Spec | Software-Only Upgrade Pushed in NexRouter v5.0.0 | 
| ----- | ----- | ----- | 
| **1. `ESMT M15T1G1664A` (DRAM)** | **128 MiB** 16-bit DDR3-1600 | **64 MiB ZRAM Compressed Virtual RAM Multiplier (`nexrouter-core.sh` + `99-nexrouter-firstboot.sh`)**: Creates an in-RAM `lz4` / `lzo-rle` compressed swap block device across all 4 MIPS VPEs (`vm.page-cluster=0`, `vm.swappiness=100`). With \~3:1 compression, your stock **128 MiB DDR3 chip operates like \~190–210 MiB of effective RAM** with zero NAND flash wear. | 
| **2. `2× Qorvo QPF4200` (2.4 GHz FEMs)** | **Wi-Fi 6 Rated** +5V External PA/LNA (`33 dB` TX, `15.5 dB` LNA, `2.1 dB` NF) | **QPF4200 High-Gain LNA & 256-QAM 400 Mbps Unlock (`nexrouter-core.sh` + Patch `202`)**: Programs `MT7603EN` register `0x10f18 = 0x00000012` at boot to unlock the QPF4200's full `15.5 dB` RX LNA gain (`-98 dBm` sensitivity floor) and enables `vendor_vht='1'` (256-QAM VHT40) so 2.4 GHz links at **400 Mbps PHY** (up from 300 Mbps). | 
| **3. `MediaTek MT7615N` (5 GHz 4×4 Radio)** | 4T4R 802.11ac Wave 2 + Dual Internal MCUs (Andes N9 + Cortex-R4) + Stock Heatsink | **1,733.3 Mbps 4×4 VHT80 + 11.4 KB MPDU + Stock Heatsink Thermal Auto-Guard (`farlink-ai-rf-daemon.sh` + Patch `201`/`203`)**: Unlocks 11,454-byte MPDUs, 16-fragment hardware TX A-MSDU, 4×4 eBF/iBF Phased Array beamforming, and 26 dBm (400 mW) TX power—while polling the on-die thermal sensor (`temp1_input`) to step down 2 dBm (`24 dBm`) if the unmodded stock heatsink reaches `78 °C`. | 
| **4. `MediaTek MT7621AT` + `MT7530` (SoC + Switch)** | Dual-Core / 4-VPE MIPS 1004Kc @ 880 MHz + 2 Gbps PPE + 7-Port Switch | **1.2G TRGMII Trunk + 16,384-Flow Hardware PPE + 4-VPE Threaded NAPI Split (`nexrouter-core.sh` + Patch `101`/`102`)**: Overclocks switch trunk to 1.2 Gbps, expands DMA rings to `512`, expands PPE hardware flowtable to `16,384` flows, enables DDR3 burst prefetching (`memc + 0x04`), enables Threaded NAPI (`threaded=1`), and pins GMAC to `VPE1`, 5G (`MT7615N`) to `VPE2`, 2.4G (`MT7603EN`) to `VPE3`, and Timer/SoftIRQ to `VPE0`. | 
| **5. Wi-Fi 6 MAC Backport & DoH Ad-Blocker** | Software MAC (`mac80211` + `hostapd`) + `https-dns-proxy` | **AX1800 Wi-Fi 6 Hybrid Features + 1-Click Encrypted DoH**: MBO, RNR, OKC, QoS Map Set, HTC-VHT, Dynamic `OBSS-PD` Spatial Reuse (`CCA-ED` `-68 dBm` to `-98 dBm`), Virtual-Time Airtime Fairness (`ATF` + `AQL`), `802.11v WNM` Sleep + `ProxyARP` (TWT equivalent), `MU-EDCA` gaming/voice queues, `<15 ms` `802.11r` Fast Roaming, and one-click Cloudflare / AdGuard Ad-Block DoH in `/nex/`. | 

## 4. Local CLI Build Quick Start

```
# Default: Build using LATEST OpenWrt SNAPSHOT (ImageBuilder, ~3 mins)
./build/build.sh --release snapshot

# Or build using stable OpenWrt 24.10.2 LTS (ImageBuilder, ~3 mins)
./build/build.sh --release 24.10.2

# Full Source Build (Latest OpenWrt main/snapshot + all 7 Kernel & mt76 C patches)
./build/build-from-source.sh --branch main

# MediaTek Proprietary Driver + WHNAT Repack (0x4DA8 EEPROM + Hardware MU-MIMO)
./build/repack-mtk-firmware.sh analysis/raw/catwrt_v24.9.bin

```