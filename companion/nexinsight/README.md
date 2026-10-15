# NexInsight — off-router analysis companion

This is the half of NexRouter's "intelligence" that runs on a real computer
instead of on the router. It collects **NetFlow v5** records exported by
`softflowd` on the AC2100, aggregates them, and runs anomaly detection and
traffic classification where there is actually enough CPU and RAM to do it
properly.

**Zero runtime dependencies.** Node.js built-ins only (`dgram`, `http`, `fs`,
`path`, `crypto`). Node >= 20. Runs on Linux, macOS, Windows, a Raspberry Pi or
a NAS.

---

## Why the ML lives here and not on the router

This is the honest answer to "make an AI-driven router OS", and it is a design
decision, not a limitation we worked around.

The Redmi AC2100's MT7621 is an **880 MHz dual-core MIPS 1004Kc** with:

- **no FPU** — all floating point is software-emulated
- **no SIMD or vector unit** — no way to parallelise tensor math
- **no NPU or DSP**
- **128 MiB RAM** shared with the kernel, conntrack, the `mt76` radio drivers
  and the web UI
- **both cores already busy** forwarding packets

Neural inference is simply not feasible there. Even *classical* ML is a bad
trade: the expensive part is **feature extraction**, not the model. Tracking the
first N packets of every flow at 500 Mbps is estimated at **30-50% of one core
and 20-40 MB of RAM** — which would directly degrade the routing the router
exists to do. (Published tinyML traffic-classification work targets ARM
Cortex-M4/M7 with DSP extensions or RISC-V with vector extensions; none target
FPU-less MIPS.)

So NexRouter splits the job:

| | On the router | Off the router (here) |
|---|---|---|
| **Method** | OUI lookup, DHCP/ARP inventory, EWMA + robust-deviation anomaly baselines, in fixed-point integer arithmetic | Isolation Forest anomaly detection, decision-tree classification, full feature extraction |
| **Cost** | ~0% CPU, sampled every 15 min | Whatever your PC/Pi has |
| **Data** | device counters | NetFlow v5 records (src/dst IP, ports, bytes, timing) |
| **Export** | `softflowd`, ~2-5% CPU, **off by default** | received on UDP 2056 |

See [`docs/05-intelligence-layer.md`](../../docs/05-intelligence-layer.md) for
the full reasoning.

---

## Quick start

```sh
cd companion/nexinsight

# 1. Start collecting (binds 127.0.0.1:2056 by default)
node collector.mjs listen

# 2. Point the router's softflowd at this machine — see below.

# 3. In another shell, look at what arrived
node collector.mjs report
node collector.mjs stats
```

### Point the router at the collector

On the router (SSH or the NexRouter **Settings → NetFlow export** panel):

```sh
uci set softflowd.@softflowd[0].enabled=1
uci set softflowd.@softflowd[0].collector=<this-machine-ip>
uci set softflowd.@softflowd[0].port=2056
uci commit softflowd
/etc/init.d/softflowd restart
```

> The collector binds to **127.0.0.1** by default. To receive from the router on
> your LAN you must bind a routable address:
> ```sh
> node collector.mjs listen --bind 0.0.0.0
> ```
> The tool prints a privacy warning when you do this, because flow records are
> traffic metadata and `0.0.0.0` makes the port reachable from the network.
>
> The router side enforces the mirror-image rule: `export_set` **refuses to
> enable export unless a collector address is configured**, so you cannot
> accidentally start streaming flow records toward some default destination.

---

## Commands

| Command | What it does |
|---------|-------------|
| `listen` | Bind a UDP socket and collect NetFlow v5 datagrams (default `127.0.0.1:2056`) |
| `report` | Print a per-host traffic summary table |
| `train` | Train the anomaly-detection and classification models on stored data |
| `score` | Score current data against the trained models |
| `serve` | Start a dependency-free HTTP JSON API (default `127.0.0.1:8080`) |
| `stats` | Print collection statistics |

**Options:** `--port <n>`, `--bind <addr>`, `--data-dir <path>`,
`--retention-days <n>`, `--threshold <f>`, `--delete-raw`.

`nexinsight help` prints the same, plus the router UCI snippet.

### The JSON API (`serve`)

Endpoints, so a dashboard (or the router UI, later) can query results without
shelling out:

- `GET /api/hosts` — per-host aggregates
- `GET /api/conversations` — per-5-tuple conversations
- `GET /api/anomalies` — isolation-forest outliers
- `GET /api/summary` — totals

Binds localhost by default. Exposing it on the LAN requires an explicit
`--bind 0.0.0.0`, which prints a warning.

---

## What the ML actually is

Implemented from scratch, no libraries — see `ml.mjs`.

**Feature extraction** (`extractHostFeatures`) — per host: bytes in/out ratio,
packet-size mean and variance, inter-arrival statistics, destination-port
entropy, protocol distribution, destination fan-out, connection rate, and a
time-of-day activity profile. Each feature's discriminative rationale is
documented inline.

**Anomaly detection** (`trainIsolationForest` / `scoreIsolationForest`) — an
**Isolation Forest** built from scratch. Chosen because it makes no
distributional assumptions, trains fast, and is the right tool when "normal"
traffic is too varied to model with a Gaussian. The path-length math is in the
comments.

**Classification** (`trainClassifier` / `predictClassifier`) — a small
decision-tree ensemble trained from an optional labelled CSV
(`data/labels.csv`: `host,mac,label`). Predicts device class
(phone/laptop/tv/iot/camera/console/printer/speaker/unknown).

> **On honesty:** every model reports its sample size and **warns when the data
> is too small to trust**. A home network has dozens of devices, not thousands;
> a classifier that printed "100% accuracy" on a 12-device training set would be
> reporting overfitting as success. `train`/`score`/`evaluate` split train/test,
> report precision/recall/F1 and a confusion matrix, and refuse to present a
> flattering number from insufficient data. Models persist to versioned JSON.

---

## Storage

Append-only JSONL, no database driver:

```
data/
├── flows-YYYY-MM-DD.jsonl    # raw records, daily rotation
├── summaries/                # compacted per-host daily summaries
└── models/                   # persisted trained models (versioned JSON)
```

`FlowStore` keeps per-host counters and a **bounded LRU** of conversations
(memory-capped — a busy network can produce tens of thousands of 5-tuples).
`compact()` rolls a day's raw JSONL into per-host summaries so raw data can be
pruned; `--retention-days` (default 30) and `--delete-raw` control that.

**Durability note:** `flush()` is `async` and must be awaited. `createWriteStream`
opens the file asynchronously, so a synchronous-looking flush would leave records
buffered and a SIGTERM could truncate the day's file. The collector's shutdown
handler awaits it, which is what makes Ctrl-C safe.

---

## Privacy

Flow records contain source/destination IPs, ports, byte counts and timing. That
is **traffic metadata** (not payload), and it is sensitive. Therefore:

- binds **localhost by default**; `0.0.0.0` requires an explicit flag and warns
- **never transmits anything anywhere** — no telemetry, no cloud, no analytics,
  no update check that identifies your machine
- all data stays in `data/` on the machine you run it on

Keep it on your own network.

---

## Tests

```sh
node --test test/smoke.mjs
```

Covers NetFlow v5 round-trip encode/decode, wrong-version rejection, truncated-
and too-short-datagram handling, the aggregator's per-host counters, the LRU
bound, isolation-forest training with an injected outlier that must be flagged,
classifier training and the too-small-sample warning path, and model
serialisation. (Run against the file directly — `node --test test/` as a
directory glob does not resolve on Windows.)

---

## Licence

MIT — see [`../../LICENSES/MIT.txt`](../../LICENSES/MIT.txt).
