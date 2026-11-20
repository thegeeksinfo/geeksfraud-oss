/**
 * @geeksfraud/node — server client for the GeeksFraud Decision API.
 *
 * Fail-open by design (NFR-04): on timeout, network error, 429 or 5xx the
 * client returns APPROVE with `fail_open: true` so a GeeksFraud outage can
 * never block a payment. Every fail-open is surfaced via `onFailOpen` for logging.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type Decision = 'APPROVE' | 'REVIEW' | 'REJECT';

export interface DecisionResponse {
  decision_id: string | null;
  geek_score: number | null;
  decision: Decision;
  mode: 'live' | 'shadow' | 'sandbox';
  signals_coverage: 'full' | 'partial' | 'none';
  reasons: Array<{ code: string; severity: string; merchant_text: string }>;
  rule_hits: string[];
  device_id: string | null;
  model_version: string | null;
  latency_ms: number | null;
  /** Present only when the client failed open. */
  fail_open?: true;
  error?: string;
}

export type Outcome = 'completed' | 'failed' | 'chargeback' | 'refund_fraud' | 'confirmed_fraud' | 'confirmed_good';

export interface ClientOptions {
  secretKey: string;
  baseUrl?: string;
  /** Recommended 300 ms (PRD §11.6). */
  timeoutMs?: number;
  tenant?: string;
  fetch?: typeof fetch;
  onFailOpen?: (err: Error, request: unknown) => void;
}

export class GeeksFraudError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'GeeksFraudError';
  }
}

export class GeeksFraud {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    if (!opts.secretKey) throw new Error('secretKey is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.geeksfraud.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.opts.secretKey}`,
      'User-Agent': 'geeksfraud-node/1.0.0',
      ...(this.opts.tenant ? { 'FG-Tenant': this.opts.tenant } : {}),
      ...extra,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(extra),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) throw new GeeksFraudError(json.message ?? res.statusText, res.status, json.code);
      return json as T;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new GeeksFraudError(`timeout after ${timeoutMs} ms`, 0, 'timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Score a transaction. Never throws for availability problems: returns APPROVE + fail_open.
   * Throws only for 400/401/409, which are integration bugs the developer must fix.
   */
  async decide(body: Record<string, unknown>, opts: { idempotencyKey?: string } = {}): Promise<DecisionResponse> {
    const idem = opts.idempotencyKey ?? ((body.transaction as any)?.id as string | undefined);
    try {
      return await this.request<DecisionResponse>('POST', '/v1/decisions', body, idem ? { 'Idempotency-Key': idem } : {});
    } catch (e: any) {
      const status = e instanceof GeeksFraudError ? e.status : 0;
      if (status === 400 || status === 401 || status === 409) throw e;
      this.opts.onFailOpen?.(e, body);
      return {
        decision_id: null,
        geek_score: null,
        decision: 'APPROVE',
        mode: 'live',
        signals_coverage: 'none',
        reasons: [],
        rule_hits: [],
        device_id: null,
        model_version: null,
        latency_ms: null,
        fail_open: true,
        error: e?.message ?? String(e),
      };
    }
  }

  getDecision(id: string) {
    return this.request<DecisionResponse>('GET', `/v1/decisions/${encodeURIComponent(id)}`, undefined, {}, 5_000);
  }

  reportOutcome(id: string, outcome: Outcome, extra: { amount?: number; reason?: string } = {}) {
    return this.request<{ ok: true }>('POST', `/v1/decisions/${encodeURIComponent(id)}/outcome`, { outcome, ...extra }, {}, 5_000);
  }

  reportOutcomes(items: Array<{ decision_id: string; outcome: Outcome }>) {
    if (items.length > 1000) throw new Error('max 1000 outcomes per batch');
    return this.request<{ accepted: number; errors: Array<{ index: number; error: string }> }>('POST', '/v1/outcomes:batch', { outcomes: items }, {}, 15_000);
  }
}

/**
 * Hash an identifier (phone, email, account id) before sending (NFR-15).
 * Phone numbers are normalised to digits so "+256 772 123456" and "256772123456" match.
 */
export function hashIdentifier(value: string, salt: string, kind: 'msisdn' | 'email' | 'account' = 'account'): string {
  let v = value.trim();
  if (kind === 'msisdn') v = v.replace(/[^\d]/g, '');
  if (kind === 'email') v = v.toLowerCase();
  return 'sha256:' + createHash('sha256').update(`${salt}:${v}`).digest('hex');
}

/** Verify an `FG-Signature: t=<unix>,v1=<hex>` webhook header (HMAC-SHA256). */
export function verifyWebhook(rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString()}`).digest();
  const got = Buffer.from(parts.v1, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function signWebhook(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}
