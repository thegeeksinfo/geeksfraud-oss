# Contributing

1. `npm install`, then `npm run build && npm test`.
2. Keep the engine and SDK dependency-free.
3. New signals need a reason code in `packages/engine/src/reasons.ts`, a detector in `signals.ts`, and a test.
4. Never add code to the SDK that reads `value`, `textContent` or clipboard contents of form fields. `packages/sdk-js/test/privacy.test.ts` must keep passing.

By contributing you agree your work is licensed under Apache-2.0.
