import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeeksFraudEngine,
  MemoryVelocityStore,
  PERSONAS,
  LinkGraph,
  financialHealth,
  validateRule,
  evaluateRules,
  resolveThresholds,
  type DecisionRequest,
  type TenantConfig,
} from '../src';

const tenant = (over: Partial<TenantConfig> = {}): TenantConfig => ({
  tenant_id: 'gw_ug_001',
  mode: 'live',
  thresholds: { default: { review: 50, reject: 80 } },
  rules: [],
  ...over,
});

const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  session_id: 's1',
  checkpoint: 'checkout',
  merchant: { id: 'mer_88', segment: 'ecommerce', country: 'UG' },
  transaction: { id: `ord_${Math.random()}`, amount: 450_000, currency: 'UGX', payment_method: 'mobile_money' },
  payer: { msisdn_hash: 'sha256:aa', network: 'MTN', ip: '102.85.12.40', country: 'UG', account_age_days: 200 },
  ...over,
});

test('honest human approves with full coverage and no reasons', async () => {
  const e = new GeeksFraudEngine();
  const p = PERSONAS.sbx_human;
  const r = await e.decide(req(), { tenant: tenant(), behavior: p.behavior, enrichment: p.enrichment });
  assert.equal(r.decision, 'APPROVE');
  assert.equal(r.signals_coverage, 'full');
  assert.equal(r.reasons.length, 0);
  assert.ok(r.decision_id.startsWith('dec_'));
  assert.ok(r.latency_ms < 50, `latency ${r.latency_ms}`);
});

test('every sandbox persona returns its documented decision', async () => {
  for (const p of Object.values(PERSONAS)) {
    const e = new GeeksFraudEngine();
    const payer =
      p.key === 'sbx_account_takeover'
        ? { ...req().payer, sim_swap_days: 1, name_match: 'partial' as const }
        : req().payer;
    const r = await e.decide(req({ payer }), { tenant: tenant(), behavior: p.behavior, enrichment: p.enrichment });
    assert.equal(r.decision, p.expected, `${p.key}: got ${r.decision} (${r.geek_score}) ${r.reasons.map((x) => x.code)}`);
  }
});

test('bot is rejected with automation as the top reason', async () => {
  const e = new GeeksFraudEngine();
  const p = PERSONAS.sbx_bot;
  const r = await e.decide(req(), { tenant: tenant(), behavior: p.behavior, enrichment: p.enrichment });
  assert.equal(r.decision, 'REJECT');
  assert.ok(r.geek_score >= 90);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('FG_AUTOMATION_DETECTED'));
  assert.ok(codes.includes('FG_UNIFORM_KEYSTROKE_TIMING'));
  assert.ok(codes.includes('FG_PROGRAMMATIC_FILL'));
  // contributions are ordered and sum to the score (before rules)
  const sum = r.reasons.reduce((a, x) => a + x.contribution, 0);
  assert.ok(Math.abs(sum - r.geek_score) <= r.reasons.length, `sum ${sum} vs ${r.geek_score}`);
});

test('shadow mode: decision logged but effective decision is APPROVE (FR-309)', async () => {
  const e = new GeeksFraudEngine();
  const p = PERSONAS.sbx_bot;
  const r = await e.decide(req(), { tenant: tenant({ mode: 'shadow' }), behavior: p.behavior, enrichment: p.enrichment });
  assert.equal(r.decision, 'REJECT');
  assert.equal(r.effective_decision, 'APPROVE');
  assert.equal(r.mode, 'shadow');
});

test('no telemetry → partial/none coverage, still scored on server signals (FR-303)', async () => {
  const e = new GeeksFraudEngine();
  const r = await e.decide(req(), { tenant: tenant(), enrichment: { ip: { country: 'NG', is_tor: true } } });
  assert.equal(r.signals_coverage, 'none');
  assert.ok(r.reasons.some((x) => x.code === 'FG_IP_HOSTING_OR_PROXY'));
  assert.ok(r.reasons.some((x) => x.code === 'FG_GEO_MISMATCH'));
  assert.equal(r.decision, 'REVIEW');
});

test('consent off drops behavioral signals but keeps automation (FR-111)', async () => {
  const e = new GeeksFraudEngine();
  const b = { ...PERSONAS.sbx_bot.behavior, consent: false };
  const r = await e.decide(req(), { tenant: tenant(), behavior: b });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('FG_AUTOMATION_DETECTED'));
  assert.ok(!codes.includes('FG_UNIFORM_KEYSTROKE_TIMING'));
  assert.equal(r.signals_coverage, 'partial');
});

test('PRD US-05 rule: REJECT if webdriver and amount > UGX 500,000 always wins', async () => {
  const rule = {
    id: 'rule_42_webdriver_high_value',
    name: 'Webdriver high value',
    enabled: true,
    conditions: {
      all: [
        { field: 'behavior.automation.webdriver', op: 'eq' as const, value: true },
        { field: 'transaction.amount', op: 'gt' as const, value: 500_000 },
      ],
    },
    action: { type: 'REJECT' as const },
  };
  assert.deepEqual(validateRule(rule), []);
  const e = new GeeksFraudEngine();
  const behavior = { device_id: 'd', automation: { webdriver: true } };
  const hi = await e.decide(req({ transaction: { id: 'a', amount: 600_000, currency: 'UGX', payment_method: 'mobile_money' } }), {
    tenant: tenant({ rules: [rule], thresholds: { default: { review: 95, reject: 99 } } }),
    behavior,
  });
  assert.equal(hi.decision, 'REJECT');
  assert.deepEqual(hi.rule_hits, ['rule_42_webdriver_high_value']);
  assert.ok(hi.reasons.some((x) => x.code === 'FG_RULE_MATCH'));
  const lo = await e.decide(req({ transaction: { id: 'b', amount: 100_000, currency: 'UGX', payment_method: 'mobile_money' } }), {
    tenant: tenant({ rules: [rule], thresholds: { default: { review: 95, reject: 99 } } }),
    behavior,
  });
  assert.deepEqual(lo.rule_hits, []);
});

test('rule priority and severity tie-break; ADD_SCORE adds points', () => {
  const facts = { geek_score: 10, payer: { network: 'MTN' } };
  const r = evaluateRules(
    [
      { id: 'a', name: 'a', enabled: true, conditions: { all: [{ field: 'payer.network', op: 'eq', value: 'mtn' }] }, action: { type: 'APPROVE' } },
      { id: 'b', name: 'b', enabled: true, conditions: { all: [{ field: 'payer.network', op: 'in', value: ['MTN', 'Airtel'] }] }, action: { type: 'REVIEW' } },
      { id: 'c', name: 'c', enabled: true, priority: 5, conditions: { any: [{ field: 'geek_score', op: 'lt', value: 20 }] }, action: { type: 'APPROVE' } },
      { id: 'd', name: 'd', enabled: true, conditions: { all: [{ field: 'payer.network', op: 'exists' }] }, action: { type: 'ADD_SCORE', points: 15 } },
      { id: 'e', name: 'e', enabled: false, priority: 99, conditions: { all: [{ field: 'payer.network', op: 'exists' }] }, action: { type: 'REJECT' } },
    ],
    facts,
  );
  assert.equal(r.forced, 'APPROVE');
  assert.equal(r.forcedBy?.id, 'c');
  assert.equal(r.addScore, 15);
  assert.deepEqual(r.hits.map((h) => h.id), ['a', 'b', 'c', 'd']);
});

test('thresholds: merchant overrides segment overrides default (FR-504)', () => {
  const cfg = { default: { review: 50, reject: 80 }, segments: { betting: { review: 40, reject: 70 } }, merchants: { m1: { reject: 90 } } };
  assert.deepEqual(resolveThresholds(cfg, 'x', 'betting'), { review: 40, reject: 70 });
  assert.deepEqual(resolveThresholds(cfg, 'm1', 'betting'), { review: 40, reject: 90 });
  assert.deepEqual(resolveThresholds(cfg, 'x'), { review: 50, reject: 80 });
});

test('velocity: one device cycling through phone numbers trips FG_DEVICE_VELOCITY', async () => {
  const e = new GeeksFraudEngine(new MemoryVelocityStore());
  const now = Date.now();
  let last;
  for (let i = 0; i < 6; i++) {
    last = await e.decide(req({ payer: { msisdn_hash: `sha256:n${i}`, ip: '1.1.1.1' } }), {
      tenant: tenant(),
      behavior: { device_id: 'dev_farm' },
      now: now + i * 1000,
    });
  }
  assert.ok(last!.reasons.some((x) => x.code === 'FG_DEVICE_VELOCITY'));
  assert.equal(last!.velocity.device_identities_24h, 6);
});

test('velocity is isolated per tenant', async () => {
  const store = new MemoryVelocityStore();
  const e = new GeeksFraudEngine(store);
  for (let i = 0; i < 5; i++) {
    await e.decide(req({ payer: { msisdn_hash: `h${i}` } }), { tenant: tenant({ tenant_id: 'A' }), behavior: { device_id: 'shared' } });
  }
  const r = await e.decide(req({ payer: { msisdn_hash: 'x' } }), { tenant: tenant({ tenant_id: 'B' }), behavior: { device_id: 'shared' } });
  assert.equal(r.velocity.device_identities_24h, 1);
});

test('mobile money: recent SIM swap + name mismatch → REVIEW or worse', async () => {
  const e = new GeeksFraudEngine();
  const r = await e.decide(req({ payer: { msisdn_hash: 'z', sim_swap_days: 2, name_match: 'mismatch' } }), { tenant: tenant() });
  assert.ok(['REVIEW', 'REJECT'].includes(r.decision));
  assert.ok(r.reasons.some((x) => x.code === 'FG_SIM_SWAP_RECENT'));
  assert.ok(r.reasons.some((x) => x.code === 'FG_NAME_MISMATCH'));
});

test('allow-list approves unless automation is present', async () => {
  const e = new GeeksFraudEngine();
  const a = await e.decide(req({ payer: { msisdn_hash: 'q', sim_swap_days: 1, name_match: 'mismatch' } }), {
    tenant: tenant(),
    enrichment: { lists: { allowed: ['msisdn'] } },
  });
  assert.equal(a.decision, 'APPROVE');
  const b = await e.decide(req(), { tenant: tenant(), behavior: PERSONAS.sbx_bot.behavior, enrichment: { lists: { allowed: ['msisdn'] } } });
  assert.equal(b.decision, 'REJECT');
});

test('ML model blends in and a failing model never breaks the decision', async () => {
  const e = new GeeksFraudEngine();
  const ok = await e.decide(req(), { tenant: tenant(), model: { version: 'gbdt-1', score: () => 0.95 } });
  assert.ok(ok.geek_score >= 60);
  assert.match(ok.model_version, /gbdt-1/);
  const broken = await e.decide(req(), { tenant: tenant(), model: { version: 'x', score: () => { throw new Error('boom'); } } });
  assert.equal(broken.decision, 'APPROVE');
  assert.match(broken.model_version, /model_unavailable/);
});

test('graph: fraud distance, mule fan-in, circular flow and supernode guard', () => {
  const g = new LinkGraph({ supernodeDegree: 50 });
  const t = Date.now();
  g.observe({ device: 'd1', msisdn: 'm1' }, 100, t);
  g.observe({ device: 'd1', msisdn: 'm2' }, 100, t);
  g.label(LinkGraph.id('msisdn', 'm1'), 'fraud');
  assert.equal(g.fraudDistance({ msisdn: 'm2' }), 2); // m2 → d1 → m1
  assert.equal(g.fraudDistance({ msisdn: 'm1' }), 0);
  assert.equal(g.fraudDistance({ msisdn: 'unknown' }), null);

  for (let i = 0; i < 12; i++) g.observe({ msisdn: `p${i}`, beneficiary: 'mule' }, 1000, t);
  assert.equal(g.fanIn('mule', 86_400_000, t), 12);

  // A → B → C, then C pays A: closes a cycle
  g.observe({ account: 'A', beneficiary: 'B' }, 500, t);
  g.observe({ account: 'B', beneficiary: 'C' }, 480, t);
  assert.ok(g.closesCycle({ account: 'C', beneficiary: 'A' }, 4, undefined, t));
  assert.equal(g.closesCycle({ account: 'Z', beneficiary: 'A' }, 4, undefined, t), null);

  const enr = g.enrichment({ msisdn: 'm2', device: 'd1' }, t);
  assert.equal(enr.fraud_distance, 1);
  const sub = g.subgraph({ msisdn: 'm2' });
  assert.ok(sub.nodes.length >= 3);
});

test('graph enrichment raises the geek score', async () => {
  const e = new GeeksFraudEngine();
  const r = await e.decide(req({ beneficiary: { account_hash: 'mule' } }), {
    tenant: tenant(),
    enrichment: { graph: { fraud_distance: 1, beneficiary_fan_in: 25, closes_cycle: true } },
  });
  assert.equal(r.decision, 'REJECT');
  const codes = r.reasons.map((x) => x.code);
  for (const c of ['FG_LINKED_TO_FRAUD_NETWORK', 'FG_MULE_FAN_IN', 'FG_CIRCULAR_FLOW']) assert.ok(codes.includes(c), c);
});

test('financial health: steady saver is healthy, scam victim is vulnerable', () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const steady = [];
  for (let m = 0; m < 4; m++) {
    steady.push({ ts: now - (m * 30 + 1) * DAY, amount: 800_000, category: 'income' as const, counterparty: 'employer' });
    steady.push({ ts: now - (m * 30 + 2) * DAY, amount: 80_000, category: 'income' as const, counterparty: 'side' });
    steady.push({ ts: now - (m * 30 + 3) * DAY, amount: 100_000, category: 'savings_in' as const });
    for (let d = 0; d < 10; d++) steady.push({ ts: now - (m * 30 + 4 + d) * DAY, amount: 55_000, category: 'expense' as const });
  }
  const a = financialHealth({ transactions: steady, balance: 900_000, now });
  assert.equal(a.tier, 'healthy', JSON.stringify(a.pillars));

  const victim = [
    { ts: now - 40 * DAY, amount: 300_000, category: 'income' as const },
    { ts: now - 10 * DAY, amount: 50_000, category: 'income' as const },
    { ts: now - 9 * DAY, amount: 250_000, category: 'transfer_out' as const, fraud_loss: true },
    { ts: now - 5 * DAY, amount: 120_000, category: 'loan_in' as const },
    { ts: now - 2 * DAY, amount: 90_000, category: 'loan_repayment' as const },
    { ts: now - 1 * DAY, amount: 100_000, category: 'expense' as const },
  ];
  const b = financialHealth({ transactions: victim, balance: 5_000, sim_swap_days: 3, now });
  assert.equal(b.tier, 'vulnerable', JSON.stringify(b));
  assert.ok(b.nudges.some((n) => n.includes('PIN')));
  assert.equal(b.confidence, 'low');
});
