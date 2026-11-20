import type { Condition, ConditionGroup, Decision, Rule } from './types';

/** Resolve a dotted path such as "payer.network" or "velocity.ip_tx_1h". */
export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return null;
}

function norm(v: unknown): unknown {
  return typeof v === 'string' ? v.toLowerCase() : v;
}

export function evalCondition(c: Condition, facts: unknown): boolean {
  const v = getPath(facts, c.field);
  switch (c.op) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'not_exists':
      return v === undefined || v === null;
    case 'eq':
      return norm(v) === norm(c.value);
    case 'neq':
      return norm(v) !== norm(c.value);
    case 'gt': {
      const r = cmp(v, c.value);
      return r !== null && r > 0;
    }
    case 'gte': {
      const r = cmp(v, c.value);
      return r !== null && r >= 0;
    }
    case 'lt': {
      const r = cmp(v, c.value);
      return r !== null && r < 0;
    }
    case 'lte': {
      const r = cmp(v, c.value);
      return r !== null && r <= 0;
    }
    case 'in':
      return Array.isArray(c.value) && c.value.map(norm).includes(norm(v));
    case 'not_in':
      return Array.isArray(c.value) && !c.value.map(norm).includes(norm(v));
    case 'contains':
      if (Array.isArray(v)) return v.map(norm).includes(norm(c.value));
      return typeof v === 'string' && typeof c.value === 'string' && v.toLowerCase().includes(c.value.toLowerCase());
    case 'not_contains':
      if (Array.isArray(v)) return !v.map(norm).includes(norm(c.value));
      return !(typeof v === 'string' && typeof c.value === 'string' && v.toLowerCase().includes(c.value.toLowerCase()));
    case 'starts_with':
      return typeof v === 'string' && typeof c.value === 'string' && v.toLowerCase().startsWith(c.value.toLowerCase());
    default:
      return false;
  }
}

function isGroup(x: Condition | ConditionGroup): x is ConditionGroup {
  return 'all' in x || 'any' in x || 'not' in x;
}

export function evalGroup(g: ConditionGroup, facts: unknown): boolean {
  const ev = (x: Condition | ConditionGroup) => (isGroup(x) ? evalGroup(x, facts) : evalCondition(x, facts));
  if (g.all && !g.all.every(ev)) return false;
  if (g.any && g.any.length && !g.any.some(ev)) return false;
  if (g.not && ev(g.not)) return false;
  return !!(g.all?.length || g.any?.length || g.not);
}

const SEVERITY_RANK: Record<Decision, number> = { APPROVE: 0, REVIEW: 1, REJECT: 2 };

export interface RuleOutcome {
  hits: Rule[];
  forced: Decision | null;
  forcedBy: Rule | null;
  addScore: number;
}

/**
 * Evaluate tenant rules (FR-302): forcing actions always win over the model.
 * Highest priority wins; on a tie the most severe action wins.
 */
export function evaluateRules(rules: Rule[], facts: unknown): RuleOutcome {
  const hits: Rule[] = [];
  let forcedBy: Rule | null = null;
  let addScore = 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    let matched = false;
    try {
      matched = evalGroup(rule.conditions, facts);
    } catch {
      matched = false; // a malformed rule must never break the decision path
    }
    if (!matched) continue;
    hits.push(rule);
    if (rule.action.type === 'ADD_SCORE') {
      addScore += rule.action.points;
      continue;
    }
    if (!forcedBy) {
      forcedBy = rule;
      continue;
    }
    const pa = rule.priority ?? 0;
    const pb = forcedBy.priority ?? 0;
    if (pa > pb || (pa === pb && SEVERITY_RANK[rule.action.type] > SEVERITY_RANK[forcedBy.action.type as Decision])) {
      forcedBy = rule;
    }
  }

  return {
    hits,
    forced: forcedBy ? (forcedBy.action.type as Decision) : null,
    forcedBy,
    addScore,
  };
}

/** Validate a rule definition before publishing; returns human-readable problems. */
export function validateRule(rule: Rule): string[] {
  const problems: string[] = [];
  if (!rule.id) problems.push('id is required');
  if (!rule.name) problems.push('name is required');
  const ops = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'not_contains', 'exists', 'not_exists', 'starts_with']);
  const walk = (x: Condition | ConditionGroup, depth: number) => {
    if (depth > 6) {
      problems.push('conditions nested deeper than 6 levels');
      return;
    }
    if (isGroup(x)) {
      x.all?.forEach((c) => walk(c, depth + 1));
      x.any?.forEach((c) => walk(c, depth + 1));
      if (x.not) walk(x.not, depth + 1);
    } else {
      if (!x.field) problems.push('condition missing field');
      if (!ops.has(x.op)) problems.push(`unknown operator "${x.op}"`);
      if ((x.op === 'in' || x.op === 'not_in') && !Array.isArray(x.value)) problems.push(`"${x.op}" needs an array value`);
    }
  };
  walk(rule.conditions, 0);
  if (!(rule.conditions.all?.length || rule.conditions.any?.length || rule.conditions.not)) problems.push('rule has no conditions');
  if (rule.action.type === 'ADD_SCORE' && (typeof rule.action.points !== 'number' || Math.abs(rule.action.points) > 100)) {
    problems.push('ADD_SCORE points must be a number between -100 and 100');
  }
  return problems;
}
