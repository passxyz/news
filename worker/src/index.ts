// CyberSec Daily — Cloudflare Worker backend (Phase P6).
//
// Endpoints (see implementation-plan.md §Phase 6):
//   POST   /api/subscribe           — create pending subscriber + confirmation email
//   GET    /api/subscribe/confirm   — activate subscriber (double opt-in)
//   GET    /api/unsubscribe         — deactivate subscriber
//   GET    /api/subscribers         — admin: list subscribers
//   GET    /api/sources             — public, edge-cached source list mirror
//   PUT    /api/sources             — admin: update source list mirror
//   POST   /api/send-daily          — Actions-HMAC-authed: render + send daily digest
//   GET    /api/health              — liveness probe
//
// Storage: Cloudflare KV (primary). See schema.sql for a D1 alternative.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Digest, Env, ResendEmail, Source, SourceList, Subscriber } from './types';
import { renderConfirmationEmail, renderEmail, renderSuccessPage } from './email_template';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBSCRIBE_RATE_LIMIT = 5; // requests per minute per IP
const SUBSCRIBE_WINDOW_SEC = 60;
const SEND_DAILY_RATE_LIMIT = 10; // requests per hour per IP
const SEND_DAILY_WINDOW_SEC = 3600;
const DAILY_EMAIL_CAP = 100; // Resend free-tier daily cap

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_BASE = 'https://api.resend.com';

// ---------------------------------------------------------------------------
// Helpers — crypto, validation, logging
// ---------------------------------------------------------------------------

export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short hashed identifier for an email, safe to emit in logs. */
export async function hashEmailForLog(email: string): Promise<string> {
  return (await sha256Hex('email:' + email)).slice(0, 16);
}

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Length-agnostic constant-time comparison via SHA-256 fingerprints. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return timingSafeEqualHex(ha, hb);
}

/** Emit a structured JSON log line. */
function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

// ---------------------------------------------------------------------------
// Helpers — rate limiting (fixed-window counter in KV with TTL)
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  bucket: string,
  limit: number,
  windowSeconds: number,
  ip: string,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const key = `rl:${bucket}:${ip}:${windowStart}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) {
    return { allowed: false, count, limit };
  }
  // KV writes are eventually consistent and not atomic; this is acceptable
  // for best-effort rate limiting (a few extra requests under contention).
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds + 5 });
  return { allowed: true, count: count + 1, limit };
}

function clientIp(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers — auth
// ---------------------------------------------------------------------------

async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return false;
  const auth = c.req.header('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return safeEqual(m[1], expected);
}

/**
 * Verify the GitHub Actions HMAC signature against the raw request body.
 * `X-Actions-Signature` is hex HMAC-SHA256(body, ACTIONS_SECRET).
 */
async function verifyActionsSignature(rawBody: string, c: Context<{ Bindings: Env }>): Promise<boolean> {
  const secret = c.env.ACTIONS_SECRET;
  if (!secret) return false;
  const sig = (c.req.header('X-Actions-Signature') || '').trim().toLowerCase();
  if (!sig) return false;
  const expected = (await hmacSha256Hex(rawBody, secret)).toLowerCase();
  return timingSafeEqualHex(sig, expected);
}

// ---------------------------------------------------------------------------
// Helpers — subscriber storage
// ---------------------------------------------------------------------------

/** Key under which a subscriber record is stored (= lowercased email). */
function subscriberKey(email: string): string {
  return email.toLowerCase();
}

/** Key under which the reverse token→email index is stored. */
function tokenKey(token: string): string {
  return `token:${token}`;
}

async function listAllSubscribers(kv: KVNamespace): Promise<Subscriber[]> {
  const out: Subscriber[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ cursor, limit: 1000 });
    for (const k of res.keys) {
      if (k.name.startsWith('token:')) continue; // skip reverse index
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as Subscriber);
      } catch {
        // skip corrupt records
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

async function listActiveSubscribers(kv: KVNamespace): Promise<Subscriber[]> {
  const all = await listAllSubscribers(kv);
  return all.filter((s) => s.status === 'active');
}

// ---------------------------------------------------------------------------
// Helpers — Resend API
// ---------------------------------------------------------------------------

async function sendConfirmationEmail(env: Env, email: string, confirmUrl: string): Promise<boolean> {
  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: email,
      subject: 'Confirm your CyberSec Daily subscription',
      html: renderConfirmationEmail(confirmUrl),
      tags: [{ name: 'type', value: 'subscribe-confirm' }],
    }),
  });
  return resp.ok;
}

async function sendDigestBatch(env: Env, emails: ResendEmail[]): Promise<{ ok: boolean; status: number; body: string }> {
  const resp = await fetch(`${RESEND_BASE}/emails/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emails),
  });
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

// ---------------------------------------------------------------------------
// Helpers — digest fetching (fallback when request body is empty)
// ---------------------------------------------------------------------------

async function fetchLatestDigest(env: Env): Promise<Digest | null> {
  const repo = env.GITHUB_REPO;
  if (!repo) return null;
  const date = new Date().toISOString().slice(0, 10);
  const url = `https://raw.githubusercontent.com/${repo}/main/data/digests/${date}.json`;
  const headers: Record<string, string> = { 'User-Agent': 'cybersec-news-worker' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    return (await resp.json()) as Digest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers — source validation
// ---------------------------------------------------------------------------

function isValidSourceList(data: unknown): data is SourceList {
  if (!data || typeof data !== 'object') return false;
  const arr = (data as { sources?: unknown }).sources;
  if (!Array.isArray(arr)) return false;
  return arr.every(
    (s) =>
      s && typeof s === 'object' &&
      typeof (s as Source).id === 'string' &&
      typeof (s as Source).name === 'string' &&
      typeof (s as Source).url === 'string' &&
      typeof (s as Source).type === 'string',
  );
}

// ---------------------------------------------------------------------------
// App + routes
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// --- Health ----------------------------------------------------------------
app.get('/api/health', (c) => {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
});

// --- Subscribe (create pending + send confirmation email) ------------------
app.post('/api/subscribe', async (c) => {
  const ip = clientIp(c);
  const rl = await checkRateLimit(c.env.RATE_LIMIT, 'subscribe', SUBSCRIBE_RATE_LIMIT, SUBSCRIBE_WINDOW_SEC, ip);
  if (!rl.allowed) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const rawEmail = (body as { email?: unknown })?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return c.json({ error: 'invalid email' }, 400);
  }

  // Idempotency: if already active or pending, do not duplicate.
  const existingRaw = await c.env.SUBSCRIBERS.get(subscriberKey(email));
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as Subscriber;
      if (existing.status === 'active') {
        logEvent('subscribe.idempotent-active', { email: await hashEmailForLog(email) });
        return c.json({ message: 'already subscribed' }, 200);
      }
      if (existing.status === 'pending') {
        logEvent('subscribe.idempotent-pending', { email: await hashEmailForLog(email) });
        return c.json({ message: 'confirmation pending; check your inbox' }, 200);
      }
      // status === 'inactive' → fall through and re-subscribe.
    } catch {
      // corrupt record: overwrite below
    }
  }

  const token = randomToken();
  const sub: Subscriber = {
    email,
    status: 'pending',
    confirm_token: token,
    created_at: new Date().toISOString(),
    lang: 'en',
  };
  await c.env.SUBSCRIBERS.put(subscriberKey(email), JSON.stringify(sub));
  // Reverse index so confirm/unsubscribe can resolve token → email in O(1).
  await c.env.SUBSCRIBERS.put(tokenKey(token), email);

  const base = (c.env.WORKER_PUBLIC_BASE || '').replace(/\/$/, '');
  const confirmUrl = `${base}/api/subscribe/confirm?token=${token}`;
  const ok = await sendConfirmationEmail(c.env, email, confirmUrl);
  if (!ok) {
    logEvent('subscribe.confirm-email-failed', { email: await hashEmailForLog(email) });
    return c.json({ error: 'failed to send confirmation email' }, 502);
  }

  logEvent('subscribe.created', { email: await hashEmailForLog(email) });
  return c.json({ message: 'confirmation email sent' }, 202);
});

// --- Confirm (double opt-in activation) ------------------------------------
app.get('/api/subscribe/confirm', async (c) => {
  const token = c.req.query('token') || '';
  if (!token) return c.html(renderSuccessPage('Invalid link', 'The confirmation link is missing a token.'), 400);

  const email = await c.env.SUBSCRIBERS.get(tokenKey(token));
  if (!email) return c.html(renderSuccessPage('Invalid link', 'This confirmation link is invalid or has expired.'), 400);

  const raw = await c.env.SUBSCRIBERS.get(subscriberKey(email));
  if (!raw) return c.html(renderSuccessPage('Not found', 'Subscriber record not found.'), 404);

  const sub = JSON.parse(raw) as Subscriber;
  if (sub.status !== 'active') {
    sub.status = 'active';
    await c.env.SUBSCRIBERS.put(subscriberKey(email), JSON.stringify(sub));
  }
  logEvent('subscribe.confirmed', { email: await hashEmailForLog(email) });
  return c.html(renderSuccessPage('Subscription confirmed', "You're subscribed! You will receive the daily cyber security digest starting with the next issue."));
});

// --- Unsubscribe -----------------------------------------------------------
app.get('/api/unsubscribe', async (c) => {
  const token = c.req.query('token') || '';
  if (!token) return c.html(renderSuccessPage('Invalid link', 'The unsubscribe link is missing a token.'), 400);

  const email = await c.env.SUBSCRIBERS.get(tokenKey(token));
  if (!email) return c.html(renderSuccessPage('Invalid link', 'This unsubscribe link is invalid or has expired.'), 400);

  const raw = await c.env.SUBSCRIBERS.get(subscriberKey(email));
  if (!raw) return c.html(renderSuccessPage('Not found', 'Subscriber record not found.'), 404);

  const sub = JSON.parse(raw) as Subscriber;
  if (sub.status !== 'inactive') {
    sub.status = 'inactive';
    await c.env.SUBSCRIBERS.put(subscriberKey(email), JSON.stringify(sub));
  }
  logEvent('unsubscribe', { email: await hashEmailForLog(email) });
  return c.html(renderSuccessPage('Unsubscribed', 'You will no longer receive the daily digest. Sorry to see you go!'));
});

// --- Admin: list subscribers -----------------------------------------------
app.get('/api/subscribers', async (c) => {
  if (!(await isAdmin(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const subs = await listAllSubscribers(c.env.SUBSCRIBERS);
  logEvent('subscribers.listed', { count: subs.length });
  return c.json({ subscribers: subs, count: subs.length });
});

// --- Public: get sources (cached) ------------------------------------------
app.get('/api/sources', async (c) => {
  const raw = await c.env.SOURCES.get('sources');
  if (!raw) {
    return c.json({ error: 'sources not seeded' }, 404, { 'Cache-Control': 'no-store' });
  }
  return new Response(raw, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
});

// --- Admin: update sources mirror ------------------------------------------
app.put('/api/sources', async (c) => {
  if (!(await isAdmin(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  // Accept either { sources: [...] } or a bare [...] array.
  const candidate: unknown = Array.isArray(body) ? { sources: body } : body;
  if (!isValidSourceList(candidate)) {
    return c.json({ error: 'expected a source list; each source requires id, name, url, type' }, 400);
  }
  await c.env.SOURCES.put('sources', JSON.stringify(candidate));
  logEvent('sources.updated', { count: candidate.sources.length });
  return c.json({ message: 'sources updated', count: candidate.sources.length });
});

// --- Actions: send daily digest --------------------------------------------
app.post('/api/send-daily', async (c) => {
  const ip = clientIp(c);
  const rl = await checkRateLimit(c.env.RATE_LIMIT, 'send-daily', SEND_DAILY_RATE_LIMIT, SEND_DAILY_WINDOW_SEC, ip);
  if (!rl.allowed) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }

  // Read raw body once; needed for HMAC verification before any parsing.
  const rawBody = await c.req.text();

  if (!(await verifyActionsSignature(rawBody, c))) {
    logEvent('send-daily.unauthorized', { ip });
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Resolve the digest: request body first, else fetch latest from the repo.
  let digest: Digest | null = null;
  if (rawBody.trim().length > 0) {
    try {
      digest = JSON.parse(rawBody) as Digest;
    } catch {
      return c.json({ error: 'invalid digest JSON in body' }, 400);
    }
  }
  if (!digest) {
    digest = await fetchLatestDigest(c.env);
    if (!digest) {
      return c.json({ error: 'digest not available; provide a body or configure GITHUB_REPO' }, 502);
    }
  }
  if (!digest.items || !Array.isArray(digest.items) || digest.items.length === 0) {
    return c.json({ error: 'digest has no items' }, 400);
  }

  const subs = await listActiveSubscribers(c.env.SUBSCRIBERS);
  if (subs.length === 0) {
    logEvent('send-daily.no-subscribers', { digest_date: digest.date });
    return c.json({ sent: 0, date: digest.date, message: 'no active subscribers' });
  }

  let capped = subs;
  if (subs.length > DAILY_EMAIL_CAP) {
    capped = subs.slice(0, DAILY_EMAIL_CAP);
    logEvent('send-daily.cap-exceeded', { subscribers: subs.length, cap: DAILY_EMAIL_CAP });
    console.warn(
      JSON.stringify({
        event: 'send-daily.daily-cap-exceeded',
        ts: new Date().toISOString(),
        subscribers: subs.length,
        cap: DAILY_EMAIL_CAP,
        message: 'Resend free-tier daily cap reached; sending to the first 100 subscribers only.',
      }),
    );
  }

  const base = (c.env.WORKER_PUBLIC_BASE || '').replace(/\/$/, '');
  const subject = `CyberSec Daily — ${digest.date}`;
  const emails: ResendEmail[] = capped.map((s) => {
    const unsubscribeUrl = `${base}/api/unsubscribe?token=${s.confirm_token}`;
    return {
      from: c.env.RESEND_FROM,
      to: s.email,
      subject,
      html: renderEmail(digest as Digest, unsubscribeUrl),
      tags: [{ name: 'type', value: 'daily-digest' }],
    };
  });

  const result = await sendDigestBatch(c.env, emails);
  if (!result.ok) {
    logEvent('send-daily.resend-error', { status: result.status, body: result.body });
    return c.json({ error: 'resend batch failed', status: result.status }, 502);
  }

  logEvent('send-daily.sent', { sent: emails.length, subscribers: subs.length, digest_date: digest.date });
  return c.json({ sent: emails.length, date: digest.date, subscribers: subs.length });
});

// --- 404 fallback ----------------------------------------------------------
app.notFound((c) => c.json({ error: 'not found' }, 404));

// --- Error handler ---------------------------------------------------------
app.onError((err, c) => {
  console.error(JSON.stringify({ event: 'unhandled-error', ts: new Date().toISOString(), message: String(err) }));
  return c.json({ error: 'internal server error' }, 500);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { app };
export default { fetch: app.fetch };
