import { REASONS } from './reasons';
import type {
  BehaviorSummary,
  DecisionRequest,
  Enrichment,
  ReasonHit,
  VelocityLimits,
  VelocitySnapshot,
} from './types';

export const DEFAULT_LIMITS: VelocityLimits = {
  identities_per_device_24h: 3,
  devices_per_msisdn_1h: 3,
  merchants_per_msisdn_1h: 4,
  prompts_per_msisdn_1h: 5,
  tx_per_ip_1h: 20,
  session_min_ms: 3_000,
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Scales a count over a threshold into a 0..1 strength: at N → 0.5, at 2N → 1. */
function overLimit(n: number, limit: number): number {
  if (n < limit) return 0;
  return clamp01(0.5 + (n - limit) / (2 * limit));
}

interface Ctx {
  req: DecisionRequest;
  behavior?: BehaviorSummary;
  enrichment: Enrichment;
  velocity: VelocitySnapshot;
  limits: VelocityLimits;
}

type Detector = (ctx: Ctx) => { strength: number; detail?: Record<string, unknown> } | null;

const IDENTITY_ROLES = new Set(['name', 'first_name', 'last_name', 'card_holder']);
const CONTACT_ROLES = new Set(['address', 'phone', 'email']);

const detectors: Record<string, Detector> = {
  FG_AUTOMATION_DETECTED: ({ behavior }) => {
    const a = behavior?.automation;
    if (!a) return null;
    const flags = (['webdriver', 'headless', 'cdp'] as const).filter((f) => a[f]);
    return flags.length ? { strength: 1, detail: { flags } } : null;
  },

  FG_EMULATOR_OR_ROOTED: ({ behavior }) => {
    const a = behavior?.automation;
    if (!a || !(a.emulator || a.rooted)) return null;
    return { strength: 1, detail: { emulator: !!a.emulator, rooted: !!a.rooted } };
  },

  FG_INCONSISTENT_DEVICE: ({ behavior }) =>
    behavior?.automation?.inconsistent_hints ? { strength: 1 } : null,

  FG_UNIFORM_KEYSTROKE_TIMING: ({ behavior }) => {
    const t = behavior?.typing;
    if (!t || t.keys < 8 || t.flight_mean_ms <= 0) return null;
    // Coefficient of variation of inter-key flight time. Humans sit ~0.3–0.8.
    const cv = Math.sqrt(Math.max(0, t.flight_var)) / t.flight_mean_ms;
    if (cv >= 0.08) return null;
    return { strength: cv <= 0.03 ? 1 : clamp01((0.08 - cv) / 0.05), detail: { flight_cv: +cv.toFixed(4), keys: t.keys } };
  },

  FG_PROGRAMMATIC_FILL: ({ behavior }) => {
    const fields = behavior?.fields ?? [];
    const bad = fields.filter((f) => f.programmatic && f.keys === 0 && !f.pasted && !f.autofilled);
    return bad.length ? { strength: clamp01(bad.length / 2), detail: { fields: bad.map((f) => f.role) } } : null;
  },

  FG_IDENTITY_FIELDS_PASTED: ({ behavior }) => {
    const fields = behavior?.fields ?? [];
    const fast = (f: { first_input_ms?: number }) => f.first_input_ms === undefined || f.first_input_ms <= 2_000;
    const idPasted = fields.some((f) => IDENTITY_ROLES.has(f.role) && f.pasted && fast(f));
    const contactPasted = fields.some((f) => CONTACT_ROLES.has(f.role) && f.pasted && fast(f));
    return idPasted && contactPasted ? { strength: 1 } : null;
  },

  FG_STRAIGHT_LINE_POINTER: ({ behavior }) => {
    const p = behavior?.pointer;
    if (!p || p.moves < 10) return null;
    if (p.straight_ratio < 0.95 || p.speed_var > 0.05) return null;
    return { strength: clamp01((p.straight_ratio - 0.95) / 0.04), detail: { straight_ratio: p.straight_ratio } };
  },

  FG_SESSION_TOO_FAST: ({ behavior, enrichment, limits, req }) => {
    const d = behavior?.session?.duration_ms;
    if (d === undefined || (req.checkpoint && req.checkpoint !== 'checkout' && req.checkpoint !== 'signup')) return null;
    const floor = enrichment.merchant_stats?.session_p01_ms ?? limits.session_min_ms;
    if (d >= floor) return null;
    return { strength: clamp01(1 - d / floor + 0.3), detail: { duration_ms: d, floor_ms: floor } };
  },

  FG_DEVICE_VELOCITY: ({ velocity, limits }) => {
    const n = Math.max(velocity.device_identities_24h, velocity.device_cards_24h);
    const s = overLimit(n, limits.identities_per_device_24h);
    return s ? { strength: s, detail: { identities: velocity.device_identities_24h, cards: velocity.device_cards_24h } } : null;
  },

  FG_MSISDN_VELOCITY: ({ velocity, limits }) => {
    const s = Math.max(
      overLimit(velocity.msisdn_devices_1h, limits.devices_per_msisdn_1h),
      overLimit(velocity.msisdn_merchants_1h, limits.merchants_per_msisdn_1h),
    );
    return s ? { strength: s, detail: { devices: velocity.msisdn_devices_1h, merchants: velocity.msisdn_merchants_1h } } : null;
  },

  FG_IP_VELOCITY: ({ velocity, limits }) => {
    const s = overLimit(velocity.ip_tx_1h, limits.tx_per_ip_1h);
    return s ? { strength: s, detail: { tx_1h: velocity.ip_tx_1h } } : null;
  },

  FG_CARD_TESTING: ({ velocity, req }) => {
    if (!req.card) return null;
    if (velocity.device_cards_24h >= 4 || velocity.bin_tx_1h >= 25) {
      return { strength: clamp01(Math.max(velocity.device_cards_24h / 8, velocity.bin_tx_1h / 50)), detail: { cards: velocity.device_cards_24h, bin_1h: velocity.bin_tx_1h } };
    }
    return null;
  },

  FG_IP_HOSTING_OR_PROXY: ({ enrichment }) => {
    const ip = enrichment.ip;
    if (!ip) return null;
    if (ip.is_tor) return { strength: 1, detail: { kind: 'tor' } };
    if (ip.is_hosting || ip.is_vpn || ip.is_proxy) {
      return { strength: 0.8, detail: { kind: ip.is_hosting ? 'hosting' : ip.is_vpn ? 'vpn' : 'proxy' } };
    }
    return null;
  },

  FG_GEO_MISMATCH: ({ enrichment, req }) => {
    const ipc = enrichment.ip?.country?.toUpperCase();
    if (!ipc) return null;
    const others = [req.payer.country, req.card?.country, req.shipping?.country]
      .filter((c): c is string => !!c)
      .map((c) => c.toUpperCase());
    const mismatched = others.filter((c) => c !== ipc);
    if (!mismatched.length) return null;
    return { strength: mismatched.length === others.length ? 1 : 0.6, detail: { ip_country: ipc, other: mismatched } };
  },

  FG_DISPOSABLE_EMAIL: ({ enrichment }) => {
    const e = enrichment.email;
    if (!e) return null;
    if (e.disposable) return { strength: 1 };
    if (e.domain_age_days !== undefined && e.domain_age_days < 30) return { strength: 0.7, detail: { domain_age_days: e.domain_age_days } };
    if (e.mx === false) return { strength: 0.6, detail: { mx: false } };
    return null;
  },

  FG_NEW_ACCOUNT_HIGH_VALUE: ({ req, enrichment }) => {
    const age = req.payer.account_age_days;
    const p95 = enrichment.merchant_stats?.amount_p95;
    if (age === undefined || age >= 7 || !p95) return null;
    if (req.transaction.amount <= p95) return null;
    return { strength: clamp01(0.5 + (req.transaction.amount / p95 - 1) / 2), detail: { account_age_days: age, amount_vs_p95: +(req.transaction.amount / p95).toFixed(2) } };
  },

  FG_SIM_SWAP_RECENT: ({ req }) => {
    const d = req.payer.sim_swap_days;
    if (d === undefined || d === null) return null;
    if (d <= 7) return { strength: 1, detail: { sim_swap_days: d } };
    if (d <= 30) return { strength: 0.5, detail: { sim_swap_days: d } };
    return null;
  },

  FG_NAME_MISMATCH: ({ req }) => {
    if (req.payer.name_match === 'mismatch') return { strength: 1 };
    if (req.payer.name_match === 'partial') return { strength: 0.4 };
    return null;
  },

  FG_COLLECTION_PROMPT_ABUSE: ({ req, velocity, limits }) => {
    if (req.transaction.payment_method !== 'mobile_money') return null;
    const s = overLimit(velocity.msisdn_tx_1h, limits.prompts_per_msisdn_1h);
    return s ? { strength: s, detail: { prompts_1h: velocity.msisdn_tx_1h } } : null;
  },

  FG_DEVICE_LINKED_TO_FRAUD: ({ enrichment }) => {
    const h = enrichment.history;
    if (!h) return null;
    const via = (['device_fraud', 'msisdn_fraud', 'email_fraud'] as const).filter((k) => h[k]);
    return via.length ? { strength: 1, detail: { via } } : null;
  },

  FG_LINKED_TO_FRAUD_NETWORK: ({ enrichment }) => {
    const d = enrichment.graph?.fraud_distance;
    if (d === undefined || d === null || d === 0 || d > 2) return null;
    return { strength: d === 1 ? 1 : 0.6, detail: { hops: d } };
  },

  FG_MULE_FAN_IN: ({ enrichment }) => {
    const n = enrichment.graph?.beneficiary_fan_in ?? 0;
    const s = overLimit(n, 10);
    return s ? { strength: s, detail: { distinct_payers: n } } : null;
  },

  FG_CIRCULAR_FLOW: ({ enrichment }) => (enrichment.graph?.closes_cycle ? { strength: 1 } : null),

  FG_SHARED_DEVICE_CLUSTER: ({ enrichment }) => {
    const n = enrichment.graph?.cluster_size ?? 0;
    const s = overLimit(n, 5);
    return s ? { strength: s, detail: { cluster_size: n } } : null;
  },

  FG_BLOCKLIST_MATCH: ({ enrichment }) => {
    const hits = enrichment.lists?.blocked ?? [];
    return hits.length ? { strength: 1, detail: { matched: hits } } : null;
  },
};

/** Runs every detector and returns reason hits (contribution filled in by the scorer). */
export function detectSignals(ctx: Ctx): ReasonHit[] {
  const hits: ReasonHit[] = [];
  for (const [code, detect] of Object.entries(detectors)) {
    const r = detect(ctx);
    if (!r || r.strength <= 0) continue;
    const def = REASONS[code];
    hits.push({
      code,
      family: def.family,
      severity: def.severity,
      strength: +r.strength.toFixed(3),
      contribution: 0,
      merchant_text: def.merchant_text,
      ...(r.detail ? { detail: r.detail } : {}),
    });
  }
  return hits;
}

/**
 * Numeric feature vector (PRD §10.3 feature families) — what an ML model trains on.
 * Stable names; missing values are -1 so tree models can split on "absent".
 */
export function extractFeatures(
  req: DecisionRequest,
  behavior: BehaviorSummary | undefined,
  enrichment: Enrichment,
  velocity: VelocitySnapshot,
): Record<string, number> {
  const t = behavior?.typing;
  const fields = behavior?.fields ?? [];
  const p = behavior?.pointer;
  const a = behavior?.automation ?? {};
  const b = (v: boolean | undefined) => (v === undefined ? -1 : v ? 1 : 0);
  const n = (v: number | undefined | null) => (v === undefined || v === null ? -1 : v);
  const flightCv = t && t.flight_mean_ms > 0 ? Math.sqrt(Math.max(0, t.flight_var)) / t.flight_mean_ms : -1;

  return {
    // typing
    typing_keys: n(t?.keys),
    typing_hold_mean: n(t?.hold_mean_ms),
    typing_flight_mean: n(t?.flight_mean_ms),
    typing_flight_cv: flightCv,
    typing_backspace_ratio: t && t.keys > 0 ? t.backspaces / t.keys : -1,
    // form
    form_paste_count: fields.filter((f) => f.pasted).length,
    form_autofill_count: fields.filter((f) => f.autofilled).length,
    form_programmatic_count: fields.filter((f) => f.programmatic).length,
    form_first_input_ms: n(fields.length ? Math.min(...fields.map((f) => f.first_input_ms ?? Infinity)) : undefined),
    // pointer
    pointer_moves: n(p?.moves),
    pointer_straight_ratio: n(p?.straight_ratio),
    pointer_speed_var: n(p?.speed_var),
    // environment
    env_webdriver: b(a.webdriver),
    env_headless: b(a.headless),
    env_emulator: b(a.emulator),
    env_touch: b(behavior?.env?.touch),
    session_ms: n(behavior?.session?.duration_ms),
    // velocity
    vel_device_identities_24h: velocity.device_identities_24h,
    vel_device_cards_24h: velocity.device_cards_24h,
    vel_msisdn_devices_1h: velocity.msisdn_devices_1h,
    vel_msisdn_merchants_1h: velocity.msisdn_merchants_1h,
    vel_msisdn_tx_24h: velocity.msisdn_tx_24h,
    vel_ip_tx_1h: velocity.ip_tx_1h,
    // network
    net_hosting: b(enrichment.ip?.is_hosting),
    net_vpn_proxy_tor: b(enrichment.ip ? !!(enrichment.ip.is_vpn || enrichment.ip.is_proxy || enrichment.ip.is_tor) : undefined),
    net_geo_mismatch: enrichment.ip?.country && req.payer.country ? +(enrichment.ip.country !== req.payer.country) : -1,
    // account / payment
    acct_age_days: n(req.payer.account_age_days),
    amount_minor: req.transaction.amount,
    amount_vs_p95: enrichment.merchant_stats?.amount_p95 ? req.transaction.amount / enrichment.merchant_stats.amount_p95 : -1,
    pm_mobile_money: +(req.transaction.payment_method === 'mobile_money'),
    pm_card: +(req.transaction.payment_method === 'card'),
    mm_sim_swap_days: n(req.payer.sim_swap_days),
    mm_name_mismatch: req.payer.name_match ? +(req.payer.name_match === 'mismatch') : -1,
    // history / graph
    hist_linked_fraud: b(enrichment.history ? !!(enrichment.history.device_fraud || enrichment.history.msisdn_fraud) : undefined),
    graph_fraud_distance: n(enrichment.graph?.fraud_distance),
    graph_fan_in: n(enrichment.graph?.beneficiary_fan_in),
  };
}
