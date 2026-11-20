# geeksfraud.js (@geeksfraud/js)

Privacy-first behavioral collector for checkout pages. **3.8 KB gzipped, zero dependencies, never blocks or breaks the page.**

```html
<script src="https://cdn.geeksfraud.com/v1.0.0/geeksfraud.min.js" integrity="sha384-…" crossorigin="anonymous" async></script>
<script>
  const sessionId = GeeksFraud.init({ publicKey: 'fg_pk_…', checkpoint: 'checkout', consent: true });
  // <input name="name" data-fg-role="name"> <input name="phone" data-fg-role="phone">
  form.addEventListener('submit', () => GeeksFraud.flush());
</script>
```

**What it collects:** key hold/flight timing statistics, backspace counts, how each tagged field was filled (typed, pasted, autofilled, scripted), pointer straight-line ratio and speed variance, session duration, automation artefacts (webdriver, headless, CDP), and a hashed device fingerprint.

**What it never collects:** anything a user types. Password, card number, CVV, PIN and OTP fields are never observed, even if tagged; only an allow-list of `data-fg-role` values is watched. `test/privacy.test.ts` types secrets into every field type and fails if any appear in the payload.

`npm run build` emits ESM, CJS and a minified IIFE and prints the SRI hash for your PCI DSS 6.4.3 script inventory. Apache-2.0.
