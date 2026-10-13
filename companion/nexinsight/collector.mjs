#!/usr/bin/env node

/**
 * collector.mjs — NexInsight CLI entry point.
 *
 * This is the off-router analysis companion for NexRouter. It collects
 * NetFlow v5 records exported by softflowd on the router, aggregates them,
 * runs anomaly detection and traffic classification, and exposes results
 * via a JSON API for dashboard integration.
 *
 * USAGE:
 *   nexinsight listen [--port 2056] [--bind 127.0.0.1] [--data-dir ./data]
 *   nexinsight report [--data-dir ./data]
 *   nexinsight train  [--data-dir ./data]
 *   nexinsight score  [--data-dir ./data]
 *   nexinsight serve  [--port 8080] [--bind 127.0.0.1] [--data-dir ./data]
 *   nexinsight stats  [--data-dir ./data]
 *
 * PRIVACY:
 *   Flow records contain IP addresses, ports, byte counts and timing.
 *   This is traffic metadata. The collector binds to localhost by default
 *   and NEVER transmits anything externally. There is no telemetry, no
 *   cloud, no analytics. Your data stays on your machine.
 */

import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseNetFlowV5 } from './netflow.mjs';
import { FlowStore } from './store.mjs';
import { extractAllHostFeatures, trainIsolationForest, detectAnomalies, trainClassifier, loadLabels, saveModel, loadModel, scoreIsolationForest, predictClassifier, evaluate } from './ml.mjs';

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args[0] || 'help';
  const opts = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      opts.port = parseInt(args[++i], 10);
    } else if (args[i] === '--bind' && args[i + 1]) {
      opts.bind = args[++i];
    } else if (args[i] === '--data-dir' && args[i + 1]) {
      opts.dataDir = args[++i];
    } else if (args[i] === '--retention-days' && args[i + 1]) {
      opts.retentionDays = parseInt(args[++i], 10);
    } else if (args[i] === '--threshold' && args[i + 1]) {
      opts.threshold = parseFloat(args[++i]);
    } else if (args[i] === '--delete-raw') {
      opts.deleteRaw = true;
    }
  }

  return { subcommand, opts };
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

/**
 * LISTEN — Bind a UDP socket and collect NetFlow v5 datagrams.
 */
async function cmdListen(opts) {
  const port = opts.port || 2056;
  const bind = opts.bind || '127.0.0.1';
  const dataDir = opts.dataDir || join(process.cwd(), 'data');

  // Privacy warning for non-localhost binding
  if (bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost') {
    console.warn(
      `\n⚠️  PRIVACY WARNING: Binding to ${bind} instead of 127.0.0.1.\n` +
      `   Flow data (IP addresses, ports, timing) will be accessible\n` +
      `   from other machines on the network. Only do this if you\n` +
      `   understand the privacy implications.\n`
    );
  }

  const store = new FlowStore({
    dataDir,
    retentionDays: opts.retentionDays,
  });

  // Load historical data into memory
  await store.loadHistory(7);

  const socket = createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    try {
      const parsed = parseNetFlowV5(msg);
      for (const record of parsed.records) {
        store.ingest(record);
      }
      if (parsed.truncated) {
        console.log(`[warn] Truncated datagram from ${rinfo.address}:${rinfo.port}: ${parsed.warning}`);
      }
    } catch (err) {
      store.stats.malformedDatagrams++;
      console.error(`[error] Malformed datagram from ${rinfo.address}:${rinfo.port}: ${err.message}`);
    }
  });

  socket.on('error', (err) => {
    console.error(`[error] UDP socket error: ${err.message}`);
  });

  socket.bind(port, bind, () => {
    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║         NexInsight Flow Collector            ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  Bind address : ${bind.padEnd(29)}║`);
    console.log(`║  Port         : ${String(port).padEnd(29)}║`);
    console.log(`║  Data dir     : ${dataDir.padEnd(29)}║`);
    console.log(`║  Retention    : ${String(store.retentionDays + ' days').padEnd(29)}║`);
    console.log(`║  Conv. cap    : ${String(store.maxConversations).padEnd(29)}║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  Point softflowd at ${bind}:${String(port).padEnd(19)}║`);
    console.log(`║  UCI: uci set softflowd.@softflowd[0].collector=${bind}`);
    console.log(`║       uci set softflowd.@softflowd[0].port=${port}`);
    console.log(`║       uci commit softflowd && /etc/init.d/softflowd restart`);
    console.log(`╚══════════════════════════════════════════════╝`);
    console.log('');
    console.log('[collector] Waiting for NetFlow v5 datagrams...');
  });

  // Graceful shutdown.
  //
  // store.flush() is ASYNC: it resolves only once the write stream has been
  // closed and every buffered record handed to the OS. Awaiting it here is
  // what makes Ctrl-C safe — the old synchronous call returned immediately
  // and then process.exit() could truncate the day's JSONL.
  //
  // `closing` guards against a second SIGINT (an impatient double Ctrl-C)
  // racing the first shutdown and exiting before the flush completes.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n[collector] Shutting down...');

    // Hard deadline: if the flush or socket close wedges (e.g. a full or
    // unresponsive disk), we still exit rather than hanging forever.
    const deadline = setTimeout(() => {
      console.error('[collector] Shutdown timed out; forcing exit.');
      process.exit(1);
    }, 3000);
    deadline.unref();

    try {
      await store.flush();
      console.log(`[collector] Flushed ${store.stats.totalFlowsReceived} flow record(s).`);
    } catch (err) {
      console.error(`[collector] Flush failed: ${err.message}`);
    }

    socket.close(() => {
      console.log('[collector] Socket closed. Goodbye.');
      clearTimeout(deadline);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Periodic stats logging
  setInterval(() => {
    const s = store.getStats();
    console.log(
      `[stats] flows=${s.totalFlowsReceived} bytes=${s.totalBytesObserved} ` +
      `hosts=${s.activeHosts} convos=${s.activeConversations}/${s.maxConversations} ` +
      `malformed=${s.malformedDatagrams}`
    );
  }, 60_000);
}

/**
 * REPORT — Print current aggregation summary as a readable table.
 */
function cmdReport(opts) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data');
  const store = new FlowStore({ dataDir });

  // We need to load history synchronously-ish for reporting
  store.loadHistory(30).then(() => {
    const hosts = store.getHosts().sort((a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut));
    const stats = store.getStats();

    console.log('\n═══ NexInsight Traffic Report ═══\n');
    console.log(`Collection period: ${stats.startTime} → now`);
    console.log(`Total flows: ${stats.totalFlowsReceived}`);
    console.log(`Total bytes: ${(stats.totalBytesObserved / 1e6).toFixed(2)} MB`);
    console.log(`Active hosts: ${stats.activeHosts}`);
    console.log(`Active conversations: ${stats.activeConversations}\n`);

    if (hosts.length === 0) {
      console.log('No host data available. Start the collector and generate some traffic.');
      return;
    }

    // Host table
    console.log('Top hosts by total traffic:');
    console.log('─'.repeat(90));
    console.log(
      'IP Address'.padEnd(18) +
      'Bytes In'.padStart(12) +
      'Bytes Out'.padStart(12) +
      'Pkts In'.padStart(10) +
      'Pkts Out'.padStart(10) +
      'Conns'.padStart(8) +
      'Top Ports'.padStart(20)
    );
    console.log('─'.repeat(90));

    for (const host of hosts.slice(0, 30)) {
      const topPorts = Object.entries(host.portHistogram || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, c]) => `${p}(${c})`)
        .join(', ');

      console.log(
        host.ip.padEnd(18) +
        formatBytes(host.bytesIn).padStart(12) +
        formatBytes(host.bytesOut).padStart(12) +
        String(host.pktsIn).padStart(10) +
        String(host.pktsOut).padStart(10) +
        String(host.connections).padStart(8) +
        topPorts.padStart(20)
      );
    }

    console.log('─'.repeat(90));
    console.log(`Showing ${Math.min(hosts.length, 30)} of ${hosts.length} hosts\n`);
  });
}

/**
 * TRAIN — Run ML training on stored data.
 */
async function cmdTrain(opts) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data');
  const store = new FlowStore({ dataDir });
  await store.loadHistory(30);
  await evaluate(store, dataDir);
}

/**
 * SCORE — Score current data against a trained model.
 */
async function cmdScore(opts) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data');
  const store = new FlowStore({ dataDir });
  await store.loadHistory(30);

  const hosts = store.getHosts();
  if (hosts.length === 0) {
    console.log('No host data available.');
    return;
  }

  const { matrix, labels } = extractAllHostFeatures(hosts);

  // Try isolation forest
  const ifPath = join(dataDir, 'models', 'isolation-forest.json');
  try {
    const ifModel = loadModel(ifPath);
    console.log('\n── Anomaly Scores (Isolation Forest) ──');
    const { allScores } = detectAnomalies(matrix, labels, ifModel, opts.threshold || 0.6);
    for (const s of allScores.slice(0, 20)) {
      const flag = s.score >= (opts.threshold || 0.6) ? ' ⚠️' : '';
      console.log(`  ${s.label.padEnd(18)} ${s.score.toFixed(4)}${flag}`);
    }
  } catch (err) {
    console.log(`No isolation forest model found. Run 'train' first.`);
  }

  // Try classifier
  const clfPath = join(dataDir, 'models', 'classifier.json');
  try {
    const clfModel = loadModel(clfPath);
    console.log('\n── Device Classification ──');
    if (clfModel.sampleWarning) {
      console.log('⚠️  Model was trained on insufficient data. Classifications are unreliable.');
    }
    for (let i = 0; i < Math.min(labels.length, 30); i++) {
      const pred = predictClassifier(matrix[i], clfModel);
      console.log(`  ${labels[i].padEnd(18)} → ${pred}`);
    }
  } catch {
    console.log('No classifier model found. Create labels.csv and run \'train\'.');
  }
}

/**
 * SERVE — HTTP JSON API server for dashboard integration.
 */
async function cmdServe(opts) {
  const port = opts.port || 8080;
  const bind = opts.bind || '127.0.0.1';
  const dataDir = opts.dataDir || join(process.cwd(), 'data');

  if (bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost') {
    console.warn(
      `\n⚠️  PRIVACY WARNING: Exposing API on ${bind}.\n` +
      `   Traffic metadata will be accessible from the network.\n`
    );
  }

  const store = new FlowStore({ dataDir });
  await store.loadHistory(30);

  const server = createServer((req, res) => {
    // CORS headers for local dashboard development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      switch (url.pathname) {
        case '/api/hosts': {
          const hosts = store.getHosts().sort((a, b) =>
            (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut)
          );
          res.end(JSON.stringify({ hosts, count: hosts.length }));
          break;
        }
        case '/api/conversations': {
          const convs = store.getConversations().sort((a, b) =>
            b.bytesFwd - a.bytesFwd
          ).slice(0, 200);
          res.end(JSON.stringify({ conversations: convs, count: convs.length }));
          break;
        }
        case '/api/anomalies': {
          const hosts = store.getHosts();
          const { matrix, labels } = extractAllHostFeatures(hosts);
          const ifPath = join(dataDir, 'models', 'isolation-forest.json');
          try {
            const model = loadModel(ifPath);
            const { anomalies, allScores } = detectAnomalies(matrix, labels, model);
            res.end(JSON.stringify({ anomalies, scores: allScores.slice(0, 50) }));
          } catch {
            res.end(JSON.stringify({ error: 'No anomaly model trained. Run "nexinsight train" first.', anomalies: [] }));
          }
          break;
        }
        case '/api/summary': {
          res.end(JSON.stringify(store.getStats()));
          break;
        }
        default:
          res.statusCode = 404;
          res.end(JSON.stringify({
            error: 'Not found',
            endpoints: ['/api/hosts', '/api/conversations', '/api/anomalies', '/api/summary'],
          }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, bind, () => {
    console.log(`[serve] NexInsight API server listening on http://${bind}:${port}`);
    console.log(`[serve] Endpoints: /api/hosts, /api/conversations, /api/anomalies, /api/summary`);
  });

  // Graceful shutdown — see the identical handler in cmdListen for why
  // flush() must be awaited and why `closing` guards re-entry.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n[serve] Shutting down...');

    const deadline = setTimeout(() => {
      console.error('[serve] Shutdown timed out; forcing exit.');
      process.exit(1);
    }, 3000);
    deadline.unref();

    try {
      await store.flush();
    } catch (err) {
      console.error(`[serve] Flush failed: ${err.message}`);
    }

    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * STATS — Print collection statistics.
 */
async function cmdStats(opts) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data');
  const store = new FlowStore({ dataDir });
  await store.loadHistory(7);
  const stats = store.getStats();

  console.log('\n═══ NexInsight Statistics ═══\n');
  console.log(`Start time       : ${stats.startTime}`);
  console.log(`Total flows      : ${stats.totalFlowsReceived}`);
  console.log(`Total bytes      : ${formatBytes(stats.totalBytesObserved)}`);
  console.log(`Active hosts     : ${stats.activeHosts}`);
  console.log(`Active convos    : ${stats.activeConversations} / ${stats.maxConversations}`);
  console.log(`Malformed DGs    : ${stats.malformedDatagrams}`);
  console.log('');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function printHelp() {
  console.log(`
NexInsight — Off-router analysis companion for NexRouter

USAGE:
  nexinsight <command> [options]

COMMANDS:
  listen   Collect NetFlow v5 datagrams via UDP (default port 2056)
  report   Print traffic summary table
  train    Train anomaly detection and classification models
  score    Score current data against trained models
  serve    Start HTTP JSON API server (default port 8080)
  stats    Print collection statistics

OPTIONS:
  --port <num>          Port number (listen: 2056, serve: 8080)
  --bind <addr>         Bind address (default: 127.0.0.1)
  --data-dir <path>     Data directory (default: ./data)
  --retention-days <n>  Raw data retention in days (default: 30)
  --threshold <f>       Anomaly score threshold (default: 0.6)
  --delete-raw          Delete raw JSONL after compaction

EXAMPLES:
  nexinsight listen                          # Start collecting on 127.0.0.1:2056
  nexinsight listen --bind 0.0.0.0           # Accept from LAN (with warning)
  nexinsight listen --port 9995              # Custom port
  nexinsight report                          # Show traffic summary
  nexinsight train                           # Train ML models
  nexinsight serve                           # Start API on 127.0.0.1:8080
  nexinsight serve --bind 0.0.0.0 --port 80  # Expose on LAN

ROUTER CONFIGURATION (OpenWrt UCI):
  uci set softflowd.@softflowd[0].enabled=1
  uci set softflowd.@softflowd[0].collector=<this-machine-ip>
  uci set softflowd.@softflowd[0].port=2056
  uci commit softflowd
  /etc/init.d/softflowd restart

PRIVACY:
  Flow records contain IP addresses, ports, byte counts and timing.
  This is traffic metadata — not payload content. The collector binds
  to localhost by default and NEVER transmits data externally.
  There is no telemetry, no cloud, no analytics.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const { subcommand, opts } = parseArgs(process.argv);

switch (subcommand) {
  case 'listen':
    cmdListen(opts);
    break;
  case 'report':
    cmdReport(opts);
    break;
  case 'train':
    cmdTrain(opts);
    break;
  case 'score':
    cmdScore(opts);
    break;
  case 'serve':
    cmdServe(opts);
    break;
  case 'stats':
    cmdStats(opts);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${subcommand}`);
    printHelp();
    process.exitCode = 1;
}
