/**
 * Public types for the GeeksFraud decision engine.
 * Amounts are always integer minor units with an ISO-4217 currency (NFR-22).
 */

export type Decision = 'APPROVE' | 'REVIEW' | 'REJECT';
export type Mode = 'live' | 'shadow' | 'sandbox';
export type Checkpoint = 'signup' | 'login' | 'checkout' | 'payout' | 'password_reset';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type SignalsCoverage = 'full' | 'partial' | 'none';
export type PaymentMethod = 'mobile_money' | 'card' | 'bank_transfer' | 'wallet' | 'ussd' | 'crypto' | 'other';

export type SignalFamily =
  | 'environment'
  | 'typing'
  | 'form'
  | 'pointer'
  | 'session'
  | 'velocity'
  | 'network'
  | 'email'
  | 'account'
  | 'mobile_money'
  | 'history'
  | 'graph'
  | 'lists'
  | 'rules';

/** Request body for POST /v1/decisions (PRD §11.2). */
export interface DecisionRequest {
  session_id?: string;
  checkpoint?: Checkpoint;
  merchant: { id: string; segment?: string; country?: string };
  transaction: {
    id: string;
    amount: number;
    currency: string;
    payment_method: PaymentMethod;
    created_at?: string;
  };
  payer: {
    msisdn_hash?: string;
    network?: string;
    email?: string;
    ip?: string;
    account_id_hash?: string;
    account_age_days?: number;
    /** Country of the wallet / payer account (ISO-3166 alpha-2). */
    country?: string;
    /** Registered-name check from the mobile-money rail (FR-603). */
    name_match?: 'match' | 'partial' | 'mismatch';
    /** Days since the SIM was last swapped, from a telco/aggregator API (FR-604). */
    sim_swap_days?: number;
  };
  /** Never the full PAN or CVV: BIN + last4 only. */
  card?: { bin: string; last4?: string; country?: string } | null;
  shipping?: { country?: string; city?: string } | null;
  /** Receiving account for payouts / P2P transfers — enables mule & circular-flow detection. */
  beneficiary?: { account_hash: string } | null;
}

/**
 * Derived behavioral summary produced by the browser/mobile SDK.
 * Contains timings and ratios only — never field values (FR-103, FR-108, NFR-16).
 */
export interface BehaviorSummary {
  device_id?: string;
  consent?: boolean;
  automation?: {
    webdriver?: boolean;
    headless?: boolean;
    cdp?: boolean;
    emulator?: boolean;
    rooted?: boolean;
    inconsistent_hints?: boolean;
  };
  typing?: {
    keys: number;
    hold_mean_ms: number;
    hold_var: number;
    flight_mean_ms: number;
    flight_var: number;
    backspaces: number;
  };
  fields?: Array<{
    role: string;
    pasted: boolean;
    autofilled: boolean;
    programmatic: boolean;
    keys: number;
    first_input_ms?: number;
  }>;
  pointer?: { moves: number; straight_ratio: number; speed_var: number; idle_gaps: number };
  session?: { duration_ms: number };
  env?: {
    timezone?: string;
    language?: string;
    touch?: boolean;
    screen?: string;
    cores?: number;
    ua?: string;
  };
}

/** Server-side enrichment the host supplies (IP intel, email intel, merchant stats, history, lists, graph). */
export interface Enrichment {
  ip?: {
    country?: string;
    asn?: number;
    is_hosting?: boolean;
    is_vpn?: boolean;
    is_tor?: boolean;
    is_proxy?: boolean;
  };
  email?: { disposable?: boolean; domain_age_days?: number; mx?: boolean };
  merchant_stats?: { amount_p95?: number; session_p01_ms?: number };
  history?: {
    device_fraud?: boolean;
    msisdn_fraud?: boolean;
    email_fraud?: boolean;
    device_good?: boolean;
  };
  lists?: { blocked?: string[]; allowed?: string[] };
  graph?: {
    /** Hops from this payer's identifiers to a confirmed-fraud node (0 = same node). */
    fraud_distance?: number | null;
    /** Personalized-PageRank mass reaching confirmed-fraud identities, 0..1. */
    fraud_proximity?: number;
    /** Distinct payers into the beneficiary over the lookback window. */
    beneficiary_fan_in?: number;
    /** True if the payment closes a directed money cycle. */
    closes_cycle?: boolean;
    /** Size of the shared-device/shared-number cluster around the payer. */
    cluster_size?: number;
  };
}

export interface ReasonHit {
  code: string;
  family: SignalFamily;
  severity: Severity;
  /** 0..1 — how strongly the signal fired. */
  strength: number;
  /** Score points this reason contributed (for UI waterfalls). */
  contribution: number;
  merchant_text: string;
  detail?: Record<string, unknown>;
}

export interface Thresholds {
  /** geek_score >= review → REVIEW */
  review: number;
  /** geek_score >= reject → REJECT */
  reject: number;
}

export interface ThresholdConfig {
  default: Thresholds;
  segments?: Record<string, Partial<Thresholds>>;
  merchants?: Record<string, Partial<Thresholds>>;
}

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists'
  | 'starts_with';

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionGroup {
  all?: Array<Condition | ConditionGroup>;
  any?: Array<Condition | ConditionGroup>;
  not?: Condition | ConditionGroup;
}

export type RuleAction =
  | { type: 'APPROVE' }
  | { type: 'REVIEW' }
  | { type: 'REJECT' }
  | { type: 'ADD_SCORE'; points: number };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** Higher wins when several forcing rules fire. Default 0. */
  priority?: number;
  version?: number;
  severity?: Severity;
  conditions: ConditionGroup;
  action: RuleAction;
  /** Optional merchant-facing explanation shown in reasons[]. */
  merchant_text?: string;
}

export interface TenantConfig {
  tenant_id: string;
  mode: Mode;
  thresholds: ThresholdConfig;
  rules: Rule[];
  /** Velocity limits (N in appendix A). */
  limits?: Partial<VelocityLimits>;
  /** Weight of an attached ML model when blending, 0..1. Default 0.7. */
  model_weight?: number;
  /** 'blend' (default) noisy-ORs the model with the expert score; 'stacked' uses the model's calibrated probability as the score. */
  model_mode?: 'blend' | 'stacked';
}

export interface VelocityLimits {
  identities_per_device_24h: number;
  devices_per_msisdn_1h: number;
  merchants_per_msisdn_1h: number;
  prompts_per_msisdn_1h: number;
  tx_per_ip_1h: number;
  session_min_ms: number;
}

export interface VelocitySnapshot {
  device_identities_24h: number;
  device_cards_24h: number;
  msisdn_devices_1h: number;
  msisdn_merchants_1h: number;
  msisdn_tx_1h: number;
  msisdn_tx_24h: number;
  ip_tx_1m: number;
  ip_tx_1h: number;
  email_tx_24h: number;
  bin_tx_1h: number;
  merchant_tx_1m: number;
}

export interface ModelScorer {
  version: string;
  /** Returns fraud probability 0..1 given the engine feature vector. */
  score(features: Record<string, number>): number | Promise<number>;
}

export interface DecisionResult {
  decision_id: string;
  geek_score: number;
  decision: Decision;
  /** What the gateway should actually do: APPROVE in shadow mode. */
  effective_decision: Decision;
  mode: Mode;
  signals_coverage: SignalsCoverage;
  reasons: ReasonHit[];
  rule_hits: string[];
  device_id: string | null;
  model_version: string;
  thresholds: Thresholds;
  velocity: VelocitySnapshot;
  features: Record<string, number>;
  latency_ms: number;
}
