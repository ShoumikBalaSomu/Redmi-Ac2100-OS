/**
 * chart.js — dependency-free canvas sparklines
 * =============================================
 * A telemetry dashboard wants small trend charts. Every charting library that
 * could draw them weighs more than this entire UI, and would need parsing on a
 * device with 128 MiB of RAM shared with the network stack. So: ~120 lines of
 * canvas.
 *
 * These are sparklines, not analytical charts. They answer "is this going up
 * or down, and is it stable?" — which is the question that actually matters
 * when watching a router. Anything needing axes and tooltips belongs in the
 * off-router companion (companion/nexinsight), which has the CPU for it.
 *
 * The canvas is redrawn on devicePixelRatio so lines stay crisp on HiDPI
 * displays, and drawing is throttled by the caller's poll interval rather than
 * by requestAnimationFrame — there is no reason to burn cycles animating a
 * value that updates every few seconds.
 */

/**
 * Draw a line sparkline with an optional filled area.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values      series, oldest first
 * @param {object} [opts]
 * @param {string} [opts.color]      stroke colour (CSS)
 * @param {string} [opts.fill]       area fill colour, or null for none
 * @param {number|null} [opts.max]   fixed upper bound; auto-scaled when null
 * @param {boolean} [opts.showLast]  draw a dot on the most recent sample
 */
export function sparkline(canvas, values, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const css = getComputedStyle(canvas);
  // Parentheses are required: mixing `??` and `||` without them is a syntax
  // error in JavaScript, not merely a precedence question. The intent is
  // "explicit option wins, else the theme variable, else a hardcoded fallback".
  const color = opts.color ?? (css.getPropertyValue('--acc').trim() || '#4d9fff');
  const fill = opts.fill ?? null;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, canvas.clientWidth || canvas.width || 200);
  const hh = Math.max(1, canvas.clientHeight || canvas.height || 56);

  // Re-size only when it actually changed: setting canvas.width clears it and
  // is not free, and this runs on every poll.
  const bw = Math.round(w * dpr), bh = Math.round(hh * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);

  const data = (Array.isArray(values) ? values : [])
    .map(v => (Number.isFinite(v) ? v : 0));
  if (data.length < 2) {
    drawBaseline(ctx, w, hh, color);
    return;
  }

  const max = opts.max !== undefined && opts.max !== null
    ? Math.max(opts.max, 1e-9)
    : Math.max(...data, 1e-9);
  const min = 0;
  const pad = 2;
  const innerH = hh - pad * 2;

  // x position for sample i. The series may be shorter than the canvas is
  // wide; we always span the full width using the actual sample count so the
  // trend stays readable during warm-up.
  const x = (i) => (i / (data.length - 1)) * (w - pad * 2) + pad;
  const y = (v) => hh - pad - ((v - min) / (max - min)) * innerH;

  // Area fill
  if (fill) {
    ctx.beginPath();
    ctx.moveTo(x(0), hh - pad);
    for (let i = 0; i < data.length; i++) ctx.lineTo(x(i), y(data[i]));
    ctx.lineTo(x(data.length - 1), hh - pad);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // Line
  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Leading dot marks "now", which stops a flat line looking like a dead feed.
  if (opts.showLast !== false) {
    const lx = x(data.length - 1), ly = y(data[data.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Faint mid-line so an all-zero series is visibly "no data", not a flatline. */
function drawBaseline(ctx, w, hh, color) {
  ctx.beginPath();
  ctx.moveTo(2, hh / 2);
  ctx.lineTo(w - 2, hh / 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/**
 * Draw a set of horizontal per-core bars.
 * Canvas rather than DOM because it is one element and one draw call instead
 * of N nodes being re-laid-out on every poll.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{id:string,pct:number}>} cores
 */
export function coreBars(canvas, cores) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const css = getComputedStyle(canvas);
  const track = css.getPropertyValue('--bg-sunken').trim() || '#0d1117';
  const acc = css.getPropertyValue('--acc').trim() || '#4d9fff';
  const warn = css.getPropertyValue('--warn').trim() || '#f5a524';
  const err = css.getPropertyValue('--err').trim() || '#f4585f';
  const dim = css.getPropertyValue('--fg-dim').trim() || '#8b97a8';

  const list = Array.isArray(cores) ? cores : [];
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rowH = 20;
  const w = Math.max(1, canvas.clientWidth || 300);
  const hh = Math.max(rowH, list.length * rowH);

  const bw = Math.round(w * dpr), bh = Math.round(hh * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  canvas.style.height = `${hh}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);

  const labelW = 44;
  const pctW = 46;
  const barX = labelW;
  const barW = Math.max(10, w - labelW - pctW);

  list.forEach((c, i) => {
    const yTop = i * rowH;
    const mid = yTop + rowH / 2;
    const p = Math.max(0, Math.min(100, Number(c.pct) || 0));

    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = dim;
    ctx.fillText(String(c.id ?? `cpu${i}`), 0, mid);

    // track
    ctx.fillStyle = track;
    ctx.beginPath();
    ctx.roundRect?.(barX, mid - 4, barW, 8, 4) ?? ctx.rect(barX, mid - 4, barW, 8);
    ctx.fill();

    // fill
    ctx.fillStyle = p >= 90 ? err : p >= 70 ? warn : acc;
    if (p > 0) {
      ctx.beginPath();
      const fw = Math.max(3, (p / 100) * barW);
      ctx.roundRect?.(barX, mid - 4, fw, 8, 4) ?? ctx.rect(barX, mid - 4, fw, 8);
      ctx.fill();
    }

    ctx.fillStyle = p >= 90 ? err : p >= 70 ? warn : dim;
    ctx.textAlign = 'right';
    ctx.fillText(`${p.toFixed(0)}%`, w, mid);
    ctx.textAlign = 'left';
  });
}

/**
 * A bounded ring buffer for sampled series.
 * Keeps the last `size` samples and exposes them oldest-first.
 */
export class Series {
  constructor(size = 60) {
    this.size = Math.max(2, size);
    this.values = [];
  }

  push(v) {
    const n = Number(v);
    this.values.push(Number.isFinite(n) ? n : 0);
    if (this.values.length > this.size) this.values.splice(0, this.values.length - this.size);
    return this;
  }

  get last() { return this.values.length ? this.values[this.values.length - 1] : null; }
  get array() { return this.values; }
  get length() { return this.values.length; }
  clear() { this.values = []; }
}
