import type { Severity, SignalFamily } from './types';

export interface ReasonDefinition {
  code: string;
  family: SignalFamily;
  severity: Severity;
  /** Plain-language text a gateway can show its merchants (PRD principle 2). */
  merchant_text: string;
  /** Translations for merchant-facing text (NFR-21). */
  i18n?: Partial<Record<'sw' | 'fr', string>>;
  /** What makes it fire — rendered in docs and the console. */
  fires_when: string;
}

/**
 * Probability-of-fraud weight per severity at full signal strength.
 * Reasons combine with a noisy-OR so independent weak signals add up without
 * any single medium signal being able to reject on its own.
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 0.12,
  medium: 0.3,
  high: 0.6,
  critical: 0.9,
};

const defs: ReasonDefinition[] = [
  // Environment
  {
    code: 'FG_AUTOMATION_DETECTED',
    family: 'environment',
    severity: 'critical',
    merchant_text: 'Automated browser detected',
    i18n: { sw: 'Kivinjari cha kiotomatiki kimegunduliwa', fr: 'Navigateur automatisé détecté' },
    fires_when: 'webdriver, headless or CDP artefacts present',
  },
  {
    code: 'FG_EMULATOR_OR_ROOTED',
    family: 'environment',
    severity: 'high',
    merchant_text: 'Payment made from an emulator or rooted device',
    i18n: { sw: 'Malipo kutoka kifaa kilichobadilishwa', fr: 'Paiement depuis un émulateur ou un appareil rooté' },
    fires_when: 'Emulator, root or hooking framework detected',
  },
  {
    code: 'FG_INCONSISTENT_DEVICE',
    family: 'environment',
    severity: 'medium',
    merchant_text: 'Device reports inconsistent characteristics',
    fires_when: 'Client hints contradict the user agent or platform',
  },
  // Typing / form / pointer / session
  {
    code: 'FG_UNIFORM_KEYSTROKE_TIMING',
    family: 'typing',
    severity: 'high',
    merchant_text: 'Typing pattern consistent with a script',
    i18n: { sw: 'Mtindo wa kuandika unaofanana na programu', fr: 'Rythme de frappe typique d’un script' },
    fires_when: 'Flight-time variance near zero across ≥ 8 keys',
  },
  {
    code: 'FG_PROGRAMMATIC_FILL',
    family: 'typing',
    severity: 'critical',
    merchant_text: 'Form filled without any typing or pasting',
    fires_when: 'Fields filled with no key or paste events',
  },
  {
    code: 'FG_IDENTITY_FIELDS_PASTED',
    family: 'form',
    severity: 'high',
    merchant_text: 'Name and contact details pasted within seconds',
    i18n: { sw: 'Jina na anwani vimebandikwa ndani ya sekunde chache', fr: 'Nom et coordonnées collés en quelques secondes' },
    fires_when: 'Name + address/phone pasted within 2 s of first input',
  },
  {
    code: 'FG_STRAIGHT_LINE_POINTER',
    family: 'pointer',
    severity: 'medium',
    merchant_text: 'Mouse movement looks machine-generated',
    fires_when: 'Straight-line ratio and constant speed across moves',
  },
  {
    code: 'FG_SESSION_TOO_FAST',
    family: 'session',
    severity: 'medium',
    merchant_text: 'Checkout completed unusually fast',
    fires_when: 'Session faster than the merchant’s 1st percentile',
  },
  // Velocity
  {
    code: 'FG_DEVICE_VELOCITY',
    family: 'velocity',
    severity: 'high',
    merchant_text: 'Device used with many phone numbers or cards today',
    i18n: { sw: 'Kifaa kimetumika na namba nyingi za simu leo', fr: 'Appareil utilisé avec de nombreux numéros ou cartes aujourd’hui' },
    fires_when: 'Device used with ≥ N phone numbers or cards in 24 h',
  },
  {
    code: 'FG_MSISDN_VELOCITY',
    family: 'velocity',
    severity: 'high',
    merchant_text: 'Phone number seen on many devices or merchants',
    i18n: { sw: 'Namba ya simu imeonekana kwenye vifaa vingi', fr: 'Numéro vu sur de nombreux appareils ou marchands' },
    fires_when: 'Phone number seen on ≥ N devices or merchants in 1 h',
  },
  {
    code: 'FG_IP_VELOCITY',
    family: 'velocity',
    severity: 'medium',
    merchant_text: 'Many payments from the same network address',
    fires_when: 'IP address used for ≥ N transactions in 1 h',
  },
  {
    code: 'FG_CARD_TESTING',
    family: 'velocity',
    severity: 'high',
    merchant_text: 'Pattern consistent with card testing',
    fires_when: 'Many cards on one device, or BIN burst with low amounts',
  },
  // Network / email / account
  {
    code: 'FG_IP_HOSTING_OR_PROXY',
    family: 'network',
    severity: 'medium',
    merchant_text: 'Connection from a data centre, VPN or proxy',
    fires_when: 'IP is data-centre, VPN, Tor or known proxy',
  },
  {
    code: 'FG_GEO_MISMATCH',
    family: 'network',
    severity: 'medium',
    merchant_text: 'Location does not match the wallet or card country',
    fires_when: 'IP country ≠ wallet / card / shipping country',
  },
  {
    code: 'FG_DISPOSABLE_EMAIL',
    family: 'email',
    severity: 'medium',
    merchant_text: 'Temporary or newly created email address',
    fires_when: 'Disposable domain or domain < 30 days old',
  },
  {
    code: 'FG_NEW_ACCOUNT_HIGH_VALUE',
    family: 'account',
    severity: 'medium',
    merchant_text: 'New account making an unusually large payment',
    fires_when: 'Account < 7 days old and amount above merchant’s p95',
  },
  // Mobile money
  {
    code: 'FG_SIM_SWAP_RECENT',
    family: 'mobile_money',
    severity: 'high',
    merchant_text: 'SIM card was changed recently',
    i18n: { sw: 'Laini ya simu imebadilishwa hivi karibuni', fr: 'Carte SIM changée récemment' },
    fires_when: 'SIM swapped in the last 7 days (half strength up to 30 days)',
  },
  {
    code: 'FG_NAME_MISMATCH',
    family: 'mobile_money',
    severity: 'high',
    merchant_text: 'Wallet registered name does not match the payer',
    i18n: { sw: 'Jina la mkoba halilingani na mlipaji', fr: 'Le nom du portefeuille ne correspond pas au payeur' },
    fires_when: 'Rail name-check returned mismatch (partial = 40 %)',
  },
  {
    code: 'FG_COLLECTION_PROMPT_ABUSE',
    family: 'mobile_money',
    severity: 'medium',
    merchant_text: 'Repeated payment prompts sent to the same number',
    fires_when: '≥ N push-prompts to one number in 1 h',
  },
  // History / graph / lists
  {
    code: 'FG_DEVICE_LINKED_TO_FRAUD',
    family: 'history',
    severity: 'critical',
    merchant_text: 'Device or number previously confirmed as fraud',
    i18n: { sw: 'Kifaa au namba imethibitishwa kuwa ya udanganyifu awali', fr: 'Appareil ou numéro déjà confirmé frauduleux' },
    fires_when: 'Device / phone / email previously labelled fraud in this tenant',
  },
  {
    code: 'FG_LINKED_TO_FRAUD_NETWORK',
    family: 'graph',
    severity: 'high',
    merchant_text: 'Connected to accounts involved in confirmed fraud',
    fires_when: 'Within 2 hops of a confirmed-fraud node in the link graph',
  },
  {
    code: 'FG_MULE_FAN_IN',
    family: 'graph',
    severity: 'high',
    merchant_text: 'Receiving account collects from many unrelated payers',
    fires_when: 'Beneficiary received from ≥ 10 distinct payers in 24 h',
  },
  {
    code: 'FG_CIRCULAR_FLOW',
    family: 'graph',
    severity: 'high',
    merchant_text: 'Money is moving in a loop between accounts',
    fires_when: 'Payment closes a directed cycle of ≤ 4 accounts',
  },
  {
    code: 'FG_SHARED_DEVICE_CLUSTER',
    family: 'graph',
    severity: 'medium',
    merchant_text: 'Part of a cluster of accounts sharing devices',
    fires_when: 'Payer cluster of ≥ 5 identities joined by shared devices/numbers',
  },
  {
    code: 'FG_BLOCKLIST_MATCH',
    family: 'lists',
    severity: 'critical',
    merchant_text: 'Matched a blocked identifier',
    fires_when: 'Phone, email, device, IP or card is on a tenant block list',
  },
  {
    code: 'FG_RULE_MATCH',
    family: 'rules',
    severity: 'medium',
    merchant_text: 'Matched a risk policy set by your payment provider',
    fires_when: 'A tenant rule fired (rule ID in rule_hits)',
  },
];

export const REASONS: Readonly<Record<string, ReasonDefinition>> = Object.freeze(
  Object.fromEntries(defs.map((d) => [d.code, d])),
);

export function listReasons(): ReasonDefinition[] {
  return [...defs];
}

export function merchantText(code: string, locale: 'en' | 'sw' | 'fr' = 'en'): string {
  const def = REASONS[code];
  if (!def) return code;
  return (locale !== 'en' && def.i18n?.[locale]) || def.merchant_text;
}
