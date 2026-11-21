/**
 * Isolation Forest (Liu, Ting & Zhou, 2008) — unsupervised anomaly score for cold start,
 * when a new merchant or segment has no fraud labels yet (PRD §10.4 day-one plan).
 * Score in (0, 1): ~0.5 normal, → 1 anomalous.
 */
import { rng } from './gbdt';

interface INode {
  f: number;
  t: number;
  l: number;
  r: number;
  size: number;
}

export interface IsolationForest {
  kind: 'iforest';
  trees: INode[][];
  sampleSize: number;
  features: string[];
}

const EULER = 0.5772156649;
/** Average path length of an unsuccessful BST search over n points. */
export function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

export function trainIsolationForest(
  X: number[][],
  features: string[],
  opts: { trees?: number; sampleSize?: number; seed?: number } = {},
): IsolationForest {
  const nTrees = opts.trees ?? 100;
  const psi = Math.min(opts.sampleSize ?? 256, X.length);
  const limit = Math.ceil(Math.log2(Math.max(2, psi)));
  const rand = rng(opts.seed ?? 11);
  const d = features.length;
  const trees: INode[][] = [];

  for (let k = 0; k < nTrees; k++) {
    const sample: number[][] = [];
    for (let i = 0; i < psi; i++) sample.push(X[Math.floor(rand() * X.length)]);
    const nodes: INode[] = [];
    const grow = (rows: number[][], depth: number): number => {
      const id = nodes.length;
      nodes.push({ f: -1, t: 0, l: -1, r: -1, size: rows.length });
      if (depth >= limit || rows.length <= 1) return id;
      // pick a feature that actually varies in this node
      for (let attempt = 0; attempt < 8; attempt++) {
        const f = Math.floor(rand() * d);
        let lo = Infinity;
        let hi = -Infinity;
        for (const r of rows) {
          if (r[f] < lo) lo = r[f];
          if (r[f] > hi) hi = r[f];
        }
        if (hi <= lo) continue;
        const t = lo + rand() * (hi - lo);
        const left = rows.filter((r) => r[f] < t);
        const right = rows.filter((r) => r[f] >= t);
        nodes[id].f = f;
        nodes[id].t = t;
        nodes[id].l = grow(left, depth + 1);
        nodes[id].r = grow(right, depth + 1);
        return id;
      }
      return id;
    };
    grow(sample, 0);
    trees.push(nodes);
  }
  return { kind: 'iforest', trees, sampleSize: psi, features };
}

export function anomalyScore(m: IsolationForest, x: number[]): number {
  let total = 0;
  for (const nodes of m.trees) {
    let n = 0;
    let depth = 0;
    while (nodes[n].f !== -1) {
      n = x[nodes[n].f] < nodes[n].t ? nodes[n].l : nodes[n].r;
      depth++;
    }
    total += depth + cFactor(nodes[n].size);
  }
  const mean = total / m.trees.length;
  return Math.pow(2, -mean / cFactor(m.sampleSize));
}
