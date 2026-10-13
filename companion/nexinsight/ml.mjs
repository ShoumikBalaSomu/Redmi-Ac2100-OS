/**
 * ml.mjs — Machine learning for NexInsight (off-router analysis companion).
 *
 * WHY ML LIVES HERE AND NOT ON THE ROUTER:
 *   The Xiaomi Redmi AC2100 runs a MediaTek MT7621 SoC: dual-core MIPS 1004Kc
 *   at 880 MHz with NO floating-point unit, NO SIMD instructions, and NO NPU.
 *   It has 128 MiB of RAM shared between the OS, forwarding plane, and all
 *   user-space processes. Both cores are busy forwarding packets at line rate.
 *
 *   Even classical ML is not viable on this hardware at line rate:
 *   - Per-flow feature extraction at 500 Mbps would cost ~30-50% of one core
 *   - Model inference per flow would add latency to the forwarding path
 *   - Training data accumulation would consume 20-40 MB of precious RAM
 *   - Soft-float arithmetic makes even simple math 10-50x slower than on x86/ARM
 *
 *   So NexRouter uses a split architecture: the router runs cheap deterministic
 *   heuristics (OUI lookup, DHCP inventory, EWMA baselines in fixed-point int)
 *   and exports NetFlow v5 via softflowd (~2-5% CPU). The real analysis happens
 *   HERE, on whatever machine has spare cycles — a Raspberry Pi, NAS, laptop,
 *   or cloud VM. This is what network operators actually do.
 *
 * WHAT THIS MODULE PROVIDES:
 *   (a) Feature extraction from aggregated flow data
 *   (b) Unsupervised anomaly detection (Isolation Forest, implemented from scratch)
 *   (c) Supervised traffic classification (Decision Tree, implemented from scratch)
 *   (d) Honest evaluation that warns when sample sizes are too small
 *
 * All algorithms are implemented from scratch with zero dependencies.
 * Models are serializable to/from JSON with versioned format.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt, randomBytes } from 'node:crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL_FORMAT_VERSION = 1;
const MIN_TRAINING_SAMPLES = 20;      // Below this, warn about reliability
const MIN_CLASSIFICATION_SAMPLES = 30; // Below this, classifier is unreliable
const DEFAULT_N_TREES = 100;          // Isolation forest ensemble size
const DEFAULT_SAMPLE_SIZE = 256;      // Subsample size for each isolation tree
const MAX_TREE_DEPTH = 15;            // Max depth for isolation trees
const MIN_SAMPLES_FOR_SPLIT = 5;      // Min samples to attempt a tree split

// ─── Feature Extraction ──────────────────────────────────────────────────────

/**
 * Extract a feature vector from a host's aggregated flow data.
 *
 * Each feature is chosen to be discriminative for device-type classification
 * and anomaly detection. We document the rationale for each:
 *
 * @param {object} host - Host aggregation object from store.mjs
 * @returns {{ features: number[], featureNames: string[] }}
 *
 * FEATURE RATIONALE:
 *   1. bytesRatio       — bytesOut / (bytesIn + bytesOut). Servers and cameras
 *                         have high outbound ratios; clients have low. Range [0,1].
 *   2. avgPacketSize    — Total bytes / total packets. IoT devices send tiny
 *                         packets; video streams send large ones. Discriminates
 *                         device class strongly.
 *   3. connectionRate   — Connections per hour. Chatty IoT vs. bursty laptops.
 *   4. uniqueDstPorts   — Number of distinct destination ports contacted.
 *                         Browsers hit many ports; IoT hits few. Proxy for
 *                         behavioral complexity.
 *   5. portEntropy      — Shannon entropy of destination port distribution.
 *                         High entropy = diverse services (laptop); low = single
 *                         service (IoT sensor, printer). More robust than raw count.
 *   6. tcpFraction      — Fraction of connections using TCP. Distinguishes
 *                         streaming/browsing (TCP-heavy) from DNS/NTP (UDP).
 *   7. udpFraction      — Fraction using UDP. Complement of above.
 *   8. topPortShare     — Fraction of connections to the single most-used port.
 *                         Single-purpose devices have high share; general-purpose
 *                         devices have low.
 *   9. pktsPerConn      — Average packets per connection. Long-lived streams
 *                         vs. short request-response patterns.
 *  10. activitySpanHrs  — Hours between first and last seen. Always-on devices
 *                         vs. intermittent ones.
 */
export function extractHostFeatures(host) {
  const totalBytes = host.bytesIn + host.bytesOut;
  const totalPkts = host.pktsIn + host.pktsOut;
  const conns = host.connections || 1;

  // 1. Bytes ratio (outbound fraction)
  const bytesRatio = totalBytes > 0 ? host.bytesOut / totalBytes : 0.5;

  // 2. Average packet size
  const avgPacketSize = totalPkts > 0 ? totalBytes / totalPkts : 0;

  // 3. Connection rate (connections per hour)
  let activitySpanHrs = 0;
  if (host.firstSeen && host.lastSeen) {
    const first = new Date(host.firstSeen).getTime();
    const last = new Date(host.lastSeen).getTime();
    activitySpanHrs = Math.max((last - first) / 3600000, 0.01); // min 36 seconds
  }
  const connectionRate = conns / Math.max(activitySpanHrs, 0.01);

  // 4 & 5. Port histogram analysis
  const portHist = host.portHistogram || {};
  const portEntries = Object.entries(portHist).map(([p, c]) => ({ port: Number(p), count: c }));
  const uniqueDstPorts = portEntries.length;

  // Port entropy: H = -Σ p(x) log2(p(x))
  const totalPortConns = portEntries.reduce((s, e) => s + e.count, 0) || 1;
  let portEntropy = 0;
  let topPortCount = 0;
  for (const entry of portEntries) {
    const p = entry.count / totalPortConns;
    if (p > 0) {
      portEntropy -= p * Math.log2(p);
    }
    if (entry.count > topPortCount) {
      topPortCount = entry.count;
    }
  }

  // 8. Top port share
  const topPortShare = totalPortConns > 0 ? topPortCount / totalPortConns : 0;

  // 6 & 7. Protocol fractions
  const protoHist = host.protoHistogram || {};
  const tcpConns = protoHist['TCP'] || 0;
  const udpConns = protoHist['UDP'] || 0;
  const tcpFraction = tcpConns / conns;
  const udpFraction = udpConns / conns;

  // 9. Packets per connection
  const pktsPerConn = totalPkts / conns;

  const features = [
    bytesRatio,
    avgPacketSize,
    connectionRate,
    uniqueDstPorts,
    portEntropy,
    tcpFraction,
    udpFraction,
    topPortShare,
    pktsPerConn,
    activitySpanHrs,
  ];

  const featureNames = [
    'bytesRatio',
    'avgPacketSize',
    'connectionRate',
    'uniqueDstPorts',
    'portEntropy',
    'tcpFraction',
    'udpFraction',
    'topPortShare',
    'pktsPerConn',
    'activitySpanHrs',
  ];

  return { features, featureNames };
}

/**
 * Extract features for ALL hosts in the store.
 * @param {object[]} hosts - Array of host aggregation objects
 * @returns {{ matrix: number[][], names: string[], labels: string[] }}
 */
export function extractAllHostFeatures(hosts) {
  const matrix = [];
  const labels = [];
  let names = null;

  for (const host of hosts) {
    const { features, featureNames } = extractHostFeatures(host);
    matrix.push(features);
    labels.push(host.ip);
    if (!names) names = featureNames;
  }

  return { matrix, names: names || [], labels };
}

// ─── Isolation Forest ────────────────────────────────────────────────────────

/**
 * ISOLATION FOREST — Unsupervised Anomaly Detection
 *
 * ALGORITHM OVERVIEW:
 *   An isolation forest detects anomalies by exploiting the fact that outliers
 *   are "few and different" — they can be isolated with fewer random splits
 *   than normal points.
 *
 *   For each tree in the ensemble:
 *     1. Sample `sampleSize` points from the dataset (without replacement)
 *     2. Build a binary tree by repeatedly:
 *        a. Choosing a random feature dimension
 *        b. Choosing a random split value between min and max of that feature
 *        c. Splitting points into left (< splitVal) and right (>= splitVal)
 *        d. Recursing until a node has 1 point, 0 points, or max depth
 *     3. Record the depth at which each point is isolated
 *
 *   ANOMALY SCORE:
 *     For each point x, compute the average path length h(x) across all trees.
 *     Normalize using the expected path length c(n) of a BST built from n items:
 *
 *       c(n) = 2 * H(n-1) - 2*(n-1)/n
 *
 *     where H(i) ≈ ln(i) + 0.5772156649 (Euler-Mascheroni constant γ).
 *
 *     The anomaly score is:
 *       s(x, n) = 2^(-h(x) / c(n))
 *
 *     Score interpretation:
 *       s ≈ 1.0  → definitely anomalous (isolated very quickly)
 *       s ≈ 0.5  → normal
 *       s < 0.5  → very normal (took many splits to isolate)
 *
 *   REFERENCES:
 *     Liu, Ting & Zhou (2008). "Isolation Forest". ICDM.
 *     https://cs.nju.edu.cn/zhouzh/zhouzh.files/publication/icdm08b.pdf
 *
 * IMPLEMENTATION NOTES:
 *   - We build explicit tree nodes rather than computing path lengths during
 *     construction, so we can score new points without rebuilding.
 *   - Random number generation uses Node's crypto.randomInt for uniformity.
 *   - The model is fully serializable to JSON.
 */

/**
 * Compute c(n): the average path length of unsuccessful search in BST.
 * This is the normalization factor for anomaly scores.
 *
 * c(n) = 2*H(n-1) - 2*(n-1)/n
 * H(i) = ln(i) + γ (harmonic number approximation)
 * γ ≈ 0.5772156649 (Euler-Mascheroni constant)
 *
 * @param {number} n - Number of samples
 * @returns {number}
 */
function averagePathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  const gamma = 0.5772156649;
  const h = Math.log(n - 1) + gamma;
  return 2 * h - 2 * (n - 1) / n;
}

/**
 * Build a single isolation tree node.
 *
 * @param {number[][]} data - Subset of feature vectors
 * @param {number} depth - Current depth
 * @param {number} maxDepth - Maximum tree depth
 * @returns {object} Tree node
 */
function buildIsolationTree(data, depth, maxDepth) {
  const n = data.length;

  // Terminal conditions
  if (n <= 1 || depth >= maxDepth) {
    return { type: 'leaf', size: n, depth };
  }

  // Check if all points are identical (no valid split possible)
  const nFeatures = data[0].length;

  // Choose a random feature
  let featIdx = randomInt(0, nFeatures);
  let minVal = Infinity;
  let maxVal = -Infinity;

  // Find min/max of chosen feature
  for (let i = 0; i < n; i++) {
    const v = data[i][featIdx];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  // If all values are the same on this feature, try others
  if (minVal === maxVal) {
    let found = false;
    for (let f = 0; f < nFeatures; f++) {
      if (f === featIdx) continue;
      minVal = Infinity;
      maxVal = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = data[i][f];
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
      if (minVal !== maxVal) {
        featIdx = f;
        found = true;
        break;
      }
    }
    if (!found) {
      // All features are constant — this is a leaf
      return { type: 'leaf', size: n, depth };
    }
  }

  // Random split value between min and max
  const splitVal = minVal + Math.random() * (maxVal - minVal);

  // Partition
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    if (data[i][featIdx] < splitVal) {
      left.push(data[i]);
    } else {
      right.push(data[i]);
    }
  }

  return {
    type: 'split',
    featIdx,
    splitVal,
    left: buildIsolationTree(left, depth + 1, maxDepth),
    right: buildIsolationTree(right, depth + 1, maxDepth),
  };
}

/**
 * Compute the path length for a single point through an isolation tree.
 *
 * @param {number[]} point - Feature vector
 * @param {object} node - Tree node
 * @param {number} depth - Current depth
 * @returns {number} Path length (depth + adjustment for leaf size)
 */
function pathLength(point, node, depth) {
  if (node.type === 'leaf') {
    // Add c(node.size) as adjustment for unbuilt subtree
    return depth + averagePathLength(node.size);
  }

  if (point[node.featIdx] < node.splitVal) {
    return pathLength(point, node.left, depth + 1);
  } else {
    return pathLength(point, node.right, depth + 1);
  }
}

/**
 * Train an Isolation Forest model.
 *
 * @param {number[][]} data - Feature matrix (rows = samples, cols = features)
 * @param {object} [opts] - Options
 * @returns {object} Trained model (serializable to JSON)
 */
export function trainIsolationForest(data, opts = {}) {
  const nTrees = opts.nTrees || DEFAULT_N_TREES;
  const sampleSize = Math.min(opts.sampleSize || DEFAULT_SAMPLE_SIZE, data.length);
  const maxDepth = opts.maxDepth || Math.ceil(Math.log2(sampleSize)) + 2;

  console.log(`[isolation-forest] Training with ${nTrees} trees, sample size ${sampleSize}, max depth ${maxDepth}`);
  console.log(`[isolation-forest] Dataset: ${data.length} samples × ${data[0]?.length || 0} features`);

  if (data.length < MIN_TRAINING_SAMPLES) {
    console.warn(
      `[isolation-forest] WARNING: Only ${data.length} samples available. ` +
      `Minimum recommended is ${MIN_TRAINING_SAMPLES}. ` +
      `Anomaly scores may be unreliable.`
    );
  }

  const trees = [];
  const effectiveMaxDepth = Math.min(maxDepth, MAX_TREE_DEPTH);

  for (let t = 0; t < nTrees; t++) {
    // Subsample without replacement
    const indices = [];
    const used = new Set();
    while (indices.length < sampleSize && indices.length < data.length) {
      const idx = randomInt(0, data.length);
      if (!used.has(idx)) {
        used.add(idx);
        indices.push(idx);
      }
    }
    const subsample = indices.map(i => data[i]);
    trees.push(buildIsolationTree(subsample, 0, effectiveMaxDepth));
  }

  const model = {
    type: 'isolation-forest',
    formatVersion: MODEL_FORMAT_VERSION,
    nTrees,
    sampleSize,
    maxDepth: effectiveMaxDepth,
    nSamples: data.length,
    nFeatures: data[0]?.length || 0,
    trainedAt: new Date().toISOString(),
    trees,
  };

  console.log(`[isolation-forest] Training complete. ${nTrees} trees built.`);
  return model;
}

/**
 * Score a single point against a trained isolation forest.
 *
 * @param {number[]} point - Feature vector
 * @param {object} model - Trained isolation forest model
 * @returns {number} Anomaly score in [0, 1]. Higher = more anomalous.
 */
export function scoreIsolationForest(point, model) {
  const n = model.sampleSize;
  const c = averagePathLength(n);

  if (c === 0) return 0.5; // Degenerate case

  let totalPath = 0;
  for (const tree of model.trees) {
    totalPath += pathLength(point, tree, 0);
  }

  const avgPath = totalPath / model.nTrees;

  // s(x, n) = 2^(-E[h(x)] / c(n))
  const score = Math.pow(2, -avgPath / c);
  return score;
}

/**
 * Score all points and return sorted anomalies.
 *
 * @param {number[][]} data - Feature matrix
 * @param {string[]} labels - Point labels (e.g., IP addresses)
 * @param {object} model - Trained model
 * @param {number} [threshold=0.6] - Score above which a point is anomalous
 * @returns {{ anomalies: object[], allScores: object[] }}
 */
export function detectAnomalies(data, labels, model, threshold = 0.6) {
  const allScores = data.map((point, i) => ({
    label: labels[i],
    score: scoreIsolationForest(point, model),
    index: i,
  }));

  allScores.sort((a, b) => b.score - a.score);

  const anomalies = allScores.filter(s => s.score >= threshold);

  return { anomalies, allScores };
}

// ─── Decision Tree Classifier ────────────────────────────────────────────────

/**
 * DECISION TREE CLASSIFIER — Supervised Traffic Classification
 *
 * A simple CART-style decision tree using Gini impurity for splits.
 * Designed for classifying network hosts into device categories:
 *   phone, laptop, tv, iot, camera, console, printer, speaker, unknown
 *
 * HONESTY NOTE:
 *   With typical home-network sample sizes (dozens of devices), any
 *   classifier will overfit. A 12-device training set cannot produce
 *   a meaningful accuracy number. This implementation:
 *   - Warns explicitly when sample size is below MIN_CLASSIFICATION_SAMPLES
 *   - Reports actual sample size alongside metrics
 *   - Uses train/test split to give at least some generalization signal
 *   - Prints confusion matrix so you can see WHERE it fails
 *   - Does NOT report flattering accuracy from tiny datasets
 *
 * GINI IMPURITY:
 *   For a node with class distribution {c1: n1, c2: n2, ...}:
 *     Gini = 1 - Σ (ni/N)²
 *   A pure node (all one class) has Gini = 0.
 *   We choose the split that maximizes the weighted Gini reduction.
 */

/**
 * Compute Gini impurity of a label array.
 * @param {string[]} labels
 * @returns {number}
 */
function giniImpurity(labels) {
  if (labels.length === 0) return 0;
  const counts = {};
  for (const l of labels) {
    counts[l] = (counts[l] || 0) + 1;
  }
  const n = labels.length;
  let sumSq = 0;
  for (const c of Object.values(counts)) {
    sumSq += (c / n) ** 2;
  }
  return 1 - sumSq;
}

/**
 * Find the best binary split for a dataset.
 * Tests all features × all unique thresholds.
 *
 * @param {number[][]} data - Feature matrix
 * @param {string[]} labels - Class labels
 * @returns {{ featIdx: number, threshold: number, gain: number } | null}
 */
function findBestSplit(data, labels) {
  const n = data.length;
  const nFeatures = data[0].length;
  const parentGini = giniImpurity(labels);

  let bestGain = 0;
  let bestFeat = -1;
  let bestThresh = 0;

  for (let f = 0; f < nFeatures; f++) {
    // Get unique values for this feature
    const values = [...new Set(data.map(row => row[f]))].sort((a, b) => a - b);

    // Try midpoints between consecutive unique values as thresholds
    for (let i = 0; i < values.length - 1; i++) {
      const thresh = (values[i] + values[i + 1]) / 2;

      const leftLabels = [];
      const rightLabels = [];
      for (let j = 0; j < n; j++) {
        if (data[j][f] < thresh) {
          leftLabels.push(labels[j]);
        } else {
          rightLabels.push(labels[j]);
        }
      }

      if (leftLabels.length === 0 || rightLabels.length === 0) continue;

      const leftGini = giniImpurity(leftLabels);
      const rightGini = giniImpurity(rightLabels);
      const weightedGini =
        (leftLabels.length / n) * leftGini +
        (rightLabels.length / n) * rightGini;
      const gain = parentGini - weightedGini;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeat = f;
        bestThresh = thresh;
      }
    }
  }

  if (bestFeat === -1 || bestGain < 1e-10) return null;
  return { featIdx: bestFeat, threshold: bestThresh, gain: bestGain };
}

/**
 * Build a decision tree recursively.
 *
 * @param {number[][]} data
 * @param {string[]} labels
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {object} Tree node
 */
function buildDecisionTree(data, labels, depth, maxDepth) {
  const n = data.length;

  // Count classes
  const classCounts = {};
  for (const l of labels) {
    classCounts[l] = (classCounts[l] || 0) + 1;
  }

  // Majority class
  let majorityClass = labels[0];
  let maxCount = 0;
  for (const [cls, cnt] of Object.entries(classCounts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      majorityClass = cls;
    }
  }

  // Terminal conditions
  if (n < MIN_SAMPLES_FOR_SPLIT || depth >= maxDepth || Object.keys(classCounts).length === 1) {
    return { type: 'leaf', class: majorityClass, counts: classCounts, n };
  }

  // Find best split
  const split = findBestSplit(data, labels);
  if (!split) {
    return { type: 'leaf', class: majorityClass, counts: classCounts, n };
  }

  // Partition
  const leftData = [];
  const leftLabels = [];
  const rightData = [];
  const rightLabels = [];

  for (let i = 0; i < n; i++) {
    if (data[i][split.featIdx] < split.threshold) {
      leftData.push(data[i]);
      leftLabels.push(labels[i]);
    } else {
      rightData.push(data[i]);
      rightLabels.push(labels[i]);
    }
  }

  return {
    type: 'split',
    featIdx: split.featIdx,
    threshold: split.threshold,
    gain: split.gain,
    left: buildDecisionTree(leftData, leftLabels, depth + 1, maxDepth),
    right: buildDecisionTree(rightData, rightLabels, depth + 1, maxDepth),
  };
}

/**
 * Predict class for a single point.
 * @param {number[]} point
 * @param {object} tree
 * @returns {string}
 */
function predictTree(point, tree) {
  if (tree.type === 'leaf') return tree.class;
  if (point[tree.featIdx] < tree.threshold) {
    return predictTree(point, tree.left);
  } else {
    return predictTree(point, tree.right);
  }
}

/**
 * Train a decision tree classifier.
 *
 * @param {number[][]} data - Feature matrix
 * @param {string[]} labels - Class labels
 * @param {object} [opts]
 * @returns {object} Trained model with evaluation metrics
 */
export function trainClassifier(data, labels, opts = {}) {
  const testSplit = opts.testSplit || 0.2;
  const maxDepth = opts.maxDepth || 8;

  const n = data.length;
  const sampleWarning = n < MIN_CLASSIFICATION_SAMPLES;

  if (sampleWarning) {
    console.warn(
      `\n⚠️  CLASSIFIER WARNING: Only ${n} labelled samples available.\n` +
      `   Minimum recommended: ${MIN_CLASSIFICATION_SAMPLES}.\n` +
      `   Results are likely overfit and should NOT be trusted for production.\n` +
      `   Collect more labelled data before relying on classifications.\n`
    );
  }

  // Train/test split (stratified by class)
  const classIndices = {};
  for (let i = 0; i < n; i++) {
    if (!classIndices[labels[i]]) classIndices[labels[i]] = [];
    classIndices[labels[i]].push(i);
  }

  const trainIdx = [];
  const testIdx = [];
  for (const indices of Object.values(classIndices)) {
    // Shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const nTest = Math.max(1, Math.round(indices.length * testSplit));
    for (let i = 0; i < indices.length; i++) {
      if (i < nTest) {
        testIdx.push(indices[i]);
      } else {
        trainIdx.push(indices[i]);
      }
    }
  }

  const trainData = trainIdx.map(i => data[i]);
  const trainLabels = trainIdx.map(i => labels[i]);
  const testData = testIdx.map(i => data[i]);
  const testLabels = testIdx.map(i => labels[i]);

  console.log(`[classifier] Training: ${trainData.length} samples, Test: ${testData.length} samples`);
  console.log(`[classifier] Classes: ${Object.keys(classIndices).join(', ')}`);

  const tree = buildDecisionTree(trainData, trainLabels, 0, maxDepth);

  // Evaluate on test set
  const predictions = testData.map(p => predictTree(p, tree));
  const metrics = computeMetrics(testLabels, predictions, Object.keys(classIndices));

  const model = {
    type: 'decision-tree',
    formatVersion: MODEL_FORMAT_VERSION,
    tree,
    nTrainingSamples: trainData.length,
    nTestSamples: testData.length,
    classes: Object.keys(classIndices),
    trainedAt: new Date().toISOString(),
    metrics,
    sampleWarning,
  };

  // Print evaluation
  printEvaluation(metrics, model);

  return model;
}

/**
 * Predict using a trained classifier.
 * @param {number[]} point
 * @param {object} model
 * @returns {string}
 */
export function predictClassifier(point, model) {
  return predictTree(point, model.tree);
}

// ─── Evaluation Metrics ──────────────────────────────────────────────────────

/**
 * Compute precision, recall, F1 per class and overall accuracy.
 */
function computeMetrics(actual, predicted, classes) {
  const n = actual.length;
  let correct = 0;

  // Confusion matrix: confusion[actual][predicted] = count
  const confusion = {};
  for (const c of classes) {
    confusion[c] = {};
    for (const c2 of classes) {
      confusion[c][c2] = 0;
    }
  }

  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const p = predicted[i];
    if (a === p) correct++;
    if (confusion[a] && confusion[a][p] !== undefined) {
      confusion[a][p]++;
    }
  }

  const perClass = {};
  for (const cls of classes) {
    let tp = confusion[cls]?.[cls] || 0;
    let fp = 0;
    let fn = 0;
    for (const c2 of classes) {
      if (c2 !== cls) {
        fp += confusion[c2]?.[cls] || 0;
        fn += confusion[cls]?.[c2] || 0;
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass[cls] = { tp, fp, fn, precision, recall, f1 };
  }

  return {
    accuracy: n > 0 ? correct / n : 0,
    n,
    perClass,
    confusion,
  };
}

/**
 * Print honest evaluation metrics.
 */
function printEvaluation(metrics, model) {
  console.log('\n═══ Classifier Evaluation ═══');
  console.log(`Samples: ${model.nTrainingSamples} train + ${model.nTestSamples} test = ${model.nTrainingSamples + model.nTestSamples} total`);

  if (model.sampleWarning) {
    console.log('⚠️  SAMPLE SIZE TOO SMALL — metrics below are unreliable.');
  }

  console.log(`Overall accuracy: ${(metrics.accuracy * 100).toFixed(1)}% (${Math.round(metrics.accuracy * metrics.n)}/${metrics.n})`);
  console.log('');

  // Per-class metrics
  console.log('Per-class metrics:');
  console.log('  Class          Precision  Recall  F1');
  for (const [cls, m] of Object.entries(metrics.perClass)) {
    console.log(
      `  ${cls.padEnd(14)} ${m.precision.toFixed(3).padStart(8)}  ${m.recall.toFixed(3).padStart(6)}  ${m.f1.toFixed(3).padStart(5)}`
    );
  }

  // Confusion matrix
  console.log('\nConfusion matrix (rows=actual, cols=predicted):');
  const classes = Object.keys(metrics.confusion);
  const header = '              ' + classes.map(c => c.slice(0, 8).padStart(9)).join('');
  console.log(header);
  for (const actual of classes) {
    const row = `  ${actual.padEnd(12)}` + classes.map(pred =>
      String(metrics.confusion[actual]?.[pred] || 0).padStart(9)
    ).join('');
    console.log(row);
  }
  console.log('');
}

// ─── Model Persistence ───────────────────────────────────────────────────────

/**
 * Save a model to disk as JSON.
 * @param {object} model - Trained model object
 * @param {string} filePath - Output path
 */
export function saveModel(model, filePath) {
  writeFileSync(filePath, JSON.stringify(model, null, 2));
  console.log(`[ml] Model saved to ${filePath}`);
}

/**
 * Load a model from disk.
 * @param {string} filePath
 * @returns {object}
 */
export function loadModel(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Model file not found: ${filePath}`);
  }
  const model = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!model.formatVersion || model.formatVersion !== MODEL_FORMAT_VERSION) {
    throw new Error(
      `Model format version mismatch: expected ${MODEL_FORMAT_VERSION}, ` +
      `got ${model.formatVersion || 'none'}. Retrain the model.`
    );
  }
  return model;
}

// ─── CSV Label Loading ───────────────────────────────────────────────────────

/**
 * Load labels from a CSV file (data/labels.csv).
 * Format: host,mac,label (one per line, header required).
 *
 * @param {string} csvPath
 * @returns {Map<string, string>} Map from IP (or MAC) to label
 */
export function loadLabels(csvPath) {
  if (!existsSync(csvPath)) {
    return new Map();
  }
  const content = readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const labels = new Map();

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim());
    if (parts.length >= 3) {
      // Use host (IP) as key; MAC is optional enrichment
      labels.set(parts[0], parts[2]);
      if (parts[1]) {
        labels.set(parts[1], parts[2]); // Also map by MAC
      }
    }
  }

  return labels;
}

// ─── Evaluate Mode ───────────────────────────────────────────────────────────

/**
 * Run full evaluation pipeline: load data, extract features, train, evaluate.
 * Prints honest metrics and warns when data is insufficient.
 *
 * @param {object} store - FlowStore instance
 * @param {string} dataDir - Data directory path
 */
export async function evaluate(store, dataDir) {
  console.log('\n═══ NexInsight ML Evaluation ═══\n');

  const hosts = store.getHosts();
  if (hosts.length === 0) {
    console.log('No host data available. Run the collector first to gather flow data.');
    return;
  }

  console.log(`Found ${hosts.length} hosts in aggregated data.\n`);

  // ── Feature extraction ─────────────────────────────────────────────────
  const { matrix, names, labels } = extractAllHostFeatures(hosts);
  console.log(`Extracted ${names.length} features for ${matrix.length} hosts.`);
  console.log(`Features: ${names.join(', ')}\n`);

  // ── Anomaly detection ──────────────────────────────────────────────────
  console.log('── Anomaly Detection (Isolation Forest) ──');
  if (matrix.length < MIN_TRAINING_SAMPLES) {
    console.log(
      `⚠️  Only ${matrix.length} hosts available for anomaly detection.\n` +
      `   Need at least ${MIN_TRAINING_SAMPLES} for reliable results.\n` +
      `   Skipping anomaly detection.\n`
    );
  } else {
    const ifModel = trainIsolationForest(matrix);
    const { anomalies, allScores } = detectAnomalies(matrix, labels, ifModel);
    console.log(`\nTop anomalies:`);
    for (const a of allScores.slice(0, 10)) {
      const flag = a.score >= 0.6 ? ' ⚠️ ANOMALY' : '';
      console.log(`  ${a.label.padEnd(18)} score=${a.score.toFixed(4)}${flag}`);
    }
    console.log(`\nTotal anomalies (score ≥ 0.6): ${anomalies.length}/${allScores.length}\n`);

    // Save model
    saveModel(ifModel, join(dataDir, 'models', 'isolation-forest.json'));
  }

  // ── Classification ─────────────────────────────────────────────────────
  console.log('── Traffic Classification (Decision Tree) ──');
  const labelMap = loadLabels(join(dataDir, 'labels.csv'));
  const labelledIndices = [];
  const labelledFeatures = [];
  const labelledLabels = [];

  for (let i = 0; i < labels.length; i++) {
    const label = labelMap.get(labels[i]);
    if (label) {
      labelledIndices.push(i);
      labelledFeatures.push(matrix[i]);
      labelledLabels.push(label);
    }
  }

  if (labelledFeatures.length === 0) {
    console.log(
      'No labelled data found. Create data/labels.csv with columns:\n' +
      '  host,mac,label\n' +
      'See data/labels.csv.example for format.\n' +
      'Unsupervised anomaly detection works without labels.\n'
    );
  } else {
    const clfModel = trainClassifier(labelledFeatures, labelledLabels);
    saveModel(clfModel, join(dataDir, 'models', 'classifier.json'));
  }

  console.log('═══ Evaluation Complete ═══\n');
}
