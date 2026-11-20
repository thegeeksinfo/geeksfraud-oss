import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeeksFraud, GeeksFraudError, hashIdentifier, signWebhook, verifyWebhook } from '../src';

const body = { merchant: { id: 'm' }, transaction: { id: 'ord_1', amount: 100, currency: 'UGX', payment_method: 'mobile_money' }, payer: {} };

const respond = (status: number, json: unknown, delayMs = 0): typeof fetch =>
  (async (_url: any, init: any) => {
    await new Promise((r, j) => {
      const t = setTimeout(r, delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        j(e);
      });
    });
    return new Response(JSON.stringify(json), { status });
  }) as any;

test('returns the API decision and sends auth + idempotency headers', async () => {
  let seen: any;
  const c = new GeeksFraud({
    secretKey: 'fg_test_sk_x',
    tenant: 'gw_1',
    fetch: (async (url: string, init: any) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ decision: 'REJECT', geek_score: 91 }), { status: 200 });
    }) as any,
  });
  const r = await c.decide(body);
  assert.equal(r.decision, 'REJECT');
  assert.equal(seen.url, 'https://api.geeksfraud.com/v1/decisions');
  assert.equal(seen.headers.Authorization, 'Bearer fg_test_sk_x');
  assert.equal(seen.headers['Idempotency-Key'], 'ord_1');
  assert.equal(seen.headers['FG-Tenant'], 'gw_1');
});

test('fails open on timeout, 5xx and 429 (NFR-04)', async () => {
  const failures: string[] = [];
  for (const f of [respond(200, {}, 1_000), respond(503, { message: 'down' }), respond(429, { code: 'rate_limited' })]) {
    const c = new GeeksFraud({ secretKey: 'k', timeoutMs: 50, fetch: f, onFailOpen: (e) => failures.push(e.message) });
    const r = await c.decide(body);
    assert.equal(r.decision, 'APPROVE');
    assert.equal(r.fail_open, true);
  }
  assert.equal(failures.length, 3);
  assert.match(failures[0], /timeout/);
});

test('throws on integration errors (400/401/409) so developers notice', async () => {
  const c = new GeeksFraud({ secretKey: 'k', fetch: respond(401, { message: 'bad key', code: 'unauthorized' }) });
  await assert.rejects(c.decide(body), (e: any) => e instanceof GeeksFraudError && e.status === 401);
});

test('hashIdentifier normalises phone numbers and emails', () => {
  assert.equal(hashIdentifier('+256 772 123456', 's', 'msisdn'), hashIdentifier('256772123456', 's', 'msisdn'));
  assert.equal(hashIdentifier('A@B.com', 's', 'email'), hashIdentifier('a@b.com', 's', 'email'));
  assert.notEqual(hashIdentifier('x', 's1'), hashIdentifier('x', 's2'));
  assert.match(hashIdentifier('x', 's'), /^sha256:[0-9a-f]{64}$/);
});

test('webhook signatures verify and reject tampering / replay', () => {
  const raw = JSON.stringify({ type: 'decision.review_completed' });
  const sig = signWebhook(raw, 'whsec');
  assert.ok(verifyWebhook(raw, sig, 'whsec'));
  assert.ok(!verifyWebhook(raw + ' ', sig, 'whsec'));
  assert.ok(!verifyWebhook(raw, sig, 'other'));
  assert.ok(!verifyWebhook(raw, signWebhook(raw, 'whsec', 1_000), 'whsec'));
});
