/**
 * Benchmark: expert rules vs gradient-boosted models, evaluated the way a fraud
 * team is judged: catch rate at a fixed, small false-positive budget, by count
 * and by money, on future traffic the model never saw.
 *
 *   npx tsx bench/run.ts            → bench/results.json + a markdown table
 *   npx tsx bench/run.ts --export   → also writes CSVs for the XGBoost reference check
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simulate, type Row } from './simulate';
import { trainGbdt, predictProba, featureImportance } from '../src/ml/gbdt';
import { trainIsolationForest, anomalyScore } from '../src/ml/iforest';
import { fitIsotonic, calibrate } from '../src/ml/calibration';
import { rocAuc, averagePrecision, recallAtFpr, calibrationError } from '../src/ml/metrics';
import { optimizeThresholds, costOf, DEFAULT_COSTS } from '../src/ml/thresholds';

// Label-maturity window: chargebacks take up to 45 days, so the model trained on day 66
// only learns from payments at least ~40 days old, and is tested on the 14 days after.
const DAYS = 80;
const TRAIN_END = 21; // days 0–20 train
const VALID_END = 28; // days 21–27 validation (early stopping, calibration, thresholds)
const LABEL_CUTOFF_DAY = 66; // training happens on day 66 with the labels known by then
const TEST_START = 66; // days 66–79: the future the model has never seen

async function main() {
const t0 = Date.now();
const rows = await simulate({ days: DAYS, perDay: 1000, seed: 42 });
const simSeconds = (Date.now() - t0) / 1000;

const cutoff = rows[0].ts - (rows[0].ts % 86_400_000) + LABEL_CUTOFF_DAY * 86_400_000;
const observed = (r: Row) => (r.fraud && r.knownAt !== null && r.knownAt <= cutoff ? 1 : 0);

const train = rows.filter((r) => r.day < TRAIN_END);
const valid = rows.filter((r) => r.day >= TRAIN_END && r.day < VALID_END);
const test = rows.filter((r) => r.day >= TEST_START);

const RAW = Object.keys(rows[0].raw).sort();
const STACKED = Array.from(new Set(rows.flatMap((r) => Object.keys(r.stacked)))).sort();
const vec = (rec: Record<string, number>, cols: string[]) => cols.map((c) => (Number.isFinite(rec[c]) ? rec[c] : c.startsWith('sig_') ? 0 : -1));

const yTrain = train.map(observed);
const yValid = valid.map(observed);
const yTest = test.map((r) => r.fraud); // ground truth
const amounts = test.map((r) => r.amount);

interface Scored {
  name: string;
  valid: number[];
  test: number[];
  note: string;
}
const models: Scored[] = [];

// A. Expert system (current engine): noisy-OR of hand-weighted signals
models.push({ name: 'A. Expert rules (current)', valid: valid.map((r) => r.expertScore / 100), test: test.map((r) => r.expertScore / 100), note: 'noisy-OR of 25 hand-weighted signals' });

// B. GBDT on raw features only
const params = { rounds: 400, learningRate: 0.06, maxDepth: 5, minChildWeight: 3, subsample: 0.8, colsample: 0.8, earlyStopping: 40 };
let tb = Date.now();
const gbRaw = trainGbdt(train.map((r) => vec(r.raw, RAW)), yTrain, { features: RAW, params, valid: { X: valid.map((r) => vec(r.raw, RAW)), y: yValid } });
const trainRawS = (Date.now() - tb) / 1000;
models.push({ name: 'B. GBDT, raw features', valid: valid.map((r) => predictProba(gbRaw, vec(r.raw, RAW))), test: test.map((r) => predictProba(gbRaw, vec(r.raw, RAW))), note: `${gbRaw.trees.length} trees, ${RAW.length} features` });

// C. GBDT stacked: raw features + expert verdict + every signal's strength
tb = Date.now();
const gbStack = trainGbdt(train.map((r) => vec(r.stacked, STACKED)), yTrain, { features: STACKED, params, valid: { X: valid.map((r) => vec(r.stacked, STACKED)), y: yValid } });
const trainStackS = (Date.now() - tb) / 1000;
models.push({ name: 'C. GBDT stacked on expert signals', valid: valid.map((r) => predictProba(gbStack, vec(r.stacked, STACKED))), test: test.map((r) => predictProba(gbStack, vec(r.stacked, STACKED))), note: `${gbStack.trees.length} trees, ${STACKED.length} features` });

// D. C + Isolation Forest anomaly score as an extra feature
const iso = trainIsolationForest(train.map((r) => vec(r.raw, RAW)), RAW, { trees: 100, sampleSize: 256 });
const withAnom = (r: Row) => [...vec(r.stacked, STACKED), anomalyScore(iso, vec(r.raw, RAW))];
const gbAnom = trainGbdt(train.map(withAnom), yTrain, { features: [...STACKED, 'anomaly'], params, valid: { X: valid.map(withAnom), y: yValid } });
models.push({ name: 'D. C + Isolation Forest', valid: valid.map((r) => predictProba(gbAnom, withAnom(r))), test: test.map((r) => predictProba(gbAnom, withAnom(r))), note: 'anomaly score as a feature' });

// E. Isolation Forest alone (cold start: no labels at all)
models.push({ name: 'E. Isolation Forest only (no labels)', valid: valid.map((r) => anomalyScore(iso, vec(r.raw, RAW))), test: test.map((r) => anomalyScore(iso, vec(r.raw, RAW))), note: 'unsupervised, for brand-new tenants' });

const typologies = ['naive_bot', 'stealth_bot', 'farm', 'ato', 'mule', 'friendly'] as const;
const results = models.map((m) => {
  const r1 = recallAtFpr(m.test, yTest, 0.01, amounts);
  const r05 = recallAtFpr(m.test, yTest, 0.005, amounts);
  const perTypology: Record<string, number> = {};
  for (const t of typologies) {
    const idx = test.map((r, i) => (r.typology === t ? i : -1)).filter((i) => i >= 0);
    perTypology[t] = idx.length ? +(idx.filter((i) => m.test[i] > r1.threshold).length / idx.length).toFixed(3) : NaN;
  }
  return {
    model: m.name,
    note: m.note,
    roc_auc: +rocAuc(m.test, yTest).toFixed(4),
    pr_auc: +averagePrecision(m.test, yTest).toFixed(4),
    recall_at_1pct_fpr: +r1.recall.toFixed(4),
    value_recall_at_1pct_fpr: +r1.valueRecall.toFixed(4),
    recall_at_0_5pct_fpr: +r05.recall.toFixed(4),
    recall_by_typology_at_1pct_fpr: perTypology,
  };
});

// Calibration + cost-optimal thresholds for the best model (chosen on validation PR-AUC)
const best = models.slice(1, 4).reduce((a, b) => (averagePrecision(b.valid, yValid) > averagePrecision(a.valid, yValid) ? b : a));
const cal = fitIsotonic(best.valid, yValid);
const calTest = best.test.map((s) => calibrate(cal, s) * 100);
const calValid = best.valid.map((s) => calibrate(cal, s) * 100);
const thr = optimizeThresholds(calValid, yValid, valid.map((r) => r.amount));
const testCostOptimal = costOf(calTest, yTest, amounts, thr.review, thr.reject, DEFAULT_COSTS);
const testCostExpertDefault = costOf(test.map((r) => r.expertScore), yTest, amounts, 50, 80, DEFAULT_COSTS);
const testCostApproveAll = costOf(test.map(() => 0), yTest, amounts, Infinity, Infinity, DEFAULT_COSTS);
const calErr = calibrationError(calTest.map((s) => s / 100), yTest);
const rawErr = calibrationError(best.test, yTest);

// Latency of the stacked model
const sample = test.slice(0, 2000).map((r) => vec(r.stacked, STACKED));
const tl = process.hrtime.bigint();
for (let rep = 0; rep < 5; rep++) for (const x of sample) predictProba(gbStack, x);
const usPerPrediction = Number(process.hrtime.bigint() - tl) / 1000 / (5 * sample.length);

const summary = {
  dataset: {
    payments: rows.length,
    fraud_rate: +(rows.filter((r) => r.fraud).length / rows.length).toFixed(4),
    train: train.length,
    valid: valid.length,
    test: test.length,
    test_fraud: yTest.reduce((a, b) => a + b, 0),
    train_labels_known: +(yTrain.reduce((a, b) => a + b, 0) / train.filter((r) => r.fraud).length).toFixed(3),
    simulation_seconds: simSeconds,
  },
  results,
  best_model: best.name,
  calibration: { raw: { brier: +rawErr.brier.toFixed(5), ece: +rawErr.ece.toFixed(4) }, isotonic: { brier: +calErr.brier.toFixed(5), ece: +calErr.ece.toFixed(4) } },
  thresholds: {
    chosen_on_validation: { review: thr.review, reject: thr.reject },
    test_cost_UGX: {
      approve_everything: Math.round(testCostApproveAll.cost),
      expert_default_50_80: Math.round(testCostExpertDefault.cost),
      best_model_cost_optimal: Math.round(testCostOptimal.cost),
    },
    best_model_test: { review_rate: +testCostOptimal.reviewRate.toFixed(4), reject_rate: +testCostOptimal.rejectRate.toFixed(4), fraud_caught: +testCostOptimal.fraudCaughtRate.toFixed(4), false_positive_rate: +testCostOptimal.falsePositiveRate.toFixed(4) },
    expert_default_test: { review_rate: +testCostExpertDefault.reviewRate.toFixed(4), reject_rate: +testCostExpertDefault.rejectRate.toFixed(4), fraud_caught: +testCostExpertDefault.fraudCaughtRate.toFixed(4), false_positive_rate: +testCostExpertDefault.falsePositiveRate.toFixed(4) },
  },
  training_seconds: { gbdt_raw: trainRawS, gbdt_stacked: trainStackS },
  inference_microseconds_per_prediction: +usPerPrediction.toFixed(2),
  top_features_stacked: featureImportance(gbStack).slice(0, 12),
};

writeFileSync(join(__dirname, 'results.json'), JSON.stringify(summary, null, 2) + '\n');

if (process.argv.includes('--export')) {
  const dir = join(__dirname, 'data');
  mkdirSync(dir, { recursive: true });
  const csv = (rs: Row[], ys: number[]) => [[...STACKED, 'label'].join(','), ...rs.map((r, i) => [...vec(r.stacked, STACKED), ys[i]].join(','))].join('\n');
  writeFileSync(join(dir, 'train.csv'), csv(train, yTrain));
  writeFileSync(join(dir, 'valid.csv'), csv(valid, yValid));
  writeFileSync(join(dir, 'test.csv'), csv(test, yTest));
  writeFileSync(join(dir, 'ours_test_scores.csv'), models[2].test.join('\n'));
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
console.log(`\n${rows.length} payments, ${pct(summary.dataset.fraud_rate)} fraud, test = last ${DAYS - TEST_START} days (${summary.dataset.test_fraud} fraud)\n`);
console.log('| Model | ROC-AUC | PR-AUC | Caught @1% FPR | Value caught @1% FPR | Caught @0.5% FPR |');
console.log('|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.model} | ${r.roc_auc} | ${r.pr_auc} | ${pct(r.recall_at_1pct_fpr)} | ${pct(r.value_recall_at_1pct_fpr)} | ${pct(r.recall_at_0_5pct_fpr)} |`);
console.log('\nCaught at 1% FPR by typology:');
console.log('| Model | ' + typologies.join(' | ') + ' |');
console.log('|---|' + typologies.map(() => '---').join('|') + '|');
for (const r of results) console.log(`| ${r.model} | ${typologies.map((t) => pct(r.recall_by_typology_at_1pct_fpr[t])).join(' | ')} |`);
console.log('\n' + JSON.stringify({ best: summary.best_model, calibration: summary.calibration, thresholds: summary.thresholds, latency_us: summary.inference_microseconds_per_prediction, training_s: summary.training_seconds }, null, 2));

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
