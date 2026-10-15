# Building NexRouter

Two build paths exist. Pick the right one.

| Path | When to use | Effort |
|---|---|---|
| **Image Builder + FILES overlay** (`build/build.sh`) | Default. All NexRouter customisation is plain config files, scripts, and a static web UI — no kernel or driver patches needed. | Minutes |
| **Full source build** | Only if you must modify the kernel, device tree, ethernet driver, or mt76 WiFi driver. | Hours + multi-GB toolchain |

If you are not patching C code in `target/linux/ramips/` or `package/kernel/`, you do not need a full source build.

---

## 1. Prerequisites

### Host System

The OpenWrt Image Builder is a **Linux x86_64 binary**. It will not run on bare Windows. Your options:

- **WSL2** (Ubuntu 22.04+ recommended) — simplest path on a Windows host.
- **Native Linux** — any modern x86_64 distro.
- **macOS** — unsupported by the official Image Builder; use a Linux VM.

Required tools:

```
curl tar xz git make awk jq nodejs   # nodejs only for fwscan.mjs verification
```

Disk space: **~10 GB** for the Image Builder cache and output. A full source build needs ~30 GB.

### Why Not Bare Windows?

The Image Builder ships precompiled `opkg`, `mkimage`, `mksquashfs`, and other ELF binaries. These are not portable executables. WSL2 provides a real Linux kernel with native ELF support and negligible overhead. Do not attempt Cygwin or MSYS2 — they lack the required syscall compatibility.

---

## 2. Image Builder Path (Recommended)

### Step-by-Step

```bash
# Clone the NexRouter repo
git clone <repo-url> nexrouter && cd nexrouter

# Build with default snapshot
./build/build.sh

# Or pin to a stable release
./build/build.sh --release 24.10.2

# Clean previous output first
./build/build.sh --clean

# Parallel build (adjust to core count)
./build/build.sh --jobs 8

# Offline mode (skip download, use cached packages)
./build/build.sh --offline
```

### What `build.sh` Does

1. Downloads the official OpenWrt Image Builder for `ramips/mt7621`.
2. Stages `build/files/` as the `FILES=` overlay — these are your UCI defaults, init scripts, rpcd plugin, web UI, and config files.
3. Builds `webui/dist` into `/www/nex/` if the directory exists.
4. Writes `/etc/nexrouter-release` with build provenance (timestamp, release tag, git hash).
5. Removes conflicting `luci*` and `uhttpd-mod-ubus` packages from the base image.
6. Adds the NexRouter package list (see below).
7. Runs `make image PROFILE=xiaomi_redmi-router-ac2100 PACKAGES=... FILES=... BIN_DIR=out/ EXTRA_IMAGE_NAME=nexrouter`.

Output lands in `out/`:

```
out/openwrt-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade-nexrouter.bin
out/openwrt-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-factory-nexrouter.bin
out/sha256sums
```

### Choosing a Release

| Option | Pros | Cons |
|---|---|---|
| `--release snapshot` (default) | Newest kernel, newest mt76 driver, latest security fixes | Moving target; package feeds can break between builds |
| `--release 24.10.2` (stable tag) | Reproducible, tested package set, stable feeds | Older kernel/driver; may miss recent CVE patches |
| `--release 23.05.5` | Most mature/stable for mt7621 | Significantly older; missing HFO improvements from 24.x |

For daily driving, prefer a stable tag. For development and testing, use snapshot. If a snapshot build fails due to a feed mismatch, wait 24–48 hours and retry — the snapshot feed resyncs regularly.

### Package List

`build.sh` adds these packages beyond the base image:

```
uhttpd uhttpd-mod-ubus rpcd rpcd-mod-file rpcd-mod-iwinfo rpcd-mod-luci
jq curl nlbwmon
kmod-nft-offload kmod-nft-flowtable kmod-nft-nat
kmod-ipt-conntrack kmod-nf-conntrack-netlink
kmod-sched-cake kmod-sched-codel kmod-sched-fq-codel
kmod-tun kmod-wireguard wireguard-tools
softflowd tcpdump-mini
collectd collectd-mod-network collectd-mod-ping
ethtool iperf3 vnstat2 htop irqbalance
odhcpd-ipv6only odhcp6c
```

It also includes `kmod-usb-*` packages solely because `block-mount` depends on them. This board has **no USB port** (see [01-hardware-truth.md](./01-hardware-truth.md) §8). For a strictly-AC2100 build, drop the USB packages to save ~700 KiB. Edit the `PACKAGES` variable in `build.sh`.

### Customising Packages

To add a package, append it to the `PACKAGES` string in `build.sh`. To remove one, prefix it with `-`:

```bash
PACKAGES="... -kmod-usb-core -kmod-usb-ohci my-custom-package"
```

The Image Builder resolves dependencies automatically. If a package name is wrong, the build fails with an explicit error listing available alternatives.

---

## 3. Verifying the Image Before Flashing

**Never flash an unverified image.** The dual-boot mechanism (see [01-hardware-truth.md](./01-hardware-truth.md) §5) silently rejects kernels with invalid uImage CRCs — a bad build looks like a bootloop, not an error message.

### Size Check

The OpenWrt `IMAGE_SIZE` for this profile is **120320k** (~117.5 MiB). Your sysupgrade image must not exceed this:

```bash
ls -la out/*sysupgrade*.bin
# Must be ≤ 123,207,680 bytes (120320 × 1024)
```

With 117.5 MiB of ubi space and a minimal rootfs, you are unlikely to hit this limit. But verify anyway.

### SHA-256

```bash
sha256sum out/*sysupgrade*.bin
# Compare against out/sha256sums
```

### Structural Verification with fwscan.mjs

Run the project's own analyzer on the output image:

```bash
node analysis/tools/fwscan.mjs out/*sysupgrade*.bin
```

Confirm these fields in the output:

- **uImage CRC:** `VERIFIED VALID` — if this says anything else, **do not flash**. u-boot will reject it.
- **squashfs superblock:** Present and parseable — confirms the rootfs is intact.
- **Entropy:** ~7.9–8.0 — confirms compression, not corruption.
- **Board match:** `BOARD=xiaomi_redmi-router-ac2100` in the CONTROL file.

This ties directly to the dual-boot safety mechanism: u-boot checks the Linux magic number AND the uImage header CRC. If either fails, it sets `sys2_fail` in the u-boot environment and falls back to `kernel_stock`. A structurally valid image that panics at runtime still triggers fallback. A structurally *invalid* image (bad CRC) is rejected before it even loads.

---

## 4. Full Source Build Path

Only needed when modifying kernel code, device tree, or drivers.

### Setup

```bash
git clone https://github.com/openwrt/openwrt.git
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a

# Copy NexRouter overlay files
cp -r ../nexrouter/build/files/ files/

# Configure
make menuconfig
# Target System → MediaTek Ralink MIPS
# Subtarget → MT7621 based boards
# Target Profile → Xiaomi Redmi Router AC2100
```

### Building

```bash
# Download all sources first
make download -j$(nproc)

# Build (first build is slow — compiles toolchain + all packages)
make -j$(nproc) V=s    # V=s for verbose; omit for quiet
```

Output: `bin/targets/ramips/mt7621/`

### When You Actually Need This

- Patching `mt7621.dtsi` or the device-specific DTS.
- Modifying the mt76 WiFi driver (`package/kernel/mt76/`).
- Adding kernel modules not in the standard feed.
- Backporting or forward-porting ethernet/PPE patches.
- Changing kernel configuration (`CONFIG_*` options).

If your change is a config file, shell script, or web asset, use the Image Builder path instead.

---

## 5. Adding Custom Packages

If you want to convert the rpcd shell plugin (`build/files/usr/libexec/rpcd/nexrouter`) into a proper C ubus plugin later:

1. Create a package directory under `package/nexrouter/` (full source) or as a feed package.
2. Write a `Makefile` following the [OpenWrt package template](https://openwrt.org/docs/guide-developer/packages).
3. Implement the ubus methods in C using `libubus` and `libblobmsg-json`.
4. Register ACLs in `/usr/share/rpcd/acl.d/` as before.
5. Add the package to `PACKAGES` in `build.sh` or select it in `menuconfig`.

The current shell plugin is fully functional and inherits rpcd session authentication. A C plugin gains performance (no jq/shell fork overhead per call) but adds build complexity. For this board's management-plane load, the shell plugin is sufficient.

---

## 6. Troubleshooting

### Image Builder Package Name Errors

```
Collected errors:
 * opkg_install_cmd: Cannot install package foo-bar.
```

The package name differs between releases. Check the available packages:

```bash
# Inside the Image Builder directory
./scripts/dump-target-info.pl packages ramips/mt7621 | grep foo
```

Or search the [OpenWrt package index](https://packages.openwrt.org/) for your exact release/architecture.

### Missing Dependency Resolution

The Image Builder does not auto-resolve missing dependencies from external feeds. If a package depends on something not in the base repository, either:

- Add the dependency explicitly to `PACKAGES`.
- Use a stable release where the feed is complete.
- Switch to a full source build.

### FILES Permissions Lost Under Windows

**This is the most common pitfall for WSL2 users who edit files from Windows.**

Files created or edited on a Windows filesystem (NTFS) and accessed via WSL2 lose their executable bit. This means:

- `99-nexrouter-firstboot` in `/etc/uci-defaults/` silently does nothing (uci-defaults requires `+x`).
- Init scripts in `/etc/init.d/` fail to start.
- The rpcd plugin is not discovered.

**Fix:** After copying `build/files/` into WSL2, restore permissions:

```bash
find build/files/etc/uci-defaults/ -type f -exec chmod +x {} \;
find build/files/etc/init.d/ -type f -exec chmod +x {} \;
chmod +x build/files/usr/libexec/rpcd/nexrouter
chmod +x build/files/usr/libexec/nexrouter/insight-query
```

Better: keep the repo inside the WSL2 filesystem (`~/nexrouter/`), not on a Windows-mounted drive (`/mnt/c/...`). Native ext4/btrfs preserves Unix permissions correctly.

### Snapshot-vs-Package-Feed Mismatch

Snapshot builds can fail when the Image Builder version and the package feed are out of sync (the feed rebuilds on a different commit than the builder was cut from). Symptoms:

```
Unknown package 'kmod-nft-flowtable'
```

Fixes:

- Wait 24–48 hours and retry (feeds resync).
- Pin to a stable release.
- Use `--offline` with a previously successful cache.

### Image Built but u-boot Rejects It

Symptoms: router boots into stock firmware after flashing OpenWrt, with no error message.

Causes:

1. **Invalid uImage CRC.** Verify with `fwscan.mjs`. Rebuild if invalid.
2. **Wrong load address.** NexRouter/OpenWrt uses `0x80001000`; stock uses `0x81001000`. A mismatched load address causes immediate failure. Do not hand-edit the uImage header.
3. **Image too large for kernel partition.** The kernel partition is 4 MiB. The sysupgrade image includes both kernel and rootfs and goes into the ubi partition, but the kernel portion alone must fit in 4 MiB. With an uncompressed kernel + loader stub, this is typically ~3.5 MiB.
4. **Wrong device.** An image built for `xiaomi_router-ac2100` (R2100, Mi Router) will not work on `xiaomi_redmi-router-ac2100` (RM2100, Redmi Router). They are different devices with different DTS files. Verify the `BOARD=` field in the sysupgrade CONTROL file.

---

## Sources

- [OpenWrt Image Builder documentation](https://openwrt.org/docs/guide-user/additional-software/imagebuilder)
- [OpenWrt build system](https://openwrt.org/docs/guide-developer/build-system/install-buildsystem)
- [OpenWrt package development](https://openwrt.org/docs/guide-developer/packages)
- Device profile: [`target/linux/ramips/image/mt7621.mk`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/image/mt7621.mk)
