import { REASONS, SEVERITY_WEIGHT } from './reasons';
import { evaluateRules } from './rules';
import { DEFAULT_LIMITS, detectSignals, extractFeatures } from './signals';
import { MemoryVelocityStore, recordAndSnapshot, type VelocityStore } from './velocity';
import type {
  BehaviorSummary,
  Decision,
  DecisionRequest,
  DecisionResult,
  Enrichment,
  ModelScorer,
  ReasonHit,
  SignalsCoverage,
  TenantConfig,
  Thresholds,
} from './types';

export const ENGINE_VERSION = 'gs-2026.11.0';

export const DEFAULT_THRESHOLDS: Thresholds = { review: 50, reject: 80 };

export interface DecideOptions {
  tenant: TenantConfig;
  behavior?: BehaviorSummary;
  enrichment?: Enrichment;
  model?: ModelScorer;
  now?: number;
  /** Override decision id (e.g. for idempotent replays). */
  decisionId?: string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-style sortable id: 10 chars time + 16 chars randomness. */
export function newDecisionId(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return `dec_${time}${rand}`;
}

export function resolveThresholds(cfg: TenantConfig['thresholds'], merchantId: string, segment?: string): Thresholds {
  const base = { ...DEFAULT_THRESHOLDS, ...cfg.default };
  const seg = segment ? cfg.segments?.[segment] : undefined;
  const mer = cfg.merchants?.[merchantId];
  const t = { ...base, ...(seg ?? {}), ...(mer ?? {}) };
  if (t.reject < t.review) t.reject = t.review;
  return t;
}

function coverage(behavior?: BehaviorSummary): SignalsCoverage {
  if (!behavior) return 'none';
  if (behavior.consent === false) return 'partial';
  const families = [behavior.typing, behavior.pointer, behavior.fields?.length ? behavior.fields : undefined, behavior.automation];
  const present = families.filter(Boolean).length;
  return present >= 3 ? 'full' : 'partial';
}

/**
 * Combine reason strengths with a noisy-OR and attribute each reason's
 * marginal contribution so the console can draw an explainable waterfall.
 */
export function combine(hits: ReasonHit[]): number {
  const ordered = [...hits].sort((a, b) => SEVERITY_WEIGHT[b.severity] * b.strength - SEVERITY_WEIGHT[a.severity] * a.strength);
  let survive = 1;
  for (const h of ordered) {
    const p = SEVERITY_WEIGHT[h.severity] * h.strength;
    const before = 1 - survive;
    survive *= 1 - p;
    h.contribution = Math.round((1 - survive - before) * 100);
  }
  hits.splice(0, hits.length, ...ordered);
  return 1 - survive;
}

export function decisionFor(score: number, t: Thresholds): Decision {
  if (score >= t.reject) return 'REJECT';
  if (score >= t.review) return 'REVIEW';
  return 'APPROVE';
}

export class GeeksFraudEngine {
  constructor(private readonly velocity: VelocityStore = new MemoryVelocityStore()) {}

  async decide(req: DecisionRequest, opts: DecideOptions): Promise<DecisionResult> {
    const started = performance.now();
    const now = opts.now ?? Date.now();
    const tenant = opts.tenant;
    const enrichment = opts.enrichment ?? {};
    // When the gateway's consent flag is off, use only device/automation signals (FR-111).
    const behavior = opts.behavior && opts.behavior.consent === false
      ? { device_id: opts.behavior.device_id, consent: false, automation: opts.behavior.automation, env: opts.behavior.env }
      : opts.behavior;
    const deviceId = behavior?.device_id ?? null;
    const limits = { ...DEFAULT_LIMITS, ...(tenant.limits ?? {}) };

    const velocity = await recordAndSnapshot(this.velocity, tenant.tenant_id, req, deviceId, now);
    const hits = detectSignals({ req, behavior, enrichment, velocity, limits });

    // Lists: an allow-list hit approves unless a critical environment signal fired.
    const allowListed = (enrichment.lists?.allowed?.length ?? 0) > 0;

    let p = combine(hits);
    const features = extractFeatures(req, behavior, enrichment, velocity);
    let modelVersion = `${ENGINE_VERSION}+rules`;
    if (opts.model) {
      try {
        const mp = Math.min(1, Math.max(0, await opts.model.score(features)));
        const w = tenant.model_weight ?? 0.7;
        p = 1 - (1 - p) * (1 - mp * w);
        modelVersion = `${ENGINE_VERSION}+${opts.model.version}`;
      } catch {
        modelVersion = `${ENGINE_VERSION}+rules(model_unavailable)`;
      }
    }
    // Known-good history dampens risk (confirmed_good labels on this device).
    if (enrichment.history?.device_good && !enrichment.history.device_fraud) p *= 0.6;

    let score = Math.round(p * 100);
    const thresholds = resolveThresholds(tenant.thresholds, req.merchant.id, req.merchant.segment);

    const facts = {
      ...req,
      behavior: behavior ?? {},
      enrichment,
      velocity,
      features,
      geek_score: score,
      reasons: hits.map((h) => h.code),
      signals_coverage: coverage(behavior),
    };
    const ruleOutcome = evaluateRules(tenant.rules, facts);
    score = Math.max(0, Math.min(100, score + ruleOutcome.addScore));

    let decision: Decision = decisionFor(score, thresholds);
    if (ruleOutcome.forced) decision = ruleOutcome.forced;
    else if (allowListed && !hits.some((h) => h.severity === 'critical' && h.family === 'environment')) decision = 'APPROVE';

    // Every rule hit appears in reasons[] (FR-302).
    const def = REASONS.FG_RULE_MATCH;
    for (const r of ruleOutcome.hits) {
      hits.push({
        code: 'FG_RULE_MATCH',
        family: 'rules',
        severity: r.severity ?? def.severity,
        strength: 1,
        contribution: r.action.type === 'ADD_SCORE' ? r.action.points : 0,
        merchant_text: r.merchant_text ?? def.merchant_text,
        detail: { rule_id: r.id, rule_name: r.name, action: r.action.type },
      });
    }

    const mode = tenant.mode;
    return {
      decision_id: opts.decisionId ?? newDecisionId(now),
      geek_score: score,
      decision,
      effective_decision: mode === 'shadow' ? 'APPROVE' : decision,
      mode,
      signals_coverage: coverage(behavior),
      reasons: hits,
      rule_hits: ruleOutcome.hits.map((r) => r.id),
      device_id: deviceId,
      model_version: modelVersion,
      thresholds,
      velocity,
      features,
      latency_ms: +(performance.now() - started).toFixed(2),
    };
  }
}
