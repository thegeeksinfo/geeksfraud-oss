/**
 * Synthetic payments benchmark for East African mobile-money checkouts.
 *
 * Purpose: compare scoring algorithms on data with realistic difficulty, until a
 * design partner's labelled traffic replaces it. Every fraud typology has a
 * legitimate look-alike, so a model only wins by genuinely separating them:
 *
 *   fraud                          legitimate look-alike
 *   naive bot (webdriver, script)  —
 *   stealth bot (no flags, jitter) fast human typers, password-manager autofill
 *   human fraud farm (shared       cybercafé / family devices shared by many
 *     devices, pasted identities)    honest payers; people pasting from contacts
 *   SIM-swap account takeover      honest new-SIM owners, travellers, VPN users
 *   mule cash-out (fan-in)         popular payout beneficiaries (merchants)
 *   friendly fraud (chargeback)    identical to honest traffic: irreducible noise
 *
 * Labels arrive with a chargeback delay (5–45 days) and 15 % of fraud is never
 * reported, exactly the label quality a real fraud team trains on.
 * Deterministic: same seed, same dataset.
 */
import { GeeksFraudEngine } from '../src/engine';
import { MemoryVelocityStore } from '../src/velocity';
import { LinkGraph, type Entities } from '../src/graph';
import { rng } from '../src/ml/gbdt';
import { stackedFeatures } from '../src/ml/model';
import type { BehaviorSummary, DecisionRequest, Enrichment, TenantConfig } from '../src/types';

export type Typology = 'legit' | 'naive_bot' | 'stealth_bot' | 'farm' | 'ato' | 'mule' | 'friendly';

export interface Row {
  ts: number;
  day: number;
  typology: Typology;
  fraud: 0 | 1;
  /** When (if ever) the fraud label becomes known to the operator. */
  knownAt: number | null;
  amount: number;
  segment: string;
  expertScore: number;
  raw: Record<string, number>;
  stacked: Record<string, number>;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 1);

export async function simulate(opts: { days?: number; perDay?: number; seed?: number } = {}): Promise<Row[]> {
  const DAYS = opts.days ?? 45;
  const PER_DAY = opts.perDay ?? 1000;
  const r = rng(opts.seed ?? 42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const between = (a: number, b: number) => a + r() * (b - a);
  const logn = (median: number, sigma: number) => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()));

  // ── population ──
  const N_USERS = 9000;
  const cafeDevices = Array.from({ length: 40 }, (_, i) => `cafe_${i}`);
  const users = Array.from({ length: N_USERS }, (_, i) => {
    const family = i > 0 && r() < 0.05;
    return {
      msisdn: `256${String(700000000 + i)}`,
      devices: family ? [`d${i - 1}`] : r() < 0.1 ? [`d${i}`, `d${i}b`] : [`d${i}`],
      cafe: r() < 0.08,
      createdDay: r() < 0.12 ? Math.floor(between(0, DAYS)) : -Math.floor(between(30, 900)),
      network: pick(['MTN', 'MTN', 'Airtel', 'Airtel', 'Safaricom']),
      country: r() < 0.8 ? 'UG' : 'KE',
      flight: between(140, 380),
      cv: between(0.25, 0.8),
      hold: between(80, 140),
      touch: r() < 0.7,
      autofill: r() < 0.35,
      paster: r() < 0.05,
      vpn: r() < 0.03,
      traveller: r() < 0.02,
      ip: `102.85.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`,
    };
  });
  const legitBeneficiaries = Array.from({ length: 2500 }, (_, i) => `ben_${i}`);
  const popularBeneficiaries = legitBeneficiaries.slice(0, 15); // merchants / schools many people pay
  const muleAccounts = Array.from({ length: 25 }, (_, i) => `mule_${i}`);
  const farmDevices = Array.from({ length: 15 }, (_, i) => `farm_${i}`);
  const botDevices = Array.from({ length: 30 }, (_, i) => `botdev_${i}`);
  const segments = ['ecommerce', 'betting', 'airtime', 'utilities'];
  const p95: Record<string, number> = { ecommerce: 600_000, betting: 250_000, airtime: 40_000, utilities: 300_000 };
  const amountFor = (seg: string, scale = 1) => Math.round((seg === 'airtime' ? logn(8_000, 0.7) : seg === 'betting' ? logn(40_000, 0.9) : logn(90_000, 0.9)) * scale);

  const humanTyping = (u: { flight: number; cv: number; hold: number }) => {
    const keys = Math.floor(between(18, 60));
    return { keys, hold_mean_ms: u.hold, hold_var: (u.hold * 0.25) ** 2, flight_mean_ms: u.flight, flight_var: (u.cv * u.flight) ** 2, backspaces: Math.floor(keys * between(0, 0.12)) };
  };
  const humanPointer = () => ({ moves: Math.floor(between(30, 200)), straight_ratio: between(0.4, 0.82), speed_var: between(0.15, 0.7), idle_gaps: Math.floor(between(0, 6)) });

  // ── state ──
  const engine = new GeeksFraudEngine(new MemoryVelocityStore(2 * DAY));
  const graph = new LinkGraph({ supernodeDegree: 150 });
  const tenant: TenantConfig = { tenant_id: 'bench', mode: 'live', thresholds: { default: { review: 50, reject: 80 } }, rules: [] };
  const knownFraudDevices = new Set<string>();
  const knownFraudMsisdns = new Set<string>();
  const pendingLabels: Array<{ at: number; e: Entities }> = [];
  const rows: Row[] = [];
  let k = 0;

  for (let day = 0; day < DAYS; day++) {
    const live = users.filter((u) => u.createdDay <= day);
    for (let j = 0; j < PER_DAY; j++) {
      const ts = T0 + day * DAY + Math.floor((j / PER_DAY) * DAY);
      // labels that became known by now feed history and the graph (no future leakage)
      while (pendingLabels.length && pendingLabels[0].at <= ts) {
        const { e } = pendingLabels.shift()!;
        if (e.device) knownFraudDevices.add(e.device);
        if (e.msisdn) knownFraudMsisdns.add(e.msisdn);
        if (e.device) graph.label(LinkGraph.id('device', e.device), 'fraud', ts);
        if (e.msisdn) graph.label(LinkGraph.id('msisdn', e.msisdn), 'fraud', ts);
      }

      const x = r();
      const typology: Typology =
        x < 0.006 ? 'naive_bot' : x < 0.013 ? 'stealth_bot' : x < 0.021 ? 'farm' : x < 0.027 ? 'ato' : x < 0.032 ? 'mule' : x < 0.035 ? 'friendly' : 'legit';
      const seg = pick(segments);
      const u = live[Math.floor(r() * live.length)];
      let device: string;
      let msisdn = u.msisdn;
      let amount = amountFor(seg);
      let checkpoint: DecisionRequest['checkpoint'] = 'checkout';
      let beneficiary: string | undefined;
      let accountAge = day - u.createdDay;
      let simSwap: number | undefined = r() < 0.01 ? Math.floor(between(0, 5)) : undefined; // honest new SIMs
      let nameMatch: 'match' | 'partial' | 'mismatch' | undefined = r() < 0.6 ? (r() < 0.03 ? 'partial' : 'match') : undefined;
      let ipCountry = u.traveller && r() < 0.5 ? pick(['TZ', 'RW', 'AE']) : u.country;
      let ip = u.ip;
      let enrichIp: Enrichment['ip'] = { country: ipCountry, is_vpn: u.vpn };
      let behavior: BehaviorSummary;

      const legitBehavior = (): BehaviorSummary => {
        const fields = [
          { role: 'name', pasted: u.paster && r() < 0.5, autofilled: u.autofill, programmatic: false, keys: u.autofill ? 0 : 12, first_input_ms: Math.floor(between(1500, 9000)) },
          { role: 'phone', pasted: u.paster && r() < 0.5, autofilled: u.autofill && r() < 0.7, programmatic: false, keys: 10, first_input_ms: Math.floor(between(3000, 15000)) },
        ];
        return {
          device_id: device,
          consent: true,
          automation: { inconsistent_hints: r() < 0.003 },
          typing: humanTyping(u),
          fields,
          ...(u.touch ? {} : { pointer: humanPointer() }),
          session: { duration_ms: Math.floor(logn(u.autofill ? 18_000 : 40_000, 0.6)) },
          env: { touch: u.touch },
        };
      };

      device = u.cafe && r() < 0.6 ? pick(cafeDevices) : pick(u.devices);
      if (typology === 'legit' || typology === 'friendly') {
        behavior = legitBehavior();
        if (r() < 0.1) {
          checkpoint = 'payout';
          beneficiary = r() < 0.4 ? pick(popularBeneficiaries) : pick(legitBeneficiaries);
        }
      } else if (typology === 'naive_bot') {
        device = pick(botDevices);
        msisdn = r() < 0.5 ? pick(users).msisdn : `2567${Math.floor(r() * 1e8)}`;
        accountAge = Math.floor(between(0, 3));
        ip = `185.220.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`;
        enrichIp = { country: pick(['NL', 'US', 'DE']), is_hosting: true };
        behavior = {
          device_id: device,
          consent: true,
          automation: { webdriver: r() < 0.8, headless: r() < 0.6, cdp: r() < 0.3 },
          typing: { keys: 30, hold_mean_ms: 20, hold_var: 1, flight_mean_ms: 50, flight_var: 2, backspaces: 0 },
          fields: [
            { role: 'name', pasted: false, autofilled: false, programmatic: true, keys: 0, first_input_ms: 100 },
            { role: 'phone', pasted: false, autofilled: false, programmatic: true, keys: 0, first_input_ms: 130 },
          ],
          pointer: { moves: 12, straight_ratio: 0.995, speed_var: 0.002, idle_gaps: 0 },
          session: { duration_ms: Math.floor(between(500, 2500)) },
        };
      } else if (typology === 'stealth_bot') {
        device = `stealth_${k}`; // rotates fingerprints: no device history, no device velocity
        msisdn = `2567${Math.floor(r() * 1e8)}`;
        accountAge = Math.floor(between(0, 2));
        ip = `102.${Math.floor(between(80, 90))}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`; // residential proxy
        enrichIp = { country: r() < 0.8 ? 'UG' : 'KE' };
        const flight = between(90, 160);
        behavior = {
          device_id: device,
          consent: true,
          automation: {},
          typing: { keys: Math.floor(between(20, 40)), hold_mean_ms: between(60, 90), hold_var: 40, flight_mean_ms: flight, flight_var: (between(0.06, 0.22) * flight) ** 2, backspaces: 0 },
          fields: [
            { role: 'name', pasted: false, autofilled: false, programmatic: false, keys: 12, first_input_ms: Math.floor(between(300, 1200)) },
            { role: 'phone', pasted: false, autofilled: false, programmatic: false, keys: 10, first_input_ms: Math.floor(between(800, 2500)) },
          ],
          pointer: { moves: Math.floor(between(15, 40)), straight_ratio: between(0.88, 0.97), speed_var: between(0.02, 0.12), idle_gaps: 0 },
          session: { duration_ms: Math.floor(between(3500, 12000)) },
        };
        amount = Math.round(amount * between(1.5, 4));
      } else if (typology === 'farm') {
        device = pick(farmDevices);
        msisdn = `2567${Math.floor(r() * 1e8)}`;
        accountAge = Math.floor(between(0, 10));
        if (r() < 0.4) enrichIp = { country: pick(['UG', 'NL']), is_vpn: true };
        const op = { flight: between(160, 260), cv: between(0.3, 0.6), hold: between(80, 120) };
        behavior = {
          device_id: device,
          consent: true,
          automation: {},
          typing: humanTyping(op),
          fields: [
            { role: 'name', pasted: r() < 0.7, autofilled: false, programmatic: false, keys: 0, first_input_ms: Math.floor(between(600, 2500)) },
            { role: 'phone', pasted: r() < 0.7, autofilled: false, programmatic: false, keys: 0, first_input_ms: Math.floor(between(900, 3000)) },
          ],
          session: { duration_ms: Math.floor(logn(14_000, 0.4)) },
          env: { touch: true },
        };
        amount = Math.round(amount * between(1, 2.5));
      } else if (typology === 'ato') {
        device = `ato_${k}`;
        simSwap = r() < 0.75 ? Math.floor(between(0, 4)) : undefined;
        nameMatch = r() < 0.5 ? (r() < 0.5 ? 'partial' : 'mismatch') : nameMatch;
        checkpoint = r() < 0.6 ? 'payout' : 'checkout';
        if (checkpoint === 'payout') beneficiary = pick(legitBeneficiaries);
        const op = { flight: between(140, 300), cv: between(0.3, 0.7), hold: between(80, 130) };
        behavior = {
          device_id: device,
          consent: true,
          automation: {},
          typing: humanTyping(op),
          fields: [{ role: 'phone', pasted: r() < 0.5, autofilled: false, programmatic: false, keys: 10, first_input_ms: Math.floor(between(1500, 6000)) }],
          session: { duration_ms: Math.floor(logn(25_000, 0.5)) },
          env: { touch: true },
        };
        amount = Math.round(amount * between(2, 6));
      } else {
        // mule cash-out: victims' wallets paid out to a small set of mule accounts
        device = pick(farmDevices.slice(0, 5)) + (r() < 0.5 ? '' : `_${k % 7}`);
        checkpoint = 'payout';
        beneficiary = pick(muleAccounts);
        simSwap = r() < 0.3 ? Math.floor(between(0, 4)) : simSwap;
        const op = { flight: between(160, 280), cv: between(0.3, 0.6), hold: between(80, 120) };
        behavior = {
          device_id: device,
          consent: true,
          automation: {},
          typing: humanTyping(op),
          fields: [{ role: 'phone', pasted: r() < 0.4, autofilled: false, programmatic: false, keys: 10, first_input_ms: Math.floor(between(1500, 5000)) }],
          session: { duration_ms: Math.floor(logn(20_000, 0.5)) },
          env: { touch: true },
        };
        amount = Math.round(amount * between(1.5, 4));
      }

      const req: DecisionRequest = {
        session_id: `s${k}`,
        checkpoint,
        merchant: { id: `m_${seg}_${Math.floor(r() * 20)}`, segment: seg, country: 'UG' },
        transaction: { id: `t${k}`, amount, currency: 'UGX', payment_method: 'mobile_money' },
        payer: { msisdn_hash: msisdn, network: u.network, ip, country: u.country, account_age_days: accountAge, sim_swap_days: simSwap, name_match: nameMatch },
        beneficiary: beneficiary ? { account_hash: beneficiary } : null,
      };
      const ents: Entities = { device, msisdn, ip, account: undefined, beneficiary };
      const enrichment: Enrichment = {
        ip: enrichIp,
        merchant_stats: { amount_p95: p95[seg] },
        history: { device_fraud: knownFraudDevices.has(device), msisdn_fraud: knownFraudMsisdns.has(msisdn) },
        graph: graph.enrichment(ents, ts),
      };
      const res = await engine.decide(req, { tenant, behavior, enrichment, now: ts, decisionId: `d${k}` });
      graph.observe(ents, amount, ts);

      const fraud: 0 | 1 = typology === 'legit' ? 0 : 1;
      let knownAt: number | null = null;
      if (fraud && r() < (typology === 'friendly' ? 0.95 : 0.85)) {
        knownAt = ts + Math.floor(between(5, 45) * DAY);
        // friendly fraud labels the payment, but the device/number belongs to a real customer
        if (typology !== 'friendly') {
          const at = knownAt;
          const idx = pendingLabels.findIndex((p) => p.at > at);
          pendingLabels.splice(idx === -1 ? pendingLabels.length : idx, 0, { at, e: { device, msisdn } });
        }
      }

      rows.push({
        ts,
        day,
        typology,
        fraud,
        knownAt,
        amount,
        segment: seg,
        expertScore: res.geek_score,
        raw: res.features,
        stacked: stackedFeatures(res.features, res.geek_score / 100, res.reasons),
      });
      k++;
    }
  }
  return rows;
}
