# Technical Truth: MU-MIMO vs SU-MIMO on MediaTek MT7615 (OpenWrt)

This document provides a deep, evidence-based assessment of Multi-User MIMO (MU-MIMO) support on the Xiaomi Redmi Router AC2100 (RM2100) running OpenWrt with the MediaTek MT7615 5GHz wireless chipset.

---

## 1. Summary of Findings

1. **User Observation Confirmed:** In mainline OpenWrt running the open-source `mt7615e` driver, **MU-MIMO is NOT enabled or active**.
2. **Configuration Illusion:** Adding `option mu_beamformer '1'` in `/etc/config/wireless` has **zero effect** because the driver does not advertise MU-MIMO capability to `hostapd`.
3. **Upstream Driver Reality:** In the Linux kernel `mac80211` / `mt76` subsystem, lead developer Felix Fietkau (`nbd`) implemented 802.11ax (WiFi 6) sounding for newer chips like MT7915, but **never implemented the closed MCU sounding commands or calibration routines for the older 802.11ac MT7615**.
4. **Real-World Throughput Unaffected:** Despite lacking MU-MIMO sounding, OpenWrt 24.10.2 achieves **512–584 Mbps single-stream** and **893 Mbps parallel stream** throughput over 5GHz Wi-Fi (Channel 149, VHT80) using 4×4 spatial multiplexing, A-MSDU frame aggregation, and MT7621 hardware flowtable offloading.

---

## 2. Low-Level Binary Evidence

Inspecting the MT7615 hardware capabilities via `iw phy phy1 info` on physical hardware reveals:

```
VHT Capabilities (0x338001f8):
    Max MPDU length: 3895
    Supported Channel Width: 160 MHz, 80+80 MHz
    RX LDPC
    short GI (80 MHz)
    short GI (160/80+80 MHz)
    TX STBC
    RX antenna pattern consistency
    TX antenna pattern consistency
```

Analysis of the `0x338001f8` bitmask against IEEE 802.11ac specifications:
- **Bit 11 (`0x00000800` - SU Beamformer Capable):** `0` (Disabled)
- **Bit 12 (`0x00001000` - SU Beamformee Capable):** `0` (Disabled)
- **Bit 19 (`0x00080000` - MU Beamformer Capable):** `0` (Disabled)
- **Bit 20 (`0x00100000` - MU Beamformee Capable):** `0` (Disabled)

### What Happens in `hostapd`:
OpenWrt's `/lib/netifd/wireless/mac80211.sh` compares requested options against the driver's advertised bits:
```sh
mac80211_add_capabilities vht_capab $vht_cap \
    SU-BEAMFORMER:0x800::$su_beamformer \
    MU-BEAMFORMER:0x80000::$mu_beamformer
```
Since the driver reports `0` for both masks, `mac80211.sh` strips `[SU-BEAMFORMER]` and `[MU-BEAMFORMER]` from `/var/run/hostapd-phy1.conf`. The AP broadcasts beacons without the MU-MIMO Information Element, and all stations connect in 4×4 Single-User MIMO mode.

---

## 3. Why MU-MIMO Sounding Is Omitted in Upstream `mt7615e`

In 802.11ac Wave 2, Downlink Multi-User MIMO requires continuous channel sounding:
1. The AP broadcasts Null Data Packet Announcements (NDPA) and Null Data Packets (NDP).
2. Connected client stations calculate CSI (Channel State Information) matrices and reply with Compressed Beamforming Feedback frames.
3. The AP's wireless driver/microcontroller processes these matrices to construct zero-forcing precoding steering vectors, shaping RF nulls so streams intended for Client A do not interfere with Client B.

In MediaTek's closed-source driver (`mt_wifi.ko`), this is handled by proprietary MCU firmware routines calibrated with factory binary files (`mt7615-sku-bf.dat`). 

In the open-source `mt7615e` driver:
- Porting these proprietary calibration algorithms to upstream Linux was never completed for MT7615.
- If `[MU-BEAMFORMER]` were blindly declared in `hostapd` without the underlying driver sounding routines, stations attempting to send feedback would experience timeouts, frame drops, or link renegotiations.
- Therefore, upstream maintainers intentionally leave the bit unset to guarantee maximum link stability.

---

## 4. Why OpenWrt 24.10.2 Still Achieves 500–893 Mbps

MU-MIMO is primarily beneficial when multiple 1×1 or 2×2 client devices are downloading simultaneously. For single-client and high-throughput aggregate routing, performance is governed by:

1. **4×4 Spatial Multiplexing:** Physical link rates negotiate up to 866.7 Mbps (2×2 VHT80) or 1733 Mbps (4×4 VHT80).
2. **A-MSDU Frame Aggregation (`amsdu=1`):** Bundles multiple IP frames inside an 802.11 A-MPDU, cutting MAC overhead by >35%.
3. **4-VPE CPU Affinity Partitioning:** Pinning GMAC interrupts to CPU0, 2.4G interrupts to CPU1, and 5G interrupts to CPUs 2 & 3 eliminates softirq contention.
4. **Hardware Flowtable Offloading:** The MT7621 Packet Processing Engine (PPE) forwards packets directly via silicon DMA, maintaining line-rate throughput with <5% CPU usage.

---

## 5. Architectural Comparison

| Architecture | OpenWrt 24.10.2 (Upstream mt76) | CatWrt / Stock (MediaTek Proprietary) |
|---|---|---|
| **Kernel** | **Linux 6.6.93 LTS** | Linux 5.4 LTS / 3.10 EOL |
| **MU-MIMO Status** | Disabled in driver | Active (`MUTxRxEnable=1`) |
| **WPA3-Personal (SAE)** | **Fully Supported (`sae-mixed`)** | Unsupported (WPA2 only) |
| **2.4 GHz Silicon** | **Dedicated `kmod-mt7603` (PCIe1)** | Buggy / DBDC emulation issues |
| **5 GHz Real-World Speed** | **512–584 Mbps (Single)** / **893 Mbps (Parallel)** | 795–830 Mbps (Single) / 905 Mbps (Parallel) |
| **Stability & Security** | **Rock-Solid & Actively Maintained** | Stale binary blobs, no security updates |
