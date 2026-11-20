/**
 * Link graph for fraud-ring, mule and circular-flow detection.
 *
 * Adapted from knowledge-graph fraud patterns (shared accounts, money-mule
 * fan-in, collusion clusters, circular schemes) to payments, with fixes:
 *  - cycles are real *directed* money cycles, not shared-attribute triangles;
 *  - supernodes (e.g. a utility's collection account) are skipped by degree cap;
 *  - fan-in is time-windowed, so a busy merchant doesn't look like a mule forever.
 *
 * In-memory for single-node/sandbox use; the same API can sit over Neo4j or
 * Postgres recursive CTEs when volume demands.
 */

export type NodeKind = 'device' | 'msisdn' | 'email' | 'ip' | 'card' | 'account' | 'beneficiary';
export type NodeId = `${NodeKind}:${string}`;
export type Label = 'fraud' | 'good';

export interface GraphNode {
  id: NodeId;
  kind: NodeKind;
  label?: Label;
  first_seen: number;
  last_seen: number;
}

interface Transfer {
  from: NodeId;
  to: NodeId;
  amount: number;
  ts: number;
}

export interface Entities {
  device?: string | null;
  msisdn?: string;
  email?: string;
  ip?: string;
  card?: string;
  account?: string;
  beneficiary?: string;
}

export class LinkGraph {
  private readonly nodes = new Map<NodeId, GraphNode>();
  /** Undirected "seen together" links (identity graph). */
  private readonly links = new Map<NodeId, Set<NodeId>>();
  /** Directed money flow (payer identity → beneficiary). */
  private readonly out = new Map<NodeId, Transfer[]>();
  private readonly inbound = new Map<NodeId, Transfer[]>();

  constructor(private readonly opts: { supernodeDegree?: number } = {}) {}

  static id(kind: NodeKind, value: string): NodeId {
    return `${kind}:${value}`;
  }

  private touch(id: NodeId, ts: number): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind: id.split(':')[0] as NodeKind, first_seen: ts, last_seen: ts };
      this.nodes.set(id, n);
    } else n.last_seen = Math.max(n.last_seen, ts);
    return n;
  }

  private link(a: NodeId, b: NodeId) {
    if (a === b) return;
    if (!this.links.has(a)) this.links.set(a, new Set());
    if (!this.links.has(b)) this.links.set(b, new Set());
    this.links.get(a)!.add(b);
    this.links.get(b)!.add(a);
  }

  /** Primary payer identity used as the "from" side of money flow. */
  static payerKey(e: Entities): NodeId | null {
    if (e.account) return LinkGraph.id('account', e.account);
    if (e.msisdn) return LinkGraph.id('msisdn', e.msisdn);
    if (e.email) return LinkGraph.id('email', e.email);
    return null;
  }

  private entityIds(e: Entities): NodeId[] {
    const ids: NodeId[] = [];
    if (e.device) ids.push(LinkGraph.id('device', e.device));
    if (e.msisdn) ids.push(LinkGraph.id('msisdn', e.msisdn));
    if (e.email) ids.push(LinkGraph.id('email', e.email.toLowerCase()));
    if (e.card) ids.push(LinkGraph.id('card', e.card));
    if (e.account) ids.push(LinkGraph.id('account', e.account));
    // IPs are linked but treated as weak (shared NAT on mobile carriers is common in Africa).
    if (e.ip) ids.push(LinkGraph.id('ip', e.ip));
    return ids;
  }

  /** Add one observed transaction. */
  observe(e: Entities, amount: number, ts: number = Date.now()): void {
    const ids = this.entityIds(e);
    ids.forEach((id) => this.touch(id, ts));
    const strong = ids.filter((id) => !id.startsWith('ip:'));
    for (let i = 0; i < strong.length; i++) for (let j = i + 1; j < strong.length; j++) this.link(strong[i], strong[j]);
    const ip = ids.find((id) => id.startsWith('ip:'));
    if (ip && e.device) this.link(ip, LinkGraph.id('device', e.device));

    const from = LinkGraph.payerKey(e);
    if (from && e.beneficiary) {
      const to = LinkGraph.id('account', e.beneficiary);
      this.touch(to, ts);
      const t: Transfer = { from, to, amount, ts };
      if (!this.out.has(from)) this.out.set(from, []);
      if (!this.inbound.has(to)) this.inbound.set(to, []);
      this.out.get(from)!.push(t);
      this.inbound.get(to)!.push(t);
    }
  }

  label(id: NodeId, label: Label, ts: number = Date.now()): void {
    this.touch(id, ts).label = label;
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodes.get(id);
  }

  private neighbours(id: NodeId): NodeId[] {
    const s = this.links.get(id);
    if (!s) return [];
    const cap = this.opts.supernodeDegree ?? 1_000;
    if (s.size > cap) return []; // supernode guard
    return [...s];
  }

  /** BFS hops from any of the entities to the nearest node labelled fraud. */
  fraudDistance(e: Entities, maxHops = 3): number | null {
    const start = this.entityIds(e).filter((id) => this.nodes.has(id));
    const seen = new Set<NodeId>(start);
    let frontier = start;
    for (let hop = 0; hop <= maxHops; hop++) {
      for (const id of frontier) if (this.nodes.get(id)?.label === 'fraud') return hop;
      if (hop === maxHops) break;
      const next: NodeId[] = [];
      for (const id of frontier) {
        if (id.startsWith('ip:') && hop > 0) continue; // don't traverse through shared IPs
        for (const nb of this.neighbours(id)) if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Distinct payers that sent money to a beneficiary within the window. */
  fanIn(beneficiary: string, windowMs: number, now: number = Date.now()): number {
    const list = this.inbound.get(LinkGraph.id('account', beneficiary)) ?? [];
    const s = new Set<NodeId>();
    for (const t of list) if (t.ts >= now - windowMs) s.add(t.from);
    return s.size;
  }

  /**
   * Would a transfer payer → beneficiary close a directed cycle of ≤ maxLen?
   * Bounded DFS from the beneficiary back to the payer through money flow,
   * also hopping across identity links (same person, different wallet).
   */
  closesCycle(e: Entities, maxLen = 4, windowMs = 7 * 24 * 3_600_000, now: number = Date.now()): NodeId[] | null {
    const from = LinkGraph.payerKey(e);
    if (!from || !e.beneficiary) return null;
    const target = new Set<NodeId>([from, ...this.entityIds(e)]);
    const start = LinkGraph.id('account', e.beneficiary);

    const stack: Array<{ node: NodeId; path: NodeId[] }> = [{ node: start, path: [from, start] }];
    while (stack.length) {
      const { node, path } = stack.pop()!;
      if (path.length - 1 > maxLen) continue;
      // money leaving `node` directly, or from identities linked to it
      const owners = [node, ...this.neighbours(node).filter((n) => !n.startsWith('ip:'))];
      for (const owner of owners) {
        for (const t of this.out.get(owner) ?? []) {
          if (t.ts < now - windowMs) continue;
          if (target.has(t.to)) return [...path, t.to];
          if (!path.includes(t.to)) stack.push({ node: t.to, path: [...path, t.to] });
        }
      }
    }
    return null;
  }

  /** Connected identity cluster (excluding IPs) around the entities, capped. */
  cluster(e: Entities, limit = 200): NodeId[] {
    const start = this.entityIds(e).filter((id) => this.nodes.has(id) && !id.startsWith('ip:'));
    const seen = new Set<NodeId>(start);
    const queue = [...start];
    while (queue.length && seen.size < limit) {
      const id = queue.shift()!;
      for (const nb of this.neighbours(id)) {
        if (nb.startsWith('ip:') || seen.has(nb)) continue;
        seen.add(nb);
        queue.push(nb);
      }
    }
    return [...seen];
  }

  /** Count of payer identities (msisdn/email/account) in the cluster. */
  clusterIdentityCount(e: Entities): number {
    return this.cluster(e).filter((id) => id.startsWith('msisdn:') || id.startsWith('account:') || id.startsWith('email:')).length;
  }

  /** Enrichment block the engine consumes. */
  enrichment(e: Entities, now: number = Date.now()) {
    return {
      fraud_distance: this.fraudDistance(e),
      beneficiary_fan_in: e.beneficiary ? this.fanIn(e.beneficiary, 24 * 3_600_000, now) : 0,
      closes_cycle: !!this.closesCycle(e, 4, undefined, now),
      cluster_size: this.clusterIdentityCount(e),
    };
  }

  /** Subgraph for the console's link-analysis view (FR-511). */
  subgraph(e: Entities, limit = 60) {
    const ids = this.cluster(e, limit);
    const set = new Set(ids);
    const ipIds = new Set<NodeId>();
    for (const id of ids) for (const nb of this.links.get(id) ?? []) if (nb.startsWith('ip:')) ipIds.add(nb);
    ipIds.forEach((id) => set.add(id));
    const edges: Array<{ source: NodeId; target: NodeId; kind: 'link' | 'transfer'; amount?: number }> = [];
    for (const id of set) {
      for (const nb of this.links.get(id) ?? []) if (set.has(nb) && id < nb) edges.push({ source: id, target: nb, kind: 'link' });
      for (const t of this.out.get(id) ?? []) {
        set.add(t.to);
        edges.push({ source: t.from, target: t.to, kind: 'transfer', amount: t.amount });
      }
    }
    return {
      nodes: [...set].map((id) => this.nodes.get(id) ?? { id, kind: id.split(':')[0] as NodeKind, first_seen: 0, last_seen: 0 }),
      edges,
    };
  }

  stats() {
    let transfers = 0;
    for (const l of this.out.values()) transfers += l.length;
    return { nodes: this.nodes.size, transfers };
  }
}
