# GeeksFraud open source

The open-source core of [GeeksFraud](https://geeksfraud.com): behavioral fraud decisions and financial-health scoring for African payments, built for mobile money first.

| Package | What it is |
|---|---|
| [`@geeksfraud/engine`](packages/engine) | Zero-dependency decision engine: 25 signal detectors with stable reason codes, explainable scoring, a rules DSL, sliding-window velocity, a link graph for rings, mule fan-in and money cycles, a Financial Health Score, and sandbox personas. |
| [`@geeksfraud/js`](packages/sdk-js) | `geeksfraud.js`, a privacy-first browser collector: typing rhythm, paste and autofill, pointer movement, automation artefacts. Timings only, never typed values. Under 4 KB gzipped. |
| [`@geeksfraud/node`](packages/node) | Server client for the hosted Decision API: fail-open, idempotent, identifier hashing, webhook verification. |

## Why open source

Fraud tools ask to run inside your checkout and see your customers' behavior. You should be able to read exactly what they collect. The SDK's privacy contract is enforced by a test that types secrets into every field type and fails the build if any reach the payload. Gateways' DPOs and PCI DSS 6.4.3 assessors can review the code instead of a datasheet.

## Quick look

```ts
import { GeeksFraudEngine, PERSONAS } from '@geeksfraud/engine';

const engine = new GeeksFraudEngine();
const bot = PERSONAS.sbx_bot;
const r = await engine.decide(
  {
    merchant: { id: 'mer_1', segment: 'ecommerce' },
    transaction: { id: 'ord_1', amount: 450000, currency: 'UGX', payment_method: 'mobile_money' },
    payer: { msisdn_hash: 'sha256:…', network: 'MTN' },
  },
  { tenant: { tenant_id: 't', mode: 'live', thresholds: { default: { review: 50, reject: 80 } }, rules: [] }, behavior: bot.behavior, enrichment: bot.enrichment },
);
console.log(r.decision, r.geek_score, r.reasons.map((x) => x.code));
// REJECT 100 [ 'FG_AUTOMATION_DETECTED', 'FG_PROGRAMMATIC_FILL', … ]
```

## Develop

```bash
npm install
npm run build
npm test
```

## What is not here

The hosted platform (Decision API, console, trained models, cross-gateway consortium signals, in-region infrastructure) is GeeksFraud's commercial product. The engine here is fully functional on its own: you can run it in-process with your own rules and data.

## License

Apache-2.0. See [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
