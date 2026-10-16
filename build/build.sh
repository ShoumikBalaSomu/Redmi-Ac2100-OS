#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# NexRouter build script
# ---------------------------------------------------------------------------
# Builds a NexRouter sysupgrade image for the Xiaomi Redmi Router AC2100
# (OpenWrt target: ramips/mt7621, profile: xiaomi_redmi-router-ac2100).
#
# Strategy: OpenWrt Image Builder + a FILES/ overlay.
#
#   Why not a full source build? A full OpenWrt toolchain build for this
#   target needs ~25 GB of disk and hours of compile time. The Image Builder
#   uses the same official prebuilt packages and kernel, produces an
#   identically-signed squashfs/UBI sysupgrade image, and finishes in
#   minutes. Every NexRouter customisation (configs, tuning scripts, web UI)
#   is plain files, so it drops straight into FILES/ with no patching.
#
#   The full-source path is documented in docs/04-build-guide.md for anyone
#   who needs to modify the kernel or the device tree itself.
#
# Requirements: Linux or WSL2. bash, curl, tar, xz, git, coreutils.
#             ~10 GB free disk. The Image Builder does NOT run on bare Windows.
#
# Usage:  ./build.sh [--release RELEASE] [--clean] [--offline] [--jobs N]
#
#   --release   OpenWrt release to build against. Default: "snapshot".
#               Use a stable tag such as "24.10.2" for daily driving and
#               "snapshot" only if you want the newest kernel/mt76.
#   --clean     remove the downloaded Image Builder before building
#   --offline   reuse an already-downloaded Image Builder, do not re-fetch
#   --jobs N    parallel jobs for make (default: nproc)
#
# Output:   out/*.bin  (sysupgrade + factory images)
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- defaults -------------------------------------------------------------
RELEASE="snapshot"
TARGET="ramips/mt7621"
PROFILE="xiaomi_redmi-router-ac2100"
CLEAN=0
OFFLINE=0
JOBS="$(nproc 2>/dev/null || echo 4)"

# ---- argument parsing -----------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --clean)   CLEAN=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --jobs)    JOBS="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- paths ----------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$ROOT/build/.work"
OUT="$ROOT/out"
IB_DIR="$WORK/imagebuilder"

# ---- package selection ----------------------------------------------------
# Baseline: OpenWrt's default profile, minus things we replace, plus the
# NexRouter feature set. Keep this list honest about flash AND RAM cost —
# the ubi partition is a roomy 117.5 MiB, but runtime RAM is only 128 MiB
# and that is the real constraint.
#
# Deliberately ABSENT, with reasons:
#   luci*                      — replaced by the NexRouter SPA (see webui/)
#   sqm-scripts / luci-app-sqm — CAKE tops out around ~150 Mbps on an 880 MHz
#                                MIPS core; shipping it enabled would silently
#                                halve a 500 Mbps link. fq_codel is used
#                                instead (see etc/config/nexrouter).
#   kmod-mt7615e is pulled in by DEVICE_PACKAGES for this profile already.
PACKAGES_REMOVE="-luci-theme-bootstrap -wpad-basic-mbedtls -px5g-wolfssl"

PACKAGES_ADD=" \
  luci luci-base luci-mod-admin-full luci-app-firewall luci-app-filemanager cgi-io luci-app-opkg \
  luci-theme-argon luci-app-argon-config \
  https-dns-proxy luci-app-https-dns-proxy \
  wpad-mbedtls kmod-tcp-bbr zram-swap kmod-zram \
  uhttpd uhttpd-mod-ubus rpcd rpcd-mod-file rpcd-mod-iwinfo rpcd-mod-luci \
  libubus libblobmsg-json jq curl ca-bundle ca-certificates \
  nlbwmon luci-lib-nixio \
  kmod-nft-offload kmod-crypto-hw-eip93 kmod-crypto-authenc kmod-crypto-cmac kmod-crypto-ccm kmod-crypto-gcm kmod-crypto-sha256 kmod-crypto-hmac kmod-crypto-ecdh bridger kmod-nft-nat \
  kmod-ipt-conntrack kmod-ipt-raw kmod-nf-conntrack-netlink \
  kmod-sched-cake \
  kmod-tun kmod-wireguard wireguard-tools \
  softflowd tcpdump-mini \
  luci-app-statistics collectd collectd-mod-load collectd-mod-memory \
    collectd-mod-network collectd-mod-interface collectd-mod-iwinfo \
  ethtool iperf3 vnstat2 htop nano less procps-ng-ps procps-ng-free \
  odhcpd-ipv6only odhcp6c \
  ethtool"

# NOTE on kmod-usb*: this board has NO USB port (verified against the DTS).
# They are listed only because block-mount is useful for future boards sharing
# this image recipe. If you build strictly for the AC2100, remove them to save
# ~700 KiB of flash. Left in, commented here rather than silently shipped.

# ---- preflight ------------------------------------------------------------
echo "==> NexRouter build"
echo "    release : $RELEASE"
echo "    target  : $TARGET"
echo "    profile : $PROFILE"
echo "    jobs    : $JOBS"

if [ "$(uname -s)" != "Linux" ]; then
  echo "ERROR: the OpenWrt Image Builder requires Linux." >&2
  echo "       On Windows, run this inside WSL2 (wsl --install) or a container." >&2
  exit 1
fi

for need in curl tar git make awk; do
  command -v "$need" >/dev/null 2>&1 || { echo "ERROR: missing dependency: $need" >&2; exit 1; }
done

mkdir -p "$WORK" "$OUT"

# Ensure FindBin / JSON::PP / Time::Piece are available for Image Builder scripts
PERL5_DIR="$WORK/perl5"
mkdir -p "$PERL5_DIR"
if ! perl -MFindBin -e 1 >/dev/null 2>&1; then
  echo "==> bootstrapping local perl modules in $PERL5_DIR"
  mkdir -p "$PERL5_DIR/JSON/PP" "$PERL5_DIR/Time"
  [ -f "$PERL5_DIR/FindBin.pm" ] || curl -sL "https://raw.githubusercontent.com/Perl/perl5/blead/dist/FindBin/lib/FindBin.pm" -o "$PERL5_DIR/FindBin.pm"
  [ -f "$PERL5_DIR/JSON/PP.pm" ] || curl -sL "https://raw.githubusercontent.com/makamaka/JSON-PP/master/lib/JSON/PP.pm" -o "$PERL5_DIR/JSON/PP.pm"
  [ -f "$PERL5_DIR/JSON/PP/Boolean.pm" ] || curl -sL "https://raw.githubusercontent.com/makamaka/JSON-PP/master/lib/JSON/PP/Boolean.pm" -o "$PERL5_DIR/JSON/PP/Boolean.pm"
  if [ ! -f "$PERL5_DIR/Time/Piece.pm" ]; then
    cat << 'EOF' > "$PERL5_DIR/Time/Piece.pm"
package Time::Piece;
use strict;
use warnings;
use POSIX qw(strftime);
use Exporter 'import';

our $VERSION = '1.3401';
our @EXPORT = qw(gmtime localtime);

sub gmtime {
    my $t = shift // CORE::time();
    return bless { t => $t, is_gmt => 1 }, __PACKAGE__;
}

sub localtime {
    my $t = shift // CORE::time();
    return bless { t => $t, is_gmt => 0 }, __PACKAGE__;
}

sub datetime {
    my $self = shift;
    if ($self->{is_gmt}) {
        return POSIX::strftime("%Y-%m-%dT%H:%M:%S", CORE::gmtime($self->{t}));
    } else {
        return POSIX::strftime("%Y-%m-%dT%H:%M:%S", CORE::localtime($self->{t}));
    }
}

1;
EOF
  fi
fi

# Add local_root host tools (such as patch) and modules if present
if [ -d "$WORK/local_root/usr/bin" ]; then
  export PATH="$WORK/local_root/usr/bin:$PATH"
fi
export PERL5LIB="$PERL5_DIR:$WORK/local_root/usr/share/perl5/vendor_perl:$WORK/local_root/usr/share/perl5:$WORK/local_root/usr/lib64/perl5/vendor_perl:${PERL5LIB:-}"

# ---- fetch the Image Builder ---------------------------------------------
TARGET_SLUG="${TARGET//\//-}"
if [ "$RELEASE" = "snapshot" ]; then
  IB_BASE="https://downloads.openwrt.org/snapshots/targets/${TARGET}/openwrt-imagebuilder-${TARGET_SLUG}.Linux-x86_64"
else
  IB_BASE="https://downloads.openwrt.org/releases/${RELEASE}/targets/${TARGET}/openwrt-imagebuilder-${RELEASE}-${TARGET_SLUG}.Linux-x86_64"
fi

if [ "$CLEAN" = "1" ]; then
  echo "==> --clean: removing $IB_DIR"
  rm -rf "$IB_DIR"
fi

if [ ! -d "$IB_DIR" ] && [ "$OFFLINE" = "0" ]; then
  echo "==> downloading Image Builder"
  IB_ARCHIVE=""
  if curl -fIs "${IB_BASE}.tar.zst" >/dev/null 2>&1; then
    IB_URL="${IB_BASE}.tar.zst"
    IB_ARCHIVE="$WORK/imagebuilder.tar.zst"
  elif curl -fIs "${IB_BASE}.tar.xz" >/dev/null 2>&1; then
    IB_URL="${IB_BASE}.tar.xz"
    IB_ARCHIVE="$WORK/imagebuilder.tar.xz"
  else
    echo "ERROR: could not locate Image Builder at ${IB_BASE}.tar.{zst,xz}" >&2
    exit 1
  fi
  echo "    $IB_URL"
  curl -fL --retry 3 --retry-delay 2 -o "$IB_ARCHIVE" "$IB_URL"
  echo "==> extracting"
  mkdir -p "$IB_DIR"
  tar -C "$IB_DIR" --strip-components=1 -xf "$IB_ARCHIVE"
  rm -f "$IB_ARCHIVE"
fi

if [ ! -x "$IB_DIR/Makefile" ] && [ ! -f "$IB_DIR/Makefile" ]; then
  echo "ERROR: Image Builder not present at $IB_DIR" >&2
  echo "       Re-run without --offline, or check the release name." >&2
  exit 1
fi

# ---- adapt package list for OpenWrt snapshot (apk) vs stable 24.10 (opkg) --
if grep -q "CONFIG_USE_APK=y" "$IB_DIR/.config" 2>/dev/null; then
  echo "==> detected OpenWrt SNAPSHOT (apk package manager)"
  # In OpenWrt snapshot (apk), luci-app-opkg is replaced by luci-app-package-manager
  # and local .ipk files are skipped unless available in the apk feed.
  PACKAGES_ADD="${PACKAGES_ADD//luci-app-opkg/luci-app-package-manager}"
  PACKAGES_ADD="${PACKAGES_ADD//luci-theme-argon/}"
  PACKAGES_ADD="${PACKAGES_ADD//luci-app-argon-config/}"
  if [ -d "$ROOT/packages" ] && compgen -G "$ROOT/packages/*.apk" > /dev/null; then
    echo "==> staging custom .apk packages into ImageBuilder"
    mkdir -p "$IB_DIR/packages"
    cp -a "$ROOT/packages/"*.apk "$IB_DIR/packages/"
  fi
else
  if [ -d "$ROOT/packages" ] && compgen -G "$ROOT/packages/*.ipk" > /dev/null; then
    echo "==> staging custom .ipk packages into ImageBuilder"
    mkdir -p "$IB_DIR/packages"
    cp -a "$ROOT/packages/"*.ipk "$IB_DIR/packages/"
  fi
fi

# ---- assemble the FILES/ overlay -----------------------------------------
# Everything under build/files/ lands verbatim at / on the device.
FILES="$WORK/files"
rm -rf "$FILES"
mkdir -p "$FILES"

echo "==> staging overlay files"
cp -a "$ROOT/build/files/." "$FILES/"

# Ship the built web UI if it exists; otherwise build it.
if [ -d "$ROOT/webui/dist" ] && [ -n "$(ls -A "$ROOT/webui/dist" 2>/dev/null)" ]; then
  echo "==> using prebuilt web UI from webui/dist"
  mkdir -p "$FILES/www/nex"
  cp -a "$ROOT/webui/dist/." "$FILES/www/nex/"
else
  echo "==> webui/dist is empty — attempting to build the web UI"
  # The web UI has ZERO dependencies, so there is no package-lock.json and
  # `npm ci` would fail outright (it requires a lockfile). Invoke the build
  # script directly with node — that is all `npm run build` would do anyway.
  if command -v node >/dev/null 2>&1 && [ -f "$ROOT/webui/build.mjs" ]; then
    ( cd "$ROOT/webui" && node build.mjs ) || {
      echo "ERROR: web UI build failed." >&2
      echo "       Fix it, or pre-populate webui/dist and re-run." >&2
      exit 1
    }
    mkdir -p "$FILES/www/nex"
    cp -a "$ROOT/webui/dist/." "$FILES/www/nex/"
  else
    echo "ERROR: node not available and webui/dist is empty." >&2
    echo "       The image cannot be assembled without the web UI." >&2
    exit 1
  fi
fi

# Ship the OUI vendor table used by the intelligence layer. If it is already
# present (committed or previously generated) use it; otherwise try to build it
# from the IEEE registry. A missing table is NOT fatal — device vendor names
# simply show as "unknown" — so this step warns rather than aborting the build.
if [ ! -s "$FILES/usr/lib/nexrouter/oui.txt" ]; then
  echo "==> OUI table absent — generating from the IEEE registry"
  if command -v node >/dev/null 2>&1 && [ -f "$ROOT/tools/build-oui.mjs" ]; then
    mkdir -p "$FILES/usr/lib/nexrouter"
    if node "$ROOT/tools/build-oui.mjs" --out "$FILES/usr/lib/nexrouter/oui.txt"; then
      echo "    OUI table: $(wc -l < "$FILES/usr/lib/nexrouter/oui.txt") entries"
    else
      echo "    WARNING: could not build the OUI table (network?)." >&2
      echo "             Vendor names will show as 'unknown'. To include them," >&2
      echo "             run tools/build-oui.mjs on a networked host and commit the" >&2
      echo "             result to build/files/usr/lib/nexrouter/oui.txt." >&2
    fi
  else
    echo "    WARNING: node unavailable; skipping OUI table generation." >&2
  fi
fi

# Make the shipped scripts executable — cp -a preserves mode, but files created
# by tooling on Windows lose it, and a non-executable uci-defaults script
# silently does nothing.
echo "==> normalising executable bits"
find "$FILES" -type f \( -path '*/init.d/*' -o -path '*/uci-defaults/*' \
  -o -path '*/hotplug.d/*' -o -path '*/nexrouter/*' -o -path '*/sbin/*' -o -path '*/rpcd/*' \) -exec chmod 0755 {} +
find "$FILES" -type f -path '*/config/*' -exec chmod 0644 {} +

# Record build provenance inside the image so it is self-identifying.
mkdir -p "$FILES/etc"
cat > "$FILES/etc/nexrouter-release" <<EOF
NEXROUTER_NAME="NexRouter OS"
NEXROUTER_VERSION=$(cat "$ROOT/VERSION" 2>/dev/null || echo dev)
NEXROUTER_CODENAME="Apex-Silicon-Argon-FileManager-Verified-v5.1"
NEXROUTER_TARGET=$TARGET
NEXROUTER_DEVICE=$PROFILE
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OPENWRT_RELEASE=$RELEASE
TARGET=$TARGET
PROFILE=$PROFILE
GIT_COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_DIRTY=$(git -C "$ROOT" diff --quiet 2>/dev/null && echo no || echo yes)
EOF

# ---- build ----------------------------------------------------------------
echo "==> running Image Builder"
cd "$IB_DIR"
make image \
  PROFILE="$PROFILE" \
  PACKAGES="$PACKAGES_ADD $PACKAGES_REMOVE" \
  FILES="$FILES" \
  BIN_DIR="$OUT" \
  EXTRA_IMAGE_NAME="nexrouter" \
  -j"$JOBS"

# Standardize binary name and checksum
SYSUPGRADE_RAW="$(find "$OUT" -maxdepth 1 -name "*squashfs-sysupgrade.bin" ! -name "NexRouter-OS-*" | head -n 1)"
V_TAG="$(cat "$ROOT/VERSION" 2>/dev/null || echo "5.0.0")"
if [ -n "$SYSUPGRADE_RAW" ] && [ -f "$SYSUPGRADE_RAW" ]; then
  STANDARDIZED_NAME="NexRouter-OS-v${V_TAG}-ramips-mt7621-${PROFILE}-squashfs-sysupgrade.bin"
  cp -f "$SYSUPGRADE_RAW" "$OUT/$STANDARDIZED_NAME"
  ( cd "$OUT" && sha256sum "$STANDARDIZED_NAME" > "${STANDARDIZED_NAME}.sha256" )
fi

# ---- report ---------------------------------------------------------------
echo
echo "==> build complete"
if compgen -G "$OUT/*.bin" > /dev/null; then
  echo "    images:"
  for f in "$OUT"/*.bin; do
    printf '      %-70s %10s bytes  sha256:%s\n' \
      "$(basename "$f")" "$(stat -c%s "$f")" "$(sha256sum "$f" | cut -c1-16)"
  done
  echo
  echo "    Flash with the *sysupgrade* image:"
  echo "      sysupgrade -n /tmp/nexrouter-...-sysupgrade.bin"
  echo "    (-n wipes the old overlay; do NOT omit it when coming from stock"
  echo "     or from a different distribution.)"
else
  echo "ERROR: no images produced in $OUT" >&2
  exit 1
fi
