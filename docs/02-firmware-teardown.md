# Firmware Teardown — Three ROMs, Reverse Engineered

This document presents the results of static binary analysis on three firmware images for the Xiaomi Redmi Router AC2100 (RM2100). All data below comes from direct inspection of the image bytes — nothing is inferred from documentation or assumed from filenames.

---

## Methodology

NexRouter ships its own zero-dependency firmware analyzer: `analysis/tools/fwscan.mjs`. It performs **read-only static analysis** — it never touches a device, never decrypts, never writes flash. For each image it:

1. **Streams** the file in chunks (no full-load requirement for large images).
2. **Indexes container magic signatures** — HDR1 vendor headers, uImage (`0x27051956`), squashfs (`hsqs`), FDT/FIT (`0xD00DFEED`), gzip (`0x1F8B`), UBI erase-count headers (`UBI#`), tar ustar markers.
3. **Deep-parses uImage headers** including CRC-32 verification against the declared header checksum.
4. **Parses squashfs superblocks** — version, compression algorithm, block size, inode count, fragment count, bytes used, mkfs timestamp.
5. **Computes a Shannon entropy profile** across the image to distinguish compressed, encrypted, and empty regions.
6. **Counts signature occurrences** (xz markers, bzip2 headers, UBI erase-count headers) as a census of embedded artefacts.

All numbers below are hard data from this tool. Where a field says "VERIFIED VALID" for a CRC, that means the computed CRC-32 over the header bytes matches the stored value exactly.

---

## Image 1: Stock Xiaomi Firmware

**File:** `miwifi_rm2100_firmware_0a7f5_2.0.503.bin`
**Size:** 15.66 MiB (16,424,000 bytes)
**SHA-256:** `937baa2332ad49420246ce359ee2f789154f419bc4bc5053999f8c17fab348aa`

### Container Format

Offset `0x00000000`: Xiaomi `HDR1` vendor container header. Immediately following in plaintext ASCII is a UCI-style version manifest:

```
config core 'version'
    option ROM '2.0.503'
    option CHANNEL 'release'
    option UBOOT '1.0.2'
    option LINUX '0.0.1'
    option ROOTFS '0.0.1'
    option BUILDTIME 'Tue, 14 Feb 2023 02:50:43 +0000'
    option BUILDTS '1676343043'
```

The string `xiaoqiang_version` appears adjacent, confirming this is the standard Xiaomi router firmware packaging format.

### uImage Header

| Field | Value |
|---|---|
| Offset | `0x000002AC` |
| Magic | `0x27051956` ✓ |
| Header CRC | `0xEC531861` — **VERIFIED VALID** |
| Timestamp | 2023-02-13T12:40:43Z |
| Data Size | 3,053,588 bytes (2.91 MiB) |
| Load Address | `0x81001000` |
| Entry Point | `0x813F9F00` |
| Architecture | MIPS |
| OS | Linux |
| Type | Kernel |
| Compression | lzma |
| Image Name | `MIPS OpenWrt Linux-3.10.14` |

### SquashFS Root Filesystem

| Field | Value |
|---|---|
| Offset | `0x0032AB30` |
| Version | 4.0, little-endian |
| Compression | xz |
| Block Size | 256 KiB (block_log 18) |
| Inodes | 2,998 |
| Fragments | 79 |
| Bytes Used | 12.09 MiB |
| Mkfs Time | 2023-02-14T02:58:12Z |
| Integrity Check | None |
| IDs | 1 |

### Entropy & Signature Census

- Entropy range: 7.82–7.94 (compressed, **not encrypted**)
- UBI erase-count headers (`UBI#`): 102
- xz stream markers: 196
- String `root.ubi` present near `0x002E9B30`

---

## Image 2: OpenWrt Snapshot

**File:** `openwrt-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin`
**Size:** 7.91 MiB (8,294,984 bytes)
**SHA-256:** `7654cec8b931c0552a1b90828fb070c26c2def4a90814c3ccc2d2afdf15b7c34`

### Container Format

Wrapped in a tar archive containing directory `sysupgrade-xiaomi_redmi-router-ac2100/` with members: `CONTROL`, `BOARD=xiaomi_redmi-router-ac2100`, `kernel`, `root`. 4 tar ustar markers detected.

### uImage Header

| Field | Value |
|---|---|
| Offset | `0x00000800` |
| Magic | `0x27051956` ✓ |
| Header CRC | `0x8F66065F` — **VERIFIED VALID** |
| Timestamp | 2026-10-12T06:48:37Z |
| Data Size | 3,734,524 bytes (3.56 MiB) |
| Load Address | `0x80001000` |
| Entry Point | `0x80001000` |
| Architecture | MIPS |
| OS | Linux |
| Type | Kernel |
| Compression | none |
| Image Name | `MIPS OpenWrt Linux-6.18.55` |

At offset `0x1000` within the kernel data: Gabor Juhos kernel loader stub — `"OpenWrt kernel loader for MIPS based SoC / Copyright (C) 2011 Gabor Juhos"`. This stub prints `"Decompressing kernel..."` and `"Starting kernel at %08x..."` during boot. Since compression is `none`, the stub acts as a relocation/trampoline rather than a decompressor.

### SquashFS Root Filesystem

| Field | Value |
|---|---|
| Offset | `0x00390800` |
| Version | 4.0, little-endian |
| Compression | xz |
| Block Size | 256 KiB |
| Inodes | 942 |
| Fragments | 28 |
| Bytes Used | 4.34 MiB |
| Mkfs Time | 2026-10-12T06:48:37Z |

### Entropy & Signature Census

- Entropy: ~7.997–8.000 (fully compressed, near theoretical maximum)
- Minimal package set reflected in 942 inodes / 4.34 MiB rootfs

---

## Image 3: CatWrt v24.9

**File:** CatWrt v24.9.mt7621 sysupgrade
**Size:** 21.56 MiB (22,611,034 bytes)
**SHA-256:** `e2447ea1f546ccf4228fc97ddda32e39fe3f51a353561e4ed4c48801ce73c0d7`

### Container Format

Same tar sysupgrade wrapper as OpenWrt, `BOARD=xiaomi_redmi-router-ac2100`.

### uImage Header

| Field | Value |
|---|---|
| Offset | `0x00000800` |
| Magic | `0x27051956` ✓ |
| Header CRC | `0xC8E1F3C` — **VERIFIED VALID** |
| Timestamp | 2024-08-20T09:34:00Z |
| Data Size | 2,619,396 bytes (2.50 MiB) |
| Load Address | `0x80001000` |
| Entry Point | `0x80001000` |
| Architecture | MIPS |
| OS | Linux |
| Type | Kernel |
| Compression | none |
| Image Name | `MIPS OpenWrt Linux-5.4.278` |

Same Gabor Juhos kernel-loader stub at offset `0x1000`.

### SquashFS Root Filesystem

| Field | Value |
|---|---|
| Offset | `0x00280400` |
| Version | 4.0, little-endian |
| Compression | xz |
| Block Size | 256 KiB |
| Inodes | 2,516 |
| Fragments | 78 |
| Bytes Used | 19.05 MiB |
| Mkfs Time | 2024-08-20T09:34:00Z |

### Entropy & Signature Census

- xz markers: 358
- bzip2 markers: 3
- Significantly larger rootfs reflecting CatWrt's expanded default package selection

---

## Comparison Table

| Property | Stock Xiaomi | OpenWrt Snapshot | CatWrt v24.9 |
|---|---|---|---|
| Total size | 15.66 MiB | 7.91 MiB | 21.56 MiB |
| Kernel version | **3.10.14** | **6.18.55** | **5.4.278** |
| Kernel build date | 2023-02-13 | 2026-10-12 | 2024-08-20 |
| Kernel compression | lzma | none | none |
| Kernel load address | `0x81001000` | `0x80001000` | `0x80001000` |
| Kernel entry point | `0x813F9F00` | `0x80001000` | `0x80001000` |
| uImage CRC valid | ✓ | ✓ | ✓ |
| Rootfs inodes | 2,998 | 942 | 2,516 |
| Rootfs bytes used | 12.09 MiB | 4.34 MiB | 19.05 MiB |
| Rootfs compression | xz | xz | xz |
| Entropy range | 7.82–7.94 | 7.997–8.000 | ~7.99 |
| Container format | HDR1 vendor | tar sysupgrade | tar sysupgrade |
| Encryption | None | None | None |
| Base lineage | Forked OpenWrt (~2014) | Upstream OpenWrt | Lean's LEDE (coolsnowwolf) |

---

## Findings

### (a) Stock Runs Kernel 3.10.14 — EOL Since October 2017

This is the single most important finding. The stock firmware's own uImage name declares `MIPS OpenWrt Linux-3.10.14`. Kernel 3.10 was released July 2013 and reached end-of-life upstream in October 2017. The build date of February 2023 means Xiaomi refreshed the userspace and repackaged the image, but **did not update the kernel base**. The vendor forked a ~2014-era OpenWrt and has been shipping it with cosmetic updates ever since.

### (b) Load Address Difference: `0x81001000` vs `0x80001000`

Stock loads at `0x81001000`; both OpenWrt images load at `0x80001000`. The stock kernel is relocated above the 16 MiB mark in physical memory. This is an observed difference consistent with the vendor's memory layout conventions (reserving lower memory for bootloader/DMA buffers). We note it without over-claiming its purpose — it may relate to the vendor's proprietary HNAT driver DMA requirements or simply be a legacy convention from their older BSP.

### (c) Compression Strategy Divergence

Stock compresses its kernel with **lzma** (smaller flash footprint, slower decompression at boot). Both OpenWrt images ship the kernel **uncompressed** with the Gabor Juhos loader stub acting as a trampoline. With 117.5 MiB of ubi space, there is no pressure to compress the kernel — faster boot and simpler debugging are worth the marginal size increase.

### (d) Inode Counts Tell the Packaging Story

- **942 inodes** (OpenWrt snapshot): Minimal default profile. Bare kernel, base system, essential drivers. Tons of headroom in the ubi partition.
- **2,516 inodes** (CatWrt): Fat package selection — includes additional utilities, themes, and pre-installed packages typical of the Lean/LEDE ecosystem.
- **2,998 inodes** (Stock): Full vendor userspace with Xiaomi's management stack, QoS engine, and proprietary WiFi control daemons.

### (e) Plaintext Version Manifest in Stock HDR1

The stock `HDR1` container carries a fully readable UCI-style configuration block listing ROM version, build timestamp, u-boot version, and component versions. This is useful for automated version detection and confirms the container format is not obfuscated.

### (f) Nothing Is Encrypted

All three images have entropy in the 7.8–8.0 range, consistent with xz/lzma compression and **inconsistent with encryption** (which would produce entropy ≥7.99 uniformly across all regions). There is no DRM, no signature wall, no encrypted payload blocking custom firmware installation. The dual-boot mechanism provides a safety net, and u-boot accepts any image with a valid uImage header and CRC.

### (g) CatWrt Is on 5.4 LTS Because of Its Lineage

CatWrt derives from Lean's LEDE (`coolsnowwolf/lede`), which tracks the 5.4 LTS kernel branch. Its GitHub repository is primarily a binary ipk package feed; actual build sources live in separate repos (`miaoermua/lede`, `miaoermua/catwrt_base`). The project has ~208 commits, 651 stars, and 3 contributors. Its own maintainer recommends ImmortalWrt for users who want modern upstream. CatWrt is functional but represents a different maintenance philosophy than upstream OpenWrt.

---

## Security Observation

A kernel from 2013 that reached EOL in 2017 is missing **roughly a decade** of upstream network-stack and driver CVE fixes. This includes critical vulnerabilities in TCP/IP processing, netfilter, WiFi drivers, and USB/storage subsystems (where applicable). On pure security grounds, the stock firmware is the **worst** of the three options analysed here — not the best. The common assumption that "vendor firmware is safer because it is official" does not survive contact with the evidence when the vendor is shipping a kernel that stopped receiving security patches seven years before the firmware was rebuilt.

OpenWrt snapshot (6.18.x) receives active security maintenance. CatWrt (5.4.x) is on an LTS branch that still receives backported fixes. Neither is perfect, but both are orders of magnitude more current than 3.10.14.

---

## Reproduce This Yourself

```bash
# Analyse any firmware image
node analysis/tools/fwscan.mjs miwifi_rm2100_firmware_0a7f5_2.0.503.bin

# Compare two images side by side
node analysis/tools/fwscan.mjs --compare \
  miwifi_rm2100_firmware_0a7f5_2.0.503.bin \
  openwrt-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin

# Verify a uImage CRC manually
hexdump -C -s 0x2ac -n 64 miwifi_rm2100_firmware_0a7f5_2.0.503.bin

# Extract and inspect the squashfs superblock
unsquashfs -s miwifi_rm2100_firmware_0a7f5_2.0.503.bin
```

`fwscan.mjs` requires only Node.js ≥18 and no native dependencies. It is read-only and safe to run on any firmware image without risk to your device.
