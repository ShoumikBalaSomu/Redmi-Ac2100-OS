#!/usr/bin/env bash
# ===========================================================================
# NexRouter MTK Proprietary Repackaging Tool
# ===========================================================================
# This tool extracts, customises, and repackages CatWrt / Lean LEDE firmware
# containing MediaTek's proprietary mt_wifi.ko and mtkhnat.ko drivers for
# the Xiaomi Redmi Router AC2100 (RM2100).
#
# Generates a lean, ultra-high performance sysupgrade image with:
#  - Proprietary mt_wifi v5.0.4.0 + mtkhnat hardware NAT
#  - Channel 149 (5.745 GHz UNII-3) preconfigured for Bangladesh
#  - 4x4 MU-MIMO and explicit beamforming enabled
#  - Preconfigured PPPoE WAN & Dual-Band WiFi credentials
#  - Turbo ACC (SFE + Hardware NAT + BBR)
#  - LuCI with Argon Theme in English
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${ROOT_DIR}/build/.work_repack"
OUT_DIR="${ROOT_DIR}/out"

BASE_IMAGE="${1:-${ROOT_DIR}/analysis/raw/CatWrt.v24.9.mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin}"

if [ ! -f "${BASE_IMAGE}" ]; then
    echo "Error: Base image not found at ${BASE_IMAGE}"
    exit 1
fi

echo "[*] Cleaning work directory..."
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/sysupgrade" "${WORK_DIR}/rootfs" "${OUT_DIR}"

echo "[*] Extracting sysupgrade tar archive..."
tar -xf "${BASE_IMAGE}" -C "${WORK_DIR}/sysupgrade"

KERNEL_FILE="${WORK_DIR}/sysupgrade/kernel"
ROOT_SQUASHFS="${WORK_DIR}/sysupgrade/root"

if [ ! -f "${KERNEL_FILE}" ] || [ ! -f "${ROOT_SQUASHFS}" ]; then
    echo "Error: kernel or root not found in sysupgrade image!"
    exit 1
fi

echo "[*] Extracting SquashFS root filesystem..."
unsquashfs -d "${WORK_DIR}/rootfs" "${ROOT_SQUASHFS}" > /dev/null

echo "[*] Stripping bloated proxy binaries (>40MB)..."
rm -f "${WORK_DIR}/rootfs/usr/bin/xray" \
      "${WORK_DIR}/rootfs/usr/bin/dnsproxy" \
      "${WORK_DIR}/rootfs/usr/bin/chinadns-ng" \
      "${WORK_DIR}/rootfs/usr/bin/sing-box" 2>/dev/null || true

echo "[*] Injecting firstboot defaults..."
cat << 'EOF' > "${WORK_DIR}/rootfs/etc/uci-defaults/99-default-settings"
#!/bin/sh
uci set luci.main.lang='en'
uci commit luci
uci set system.@system[0].zonename='Asia/Dhaka'
uci set system.@system[0].timezone='<+06>-6'
uci commit system

# Network LAN IP
uci set network.lan.ipaddr='192.168.1.1'
uci set network.lan.dns='1.1.1.1 8.8.8.8'

# Network WAN PPPoE
uci set network.wan.proto='pppoe'
uci set network.wan.username='your_pppoe_username'
uci set network.wan.password='your_pppoe_password'
uci set network.wan.peerdns='0'
uci set network.wan.dns='1.1.1.1 8.8.8.8'
uci commit network

# Turbo ACC Offload
uci set turboacc.config.sfe_flow='1'
uci set turboacc.config.bbr_cca='1'
uci set turboacc.config.fullcone_nat='1'
uci commit turboacc 2>/dev/null || true

# Wireless MTK Proprietary Profiles
if [ -f /etc/wireless/mt7615/mt7615.2.dat ]; then
    sed -i 's/^Channel=.*/Channel=149/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^CountryCode=.*/CountryCode=CN/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^SSID1=.*/SSID1=NexRouter_5G/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^WPAPSK1=.*/WPAPSK1=12345678/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^AuthMode=.*/AuthMode=WPA2PSK/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^EncrypType=.*/EncrypType=AES/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^MUTxRxEnable=.*/MUTxRxEnable=1/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^MUTxOption=.*/MUTxOption=1/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^ETxBfEnCond=.*/ETxBfEnCond=1/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^ITxBfEn=.*/ITxBfEn=1/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^HT_AMSDU=.*/HT_AMSDU=1/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^HT_BAWinSize=.*/HT_BAWinSize=64/' /etc/wireless/mt7615/mt7615.2.dat
    sed -i 's/^VOW_Airtime_Fairness_En=.*/VOW_Airtime_Fairness_En=1/' /etc/wireless/mt7615/mt7615.2.dat
fi

if [ -f /etc/wireless/mt7603/mt7603.dat ]; then
    sed -i 's/^SSID1=.*/SSID1=NexRouter_2.4G/' /etc/wireless/mt7603/mt7603.dat
    sed -i 's/^WPAPSK1=.*/WPAPSK1=12345678/' /etc/wireless/mt7603/mt7603.dat
    sed -i 's/^Channel=.*/Channel=6/' /etc/wireless/mt7603/mt7603.dat
fi

# Reset root password to empty
passwd -d root
exit 0
EOF
chmod +x "${WORK_DIR}/rootfs/etc/uci-defaults/99-default-settings"

echo "[*] Repackaging SquashFS filesystem..."
rm -f "${ROOT_SQUASHFS}"
mksquashfs "${WORK_DIR}/rootfs" "${ROOT_SQUASHFS}" -comp xz -b 256k -no-xattrs -all-root > /dev/null

OUTPUT_IMAGE="${OUT_DIR}/catwrt-mtk-nexrouter-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin"
echo "[*] Creating final sysupgrade tar image..."
(cd "${WORK_DIR}/sysupgrade" && tar -cf "${OUTPUT_IMAGE}" sysupgrade-xiaomi_redmi-router-ac2100/CONTROL sysupgrade-xiaomi_redmi-router-ac2100/kernel sysupgrade-xiaomi_redmi-router-ac2100/root 2>/dev/null || tar -cf "${OUTPUT_IMAGE}" *)

echo "[*] Build Complete!"
echo "    Output image: ${OUTPUT_IMAGE}"
echo "    Size: $(du -h "${OUTPUT_IMAGE}" | cut -f1)"
sha256sum "${OUTPUT_IMAGE}"
EOF
