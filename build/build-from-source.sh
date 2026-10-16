#!/usr/bin/env bash
# ===========================================================================
# NexRouter v5.0.0 Apex Full Source Builder (OpenWrt Snapshot / 24.10 + All 14 Custom Patches)
# ===========================================================================
# Compiles OpenWrt from source with NexRouter's custom Kernel, DTS, TRGMII 1.2G,
# MIPS 1004Kc DSP, EIP-93 Crypto, MT7530 DSA, and mt76 wireless/MCU patches:
#   Kernel Patches (`patches/kernel-6.6/`):
#     - 100-mips-mt7621-dts-redmi-ac2100-optimizations.patch (1.2G TRGMII + 0x4da8 + EIP-93 + HSDMA)
#     - 101-net-mtk_eth_soc-ppe-wed-bridge-fastpath-and-dma-512.patch (512 DMA rings + 16K PPE flows)
#     - 102-mips-mt7621-cpu-bus-prefetch-and-unaligned-fastpath.patch (DDR3 burst prefetch + -O3 net/core)
#     - 103-net-dsa-mt7530-disable-eee-lpi-laptop-linkflap-fix.patch (Zero-drop laptop LAN EEE disable)
#     - 104-net-mtk_eth_soc-napi-weight-256-anti-vpe-starvation.patch (NAPI 256 + NF_FLOW_XMIT_NEIGH)
#     - 105-pci-mt7621-pcie-rc-mps256-fts-and-cpc-coherency.patch (PCIe N_FTS=0x50 + DDR3 write-coalesce)
#     - 106-mips-mt7621-1004kc-dsp-l2-cca-and-network-fastpath.patch (-O3 -mtune=1004kc -mdsp hotpaths)
#   Wireless `mt76` Patches (`patches/mt76/`):
#     - 200-mt7615-mt7603-threaded-napi-and-dma-tx-rx-boost.patch (2048 TX / 1024 RX rings + Threaded NAPI)
#     - 201-mt7615-full-4x4-txbf-mumimo-and-11454-mpdu.patch (Port MT7915 STA_REC_BF 0x02 PFMU TLV)
#     - 202-mt7603-256qam-vht24g-and-long-range-cca-sensitivity.patch (Padavan ED-CCA fix + 0x0f2 6dBm fix + QPF4200)
#     - 203-mt76-eeprom-max-txpower-and-pa-lna-calibration-unlock.patch (26 dBm 5G / 23 dBm 2.4G calibration unlock)
#     - 204-mt7615-vht80p80-160mhz-mcu-chan2-support.patch (VHT80P80 80+80 MHz chan2 MCU support)
#     - 205-mt7615-cr4-wa-red-token-and-mt_wifi-agg-registers.patch (MT_AGG_ACR 0x21210 + #1009 TXQ wake kick)
#     - 206-mt7615-mt7915-wifi6-8023-hw-encap-and-hw-wpa3-wtbl.patch (Wi-Fi 6 802.3 HW encap + HW WPA3 WTBL)
#     - 207-mt7615-mt7603-wpdma-burst-delay-int-and-vht160-rc-fix.patch (WPDMA 0x4208 + 0x4210 IRQ coalesce + #465 fix)
#     - 208-mt7615-pse-ple-sram-quota-and-cr4-cut-through.patch (Cortex-R4 PDMA cut-through + -O3 -mtune=1004kc)
#
# Usage:
#   ./build/build-from-source.sh [--branch main|v24.10.2] [--jobs N] [--config-only]
# ===========================================================================
set -euo pipefail

BRANCH="main"
JOBS="$(nproc 2>/dev/null || echo 4)"
CONFIG_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)      BRANCH="$2"; shift 2 ;;
    --jobs)        JOBS="$2"; shift 2 ;;
    --config-only) CONFIG_ONLY=1; shift ;;
    -h|--help)     sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC_DIR="$ROOT/build/.openwrt-src"
OUT_DIR="$ROOT/out"

mkdir -p "$OUT_DIR"

if [ ! -d "$SRC_DIR/.git" ]; then
  echo "==> Cloning OpenWrt ($BRANCH) into $SRC_DIR"
  git clone --depth 1 --branch "$BRANCH" https://github.com/openwrt/openwrt.git "$SRC_DIR"
fi

cd "$SRC_DIR"
echo "==> Updating and installing OpenWrt feeds"
./scripts/feeds update -a
./scripts/feeds install -a

echo "==> Injecting NexRouter Kernel, TRGMII 1.2G, EIP-93, 1004Kc DSP & MT7530 LAN patches (100-106)"
for kdir in "$SRC_DIR"/target/linux/ramips/patches-*; do
  [ -d "$kdir" ] || continue
  cp -f "$ROOT/patches/kernel-6.6/"*.patch "$kdir/"
done

echo "==> Injecting NexRouter mt76 driver patches (200-208: STA_REC_BF, HW WPA3, 802.3 Encap, WPDMA Coalesce)"
mkdir -p "$SRC_DIR/package/kernel/mt76/patches"
cp -f "$ROOT/patches/mt76/"*.patch "$SRC_DIR/package/kernel/mt76/patches/"

echo "==> Building Web UI SPA into files/www/nex"
( cd "$ROOT/webui" && node build.mjs )
rm -rf "$SRC_DIR/files"
mkdir -p "$SRC_DIR/files/www/nex"
cp -a "$ROOT/build/files/." "$SRC_DIR/files/"
cp -a "$ROOT/webui/dist/." "$SRC_DIR/files/www/nex/"

find "$SRC_DIR/files" -type f \( -path '*/init.d/*' -o -path '*/uci-defaults/*' \
  -o -path '*/hotplug.d/*' -o -path '*/nexrouter/*' -o -path '*/sbin/*' -o -path '*/rpcd/*' \) -exec chmod 0755 {} +

echo "==> Generating .config for Xiaomi Redmi Router AC2100 (ramips/mt7621)"
cat > "$SRC_DIR/.config" <<'EOF'
CONFIG_TARGET_ramips=y
CONFIG_TARGET_ramips_mt7621=y
CONFIG_TARGET_ramips_mt7621_DEVICE_xiaomi_redmi-router-ac2100=y
CONFIG_SCHED_SMT=y
CONFIG_MIPS_MT_SMP=y
CONFIG_PACKAGE_zram-swap=y
CONFIG_PACKAGE_kmod-zram=y
CONFIG_PACKAGE_kmod-lib-lz4=y
CONFIG_PACKAGE_kmod-mt7603=y
CONFIG_PACKAGE_kmod-mt7615e=y
CONFIG_PACKAGE_kmod-mt7615-firmware=y
CONFIG_PACKAGE_wpad-mbedtls=y
CONFIG_PACKAGE_kmod-nft-offload=y
CONFIG_PACKAGE_bridger=y
CONFIG_PACKAGE_kmod-crypto-hw-eip93=y
CONFIG_PACKAGE_kmod-crypto-authenc=y
CONFIG_PACKAGE_kmod-crypto-cmac=y
CONFIG_PACKAGE_kmod-crypto-ccm=y
CONFIG_PACKAGE_kmod-crypto-gcm=y
CONFIG_PACKAGE_kmod-crypto-sha256=y
CONFIG_PACKAGE_kmod-crypto-hmac=y
CONFIG_PACKAGE_kmod-crypto-ecdh=y
CONFIG_PACKAGE_kmod-tcp-bbr=y
CONFIG_PACKAGE_kmod-sched-cake=y
CONFIG_PACKAGE_kmod-wireguard=y
CONFIG_PACKAGE_wireguard-tools=y
CONFIG_PACKAGE_luci=y
CONFIG_PACKAGE_luci-app-firewall=y
CONFIG_PACKAGE_luci-app-filemanager=y
CONFIG_PACKAGE_cgi-io=y
CONFIG_PACKAGE_ucode-mod-fs=y
CONFIG_PACKAGE_https-dns-proxy=y
CONFIG_PACKAGE_luci-app-https-dns-proxy=y
CONFIG_PACKAGE_uhttpd=y
CONFIG_PACKAGE_uhttpd-mod-ubus=y
CONFIG_PACKAGE_rpcd=y
CONFIG_PACKAGE_rpcd-mod-file=y
CONFIG_PACKAGE_rpcd-mod-iwinfo=y
CONFIG_PACKAGE_rpcd-mod-luci=y
CONFIG_PACKAGE_jq=y
CONFIG_PACKAGE_nlbwmon=y
CONFIG_PACKAGE_softflowd=y
CONFIG_PACKAGE_ethtool=y
CONFIG_PACKAGE_iperf3=y
CONFIG_PACKAGE_htop=y
EOF

make defconfig

if [ "$CONFIG_ONLY" = "1" ]; then
  echo "==> --config-only requested. Source tree prepared at $SRC_DIR"
  exit 0
fi

echo "==> Downloading sources and compiling firmware (-j$JOBS)"
make download -j"$JOBS"
make -j"$JOBS"

cp -f "$SRC_DIR/bin/targets/ramips/mt7621/"*xiaomi_redmi-router-ac2100* "$OUT_DIR/"
echo "==> Source build complete! Output in $OUT_DIR"
