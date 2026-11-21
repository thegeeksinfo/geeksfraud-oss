/**
 * GeeksFraud risk model: gradient-boosted trees, optionally fed an Isolation
 * Forest anomaly score, with isotonic calibration on top. Implements the engine's
 * ModelScorer interface, so a trained model drops straight into `decide()`.
 */
import type { ModelScorer, ReasonHit } from '../types';
import { explain, predictMargin, vectorize, type GbdtModel } from './gbdt';
import { anomalyScore, type IsolationForest } from './iforest';
import { calibrate, type IsotonicCalibrator } from './calibration';

export interface RiskModelBundle {
  kind: 'geeksfraud-risk-model';
  version: string;
  gbdt: GbdtModel;
  iforest?: IsolationForest;
  calibrator?: IsotonicCalibrator;
  /** Evaluation snapshot recorded at training time (for the console and audits). */
  report?: Record<string, unknown>;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Feature record for stacked models: raw features + expert verdict + each reason's strength. */
export function stackedFeatures(features: Record<string, number>, expertP: number, reasons: Pick<ReasonHit, 'code' | 'strength'>[]): Record<string, number> {
  const out: Record<string, number> = { ...features, expert_p: expertP };
  for (const r of reasons) if (r.code !== 'FG_RULE_MATCH') out[`sig_${r.code}`] = Math.max(out[`sig_${r.code}`] ?? 0, r.strength);
  return out;
}

export class RiskModel implements ModelScorer {
  readonly version: string;
  constructor(readonly bundle: RiskModelBundle) {
    this.version = bundle.version;
  }

  private input(rec: Record<string, number>): number[] {
    const r = { ...rec };
    if (this.bundle.iforest) {
      const xf = this.bundle.iforest.features.map((f) => (Number.isFinite(r[f]) ? r[f] : -1));
      r.anomaly = anomalyScore(this.bundle.iforest, xf);
    }
    // signals that did not fire are 0, not "missing"
    for (const f of this.bundle.gbdt.features) if (f.startsWith('sig_') && r[f] === undefined) r[f] = 0;
    return vectorize(this.bundle.gbdt, r);
  }

  /** Raw (uncalibrated) model probability. */
  raw(rec: Record<string, number>): number {
    return sigmoid(predictMargin(this.bundle.gbdt, this.input(rec)));
  }

  /** Calibrated fraud probability, 0..1. */
  score(rec: Record<string, number>): number {
    const p = this.raw(rec);
    return this.bundle.calibrator ? calibrate(this.bundle.calibrator, p) : p;
  }

  /** Features that pushed this payment's risk up or down most (log-odds contributions). */
  explain(rec: Record<string, number>, top = 5): Array<{ feature: string; contribution: number }> {
    const { contributions } = explain(this.bundle.gbdt, this.input(rec));
    return contributions
      .map((c, i) => ({ feature: this.bundle.gbdt.features[i], contribution: +c.toFixed(4) }))
      .filter((c) => Math.abs(c.contribution) > 1e-4)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, top);
  }
}
