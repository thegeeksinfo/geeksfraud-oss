/**
 * Financial Health Score — the "health" half of GeeksFraud.
 *
 * Turns a wallet/account's transaction history into a 0–100 score across five
 * pillars (Spend, Save, Borrow, Plan, Protect), a tier, and plain-language
 * nudges. Designed for low-income mobile-money users: works on irregular
 * income, small balances and short histories, and counts fraud exposure as a
 * financial-health factor (a scam can wipe out a household buffer).
 *
 * Pure and deterministic, so lenders/MNOs can audit it and users can be told
 * exactly why their score moved.
 */

export type TxCategory =
  | 'income'
  | 'expense'
  | 'savings_in'
  | 'savings_out'
  | 'loan_in'
  | 'loan_repayment'
  | 'transfer_in'
  | 'transfer_out'
  | 'airtime'
  | 'bill'
  | 'fee';

export interface HealthTx {
  ts: number;
  /** Positive minor units. Direction comes from the category. */
  amount: number;
  category: TxCategory;
  counterparty?: string;
  /** True if later confirmed fraud/scam against this user. */
  fraud_loss?: boolean;
}

export interface HealthInput {
  transactions: HealthTx[];
  /** Current wallet + savings balance, minor units. */
  balance: number;
  /** Fraud attempts blocked by GeeksFraud on this user in the period. */
  fraud_attempts_blocked?: number;
  /** Days since last SIM swap, if known. */
  sim_swap_days?: number;
  now?: number;
}

export type Tier = 'healthy' | 'coping' | 'vulnerable';

export interface Pillar {
  key: 'spend' | 'save' | 'borrow' | 'plan' | 'protect';
  score: number; // 0..100
  weight: number;
  metrics: Record<string, number>;
}

export interface HealthResult {
  score: number;
  tier: Tier;
  pillars: Pillar[];
  nudges: string[];
  data_days: number;
  confidence: 'low' | 'medium' | 'high';
}

const DAY = 86_400_000;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
/** Linear map: value at `bad` → 0, at `good` → 100 (works for either direction). */
const scale = (v: number, bad: number, good: number) => clamp(((v - bad) / (good - bad)) * 100);

function monthlyBuckets(txs: HealthTx[], now: number, months: number, pick: (t: HealthTx) => boolean): number[] {
  const out = new Array(months).fill(0);
  for (const t of txs) {
    if (!pick(t)) continue;
    const idx = Math.floor((now - t.ts) / (30 * DAY));
    if (idx >= 0 && idx < months) out[idx] += t.amount;
  }
  return out;
}

function cv(values: number[]): number {
  const n = values.length;
  if (!n) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 1;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / mean;
}

export function financialHealth(input: HealthInput): HealthResult {
  const now = input.now ?? Date.now();
  const txs = input.transactions.filter((t) => t.ts <= now && t.ts > now - 180 * DAY);
  const oldest = txs.reduce((m, t) => Math.min(m, t.ts), now);
  const dataDays = Math.max(1, Math.round((now - oldest) / DAY));
  const months = Math.max(1, Math.min(6, Math.round(dataDays / 30)));
  const sum = (cats: TxCategory[]) => txs.filter((t) => cats.includes(t.category)).reduce((a, t) => a + t.amount, 0);

  const income = sum(['income', 'transfer_in']);
  const spending = sum(['expense', 'airtime', 'bill', 'fee', 'transfer_out']);
  const saved = sum(['savings_in']) - sum(['savings_out']);
  const repayments = sum(['loan_repayment']);
  const borrowed = sum(['loan_in']);
  const fraudLoss = txs.filter((t) => t.fraud_loss).reduce((a, t) => a + t.amount, 0);

  const dailySpend = spending / dataDays || 1;
  const spendRatio = income > 0 ? spending / income : 2;
  const bufferDays = input.balance / dailySpend;
  const savingsRate = income > 0 ? saved / income : 0;
  const dsr = income > 0 ? repayments / income : repayments > 0 ? 1 : 0;
  const incomeMonths = monthlyBuckets(txs, now, months, (t) => t.category === 'income' || t.category === 'transfer_in');
  const incomeCv = cv(incomeMonths);
  const incomeSources = new Set(txs.filter((t) => t.category === 'income' && t.counterparty).map((t) => t.counterparty)).size;
  const feeShare = spending > 0 ? sum(['fee']) / spending : 0;

  const spend: Pillar = {
    key: 'spend',
    weight: 0.25,
    score: Math.round(0.8 * scale(spendRatio, 1.2, 0.8) + 0.2 * scale(feeShare, 0.08, 0.01)),
    metrics: { spend_to_income: +spendRatio.toFixed(3), fee_share: +feeShare.toFixed(3) },
  };
  const save: Pillar = {
    key: 'save',
    weight: 0.25,
    score: Math.round(0.6 * scale(bufferDays, 0, 45) + 0.4 * scale(savingsRate, 0, 0.15)),
    metrics: { buffer_days: +bufferDays.toFixed(1), savings_rate: +savingsRate.toFixed(3) },
  };
  const borrow: Pillar = {
    key: 'borrow',
    weight: 0.15,
    score: Math.round(borrowed === 0 && repayments === 0 ? 80 : scale(dsr, 0.5, 0.1)),
    metrics: { debt_service_ratio: +dsr.toFixed(3), borrowed },
  };
  const plan: Pillar = {
    key: 'plan',
    weight: 0.2,
    score: Math.round(0.7 * scale(incomeCv, 1, 0.15) + 0.3 * scale(incomeSources, 0, 3)),
    metrics: { income_volatility: +incomeCv.toFixed(3), income_sources: incomeSources },
  };
  const lossShare = income > 0 ? fraudLoss / income : fraudLoss > 0 ? 1 : 0;
  const simPenalty = input.sim_swap_days !== undefined && input.sim_swap_days <= 7 ? 25 : 0;
  const protect: Pillar = {
    key: 'protect',
    weight: 0.15,
    score: Math.round(clamp(scale(lossShare, 0.2, 0) - simPenalty - Math.min(20, (input.fraud_attempts_blocked ?? 0) * 4))),
    metrics: { fraud_loss: fraudLoss, fraud_loss_share: +lossShare.toFixed(3), attempts_blocked: input.fraud_attempts_blocked ?? 0 },
  };

  const pillars = [spend, save, borrow, plan, protect];
  const score = Math.round(pillars.reduce((a, p) => a + p.score * p.weight, 0));
  const tier: Tier = score >= 70 ? 'healthy' : score >= 40 ? 'coping' : 'vulnerable';

  const nudges: string[] = [];
  if (bufferDays < 14) nudges.push(`Your balance covers ${bufferDays < 1 ? 'less than a day' : `about ${Math.floor(bufferDays)} day${Math.floor(bufferDays) === 1 ? '' : 's'}`} of spending. Saving a small fixed amount each payday builds a 2-week cushion.`);
  if (spendRatio > 1) nudges.push('You spent more than you received this period. Review recurring bills and airtime bundles.');
  if (feeShare > 0.05) nudges.push('Transaction fees are a large share of your spending. Fewer, larger transfers or a cheaper bundle could save money.');
  if (dsr > 0.3) nudges.push('Loan repayments take over 30 % of your income. Avoid new loans until existing ones are cleared.');
  if (incomeCv > 0.6) nudges.push('Your income is irregular. Setting aside part of good months smooths the lean ones.');
  if (fraudLoss > 0 || simPenalty) nudges.push('Your account was targeted by fraud. Never share your PIN or OTP, and contact your provider if your SIM stops working unexpectedly.');
  if (!nudges.length) nudges.push('You are on track. Keep your savings habit and review your goals monthly.');

  const confidence = txs.length >= 60 && dataDays >= 60 ? 'high' : txs.length >= 20 && dataDays >= 30 ? 'medium' : 'low';
  return { score, tier, pillars, nudges, data_days: dataDays, confidence };
}
