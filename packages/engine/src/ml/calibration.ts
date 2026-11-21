/**
 * Isotonic calibration (pool-adjacent-violators). Turns any monotone risk score
 * into a probability, so "Geek Score 80" means "about 80 % of payments scored
 * like this were fraud" — which is what makes thresholds meaningful.
 */
export interface IsotonicCalibrator {
  kind: 'isotonic';
  x: number[];
  y: number[];
}

export function fitIsotonic(scores: number[], labels: number[], weights?: number[]): IsotonicCalibrator {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  // blocks: [sumW, sumWY, minX, maxX]
  const blocks: Array<{ w: number; wy: number; lo: number; hi: number }> = [];
  for (const i of idx) {
    const w = weights?.[i] ?? 1;
    blocks.push({ w, wy: w * labels[i], lo: scores[i], hi: scores[i] });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.wy / a.w <= b.wy / b.w) break;
      blocks.splice(blocks.length - 2, 2, { w: a.w + b.w, wy: a.wy + b.wy, lo: a.lo, hi: b.hi });
    }
  }
  const x: number[] = [];
  const y: number[] = [];
  for (const b of blocks) {
    const v = b.wy / b.w;
    x.push(b.lo, b.hi);
    y.push(v, v);
  }
  return { kind: 'isotonic', x, y };
}

/** Piecewise-linear interpolation between block endpoints; clamped outside the range. */
export function calibrate(c: IsotonicCalibrator, s: number): number {
  const { x, y } = c;
  if (!x.length) return s;
  if (s <= x[0]) return y[0];
  if (s >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = x[hi] - x[lo];
  return span > 0 ? y[lo] + ((s - x[lo]) / span) * (y[hi] - y[lo]) : y[hi];
}
