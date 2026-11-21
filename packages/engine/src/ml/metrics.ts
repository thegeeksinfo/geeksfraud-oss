/** Evaluation metrics that matter for fraud: ranking quality at very low false-positive rates, by count and by value. */

/** ROC-AUC via the Mann–Whitney U statistic, with tie handling. */
export function rocAuc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSumPos = 0;
  let nPos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]]) {
      rankSumPos += avgRank;
      nPos++;
    }
    i = j + 1;
  }
  const nNeg = scores.length - nPos;
  if (!nPos || !nNeg) return NaN;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Average precision (area under the precision–recall curve, step-wise). */
export function averagePrecision(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const nPos = labels.reduce((a, b) => a + b, 0);
  if (!nPos) return NaN;
  let tp = 0;
  let sum = 0;
  for (let k = 0; k < idx.length; k++) {
    if (labels[idx[k]]) {
      tp++;
      sum += tp / (k + 1);
    }
  }
  return sum / nPos;
}

/**
 * Recall (share of fraud caught) when the threshold is set so that at most
 * `fpr` of good payments are flagged. Optional `values` gives value-weighted recall.
 */
export function recallAtFpr(scores: number[], labels: number[], fpr: number, values?: number[]): { recall: number; valueRecall: number; threshold: number } {
  const neg = scores.filter((_, i) => !labels[i]).sort((a, b) => b - a);
  const k = Math.floor(fpr * neg.length);
  const threshold = k < neg.length ? neg[k] : -Infinity;
  let caught = 0;
  let pos = 0;
  let vCaught = 0;
  let vPos = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!labels[i]) continue;
    pos++;
    const v = values?.[i] ?? 1;
    vPos += v;
    if (scores[i] > threshold) {
      caught++;
      vCaught += v;
    }
  }
  return { recall: pos ? caught / pos : NaN, valueRecall: vPos ? vCaught / vPos : NaN, threshold };
}

export function logLoss(probs: number[], labels: number[]): number {
  let s = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, probs[i]));
    s -= labels[i] ? Math.log(p) : Math.log(1 - p);
  }
  return s / probs.length;
}

/** Brier score and expected calibration error over equal-count bins. */
export function calibrationError(probs: number[], labels: number[], bins = 10): { brier: number; ece: number } {
  const n = probs.length;
  let brier = 0;
  for (let i = 0; i < n; i++) brier += (probs[i] - labels[i]) ** 2;
  const idx = probs.map((_, i) => i).sort((a, b) => probs[a] - probs[b]);
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const part = idx.slice(Math.floor((b * n) / bins), Math.floor(((b + 1) * n) / bins));
    if (!part.length) continue;
    const conf = part.reduce((a, i) => a + probs[i], 0) / part.length;
    const acc = part.reduce((a, i) => a + labels[i], 0) / part.length;
    ece += (part.length / n) * Math.abs(conf - acc);
  }
  return { brier: brier / n, ece };
}
