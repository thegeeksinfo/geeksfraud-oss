import type { BehaviorSummary, Enrichment } from './types';

/**
 * Deterministic sandbox personas (FR-702). Pass `session_id: "sbx_<persona>"`
 * with a sandbox key and the API substitutes these signals, so integrators can
 * test every decision path without real traffic.
 */
export interface Persona {
  key: string;
  description: string;
  expected: 'APPROVE' | 'REVIEW' | 'REJECT';
  behavior: BehaviorSummary;
  enrichment: Enrichment;
}

const human: BehaviorSummary = {
  device_id: 'dev_sbx_human',
  consent: true,
  automation: {},
  typing: { keys: 42, hold_mean_ms: 96, hold_var: 900, flight_mean_ms: 210, flight_var: 9_800, backspaces: 3 },
  fields: [
    { role: 'name', pasted: false, autofilled: false, programmatic: false, keys: 14, first_input_ms: 3_400 },
    { role: 'phone', pasted: false, autofilled: true, programmatic: false, keys: 0, first_input_ms: 9_100 },
  ],
  pointer: { moves: 120, straight_ratio: 0.62, speed_var: 0.41, idle_gaps: 4 },
  session: { duration_ms: 48_000 },
  env: { timezone: 'Africa/Kampala', language: 'en-UG', touch: true, cores: 8 },
};

export const PERSONAS: Record<string, Persona> = {
  sbx_human: {
    key: 'sbx_human',
    description: 'Real person on a phone, typing naturally, local network.',
    expected: 'APPROVE',
    behavior: human,
    enrichment: { ip: { country: 'UG', is_hosting: false } },
  },
  sbx_new_payer: {
    key: 'sbx_new_payer',
    description: 'Honest first-time payer: no history, short session, but human signals.',
    expected: 'APPROVE',
    behavior: { ...human, device_id: 'dev_sbx_new', session: { duration_ms: 21_000 } },
    enrichment: { ip: { country: 'UG' } },
  },
  sbx_bot: {
    key: 'sbx_bot',
    description: 'Headless browser filling the form programmatically from a data centre.',
    expected: 'REJECT',
    behavior: {
      device_id: 'dev_sbx_bot',
      consent: true,
      automation: { webdriver: true, headless: true },
      typing: { keys: 30, hold_mean_ms: 20, hold_var: 0.5, flight_mean_ms: 50, flight_var: 0.4, backspaces: 0 },
      fields: [
        { role: 'name', pasted: false, autofilled: false, programmatic: true, keys: 0, first_input_ms: 120 },
        { role: 'phone', pasted: false, autofilled: false, programmatic: true, keys: 0, first_input_ms: 140 },
      ],
      pointer: { moves: 12, straight_ratio: 0.995, speed_var: 0.001, idle_gaps: 0 },
      session: { duration_ms: 900 },
    },
    enrichment: { ip: { country: 'NL', is_hosting: true } },
  },
  sbx_fraud_ring: {
    key: 'sbx_fraud_ring',
    description: 'Human operator in a ring: identity details pasted, VPN, device shared with numbers already confirmed as fraud.',
    expected: 'REJECT',
    behavior: {
      ...human,
      device_id: 'dev_sbx_ring',
      fields: [
        { role: 'name', pasted: true, autofilled: false, programmatic: false, keys: 0, first_input_ms: 800 },
        { role: 'phone', pasted: true, autofilled: false, programmatic: false, keys: 0, first_input_ms: 1_200 },
      ],
    },
    enrichment: {
      ip: { country: 'UG', is_vpn: true },
      graph: { fraud_distance: 1, cluster_size: 9 },
    },
  },
  sbx_account_takeover: {
    key: 'sbx_account_takeover',
    description: 'Legitimate account, but the SIM was swapped yesterday and the name check partially fails.',
    expected: 'REVIEW',
    behavior: { ...human, device_id: 'dev_sbx_ato' },
    enrichment: { ip: { country: 'UG' } },
  },
};

export function sandboxPersona(sessionId: string | undefined): Persona | undefined {
  if (!sessionId) return undefined;
  return PERSONAS[sessionId];
}
