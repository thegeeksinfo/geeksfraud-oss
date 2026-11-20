import type { DecisionRequest, VelocitySnapshot } from './types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Sliding-window counter store. Each `key` holds (member, timestamp) events.
 * `count` = events in window, `distinct` = distinct members in window.
 * Implement over Redis sorted sets in production (see backend RedisVelocityStore).
 */
export interface VelocityStore {
  add(key: string, member: string, ts: number): Promise<void> | void;
  count(key: string, windowMs: number, now: number): Promise<number> | number;
  distinct(key: string, windowMs: number, now: number): Promise<number> | number;
}

/** In-process store for tests, sandboxes and single-node deployments. */
export class MemoryVelocityStore implements VelocityStore {
  private readonly events = new Map<string, Array<{ m: string; t: number }>>();
  constructor(private readonly retentionMs: number = DAY) {}

  add(key: string, member: string, ts: number): void {
    let list = this.events.get(key);
    if (!list) {
      list = [];
      this.events.set(key, list);
    }
    list.push({ m: member, t: ts });
    // prune lazily
    if (list.length > 64 && list[0].t < ts - this.retentionMs) {
      const cutoff = ts - this.retentionMs;
      const idx = list.findIndex((e) => e.t >= cutoff);
      list.splice(0, idx === -1 ? list.length : idx);
    }
  }

  count(key: string, windowMs: number, now: number): number {
    const list = this.events.get(key);
    if (!list) return 0;
    const from = now - windowMs;
    let n = 0;
    for (const e of list) if (e.t >= from && e.t <= now) n++;
    return n;
  }

  distinct(key: string, windowMs: number, now: number): number {
    const list = this.events.get(key);
    if (!list) return 0;
    const from = now - windowMs;
    const s = new Set<string>();
    for (const e of list) if (e.t >= from && e.t <= now) s.add(e.m);
    return s.size;
  }

  size(): number {
    return this.events.size;
  }
}

/** Velocity keys are namespaced per tenant so one gateway never sees another's counters. */
export function velocityKeys(tenant: string, req: DecisionRequest, deviceId: string | null) {
  const p = `${tenant}:`;
  const msisdn = req.payer.msisdn_hash;
  const card = req.card ? `${req.card.bin}:${req.card.last4 ?? ''}` : undefined;
  return {
    deviceIdentities: deviceId ? `${p}dev:id:${deviceId}` : undefined,
    deviceCards: deviceId ? `${p}dev:card:${deviceId}` : undefined,
    msisdnDevices: msisdn ? `${p}msisdn:dev:${msisdn}` : undefined,
    msisdnMerchants: msisdn ? `${p}msisdn:mer:${msisdn}` : undefined,
    msisdnTx: msisdn ? `${p}msisdn:tx:${msisdn}` : undefined,
    ipTx: req.payer.ip ? `${p}ip:tx:${req.payer.ip}` : undefined,
    emailTx: req.payer.email ? `${p}email:tx:${req.payer.email.toLowerCase()}` : undefined,
    binTx: req.card?.bin ? `${p}bin:tx:${req.card.bin}` : undefined,
    merchantTx: `${p}mer:tx:${req.merchant.id}`,
    card,
  };
}

/** Record the current event first, then read windows, so counts include this attempt. */
export async function recordAndSnapshot(
  store: VelocityStore,
  tenant: string,
  req: DecisionRequest,
  deviceId: string | null,
  now: number,
): Promise<VelocitySnapshot> {
  const k = velocityKeys(tenant, req, deviceId);
  const tx = req.transaction.id;
  const identity = req.payer.msisdn_hash ?? req.payer.email ?? req.payer.account_id_hash;

  const writes: Array<Promise<void> | void> = [store.add(k.merchantTx, tx, now)];
  if (k.deviceIdentities && identity) writes.push(store.add(k.deviceIdentities, identity, now));
  if (k.deviceCards && k.card) writes.push(store.add(k.deviceCards, k.card, now));
  if (k.msisdnDevices && deviceId) writes.push(store.add(k.msisdnDevices, deviceId, now));
  if (k.msisdnMerchants) writes.push(store.add(k.msisdnMerchants, req.merchant.id, now));
  if (k.msisdnTx) writes.push(store.add(k.msisdnTx, tx, now));
  if (k.ipTx) writes.push(store.add(k.ipTx, tx, now));
  if (k.emailTx) writes.push(store.add(k.emailTx, tx, now));
  if (k.binTx) writes.push(store.add(k.binTx, tx, now));
  await Promise.all(writes);

  const c = (key: string | undefined, w: number) => (key ? store.count(key, w, now) : 0);
  const d = (key: string | undefined, w: number) => (key ? store.distinct(key, w, now) : 0);

  const [
    device_identities_24h,
    device_cards_24h,
    msisdn_devices_1h,
    msisdn_merchants_1h,
    msisdn_tx_1h,
    msisdn_tx_24h,
    ip_tx_1m,
    ip_tx_1h,
    email_tx_24h,
    bin_tx_1h,
    merchant_tx_1m,
  ] = await Promise.all([
    d(k.deviceIdentities, DAY),
    d(k.deviceCards, DAY),
    d(k.msisdnDevices, HOUR),
    d(k.msisdnMerchants, HOUR),
    c(k.msisdnTx, HOUR),
    c(k.msisdnTx, DAY),
    c(k.ipTx, MINUTE),
    c(k.ipTx, HOUR),
    c(k.emailTx, DAY),
    c(k.binTx, HOUR),
    c(k.merchantTx, MINUTE),
  ]);

  return {
    device_identities_24h,
    device_cards_24h,
    msisdn_devices_1h,
    msisdn_merchants_1h,
    msisdn_tx_1h,
    msisdn_tx_24h,
    ip_tx_1m,
    ip_tx_1h,
    email_tx_24h,
    bin_tx_1h,
    merchant_tx_1m,
  };
}
