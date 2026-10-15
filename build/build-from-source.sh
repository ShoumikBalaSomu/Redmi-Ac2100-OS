#!/usr/bin/env bash
# ===========================================================================
# NexRouter v2.0 Full Source Builder (Kernel 6.6 LTS + Custom mt76 Patches)
# ===========================================================================
# Compiles OpenWrt from source with NexRouter's custom kernel, DTS, and mt76
# wireless patches:
#   - patches/kernel-6.6/100-mips-mt7621-dts-redmi-ac2100-optimizations.patch
#   - patches/kernel-6.6/101-net-mtk_eth_soc-ppe-dma-ring-and-flow-tuning.patch
#   - patches/mt76/200-mt7615-enable-threaded-napi-and-aql-tuning.patch
#   - patches/mt76/201-mt7615-vht-beamformer-capability-and-sounding.patch
#
# Usage:
#   ./build/build-from-source.sh [--branch main|v24.10.2] [--jobs N] [--config-only]
# ===========================================================================
set -euo pipefail

BRANCH="v24.10.2"
JOBS="$(nproc 2>/dev/null || echo 4)"
CONFIG_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)      BRANCH="$2"; shift 2 ;;
    --jobs)        JOBS="$2"; shift 2 ;;
    --config-only) CONFIG_ONLY=1; shift ;;
    -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
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

echo "==> Injecting NexRouter Kernel 6.6 & DTS patches"
mkdir -p "$SRC_DIR/target/linux/ramips/patches-6.6"
cp -f "$ROOT/patches/kernel-6.6/"*.patch "$SRC_DIR/target/linux/ramips/patches-6.6/"

echo "==> Injecting NexRouter mt76 driver patches (Threaded NAPI + VHT Beamformer)"
mkdir -p "$SRC_DIR/package/kernel/mt76/patches"
cp -f "$ROOT/patches/mt76/"*.patch "$SRC_DIR/package/kernel/mt76/patches/"

echo "==> Building Web UI SPA into files/www/nex"
( cd "$ROOT/webui" && node build.mjs )
rm -rf "$SRC_DIR/files"
mkdir -p "$SRC_DIR/files/www/nex"
cp -a "$ROOT/build/files/." "$SRC_DIR/files/"
cp -a "$ROOT/webui/dist/." "$SRC_DIR/files/www/nex/"

find "$SRC_DIR/files" -type f \( -path '*/init.d/*' -o -path '*/uci-defaults/*' \
  -o -path '*/hotplug.d/*' -o -path '*/nexrouter/*' \) -exec chmod 0755 {} +

echo "==> Generating .config for Xiaomi Redmi Router AC2100 (ramips/mt7621)"
cat > "$SRC_DIR/.config" <<'EOF'
CONFIG_TARGET_ramips=y
CONFIG_TARGET_ramips_mt7621=y
CONFIG_TARGET_ramips_mt7621_DEVICE_xiaomi_redmi-router-ac2100=y
CONFIG_SCHED_SMT=y
CONFIG_MIPS_MT_SMP=y
CONFIG_PACKAGE_kmod-mt7603=y
CONFIG_PACKAGE_kmod-mt7615e=y
CONFIG_PACKAGE_kmod-mt7615-firmware=y
CONFIG_PACKAGE_wpad-mbedtls=y
CONFIG_PACKAGE_kmod-nft-offload=y
CONFIG_PACKAGE_kmod-tcp-bbr zram-swap kmod-zram=y
CONFIG_PACKAGE_kmod-sched-cake=y
CONFIG_PACKAGE_kmod-wireguard=y
CONFIG_PACKAGE_wireguard-tools=y
CONFIG_PACKAGE_luci=y
CONFIG_PACKAGE_luci-app-firewall=y
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
