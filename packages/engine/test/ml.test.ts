import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainGbdt, predictProba, explain, predictMargin, trainIsolationForest, anomalyScore, fitIsotonic, calibrate, rocAuc, averagePrecision, optimizeThresholds, psi, rng } from '../src';

test('GBDT learns a non-linear interaction, explanations sum to the margin', () => {
  const r = rng(1);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const a = r(), b = r(), c = r();
    X.push([a, b, c]);
    y.push((a > 0.7 && b > 0.6) || (c < 0.05) ? 1 : 0);
  }
  const m = trainGbdt(X.slice(0, 3000), y.slice(0, 3000), { features: ['a', 'b', 'c'], params: { rounds: 120 } });
  const s = X.slice(3000).map((x) => predictProba(m, x));
  assert.ok(rocAuc(s, y.slice(3000)) > 0.97, `auc ${rocAuc(s, y.slice(3000))}`);
  const x = X[3001];
  const e = explain(m, x);
  assert.ok(Math.abs(e.bias + e.contributions.reduce((a, b) => a + b, 0) - predictMargin(m, x)) < 1e-9);
});

test('isolation forest ranks outliers above inliers; isotonic is monotone; metrics and PSI sane', () => {
  const r = rng(2);
  const X = Array.from({ length: 1000 }, () => [r(), r()]);
  const f = trainIsolationForest(X, ['x', 'y']);
  assert.ok(anomalyScore(f, [5, 5]) > anomalyScore(f, [0.5, 0.5]));
  const c = fitIsotonic([0.1, 0.2, 0.3, 0.4, 0.9], [0, 1, 0, 1, 1]);
  assert.ok(calibrate(c, 0.95) >= calibrate(c, 0.25));
  assert.equal(rocAuc([0.1, 0.9], [0, 1]), 1);
  assert.equal(averagePrecision([0.1, 0.9], [0, 1]), 1);
  const t = optimizeThresholds([5, 95, 90, 10], [0, 1, 1, 0], [1e5, 1e5, 1e5, 1e5]);
  assert.ok(t.reject <= 90 && t.reject > 10 && t.savings > 0);
  assert.ok(psi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) < 0.01);
});

test('stacked mode: a trained RiskModel becomes the score inside decide()', async () => {
  const { GeeksFraudEngine, RiskModel, PERSONAS } = await import('../src');
  // tiny model: risk rises with the expert probability
  const X: number[][] = [];
  const y: number[] = [];
  const r = rng(3);
  for (let i = 0; i < 2000; i++) {
    const e = r();
    X.push([e]);
    y.push(r() < e * e ? 1 : 0);
  }
  const model = new RiskModel({ kind: 'geeksfraud-risk-model', version: 'test-1', gbdt: trainGbdt(X, y, { features: ['expert_p'], params: { rounds: 60 } }) });
  const tenant = { tenant_id: 't', mode: 'live' as const, thresholds: { default: { review: 50, reject: 80 } }, rules: [], model_mode: 'stacked' as const };
  const req = { merchant: { id: 'm' }, transaction: { id: 'x', amount: 1000, currency: 'UGX', payment_method: 'mobile_money' as const }, payer: {} };
  const bot = await new GeeksFraudEngine().decide(req, { tenant, behavior: PERSONAS.sbx_bot.behavior, enrichment: PERSONAS.sbx_bot.enrichment, model });
  const human = await new GeeksFraudEngine().decide(req, { tenant, behavior: PERSONAS.sbx_human.behavior, enrichment: PERSONAS.sbx_human.enrichment, model });
  assert.match(bot.model_version, /test-1/);
  assert.ok(bot.geek_score > human.geek_score);
  assert.ok(bot.reasons.length > 0, 'expert reasons are still returned for explanation');
  assert.ok(model.explain({ expert_p: 0.9 }).length >= 1);
});
