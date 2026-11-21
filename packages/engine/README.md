# @geeksfraud/engine

Explainable, zero-dependency fraud and financial-health decision engine for payments — built for mobile money.

```ts
import { GeeksFraudEngine, MemoryVelocityStore } from '@geeksfraud/engine';

const engine = new GeeksFraudEngine(new MemoryVelocityStore());
const r = await engine.decide(request, {
  tenant: { tenant_id: 'gw_1', mode: 'live', thresholds: { default: { review: 50, reject: 80 } }, rules: [] },
  behavior,     // summary from @geeksfraud/js
  enrichment,   // IP/email intel, history, lists, graph
});
// r.geek_score 0–100 · r.decision APPROVE | REVIEW | REJECT · r.reasons[] with contributions
```

- **25 signal detectors** with stable reason codes (`FG_AUTOMATION_DETECTED`, `FG_SIM_SWAP_RECENT`, `FG_MULE_FAN_IN`, …) and merchant-facing text in English (Swahili and French for the most common codes).
- **Noisy-OR scoring** so each reason's contribution to the score is exact and explainable; optional ML model blend that can never break a decision.
- **Rules DSL**: nested `all` / `any` / `not` conditions over any request field or signal; `APPROVE` / `REVIEW` / `REJECT` override the model, `ADD_SCORE` nudges it. `validateRule()` for safe publishing.
- **Velocity** over 1 min / 1 h / 24 h per phone, device, IP, email, BIN and merchant (plug in Redis via the `VelocityStore` interface).
- **Link graph**: shared-device rings, mule fan-in, directed money cycles, proximity to confirmed fraud, supernode guard.
- **Financial Health Score**: Spend, Save, Borrow, Plan, Protect pillars with nudges.
- **Sandbox personas** for deterministic integration tests.
- **Machine learning, dependency-free:** second-order gradient-boosted trees with per-prediction explanations, Isolation Forest for cold start, isotonic calibration, expected-cost threshold optimisation, PSI drift monitoring, and personalized-PageRank fraud proximity on the link graph. A trained `RiskModel` plugs into `decide()` in stacked mode.

## Benchmark

`npm run bench` simulates 80,000 mobile-money payments with hard legitimate look-alikes (cybercafé devices, password managers, honest new SIMs) and delayed chargeback labels, trains on mature labels only, and tests on later traffic. On that held-out period:

| Model | ROC-AUC | Fraud caught at 1 % false positives |
|---|---|---|
| Expert rules only | 0.827 | 35.8 % |
| GBDT stacked on expert signals | 0.963 | 89.4 % |
| XGBoost 3.2, same data and settings (reference) | 0.962 | 89.4 % |

The data is synthetic, so treat the absolute numbers as an upper bound; the comparison between algorithms is the point. Full method and limits: `bench/run.ts`, `bench/simulate.ts`.

`npm test` runs the suite. Apache-2.0.
