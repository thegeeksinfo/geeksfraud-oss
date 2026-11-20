/**
 * geeksfraud.js — behavioral risk collector for checkouts.
 *
 * Privacy contract (PRD FR-103, FR-108, NFR-10, NFR-16):
 *  - NEVER reads, stores or sends what a user types. Only timings, counts and ratios.
 *  - Only listens on fields that carry an allow-listed `data-fg-role`.
 *    Passwords, card numbers, CVV, PIN and OTP are never observed, even if tagged.
 *  - Pointer data is summarised on-device; raw paths never leave the browser.
 *  - All failures are silent: the SDK can never break or slow down a checkout.
 */

export type Checkpoint = 'signup' | 'login' | 'checkout' | 'payout' | 'password_reset';

export interface InitOptions {
  publicKey: string;
  sessionId?: string;
  checkpoint?: Checkpoint;
  /** Collector URL. Defaults to the hosted collector; set to a first-party path for ad-block resilience (FR-113). */
  endpoint?: string;
  /** Gateway-controlled consent flag (FR-111). When false only device/automation signals are sent. */
  consent?: boolean;
  /** Restrict observation to this root element. Defaults to document. */
  root?: Document | HTMLElement;
}

const VERSION = '1.0.0';
const DEFAULT_ENDPOINT = 'https://collect.geeksfraud.com/v1/collect';
const ALLOWED_ROLES = new Set([
  'name', 'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'postcode', 'card_holder', 'amount', 'search', 'username',
]);
const FORBIDDEN_TYPES = new Set(['password', 'hidden', 'file']);
const FORBIDDEN_AUTOCOMPLETE = /cc-number|cc-csc|cc-exp|one-time-code|current-password|new-password/i;
const POINTER_HZ = 30;
const IDLE_MS = 1_000;
const STROKE_GAP_MS = 300;

// ───────────────────────── helpers ─────────────────────────

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** RFC 9562 UUIDv7 — time-ordered, so session ids sort by start time. */
export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = Date.now();
  b[0] = (ts / 2 ** 40) & 0xff;
  b[1] = (ts / 2 ** 32) & 0xff;
  b[2] = (ts >>> 24) & 0xff;
  b[3] = (ts >>> 16) & 0xff;
  b[4] = (ts >>> 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Welford running mean/variance, so we never keep raw timing arrays. */
class Stat {
  n = 0;
  mean = 0;
  m2 = 0;
  push(x: number) {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }
  get variance() {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }
}

async function sha256Hex(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    // FNV-1a fallback for insecure contexts
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

// ───────────────────── role / field policy ─────────────────────

export function observableRole(el: EventTarget | null): string | null {
  if (!el || !(el as HTMLElement).getAttribute) return null;
  const input = el as HTMLInputElement;
  const role = input.getAttribute('data-fg-role');
  if (!role || !ALLOWED_ROLES.has(role)) return null;
  if (FORBIDDEN_TYPES.has((input.type || '').toLowerCase())) return null;
  if (FORBIDDEN_AUTOCOMPLETE.test(input.getAttribute('autocomplete') || '')) return null;
  return role;
}

// ───────────────────────── collectors ─────────────────────────

interface FieldState {
  role: string;
  keys: number;
  pasted: boolean;
  autofilled: boolean;
  programmatic: boolean;
  first_input_ms?: number;
}

class Collector {
  readonly startedAt = now();
  readonly hold = new Stat();
  readonly flight = new Stat();
  keys = 0;
  backspaces = 0;
  private lastKeyUp = 0;
  private readonly down = new Map<string, number>();
  readonly fields = new Map<string, FieldState>();

  // pointer
  moves = 0;
  idleGaps = 0;
  private lastSample = 0;
  private lastPoint: { x: number; y: number; t: number } | null = null;
  private strokeStart: { x: number; y: number } | null = null;
  private strokePath = 0;
  readonly straight = new Stat();
  readonly speed = new Stat();
  touch = false;

  field(role: string): FieldState {
    let f = this.fields.get(role);
    if (!f) {
      f = { role, keys: 0, pasted: false, autofilled: false, programmatic: false };
      this.fields.set(role, f);
    }
    return f;
  }

  private markFirst(f: FieldState) {
    if (f.first_input_ms === undefined) f.first_input_ms = Math.round(now() - this.startedAt);
  }

  onKeyDown = (e: KeyboardEvent) => {
    const role = observableRole(e.target);
    if (!role || e.repeat) return;
    const t = now();
    // e.code is used only to pair down/up in memory; it is never stored or sent.
    this.down.set(e.code, t);
    if (this.lastKeyUp) this.flight.push(t - this.lastKeyUp);
    if (e.key === 'Backspace' || e.key === 'Delete') this.backspaces++;
    this.keys++;
    const f = this.field(role);
    f.keys++;
    this.markFirst(f);
  };

  onKeyUp = (e: KeyboardEvent) => {
    const t0 = this.down.get(e.code);
    if (t0 === undefined) return;
    this.down.delete(e.code);
    const t = now();
    this.hold.push(t - t0);
    this.lastKeyUp = t;
  };

  onPaste = (e: ClipboardEvent) => {
    const role = observableRole(e.target);
    if (!role) return;
    const f = this.field(role);
    f.pasted = true;
    this.markFirst(f);
  };

  onInput = (e: Event) => {
    const role = observableRole(e.target);
    if (!role) return;
    const f = this.field(role);
    if (!e.isTrusted) {
      f.programmatic = true;
    } else {
      const it = (e as InputEvent).inputType;
      if ((it === undefined || it === 'insertReplacementText') && f.keys === 0 && !f.pasted) f.autofilled = true;
    }
    this.markFirst(f);
  };

  /** Fields changed with no input/keys at all (value set via script, then change dispatched). */
  onChange = (e: Event) => {
    const role = observableRole(e.target);
    if (!role) return;
    const f = this.field(role);
    if (!e.isTrusted || (f.keys === 0 && !f.pasted && !f.autofilled)) f.programmatic = true;
  };

  onPointer = (e: PointerEvent | MouseEvent) => {
    const t = now();
    if (t - this.lastSample < 1000 / POINTER_HZ) return;
    this.lastSample = t;
    if ((e as PointerEvent).pointerType === 'touch') this.touch = true;
    this.moves++;
    const p = { x: e.clientX, y: e.clientY, t };
    const last = this.lastPoint;
    if (last) {
      const dt = t - last.t;
      if (dt > IDLE_MS) this.idleGaps++;
      if (dt > STROKE_GAP_MS) this.endStroke(last);
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      this.strokePath += d;
      if (dt > 0 && dt <= STROKE_GAP_MS) this.speed.push(d / dt);
    }
    if (!this.strokeStart || (last && t - last.t > STROKE_GAP_MS)) {
      this.strokeStart = { x: p.x, y: p.y };
      this.strokePath = 0;
    }
    this.lastPoint = p;
  };

  private endStroke(end: { x: number; y: number }) {
    if (this.strokeStart && this.strokePath > 20) {
      const disp = Math.hypot(end.x - this.strokeStart.x, end.y - this.strokeStart.y);
      this.straight.push(Math.min(1, disp / this.strokePath));
    }
    this.strokeStart = null;
    this.strokePath = 0;
  }

  summary(consent: boolean) {
    if (this.lastPoint) this.endStroke(this.lastPoint);
    const out: Record<string, unknown> = {
      session: { duration_ms: Math.round(now() - this.startedAt) },
    };
    if (!consent) return out;
    if (this.keys) {
      out.typing = {
        keys: this.keys,
        hold_mean_ms: +this.hold.mean.toFixed(1),
        hold_var: +this.hold.variance.toFixed(1),
        flight_mean_ms: +this.flight.mean.toFixed(1),
        flight_var: +this.flight.variance.toFixed(1),
        backspaces: this.backspaces,
      };
    }
    if (this.fields.size) out.fields = Array.from(this.fields.values());
    if (this.moves) {
      const speedCv = this.speed.mean > 0 ? Math.sqrt(this.speed.variance) / this.speed.mean : 0;
      out.pointer = {
        moves: this.moves,
        straight_ratio: +(this.straight.n ? this.straight.mean : 0).toFixed(3),
        speed_var: +speedCv.toFixed(3),
        idle_gaps: this.idleGaps,
      };
    }
    return out;
  }
}

// ───────────────────── environment & automation ─────────────────────

export function detectAutomation(w: Window & typeof globalThis = window) {
  const n = (w.navigator || navigator) as Navigator & { userAgentData?: { platform?: string; brands?: Array<{ brand: string }> } };
  const ua = n.userAgent || '';
  const keys = Object.keys(w);
  const cdp =
    keys.some((k) => /^cdc_|^\$cdc_|__playwright|__pwInitScripts|__puppeteer|_selenium|callSelenium|__nightmare|domAutomation|_phantom|callPhantom/i.test(k)) ||
    !!(w.document && (w.document.documentElement.getAttribute('webdriver') || w.document.documentElement.getAttribute('selenium')));
  const headless = /HeadlessChrome|PhantomJS|SlimerJS/i.test(ua) || (w.outerWidth === 0 && w.outerHeight === 0);
  let inconsistent = false;
  const hinted = n.userAgentData?.platform;
  if (hinted) {
    const p = hinted.toLowerCase();
    if ((p === 'windows' && !/windows/i.test(ua)) || (p === 'android' && !/android/i.test(ua)) || (p === 'macos' && !/mac os/i.test(ua))) inconsistent = true;
  }
  if (/Chrome\//.test(ua) && !('chrome' in w) && !/Android|CriOS|Edg\//.test(ua)) inconsistent = true;
  return { webdriver: n.webdriver === true, headless, cdp, inconsistent_hints: inconsistent };
}

function canvasHash(): string {
  try {
    const c = document.createElement('canvas');
    c.width = 220;
    c.height = 30;
    const g = c.getContext('2d');
    if (!g) return '';
    g.textBaseline = 'top';
    g.font = "14px 'Arial'";
    g.fillStyle = '#f60';
    g.fillRect(100, 1, 60, 20);
    g.fillStyle = '#069';
    g.fillText('GeeksFraud ✓ 2026', 2, 15);
    return c.toDataURL().slice(-64);
  } catch {
    return '';
  }
}

function webglRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

function environment() {
  const n = navigator as Navigator & { deviceMemory?: number };
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: n.language,
    touch: 'ontouchstart' in window || (n.maxTouchPoints || 0) > 0,
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    cores: n.hardwareConcurrency || 0,
    memory: n.deviceMemory || 0,
    ua: n.userAgent,
  };
}

const STORE_KEY = '_gfid';
function firstPartyId(): string {
  try {
    let id = localStorage.getItem(STORE_KEY);
    if (!id) {
      const m = document.cookie.match(/(?:^|; )_gfid=([^;]+)/);
      id = m ? m[1] : uuidv7();
      localStorage.setItem(STORE_KEY, id);
    }
    document.cookie = `${STORE_KEY}=${id}; path=/; max-age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    return id;
  } catch {
    return '';
  }
}

// ───────────────────────── transport ─────────────────────────

function send(url: string, body: unknown): void {
  try {
    const json = JSON.stringify(body);
    const blob = new Blob([json], { type: 'text/plain' }); // text/plain avoids a CORS preflight
    if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return;
    // retry once, then drop silently (FR-109)
    fetch(url, { method: 'POST', body: json, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } }).catch(() => undefined);
  } catch {
    /* never throw into the host page */
  }
}

// ───────────────────────── public API ─────────────────────────

interface State {
  opts: Required<Pick<InitOptions, 'publicKey' | 'endpoint'>> & InitOptions;
  sessionId: string;
  checkpoint: Checkpoint;
  consent: boolean;
  collector: Collector;
  deviceId?: string;
  fpHash?: string;
  cid?: string;
  seq: number;
  detach: () => void;
}

let state: State | null = null;

function attach(root: Document | HTMLElement, c: Collector): () => void {
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  const pairs: Array<[string, EventListener]> = [
    ['keydown', c.onKeyDown as EventListener],
    ['keyup', c.onKeyUp as EventListener],
    ['paste', c.onPaste as EventListener],
    ['input', c.onInput],
    ['change', c.onChange],
    ['pointermove', c.onPointer as EventListener],
    ['mousemove', c.onPointer as EventListener],
  ];
  pairs.forEach(([t, l]) => root.addEventListener(t, l, opts));
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  return () => {
    pairs.forEach(([t, l]) => root.removeEventListener(t, l, opts));
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
  };
}

export function init(opts: InitOptions): string {
  try {
    if (state) state.detach();
    const collector = new Collector();
    const sessionId = opts.sessionId || uuidv7();
    state = {
      opts: { endpoint: DEFAULT_ENDPOINT, ...opts },
      sessionId,
      checkpoint: opts.checkpoint || 'checkout',
      consent: opts.consent !== false,
      collector,
      seq: 0,
      detach: () => undefined,
    };
    state.detach = attach(opts.root || document, collector);
    const s = state;
    s.cid = firstPartyId();
    const env = environment();
    sha256Hex([canvasHash(), webglRenderer(), env.screen, env.timezone, env.language, env.cores, env.memory].join('|')).then((fp) => {
      s.fpHash = fp;
      s.deviceId = `dev_${fp.slice(0, 24)}`;
    });
    return sessionId;
  } catch {
    return opts.sessionId || '';
  }
}

export function getSessionId(): string | null {
  return state ? state.sessionId : null;
}

export function setCheckpoint(cp: Checkpoint): void {
  if (state) {
    flush();
    state.checkpoint = cp;
  }
}

export function setConsent(consent: boolean): void {
  if (state) state.consent = consent;
}

/** Build the payload without sending — exposed for tests and the PCI data-inventory page. */
export function payload() {
  if (!state) return null;
  const s = state;
  const env = environment();
  return {
    v: VERSION,
    public_key: s.opts.publicKey,
    session_id: s.sessionId,
    checkpoint: s.checkpoint,
    seq: s.seq,
    cid: s.cid,
    fp_hash: s.fpHash,
    summary: {
      device_id: s.deviceId,
      consent: s.consent,
      automation: detectAutomation(),
      env: s.consent ? env : { timezone: env.timezone, touch: env.touch },
      ...s.collector.summary(s.consent),
    },
  };
}

/** Send the current summary. Call before submitting the payment form. */
export function flush(): void {
  try {
    const p = payload();
    if (!p || !state) return;
    state.seq++;
    send(state.opts.endpoint, p);
  } catch {
    /* silent */
  }
}

export function destroy(): void {
  if (state) state.detach();
  state = null;
}

export const version = VERSION;
