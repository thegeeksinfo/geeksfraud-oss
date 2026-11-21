/**
 * Expected-cost threshold optimisation.
 *
 * Instead of guessing "review at 50, reject at 80", choose the pair that minimises
 * the money actually lost on labelled history:
 *   approved fraud    → the payment amount is lost (plus chargeback fee)
 *   rejected good     → the merchant's margin on the sale is lost, plus a churn penalty
 *   reviewed payment  → analyst time; a reviewed fraud is caught, a reviewed good payer adds friction
 * subject to a review-capacity limit (analysts are finite).
 */
export interface CostModel {
  /** Fraction of a fraudulent amount actually lost (after any recovery). */
  fraudLossRate: number;
  /** Fixed fee per chargeback / dispute, in the same unit as amounts. */
  chargebackFee: number;
  /** Merchant margin lost when a good payment is rejected (fraction of amount). */
  goodMargin: number;
  /** Extra cost of insulting a good customer (churn), fixed per false reject. */
  falseRejectPenalty: number;
  /** Cost of one manual review. */
  reviewCost: number;
  /** Friction cost when a good payer goes through review (fraction of margin). */
  reviewFriction: number;
  /** Max share of traffic the analyst team can review. */
  maxReviewRate: number;
}

export const DEFAULT_COSTS: CostModel = {
  fraudLossRate: 1,
  chargebackFee: 15_000, // UGX ≈ $4
  goodMargin: 0.08,
  falseRejectPenalty: 2_000,
  reviewCost: 3_500,
  reviewFriction: 0.2,
  maxReviewRate: 0.03,
};

export interface ThresholdResult {
  review: number;
  reject: number;
  cost: number;
  baselineCost: number;
  savings: number;
  reviewRate: number;
  rejectRate: number;
  fraudCaughtRate: number;
  falsePositiveRate: number;
}

export function costOf(scores: number[], labels: number[], amounts: number[], review: number, reject: number, c: CostModel) {
  let cost = 0;
  let reviewed = 0;
  let rejected = 0;
  let caught = 0;
  let fraud = 0;
  let good = 0;
  let goodRejected = 0;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const a = amounts[i];
    const isFraud = labels[i] === 1;
    if (isFraud) fraud++;
    else good++;
    if (s >= reject) {
      rejected++;
      if (isFraud) caught++;
      else {
        goodRejected++;
        cost += a * c.goodMargin + c.falseRejectPenalty;
      }
    } else if (s >= review) {
      reviewed++;
      cost += c.reviewCost;
      if (isFraud) caught++;
      else cost += a * c.goodMargin * c.reviewFriction;
    } else if (isFraud) {
      cost += a * c.fraudLossRate + c.chargebackFee;
    }
  }
  const n = scores.length || 1;
  return {
    cost,
    reviewRate: reviewed / n,
    rejectRate: rejected / n,
    fraudCaughtRate: fraud ? caught / fraud : 0,
    falsePositiveRate: good ? goodRejected / good : 0,
  };
}

/** Grid search over (review, reject) on a 0–100 score scale. */
export function optimizeThresholds(scores: number[], labels: number[], amounts: number[], costs: Partial<CostModel> = {}, step = 1): ThresholdResult {
  const c = { ...DEFAULT_COSTS, ...costs };
  const baseline = costOf(scores, labels, amounts, Infinity, Infinity, c).cost; // approve everything
  let best: ThresholdResult | null = null;
  for (let reject = 0; reject <= 100; reject += step) {
    for (let review = 0; review <= reject; review += step) {
      const r = costOf(scores, labels, amounts, review, reject, c);
      if (r.reviewRate > c.maxReviewRate) continue;
      if (!best || r.cost < best.cost) {
        best = { review, reject, cost: r.cost, baselineCost: baseline, savings: baseline - r.cost, reviewRate: r.reviewRate, rejectRate: r.rejectRate, fraudCaughtRate: r.fraudCaughtRate, falsePositiveRate: r.falsePositiveRate };
      }
    }
  }
  return best!;
}
