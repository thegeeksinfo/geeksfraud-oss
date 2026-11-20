# @geeksfraud/node

Server client for the GeeksFraud Decision API.

```ts
import { GeeksFraud, hashIdentifier, verifyWebhook } from '@geeksfraud/node';

const fg = new GeeksFraud({ secretKey: process.env.GEEKSFRAUD_SECRET_KEY!, timeoutMs: 300, onFailOpen: (e) => log.warn(e) });
const r = await fg.decide({ session_id, merchant, transaction, payer: { msisdn_hash: hashIdentifier(phone, salt, 'msisdn') } });
if (r.decision === 'REJECT') decline(r.reasons[0].merchant_text);
await fg.reportOutcome(r.decision_id!, 'chargeback');
```

- **Fail-open:** timeouts, network errors, 429 and 5xx return `APPROVE` with `fail_open: true`, so an outage never blocks a payment. 400/401/409 throw, because they are integration bugs.
- **Idempotent:** sends `Idempotency-Key` (defaults to the transaction ID).
- `hashIdentifier()` normalises phone numbers and emails before salted SHA-256.
- `verifyWebhook()` checks `FG-Signature` HMAC-SHA256 with replay protection.

Apache-2.0.
