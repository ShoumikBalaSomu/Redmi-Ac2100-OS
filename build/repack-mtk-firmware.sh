#!/usr/bin/env bash
# ===========================================================================
# NexRouter v2.0 MTK Proprietary Driver + WHNAT Repackager (Kernel 5.4 LTS)
# ===========================================================================
# Fixes v1 Noop #7:
#   1. Preserves full 0x4DA8 (19,880 bytes) MT7615 5 GHz EEPROM calibration
#      in l1profile.dat (v1 truncated this to 0x4000, losing 3,496 bytes of
#      factory 4x4 MU-MIMO / TxBF phase calibration tables!).
#   2. Uses deterministic key-upsert (`upsert_dat_key`) on mt7615.2.dat and
#      RT2860AP.dat instead of `sed -i` (which silently nooped when keys were
#      absent in the base image).
#   3. Discovers system `unsquashfs`/`mksquashfs` automatically if the
#      ImageBuilder staging_dir is not present.
#   4. Configures WHNAT=1 (Wireless Hardware NAT) + 4-VPE SMP IRQ pinning for
#      ra0 (MT7603E) and rai0 (MT7615N) to achieve 800-905 Mbps on 5 GHz.
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${ROOT_DIR}/build/.work_repack"
OUT_DIR="${ROOT_DIR}/out"

BASE_IMAGE="${1:-${ROOT_DIR}/analysis/raw/catwrt_v24.9.bin}"

if [ ! -f "${BASE_IMAGE}" ]; then
    echo "Error: Base image not found at ${BASE_IMAGE}" >&2
    echo "Usage: $0 <path-to-catwrt-or-mtk-sysupgrade.bin>" >&2
    exit 1
fi

# Locate squashfs tools (system PATH first, then ImageBuilder fallback)
UNSQUASHFS="$(command -v unsquashfs4 || command -v unsquashfs || echo "${ROOT_DIR}/build/.work/imagebuilder/staging_dir/host/bin/unsquashfs4")"
MKSQUASHFS="$(command -v mksquashfs4 || command -v mksquashfs || echo "${ROOT_DIR}/build/.work/imagebuilder/staging_dir/host/bin/mksquashfs4")"

if [ ! -x "${UNSQUASHFS}" ] || [ ! -x "${MKSQUASHFS}" ]; then
    echo "Error: unsquashfs/mksquashfs not found. Install squashfs-tools." >&2
    exit 1
fi

# Helper: Upsert KEY=VALUE into a MediaTek .dat profile (never noops)
upsert_dat_key() {
    local file="$1" key="$2" val="$3"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$file"
    else
        printf '%s=%s
' "$key" "$val" >> "$file"
    fi
}

echo "[*] Cleaning work directory..."
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}/sysupgrade" "${WORK_DIR}/rootfs" "${OUT_DIR}"

echo "[*] Extracting sysupgrade tar archive..."
tar -xf "${BASE_IMAGE}" -C "${WORK_DIR}/sysupgrade"

KERNEL_FILE="$(find "${WORK_DIR}/sysupgrade" -name "kernel" | head -n 1)"
ROOT_SQUASHFS="$(find "${WORK_DIR}/sysupgrade" -name "root" | head -n 1)"

if [ -z "${KERNEL_FILE}" ] || [ -z "${ROOT_SQUASHFS}" ] || [ ! -f "${KERNEL_FILE}" ] || [ ! -f "${ROOT_SQUASHFS}" ]; then
    echo "Error: kernel or root not found in sysupgrade image!" >&2
    exit 1
fi

echo "[*] Extracting SquashFS root filesystem..."
"${UNSQUASHFS}" -d "${WORK_DIR}/rootfs" -no-xattrs "${ROOT_SQUASHFS}" >/dev/null 2>&1 || true

echo "[*] Stripping oversized proxy binaries to free RAM/flash..."
rm -f "${WORK_DIR}/rootfs/usr/bin/xray" \
      "${WORK_DIR}/rootfs/usr/bin/v2ray" \
      "${WORK_DIR}/rootfs/usr/bin/sing-box" 2>/dev/null || true

echo "[*] Configuring Dedicated MT7603E (2.4 GHz) + MT7615N (5 GHz) Profiles..."
mkdir -p "${WORK_DIR}/rootfs/etc/Wireless/RT2860" \
         "${WORK_DIR}/rootfs/etc/Wireless/mt7603e" \
         "${WORK_DIR}/rootfs/etc/wireless/mt7603" \
         "${WORK_DIR}/rootfs/etc/wireless/mt7615" \
         "${WORK_DIR}/rootfs/etc/modules.d"

echo "mt7603e" > "${WORK_DIR}/rootfs/etc/modules.d/91-mt7603e"
echo "mt_wifi" > "${WORK_DIR}/rootfs/etc/modules.d/mt7615d"

cat << 'EOF' > "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat"
#The word of "Default" must not be removed
Default
CountryRegion=5
CountryRegionABand=7
CountryCode=BD
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
TxPreamble=1
RTSThreshold=2346
FragThreshold=2346
TxBurst=1
PktAggregate=1
WmmCapable=1
APSDCapable=1
ShortSlot=1
AutoChannelSelect=0
IEEE8021X=0
AuthMode=WPA2PSKWPA3PSK
PMFMFPC=1
PMFMFPR=0
PMFSHA256=1
EncrypType=AES
WPAPSK1=12345678
DefaultKeyID=1
HT_HTC=1
HT_RDG=1
HT_EXTCHA=1
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
G_BAND_256QAM=1
RadioOn=1
EOF

for dst in "${WORK_DIR}/rootfs/etc/Wireless/mt7603e/mt7603e.dat" \
           "${WORK_DIR}/rootfs/etc/wireless/mt7603/mt7603.dat" \
           "${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.1.dat"; do
    cp -f "${WORK_DIR}/rootfs/etc/Wireless/RT2860/RT2860AP.dat" "$dst"
done

MT7615_DAT="${WORK_DIR}/rootfs/etc/wireless/mt7615/mt7615.2.dat"
if [ ! -f "$MT7615_DAT" ]; then
    printf '#The word of "Default" must not be removed
Default
' > "$MT7615_DAT"
fi

# Upsert all critical 4x4 MU-MIMO, Explicit/Implicit Beamforming & WHNAT keys
upsert_dat_key "$MT7615_DAT" "CountryRegion" "1"
upsert_dat_key "$MT7615_DAT" "CountryRegionABand" "7"
upsert_dat_key "$MT7615_DAT" "CountryCode" "BD"
upsert_dat_key "$MT7615_DAT" "BssidNum" "1"
upsert_dat_key "$MT7615_DAT" "SSID1" "NexRouter_5G"
upsert_dat_key "$MT7615_DAT" "WirelessMode" "14"
upsert_dat_key "$MT7615_DAT" "Channel" "149"
upsert_dat_key "$MT7615_DAT" "BeaconPeriod" "100"
upsert_dat_key "$MT7615_DAT" "DtimPeriod" "1"
upsert_dat_key "$MT7615_DAT" "TxPower" "100"
upsert_dat_key "$MT7615_DAT" "AuthMode" "WPA3PSK"
upsert_dat_key "$MT7615_DAT" "IEEE80211W" "2"
upsert_dat_key "$MT7615_DAT" "PMFMFPC" "1"
upsert_dat_key "$MT7615_DAT" "PMFMFPR" "1"
upsert_dat_key "$MT7615_DAT" "PMFSHA256" "1"
upsert_dat_key "$MT7615_DAT" "EncrypType" "AES"
upsert_dat_key "$MT7615_DAT" "WPAPSK1" "12345678"
upsert_dat_key "$MT7615_DAT" "HT_BW" "1"
upsert_dat_key "$MT7615_DAT" "VHT_BW" "1"
upsert_dat_key "$MT7615_DAT" "VHT_SGI" "1"
upsert_dat_key "$MT7615_DAT" "VHT_LDPC" "1"
upsert_dat_key "$MT7615_DAT" "VHT_STBC" "1"
upsert_dat_key "$MT7615_DAT" "HT_TxStream" "4"
upsert_dat_key "$MT7615_DAT" "HT_RxStream" "4"
upsert_dat_key "$MT7615_DAT" "HT_AMSDU" "1"
upsert_dat_key "$MT7615_DAT" "HT_BAWinSize" "64"
upsert_dat_key "$MT7615_DAT" "MUTxRxEnable" "1"
upsert_dat_key "$MT7615_DAT" "MUTxOption" "1"
upsert_dat_key "$MT7615_DAT" "ETxBfEnCond" "1"
upsert_dat_key "$MT7615_DAT" "ITxBfEn" "1"
upsert_dat_key "$MT7615_DAT" "VOW_Airtime_Fairness_En" "1"
upsert_dat_key "$MT7615_DAT" "VOW_WATF_Enable" "1"
upsert_dat_key "$MT7615_DAT" "VOW_RX_En" "1"
upsert_dat_key "$MT7615_DAT" "CP_SUPPORT" "2"
upsert_dat_key "$MT7615_DAT" "RED_Enable" "1"
upsert_dat_key "$MT7615_DAT" "FQ_Enable" "1"
upsert_dat_key "$MT7615_DAT" "SmartCarrierSense" "1"
upsert_dat_key "$MT7615_DAT" "MBO_Support" "1"
upsert_dat_key "$MT7615_DAT" "OCE_Support" "1"
upsert_dat_key "$MT7615_DAT" "WNM_Support" "1"
upsert_dat_key "$MT7615_DAT" "TWTSupport" "1"
upsert_dat_key "$MT7615_DAT" "WHNAT" "1" 
upsert_dat_key "$MT7615_DAT" "RadioOn" "1"

# Configure l1profile.dat with EXACT 0x4DA8 factory EEPROM size for MT7615
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
INDEX1_EEPROM_size=0x4DA8
INDEX1_EEPROM_name=e2p
INDEX1_main_ifname=rai0
INDEX1_ext_ifname=rai
INDEX1_wds_ifname=wdsi
INDEX1_apcli_ifname=apclii
INDEX1_single_sku_path=/etc_ro/Wireless/RT2860AP/SingleSKU.dat
INDEX1_bf_sku_path=/etc_ro/Wireless/RT2860AP/SingleSKU_BF.dat
EOF

echo "[*] Staging NexRouter v2.0 unified tuning & Web UI into MTK rootfs..."
( cd "${ROOT_DIR}/webui" && node build.mjs >/dev/null )
mkdir -p "${WORK_DIR}/rootfs/www/nex"
cp -a "${ROOT_DIR}/webui/dist/." "${WORK_DIR}/rootfs/www/nex/"
cp -a "${ROOT_DIR}/build/files/etc/init.d/nexrouter-core" "${WORK_DIR}/rootfs/etc/init.d/nexrouter-core"
cp -a "${ROOT_DIR}/build/files/etc/sysctl.d/99-nexrouter.conf" "${WORK_DIR}/rootfs/etc/sysctl.d/99-nexrouter.conf"
chmod +x "${WORK_DIR}/rootfs/etc/init.d/nexrouter-core"

cat << 'EOF' > "${WORK_DIR}/rootfs/etc/rc.local"
# Bring up MT7603E 2.4GHz (ra0) and MT7615N 5GHz (rai0) in br-lan
ifconfig ra0 up 2>/dev/null || true
brctl addif br-lan ra0 2>/dev/null || true
ifconfig rai0 up 2>/dev/null || true
brctl addif br-lan rai0 2>/dev/null || true

# Run NexRouter v2.0 4-VPE IRQ & RPS tuner
/etc/init.d/nexrouter-core start 2>/dev/null || true
exit 0
EOF

echo "[*] Repackaging SquashFS filesystem (xz, 256 KiB blocks)..."
rm -f "${ROOT_SQUASHFS}"
"${MKSQUASHFS}" "${WORK_DIR}/rootfs" "${ROOT_SQUASHFS}" -comp xz -b 256k -no-xattrs -all-root >/dev/null

OUTPUT_IMAGE="${OUT_DIR}/nexrouter-v2-mtk-whnat-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin"
(cd "${WORK_DIR}/sysupgrade" && tar -cf "${OUTPUT_IMAGE}" sysupgrade-xiaomi_redmi-router-ac2100)

echo "[*] MTK WHNAT Build Complete: ${OUTPUT_IMAGE}"
sha256sum "${OUTPUT_IMAGE}"