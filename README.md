# NexRouter v3.1 Apex & Wi-Fi 6 Backport Edition (Redmi-AC2100-OS)

Custom Kernel 6.6 LTS, `mt76` Wireless Driver, Wi-Fi 6 MAC Backport Stack, and On-Router AI-RF Contextual Bandit OS for the **Xiaomi Redmi Router AC2100** (RM2100, MediaTek MT7621AT + MT7603EN 2.4 GHz + MT7615N 5 GHz).

---

## 1. Why MediaTek Claims "MT7621 Supports Wi-Fi 6" — And What Your Router Can Run

The **MediaTek MT7621A** is a **dual-core MIPS 1004Kc Network Processor SoC** (CPU + 5-port Gigabit Switch + Hardware Packet Processing Engine + **3× PCIe root-complex lanes**)—it does not contain internal Wi-Fi transceivers.
- When a board pairs the MT7621A over PCIe with a **MediaTek MT7915E / MT7905D** radio chip, it operates as a native **Wi-Fi 6 (802.11ax)** router.
- On the **Xiaomi Redmi Router AC2100**, Xiaomi soldered an **MT7615N (802.11ac Wave 2, 4×4 MIMO)** to `PCIe0` and an **MT7603EN (802.11n, 2×2 MIMO)** to `PCIe1`.

While pure 802.11ax physical-layer modulation (1024-QAM MCS 10/11 and OFDMA subcarrier splitting) requires an `MT7915` RF transceiver, **five of the most impactful Wi-Fi 6 (802.11ax) MAC, Spatial Reuse, Power-Save, Security, and Scheduling features CAN be backported in software/driver code onto your MT7615N + MT7603EN radios**:

| Wi-Fi 6 (802.11ax) Feature | Can It Run on Redmi AC2100? | How NexRouter v3.1 Implements It on `MT7621A + MT7615N + MT7603EN` |
|---|---|---|
| **1. OBSS-PD Spatial Reuse (BSS Coloring Equivalent)** | **YES (Backported)** | Implements **Dynamic Smart Carrier Sense (SCS) / Adaptive CCA-ED** in `mt76` (`obss_pd_thr`) + `farlink-ai-rf-daemon.sh`. Raises CCA-ED to `-68 dBm` when clients are close so the router transmits concurrently over distant neighbor Wi-Fi chatter instead of deferring; drops CCA-ED to `-98 dBm` when clients move far away. |
| **2. Multi-Client Airtime Fairness & Low-Latency Scheduling (Software OFDMA Equivalent)** | **YES (Backported)** | Enables `NL80211_EXT_FEATURE_AIRTIME_FAIRNESS` + `NL80211_EXT_FEATURE_AQL` (`airtime_mode='2'`) in `mt7615` and `mt7603` plus per-station Deficit Round-Robin (DRR) airtime weights (`256..640`), scheduling stations by *microseconds of airtime* so slow/distant devices never lag fast devices. |
| **3. Target Wake Time (TWT) Power-Saving Equivalent** | **YES (Backported)** | Enables **802.11v WNM Sleep Mode (`wnm_sleep_mode='1'`, `wnm_sleep_mode_no_keys='1'`)**, **Proxy ARP (`proxy_arp='1'`)**, **WMM U-APSD (`uapsd='1'`)**, and `dtim_period='2'`, letting smartphones and IoT devices sleep without waking up for broadcast ARP traffic. |
| **4. MU-EDCA Low-Latency Gaming/Voice Queue Priority** | **YES (Backported)** | Configures custom WMM contention windows (`tx_queue_data0_aifs='1'`, `cwmin='3'`, `cwmax='7'`, `burst='1.5'`, `data2_burst='4.0'`) so voice and gaming packets preempt bulk downloads immediately. |
| **5. WPA3-SAE + Operating Channel Validation (`OCV`) + Sub-15ms `802.11r` Fast Roaming** | **YES (Backported)** | Configures `encryption='sae-mixed'`, `ieee80211w='1'`, `ocv='1'`, and **802.11r Fast BSS Transition (`ieee80211r='1'`, `mobility_domain='4f57'`, `ft_over_ds='0'`, `ft_psk_generate_local='1'`)** for <15 ms zero-drop handoffs between 2.4 GHz and 5 GHz. |
| **6. 1024-QAM (MCS 10/11) & Hardware OFDMA Subcarriers** | **Hardware Limited** | Requires an `MT7915` 802.11ax RF baseband chip; on `MT7615N` (5 GHz) we unlock **4×4 VHT80 256-QAM (`1,733.3 Mbps` PHY + 11,454B MPDU)**, and on `MT7603EN` (2.4 GHz) we unlock **256-QAM TurboQAM (`400 Mbps` PHY, up from 300 Mbps)**. |

---

## 2. Custom Kernel 6.6 & `mt76` Driver C Patch Stack (`patches/`)

1. **`100-mips-mt7621-dts-redmi-ac2100-optimizations.patch`**: Disables PCIe ASPM L0s/L1 power-saving on `pcie0` and `pcie1`, enables the hardware watchdog (`wdt`), and maps the full `0x4da8` (19,880-byte) factory EEPROM cell.
2. **`101-net-mtk_eth_soc-ppe-wed-bridge-fastpath-and-dma-512.patch`**: Doubles MT7621 Frame Engine DMA ring descriptors (`MTK_DMA_SIZE` 256 → 512), doubles NAPI poll weight (`64 → 128`), and expands the hardware Packet Processing Engine (PPE) table to **16,384 hardware flows** (`MTK_PPE_ENTRIES_SHIFT` 3 → 4).
3. **`102-mips-mt7621-cpu-bus-prefetch-and-unaligned-fastpath.patch`**: Enables DDR3 burst prefetching on the MT7621 memory controller (`memc + 0x04`) and compiles `net/core/` and `nf_flow_table_*` with `-O3`.
4. **`200-mt7615-mt7603-threaded-napi-and-dma-tx-rx-boost.patch`**: Enables **Threaded NAPI (`dev->mt76.napi_dev.threaded = 1`)** at PCI probe on `mt7615e` and `mt7603e`, and doubles `MT7615_TX_RING_SIZE` (`1024 → 2048`) and `MT7615_RX_RING_SIZE` (`512 → 1024`).
5. **`201-mt7615-full-4x4-txbf-mumimo-and-11454-mpdu.patch`**: Unlocks **11,454-byte VHT MPDUs (`IEEE80211_VHT_CAP_MAX_MPDU_LENGTH_11454`)**, 16-fragment hardware TX A-MSDU coalescing, 4-antenna `SU-BEAMFORMER`, `MU-BEAMFORMER`, 4 Sounding Dimensions, `TXSTBC`, `RXSTBC_4`, `RXLDPC`, and Wi-Fi 6 Virtual-Time Airtime Fairness (`NL80211_EXT_FEATURE_AIRTIME_FAIRNESS` + `AQL`).
6. **`202-mt7603-256qam-vht24g-and-long-range-cca-sensitivity.patch`**: Unlocks **256-QAM TurboQAM (`400 Mbps` PHY)** on 2.4 GHz `mt7603e`, enables `NL80211_EXT_FEATURE_AIRTIME_FAIRNESS`, and lowers the AGC/CCA energy-detection floor (`0x10f18`) to `-98 dBm`.
7. **`203-mt76-eeprom-max-txpower-and-pa-lna-calibration-unlock.patch`**: Unlocks the full factory-calibrated external PA/LNA power ceiling (**26 dBm / 400 mW** on 5 GHz UNII-3, **23 dBm / 200 mW** on 2.4 GHz).

---

## 3. Build & Flash Quick Start

```bash
# Track A: Full OpenWrt 24.10 Source Build with all Kernel 6.6, mt76 & Wi-Fi 6 Backport Patches
./build/build-from-source.sh --branch v24.10.2

# Track B: Fast OpenWrt 24.10.2 ImageBuilder (with runtime Threaded NAPI, Wi-Fi 6 MAC & AI-RF Bandit)
./build/build.sh --release 24.10.2

# Track C: MediaTek Proprietary Driver + WHNAT Repack (0x4DA8 EEPROM + Hardware MU-MIMO)
./build/repack-mtk-firmware.sh analysis/raw/catwrt_v24.9.bin
```
