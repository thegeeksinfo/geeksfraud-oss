/**
 * Population Stability Index per feature (PRD §10.4 v1 drift monitoring).
 * PSI < 0.1 stable · 0.1–0.25 moderate shift · > 0.25 significant: retrain or investigate.
 */
export function psi(expected: number[], actual: number[], bins = 10): number {
  if (!expected.length || !actual.length) return 0;
  const sorted = [...expected].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < bins; b++) edges.push(sorted[Math.floor((b / bins) * (sorted.length - 1))]);
  const uniq = Array.from(new Set(edges));
  const hist = (vals: number[]) => {
    const h = new Array(uniq.length + 1).fill(0);
    for (const v of vals) {
      let k = 0;
      while (k < uniq.length && v > uniq[k]) k++;
      h[k]++;
    }
    return h.map((c) => Math.max(c / vals.length, 1e-4));
  };
  const e = hist(expected);
  const a = hist(actual);
  let s = 0;
  for (let k = 0; k < e.length; k++) s += (a[k] - e[k]) * Math.log(a[k] / e[k]);
  return s;
}

export function driftReport(features: string[], baseline: number[][], current: number[][]) {
  return features
    .map((f, j) => ({ feature: f, psi: +psi(baseline.map((r) => r[j]), current.map((r) => r[j])).toFixed(4) }))
    .map((r) => ({ ...r, status: r.psi > 0.25 ? 'significant' : r.psi > 0.1 ? 'moderate' : 'stable' }))
    .sort((a, b) => b.psi - a.psi);
}
