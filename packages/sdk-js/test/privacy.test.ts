/**
 * NFR-10 / US-12: an automated test that fails the build if the SDK ever
 * sends a field value. We simulate a DOM, type a secret into every kind of
 * field, and assert the secret never appears in the outgoing payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM shim (no jsdom dependency) ───────────────────────────────
type Listener = (e: any) => void;
class Target {
  private l = new Map<string, Listener[]>();
  addEventListener(t: string, f: Listener) {
    (this.l.get(t) ?? this.l.set(t, []).get(t)!).push(f);
  }
  removeEventListener(t: string, f: Listener) {
    this.l.set(t, (this.l.get(t) ?? []).filter((x) => x !== f));
  }
  dispatch(t: string, e: any) {
    (this.l.get(t) ?? []).forEach((f) => f(e));
  }
}
class Field {
  value = '';
  constructor(public type: string, private attrs: Record<string, string>) {}
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
}

const doc = new Target() as any;
doc.visibilityState = 'visible';
doc.cookie = '';
doc.documentElement = { getAttribute: () => null };
doc.createElement = () => ({ getContext: () => null });
const win = new Target() as any;
const store = new Map<string, string>();
const sent: string[] = [];
Object.assign(globalThis, {
  document: doc,
  window: Object.assign(win, { outerWidth: 1200, outerHeight: 800, chrome: {} }),
  location: { protocol: 'https:' },
  screen: { width: 390, height: 844, colorDepth: 24 },
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
  Blob: class {
    constructor(public parts: string[]) {}
  },
});
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/130.0 Mobile',
    language: 'en-UG',
    hardwareConcurrency: 8,
    maxTouchPoints: 5,
    webdriver: false,
    sendBeacon: (_u: string, b: any) => {
      sent.push(b.parts.join(''));
      return true;
    },
  },
  configurable: true,
});

test('never sends typed values, passwords, card numbers or OTPs', async () => {
  const sdk = await import('../src/index');
  const SECRET = 'S3cr3t-4111111111111111-0000';
  sdk.init({ publicKey: 'pk_test_x', consent: true, endpoint: 'https://collector.test/v1/collect' });

  const fields = [
    new Field('text', { 'data-fg-role': 'name' }),
    new Field('tel', { 'data-fg-role': 'phone' }),
    new Field('password', { 'data-fg-role': 'name' }), // tagged but forbidden by type
    new Field('text', { 'data-fg-role': 'card_number' }), // not on allow-list
    new Field('text', { 'data-fg-role': 'email', autocomplete: 'one-time-code' }), // OTP via autocomplete
  ];
  let t = 0;
  (globalThis as any).performance = { now: () => (t += 137) };
  for (const f of fields) {
    for (const ch of SECRET) {
      f.value += ch;
      doc.dispatch('keydown', { target: f, key: ch, code: `Key${ch}`, repeat: false, isTrusted: true });
      doc.dispatch('keyup', { target: f, key: ch, code: `Key${ch}`, isTrusted: true });
      doc.dispatch('input', { target: f, isTrusted: true, inputType: 'insertText', data: ch });
    }
    doc.dispatch('paste', { target: f, clipboardData: { getData: () => SECRET } });
  }

  sdk.flush();
  assert.equal(sent.length, 1);
  const body = sent[0];
  assert.ok(!body.includes(SECRET), 'payload contains typed value');
  for (const fragment of ['4111', 'S3cr3t', '0000']) assert.ok(!body.includes(fragment), `payload leaked "${fragment}"`);

  const p = JSON.parse(body);
  const roles = p.summary.fields.map((f: any) => f.role).sort();
  assert.deepEqual(roles, ['name', 'phone'], 'only allow-listed, non-sensitive fields observed');
  assert.equal(p.summary.typing.keys, SECRET.length * 2);
  assert.ok(p.summary.fields.every((f: any) => f.pasted === true));
  assert.match(p.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  sdk.destroy();
});

test('untrusted input events are flagged programmatic; consent=false sends no behavior', async () => {
  const sdk = await import('../src/index');
  sent.length = 0;
  sdk.init({ publicKey: 'pk', consent: true, endpoint: 'https://c.test' });
  const f = new Field('text', { 'data-fg-role': 'name' });
  doc.dispatch('input', { target: f, isTrusted: false });
  let p: any = sdk.payload();
  assert.equal(p.summary.fields[0].programmatic, true);

  sdk.setConsent(false);
  p = sdk.payload();
  assert.equal(p.summary.fields, undefined);
  assert.equal(p.summary.typing, undefined);
  assert.ok(p.summary.automation);
  assert.equal(p.summary.env.ua, undefined);
  sdk.destroy();
});

test('automation detection flags webdriver and CDP artefacts', async () => {
  const { detectAutomation } = await import('../src/index');
  const fake: any = { navigator: { userAgent: 'Mozilla/5.0 HeadlessChrome/130', webdriver: true }, outerWidth: 0, outerHeight: 0, document: doc, cdc_adoQpoasnfa76pfcZLmcfl_Array: [] };
  const a = detectAutomation(fake);
  assert.equal(a.webdriver, true);
  assert.equal(a.headless, true);
  assert.equal(a.cdp, true);
});
