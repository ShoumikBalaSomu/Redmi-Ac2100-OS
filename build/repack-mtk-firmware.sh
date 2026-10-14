#!/usr/bin/env bash
# ===========================================================================
# NexRouter MTK Proprietary Repackaging Tool
# ===========================================================================
# This tool extracts, customises, and repackages OpenWrt / CatWrt firmware
# containing MediaTek's proprietary mt_wifi.ko (MT7615) and mt7603e.ko (MT7603)
# drivers for the Xiaomi Redmi Router AC2100 (RM2100).
#
# Generates a lean, ultra-high performance sysupgrade image with:
#  - Dedicated MT7603E 2.4GHz hardware driver (ra0, 2x2 HT40, Ch 6)
#  - Proprietary MT7615 5GHz hardware driver (rai0, 4x4 VHT80, Ch 149 UNII-3)
#  - Silicon-level NDP (Null Data Packet) Channel Sounding enabled (ETxBfEnCond=1)
#  - True 4x4 Multi-User MIMO enabled (MUTxRxEnable=1, MUTxOption=1)
#  - Implicit Beamforming enabled (ITxBfEn=1)
#  - Preconfigured PPPoE WAN & Dual-Band WiFi credentials
#  - Turbo ACC (SFE + Hardware NAT + BBR)
#  - LuCI with Argon Theme in English
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${ROOT_DIR}/build/.work_repack"
OUT_DIR="${ROOT_DIR}/out"

BASE_IMAGE="${1:-${ROOT_DIR}/analysis/raw/catwrt_v24.9.bin}"

if [ ! -f "${BASE_IMAGE}" ]; then
    echo "Error: Base image not found at ${BASE_IMAGE}"
    exit 1
fi

echo "[*] Cleaning work directory..."
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/sysupgrade" "${WORK_DIR}/rootfs" "${OUT_DIR}"

echo "[*] Extracting sysupgrade tar archive..."
tar -xf "${BASE_IMAGE}" -C "${WORK_DIR}/sysupgrade"

KERNEL_FILE=$(find "${WORK_DIR}/sysupgrade" -name "kernel" | head -n 1)
ROOT_SQUASHFS=$(find "${WORK_DIR}/sysupgrade" -name "root" | head -n 1)

if [ -z "${KERNEL_FILE}" ] || [ -z "${ROOT_SQUASHFS}" ] || [ ! -f "${KERNEL_FILE}" ] || [ ! -f "${ROOT_SQUASHFS}" ]; then
    echo "Error: kernel or root not found in sysupgrade image!"
    exit 1
fi

ulimit -n 65535 2>/dev/null || true

UNSQUASHFS="${ROOT_DIR}/build/.work/imagebuilder/staging_dir/host/bin/unsquashfs4"
MKSQUASHFS="${ROOT_DIR}/build/.work/imagebuilder/staging_dir/host/bin/mksquashfs4"

echo "[*] Extracting SquashFS root filesystem..."
"${UNSQUASHFS}" -d "${WORK_DIR}/rootfs" -no-xattrs -ignore-errors -no-exit-code "${ROOT_SQUASHFS}" > /dev/null || true

echo "[*] Stripping bloated proxy binaries (>40MB)..."
rm -f "${WORK_DIR}/rootfs/usr/bin/xray" \
      "${WORK_DIR}/rootfs/usr/bin/dnsproxy" \
      "${WORK_DIR}/rootfs/usr/bin/chinadns-ng" \
      "${WORK_DIR}/rootfs/usr/bin/sing-box" 2>/dev/null || true

echo "[*] Configuring Dedicated MT7603E 2.4GHz Hardware Driver..."
mkdir -p "${WORK_DIR}/rootfs/etc/Wireless/RT2860"
mkdir -p "${WORK_DIR}/rootfs/etc/Wireless/mt7603e"
mkdir -p "${WORK_DIR}/rootfs/etc/wireless/mt7603"
mkdir -p "${WORK_DIR}/rootfs/etc/wireless/mt7615"
mkdir -p "${WORK_DIR}/rootfs/etc/modules.d"

# Ensure mt7603e driver loads at boot
echo "mt7603e" > "${WORK_DIR}/rootfs/etc/modules.d/91-mt7603e"
echo "mt_wifi" > "${WORK_DIR}/rootfs/etc/modules.d/mt7615d"

# Create Dedicated MT7603 Profile (2.4GHz, HT40, 2x2 MIMO, Ch 6)
cat << 'EOF' > "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat"
#The word of "Default" must not be removed
Default
CountryRegion=5
CountryRegionABand=7
CountryCode=CN
BssidNum=1
SSID1=NexRouter_2.4G
WirelessMode=9
TxRate=0
Channel=6
BasicRate=15
BeaconPeriod=100
DtimPeriod=1
TxPower=100
DisableOLBC=0
BGProtection=0
MaxStaNum=0
TxPreamble=0
RTSThreshold=2347
FragThreshold=2346
TxBurst=1
PktAggregate=1
TurboRate=0
WmmCapable=1
APSDCapable=0
DLSCapable=0
APAifsn=3;7;1;1
APCwmin=4;4;3;2
APCwmax=6;10;4;3
APTxop=0;0;94;47
APACM=0;0;0;0
BSSAifsn=3;7;2;2
BSSCwmin=4;4;3;2
BSSCwmax=10;10;4;3
BSSTxop=0;0;94;47
BSSACM=0;0;0;0
AckPolicy=0;0;0;0
NoForwarding=0
NoForwardingBTNBSSID=0
HideSSID=0
ShortSlot=1
AutoChannelSelect=0
IEEE8021X=0
IEEE80211H=0
CSPeriod=10
WirelessEvent=1
IdsEnable=0
PreAuth=0
AuthMode=WPA2PSK
EncrypType=AES
WPAPSK1=12345678
DefaultKeyID=1
HT_HTC=1
HT_RDG=1
HT_EXTCHA=1
HT_LinkAdapt=0
HT_OpMode=0
HT_MpduDensity=5
HT_BW=1
HT_AutoBA=1
HT_AMSDU=1
HT_BAWinSize=64
HT_GI=1
HT_LDPC=1
HT_MCS=33
HT_TxStream=2
HT_RxStream=2
RadioOn=1
EOF

# Copy to all candidate search paths for MT7603
cp -f "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat" "${WORK_DIR}/rootfs/etc/Wireless/mt7603e/mt7603e.dat"
cp -f "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat" "${WORK_DIR}/rootfs/etc/wireless/mt7603/mt7603.dat"
cp -f "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat" "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.1.dat"

echo "[*] Configuring MT7615 5GHz Hardware Driver (4x4 MU-MIMO + NDP Sounding)..."
if [ -f "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat" ]; then
    sed -i 's/^Channel=.*/Channel=149/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^CountryCode=.*/CountryCode=CN/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^SSID1=.*/SSID1=NexRouter_5G/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^WPAPSK1=.*/WPAPSK1=12345678/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^AuthMode=.*/AuthMode=WPA2PSK/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^EncrypType=.*/EncrypType=AES/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^WirelessMode=.*/WirelessMode=14/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^VHT_BW=.*/VHT_BW=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^HT_TxStream=.*/HT_TxStream=4/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^HT_RxStream=.*/HT_RxStream=4/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    # True Silicon NDP Sounding & MU-MIMO
    sed -i 's/^MUTxRxEnable=.*/MUTxRxEnable=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^MUTxOption=.*/MUTxOption=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^ETxBfEnCond=.*/ETxBfEnCond=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^ITxBfEn=.*/ITxBfEn=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^HT_AMSDU=.*/HT_AMSDU=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^HT_BAWinSize=.*/HT_BAWinSize=64/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
    sed -i 's/^VOW_Airtime_Fairness_En=.*/VOW_Airtime_Fairness_En=1/' "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
fi

# Configure l1profile.dat mapping
cat << 'EOF' > "${WORK_DIR}/rootfs/etc/wireless/l1profile.dat"
Default
INDEX0=MT7603
INDEX0_profile_path=/etc/Wireless/RT2860/RT2860AP.dat
INDEX0_EEPROM_offset=0x0
INDEX0_EEPROM_size=0x400
INDEX0_EEPROM_name=e2p
INDEX0_main_ifname=ra0
INDEX0_ext_ifname=ra
INDEX0_wds_ifname=wds
INDEX0_apcli_ifname=apcli
INDEX1=MT7615
INDEX1_profile_path=/etc/wireless/mt7615/mt7615.2.dat
INDEX1_EEPROM_offset=0x8000
INDEX1_EEPROM_size=0x4000
INDEX1_EEPROM_name=e2p
INDEX1_main_ifname=rai0
INDEX1_ext_ifname=rai
INDEX1_wds_ifname=wdsi
INDEX1_apcli_ifname=apclii
INDEX1_single_sku_path=/etc_ro/Wireless/RT2860AP/SingleSKU.dat
INDEX1_bf_sku_path=/etc_ro/Wireless/RT2860AP/SingleSKU_BF.dat
EOF

echo "[*] Injecting rc.local to guarantee dual-band bringup and LAN bridge..."
cat << 'EOF' > "${WORK_DIR}/rootfs/etc/rc.local"
# Put your custom commands here that should be executed once
# the system init finished. By default this file does nothing.

# Bring up MT7603 2.4GHz
ifconfig ra0 up 2>/dev/null || true
brctl addif br-lan ra0 2>/dev/null || true

# Bring up MT7615 5GHz
ifconfig rai0 up 2>/dev/null || true
brctl addif br-lan rai0 2>/dev/null || true

exit 0
EOF

echo "[*] Injecting firstboot defaults..."
cat << 'EOF' > "${WORK_DIR}/rootfs/etc/uci-defaults/99-default-settings"
#!/bin/sh
uci set luci.main.lang='en'
uci set luci.main.mediaurlbase='/luci-static/argon'
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

# Reset root password to empty
passwd -d root
exit 0
EOF
chmod +x "${WORK_DIR}/rootfs/etc/uci-defaults/99-default-settings"

echo "[*] Repackaging SquashFS filesystem..."
rm -f "${ROOT_SQUASHFS}"
"${MKSQUASHFS}" "${WORK_DIR}/rootfs" "${ROOT_SQUASHFS}" -comp xz -b 256k -no-xattrs -all-root > /dev/null

OUTPUT_IMAGE="${OUT_DIR}/openwrt-mtk-ndp-mumimo-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin"
echo "[*] Creating final sysupgrade tar image..."
(cd "${WORK_DIR}/sysupgrade" && tar -cf "${OUTPUT_IMAGE}" sysupgrade-xiaomi_redmi-router-ac2100)

echo "[*] Build Complete!"
echo "    Output image: ${OUTPUT_IMAGE}"
echo "    Size: $(du -h "${OUTPUT_IMAGE}" | cut -f1)"
sha256sum "${OUTPUT_IMAGE}"
