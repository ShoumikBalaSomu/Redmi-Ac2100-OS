# Flashing, Recovery and Brick Avoidance

This is the safety-critical document. Read it completely before touching flash.

---

## 1. Before You Start

### Required Equipment

| Item | Why |
|---|---|
| **Serial console adapter** (USB-to-TTL, 3.3V) | The only reliable way to diagnose boot failures. Connect to ttyS0 at **115200n8**. Note: uart2 and uart3 pin groups are reassigned to GPIO on this board — **only ttyS0 works as a console**. See [01-hardware-truth.md](./01-hardware-truth.md) §8. |
| **TFTP server** | For u-boot recovery. dnsmasq, tftpd-hpa, or any standard TFTP daemon. |
| **Stock firmware image** | Keep `miwifi_rm2100_firmware_0a7f5_2.0.503.bin` (or whatever version you backed up) in a safe place. This is your last-resort recovery image. SHA-256: `937baa2332ad49420246ce359ee2f789154f419bc4bc5053999f8c17fab348aa`. |
| **Verified NexRouter image** | Built and verified per [04-build-guide.md](./04-build-guide.md) §3. Never flash an unverified image. |
| **Ethernet cable** | Direct connection to the router's LAN port. Do not flash over WiFi. |
| **Stable power** | Power loss during flash = potential brick. Use a UPS or ensure uninterrupted power. |

### Pre-Flash Checklist

- [ ] Serial console connected and tested (you can see u-boot output).
- [ ] Stock firmware image downloaded and hash-verified.
- [ ] NexRouter image built, size-checked (≤ 120320k), sha256-verified, and fwscan-verified (uImage CRC = VALID).
- [ ] TFTP server configured and tested.
- [ ] Router connected via Ethernet to your workstation.
- [ ] You know which device you have: **Redmi RM2100**, not Xiaomi Mi R2100. They are different devices with different DTS files. An image for one will not work on the other.
- [ ] You have read this entire document.

---

## 2. MTD Partition Map

Reference from [01-hardware-truth.md](./01-hardware-truth.md) §4:

| Offset | Size | Name | Flags | Contents | Safe to Write? |
|---|---|---|---|---|---|
| `0x000000` | 512 KiB | Bootloader | ro | u-boot | ⛔ **NEVER** |
| `0x080000` | 256 KiB | Config | rw | u-boot environment | ⚠️ Only if you know what you are doing |
| `0x0C0000` | 256 KiB | Bdata | ro | Board calibration | ⛔ **NEVER** |
| `0x100000` | 256 KiB | factory | ro | WiFi EEPROM + MACs | ⛔ **NEVER** |
| `0x140000` | 256 KiB | crash | rw | Crash dump | Yes (auto-managed) |
| `0x180000` | 256 KiB | crash_syslog | rw | Crash syslog | Yes (auto-managed) |
| `0x1C0000` | 256 KiB | reserved0 | ro | Reserved | ⛔ No |
| `0x200000` | 4 MiB | kernel_stock | rw | Stock kernel (fallback) | ⚠️ Preserve as recovery |
| `0x600000` | 4 MiB | kernel | rw | OpenWrt kernel | ✅ Primary target |
| `0xA00000` | 117.5 MiB | ubi | rw | Root filesystem | ✅ Primary target |

### ⛔ NEVER ERASE `factory` OR `kernel_stock`

**`factory` (0x100000)** holds:

- MT7603 2.4 GHz WiFi EEPROM (`eeprom@0`, 0x0400 bytes)
- MT7615 5 GHz WiFi EEPROM (`eeprom@8000`, 0x4DA8 bytes — overridden size)
- LAN/base MAC address (`macaddr@e000`, 6 bytes)
- WAN MAC address (`macaddr@e006`, 6 bytes)

Losing the factory partition means:

- **WiFi radios cannot be calibrated.** The EEPROM contains per-device RF calibration data. Without it, transmit power, frequency offset, and antenna tuning are wrong. Performance degrades significantly and cannot be recovered without vendor-specific recalibration tools that are not publicly available.
- **MAC addresses are unrecoverable.** The device will generate random MACs on each boot, breaking DHCP reservations, firewall rules, and network access controls. There is no sticker on the board with the original MACs in a format you can reliably re-enter.

**`kernel_stock` (0x200000)** holds the stock Xiaomi kernel. This is your dual-boot fallback (see §3). If your OpenWrt kernel fails to boot, u-boot falls back to this partition. Erasing it removes your safety net.

---

## 3. Dual-Boot Mechanism

From the upstream DTS comment (verbatim):

> u-boot expects kernels at `0x200000` ("system 1") and `0x600000` ("system 2"). A kernel is booted if its **Linux magic exists AND its uImage CRC is correct**. If either check fails, a `sys'n'_fail` flag is set in the u-boot env and it restarts to try the other kernel. If BOTH fail, system 2 is booted anyway. u-boot's TFTP flash install writes the image to BOTH kernel partitions.

### What This Means in Practice

1. **Valid uImage CRC = boots.** If your kernel has a correct uImage header with valid CRC, u-boot loads it. If it then panics at runtime, the next reboot tries the other kernel.
2. **Invalid uImage CRC = silently rejected.** u-boot does not print an error message visible without serial console. It sets `sys2_fail` and falls back. To the user without serial access, this looks like "the router booted into stock instead of OpenWrt" with no explanation.
3. **Both kernels bad = system 2 anyway.** If both CRCs fail, u-boot boots system 2 regardless. This is a last-resort behaviour, not a recovery mechanism.
4. **TFTP recovery overwrites both.** Vendor u-boot TFTP flash writes to *both* kernel partitions. After TFTP recovery, your OpenWrt kernel is gone.

### Implications

- **Always verify uImage CRC before flashing.** Use `fwscan.mjs` (see [04-build-guide.md](./04-build-guide.md) §3).
- **Never zero `kernel_stock` unless your OpenWrt build is proven stable.** It is your only automated fallback.
- **Serial console is essential for debugging boot failures.** Without it, you cannot distinguish "bad CRC" from "kernel panic" from "wrong load address."

---

## 4. Flashing Paths

### From Stock Xiaomi Firmware

The vendor web UI rejects non-Xiaomi images. You need one of:

1. **Exploit + `mtd write`** — Known exploits for the RM2100 allow root access on stock firmware, after which you can `mtd write` the OpenWrt sysupgrade image directly. Search the OpenWrt forum for current exploit instructions — they change with firmware versions.
2. **Breed bootloader** — Replace u-boot with Breed (a third-party bootloader popular in the Chinese router community), which provides a web-based flash interface that accepts any image. Requires serial console for initial installation.
3. **Serial console + TFTP** — Interrupt u-boot at the serial prompt, configure TFTP, and flash directly.

⚠️ **Do not use the vendor "upgrade" page.** It validates the Xiaomi HDR1 container signature and rejects anything else.

### From Existing OpenWrt

```bash
# Transfer the image
scp openwrt-*-sysupgrade-nexrouter.bin root@192.168.1.1:/tmp/

# Flash WITHOUT preserving config (-n is critical when crossing distributions)
sysupgrade -n /tmp/openwrt-*-sysupgrade-nexrouter.bin
```

**Why `-n` matters:** When crossing from stock to OpenWrt, or between OpenWrt variants (e.g., vanilla → CatWrt → NexRouter), UCI config formats may differ. Preserving old config can cause boot failures, broken networking, or subtle misbehaviour. Always use `-n` for cross-distribution upgrades. Configure from scratch afterward (the first-boot script handles NexRouter defaults).

For NexRouter-to-NexRouter upgrades on the same release line, you can omit `-n` to preserve your configuration.

### Via u-boot TFTP

1. Connect serial console.
2. Power on and interrupt u-boot (press any key during the countdown).
3. Configure network:
   ```
   setenv ipaddr 192.168.1.1
   setenv serverip 192.168.1.100
   ```
4. Flash:
   ```
   tftp 0x80001000 openwrt-sysupgrade.bin
   nand erase 0x600000 0x400000
   nand write 0x80001000 0x600000 ${filesize}
   ```
5. Reset: `reset`

⚠️ **Vendor u-boot TFTP writes to BOTH kernel partitions.** Check your specific u-boot version's behaviour. Some variants write only to system 2; others overwrite both. Know which one you have before relying on `kernel_stock` as a fallback after TFTP recovery.

---

## 5. Verification Before Flashing

Run these checks on every image before it touches flash:

```bash
# 1. Size check (must be ≤ 120320k = 123,207,680 bytes)
stat --format=%s openwrt-*-sysupgrade-nexrouter.bin

# 2. SHA-256 verification
sha256sum openwrt-*-sysupgrade-nexrouter.bin

# 3. Structural verification
node analysis/tools/fwscan.mjs openwrt-*-sysupgrade-nexrouter.bin
# Confirm: uImage CRC = VERIFIED VALID
# Confirm: squashfs superblock present
# Confirm: BOARD = xiaomi_redmi-router-ac2100
```

If any check fails, **do not flash**. Rebuild and re-verify.

---

## 6. Recovery Ladder

In order of severity. Try each before escalating.

### Level 1: Sysupgrade Again

If the router boots but behaves incorrectly:

```bash
sysupgrade -n /tmp/openwrt-*-sysupgrade-nexrouter.bin
```

A clean reflash fixes most config-corruption issues.

### Level 2: Failsafe Mode

If the router boots but you cannot access it (broken network config, bad firewall rule):

1. Power off the router.
2. Hold the reset button (GPIO 18).
3. Power on while holding reset.
4. Release reset after the status LED starts flashing (typically 5–10 seconds).
5. The router enters failsafe mode with a static IP (usually 192.168.1.1) and minimal services.
6. Telnet to 192.168.1.1 and fix the configuration, or reflash.

### Level 3: u-boot TFTP Recovery

If the router does not boot OpenWrt at all:

1. Connect serial console.
2. Set up TFTP server with the stock firmware image.
3. Interrupt u-boot and flash via TFTP (see §4).
4. This restores stock firmware on both kernel partitions.

### Level 4: Serial Console + mtd

If TFTP fails or you need to write a specific partition:

1. Boot into any working environment (failsafe, stock, or a temporary initramfs).
2. Use `mtd write` to write specific partitions:
   ```bash
   mtd write openwrt-kernel.bin kernel
   mtd write openwrt-root.bin ubi
   ```
3. Verify with `mtd verify` after writing.

### Level 5: Full Stock Reflash

Last resort. Flash the complete stock image:

```bash
mtd write miwifi_rm2100_firmware_0a7f5_2.0.503.bin firmware
```

Or use u-boot TFTP with the stock image. This restores the device to factory state, including the stock kernel on both partitions.

---

## 7. Getting Back to Stock

The stock kernel is preserved at `kernel_stock` (0x200000) by default. If intact:

1. Set the u-boot environment to prefer system 1:
   ```
   # From serial console or SSH
   fw_setenv sys2_fail 1
   reboot
   ```
2. u-boot falls back to the stock kernel.

If `kernel_stock` has been overwritten, flash the full stock image via TFTP or `mtd write` (see §6, Level 5).

---

## 8. Things That Will Brick This Router

| Action | Consequence | Recoverable? |
|---|---|---|
| Erasing `factory` partition | WiFi uncalibrated, MACs lost | ❌ Not without vendor tools |
| Erasing `Bootloader` partition | No boot at all | ❌ Requires SPI programmer or JTAG |
| Unstable overclock | Silent DDR corruption, boot failure, thermal damage | ⚠️ Maybe (reflash if SoC survives) |
| Truncated/partially-written image | Corrupt kernel or rootfs | ✅ Dual-boot fallback or TFTP |
| Power loss during flash | Partial write = corrupt partition | ⚠️ Depends on which partition was being written |
| Flashing an R2100 image on RM2100 | Wrong DTS, hardware mismatch, likely panic | ✅ Reflash with correct image |
| Writing to wrong MTD offset | Overwrite critical partition | ⚠️ Depends on what was overwritten |
| `dd if=/dev/zero of=/dev/mtd0` | Erased bootloader | ❌ Requires SPI programmer |

### Device Identity Warning

The **Xiaomi Redmi Router AC2100 (RM2100)** and the **Xiaomi Mi Router AC2100 (R2100)** are **different devices**:

- Different DTS files (`mt7621_xiaomi_redmi-router-ac2100.dts` vs `mt7621_xiaomi_router-ac2100.dtsi`)
- Different hardware layouts
- Different flash partitioning
- Images are **not interchangeable**

Verify your device model before flashing. The label on the bottom of the unit states the model number.

---

## Sources

- [OpenWrt failsafe mode](https://openwrt.org/docs/guide-user/troubleshooting/failsafe_and_factory_reset)
- [OpenWrt sysupgrade documentation](https://openwrt.org/docs/guide-user/troubleshooting/generic.sysupgrade)
- [MT7621 NAND flash guide](https://openwrt.org/toh/xiaomi/redmi_router_ac2100)
- Upstream DTS: [`mt7621_xiaomi_nand_128m.dtsi`](https://raw.githubusercontent.com/openwrt/openwrt/master/target/linux/ramips/dts/mt7621_xiaomi_nand_128m.dtsi)
