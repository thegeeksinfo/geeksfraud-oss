/**
 * Gradient-boosted decision trees for binary fraud classification.
 *
 * Same algorithm family as XGBoost / LightGBM: second-order (Newton) boosting on
 * log-loss, histogram split finding with the parent-minus-sibling trick, L2 leaf
 * regularisation (lambda), minimum split gain (gamma), minimum child hessian,
 * shrinkage, row and column subsampling. Pure TypeScript, zero dependencies, so
 * the same model trains in the API and scores in microseconds anywhere.
 *
 * Every prediction can be explained: per-feature contributions are computed by
 * path attribution (Saabas), summing exactly to the model's log-odds margin.
 */

export interface GbdtParams {
  rounds: number;
  learningRate: number;
  maxDepth: number;
  minChildWeight: number;
  lambda: number;
  gamma: number;
  subsample: number;
  colsample: number;
  maxBins: number;
  /** Multiply positive-class gradients (class imbalance). 1 = off. */
  scalePosWeight: number;
  /** Stop when validation log-loss has not improved for this many rounds (needs validation set). */
  earlyStopping: number;
  seed: number;
}

export const DEFAULT_GBDT: GbdtParams = {
  rounds: 300,
  learningRate: 0.08,
  maxDepth: 5,
  minChildWeight: 2,
  lambda: 1,
  gamma: 0,
  subsample: 0.8,
  colsample: 0.8,
  maxBins: 64,
  scalePosWeight: 1,
  earlyStopping: 30,
  seed: 7,
};

/** Flat tree: node i has feature f[i] (-1 = leaf), threshold t[i], children l[i]/r[i], value v[i]. */
export interface Tree {
  f: number[];
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}

export interface GbdtModel {
  kind: 'gbdt';
  version: string;
  features: string[];
  base: number;
  trees: Tree[];
  params: GbdtParams;
  trained_at: string;
  metrics?: Record<string, number>;
}

/** Small deterministic PRNG (mulberry32) so training is reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Quantile bin edges per feature; value goes to the first bin whose edge >= value. */
function binEdges(X: number[][], col: number, maxBins: number): number[] {
  const vals = X.map((r) => r[col]).sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const v of vals) if (uniq.length === 0 || uniq[uniq.length - 1] !== v) uniq.push(v);
  if (uniq.length <= maxBins) {
    // midpoints between consecutive unique values
    return uniq.slice(0, -1).map((v, i) => (v + uniq[i + 1]) / 2);
  }
  const edges: number[] = [];
  for (let b = 1; b < maxBins; b++) {
    const q = vals[Math.floor((b / maxBins) * (vals.length - 1))];
    if (edges.length === 0 || q > edges[edges.length - 1]) edges.push(q);
  }
  return edges;
}

function binOf(edges: number[], v: number): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= edges[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface TrainOptions {
  features: string[];
  params?: Partial<GbdtParams>;
  weights?: number[];
  valid?: { X: number[][]; y: number[] };
  version?: string;
  onRound?: (round: number, trainLoss: number, validLoss?: number) => void;
}

export function trainGbdt(X: number[][], y: number[], opts: TrainOptions): GbdtModel {
  const p: GbdtParams = { ...DEFAULT_GBDT, ...(opts.params ?? {}) };
  const n = X.length;
  const d = opts.features.length;
  const rand = rng(p.seed);
  const w = opts.weights ?? new Array(n).fill(1);

  // ── histogram binning, column-major Uint8 ──
  const edges = Array.from({ length: d }, (_, j) => binEdges(X, j, p.maxBins));
  const bins: Uint8Array[] = edges.map((e, j) => {
    const col = new Uint8Array(n);
    for (let i = 0; i < n; i++) col[i] = binOf(e, X[i][j]);
    return col;
  });
  const nb = edges.map((e) => e.length + 1);

  const posW = y.reduce((a, yi, i) => a + yi * w[i] * p.scalePosWeight, 0);
  const totW = y.reduce((a, yi, i) => a + w[i] * (yi ? p.scalePosWeight : 1), 0);
  const prior = Math.min(1 - 1e-6, Math.max(1e-6, posW / totW));
  const base = Math.log(prior / (1 - prior));
  const margin = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);

  const validMargin = opts.valid ? new Float64Array(opts.valid.X.length).fill(base) : null;
  let bestValid = Infinity;
  let bestRound = 0;
  const trees: Tree[] = [];

  for (let round = 0; round < p.rounds; round++) {
    for (let i = 0; i < n; i++) {
      const pi = sigmoid(margin[i]);
      const cw = w[i] * (y[i] ? p.scalePosWeight : 1);
      g[i] = (pi - y[i]) * cw;
      h[i] = Math.max(pi * (1 - pi), 1e-6) * cw;
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (p.subsample >= 1 || rand() < p.subsample) rows.push(i);
    const cols: number[] = [];
    for (let j = 0; j < d; j++) if (p.colsample >= 1 || rand() < p.colsample) cols.push(j);
    if (!cols.length) cols.push(Math.floor(rand() * d));

    const tree: Tree = { f: [], t: [], l: [], r: [], v: [] };
    const histFor = (idx: number[]) => {
      const H = cols.map((j) => ({ G: new Float64Array(nb[j]), Hs: new Float64Array(nb[j]) }));
      for (let c = 0; c < cols.length; c++) {
        const col = bins[cols[c]];
        const hc = H[c];
        for (const i of idx) {
          hc.G[col[i]] += g[i];
          hc.Hs[col[i]] += h[i];
        }
      }
      return H;
    };

    const build = (idx: number[], depth: number, hist: ReturnType<typeof histFor>): number => {
      let G = 0;
      let Hs = 0;
      for (const i of idx) {
        G += g[i];
        Hs += h[i];
      }
      const node = tree.f.length;
      const value = (-G / (Hs + p.lambda)) * p.learningRate;
      tree.f.push(-1);
      tree.t.push(0);
      tree.l.push(-1);
      tree.r.push(-1);
      tree.v.push(value);
      if (depth >= p.maxDepth || idx.length < 2 || Hs < 2 * p.minChildWeight) return node;

      const parentScore = (G * G) / (Hs + p.lambda);
      let best = { gain: p.gamma > 0 ? p.gamma : 1e-9, c: -1, bin: -1 };
      for (let c = 0; c < cols.length; c++) {
        const { G: hg, Hs: hh } = hist[c];
        let GL = 0;
        let HL = 0;
        for (let b = 0; b < hg.length - 1; b++) {
          GL += hg[b];
          HL += hh[b];
          const GR = G - GL;
          const HR = Hs - HL;
          if (HL < p.minChildWeight || HR < p.minChildWeight) continue;
          const gain = 0.5 * ((GL * GL) / (HL + p.lambda) + (GR * GR) / (HR + p.lambda) - parentScore);
          if (gain > best.gain) best = { gain, c, bin: b };
        }
      }
      if (best.c < 0) return node;

      const j = cols[best.c];
      const col = bins[j];
      const left: number[] = [];
      const right: number[] = [];
      for (const i of idx) (col[i] <= best.bin ? left : right).push(i);
      if (!left.length || !right.length) return node;

      // histogram subtraction: build the smaller child, derive the larger
      const small = left.length <= right.length ? left : right;
      const hSmall = histFor(small);
      const hLarge = hist.map((hc, c) => {
        const G2 = new Float64Array(hc.G.length);
        const H2 = new Float64Array(hc.Hs.length);
        for (let b = 0; b < G2.length; b++) {
          G2[b] = hc.G[b] - hSmall[c].G[b];
          H2[b] = hc.Hs[b] - hSmall[c].Hs[b];
        }
        return { G: G2, Hs: H2 };
      });
      const hLeft = small === left ? hSmall : hLarge;
      const hRight = small === left ? hLarge : hSmall;

      tree.f[node] = j;
      tree.t[node] = edges[j][best.bin];
      tree.l[node] = build(left, depth + 1, hLeft);
      tree.r[node] = build(right, depth + 1, hRight);
      return node;
    };

    build(rows, 0, histFor(rows));
    trees.push(tree);

    let trainLoss = 0;
    for (let i = 0; i < n; i++) {
      margin[i] += leafValue(tree, X[i]);
      const pi = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(margin[i])));
      trainLoss -= y[i] ? Math.log(pi) : Math.log(1 - pi);
    }
    trainLoss /= n;

    let validLoss: number | undefined;
    if (opts.valid && validMargin) {
      validLoss = 0;
      for (let i = 0; i < opts.valid.X.length; i++) {
        validMargin[i] += leafValue(tree, opts.valid.X[i]);
        const pi = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(validMargin[i])));
        validLoss -= opts.valid.y[i] ? Math.log(pi) : Math.log(1 - pi);
      }
      validLoss /= opts.valid.X.length;
      if (validLoss < bestValid - 1e-6) {
        bestValid = validLoss;
        bestRound = round;
      } else if (p.earlyStopping > 0 && round - bestRound >= p.earlyStopping) {
        opts.onRound?.(round, trainLoss, validLoss);
        break;
      }
    }
    opts.onRound?.(round, trainLoss, validLoss);
  }

  return {
    kind: 'gbdt',
    version: opts.version ?? `gbdt-${new Date().toISOString().slice(0, 10)}`,
    features: opts.features,
    base,
    trees: opts.valid ? trees.slice(0, bestRound + 1) : trees,
    params: p,
    trained_at: new Date().toISOString(),
  };
}

function leafValue(t: Tree, x: number[]): number {
  let n = 0;
  while (t.f[n] !== -1) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
  return t.v[n];
}

export function predictMargin(m: GbdtModel, x: number[]): number {
  let s = m.base;
  for (const t of m.trees) s += leafValue(t, x);
  return s;
}

export function predictProba(m: GbdtModel, x: number[]): number {
  return sigmoid(predictMargin(m, x));
}

/**
 * Per-feature contributions to the log-odds margin (Saabas path attribution).
 * Sum of contributions + bias === predictMargin(m, x).
 */
export function explain(m: GbdtModel, x: number[]): { bias: number; contributions: number[] } {
  const c = new Array(m.features.length).fill(0);
  let bias = m.base;
  for (const t of m.trees) {
    let n = 0;
    bias += t.v[0];
    while (t.f[n] !== -1) {
      const next = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
      c[t.f[n]] += t.v[next] - t.v[n];
      n = next;
    }
  }
  return { bias, contributions: c };
}

/** Total gain-free importance: how often each feature is used to split, weighted by depth. */
export function featureImportance(m: GbdtModel): Array<{ feature: string; splits: number }> {
  const counts = new Array(m.features.length).fill(0);
  for (const t of m.trees) for (const f of t.f) if (f >= 0) counts[f]++;
  return m.features.map((feature, i) => ({ feature, splits: counts[i] })).sort((a, b) => b.splits - a.splits);
}

/** Vectorise a named feature record in model order (missing → -1, matching extractFeatures). */
export function vectorize(m: Pick<GbdtModel, 'features'>, rec: Record<string, number>): number[] {
  return m.features.map((f) => (Number.isFinite(rec[f]) ? rec[f] : -1));
}
