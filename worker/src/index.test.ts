// Tests for the CyberSec Daily Worker.
//
// Strategy: invoke the Hono routes directly via `app.request(path, init, env)`
// in a Node environment. The Cloudflare KV namespaces are replaced with an
// in-memory MockKV, and outbound `fetch` calls (Resend + GitHub) are
// intercepted with vi.stubGlobal. No Workers runtime is required.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, hmacSha256Hex } from './index';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// In-memory KV mock
// ---------------------------------------------------------------------------

interface MockEntry {
  value: string;
  expiration?: number; // epoch ms
}

// In-memory KV mock. Structurally compatible with KVNamespace for the subset
// of methods the Worker uses; cast to KVNamespace at construction time.
class MockKV {
  private store = new Map<string, MockEntry>();

  async get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' } | 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown> {
    const entry = this.peek(key);
    if (!entry) return null;
    const type = typeof options === 'string' ? options : options?.type;
    if (type === 'json') {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    const entry: MockEntry = { value };
    if (options?.expirationTtl && options.expirationTtl > 0) {
      entry.expiration = Date.now() + options.expirationTtl * 1000;
    }
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: KVNamespaceListOptions): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }> {
    const prefix = options?.prefix ?? '';
    const keys: { name: string; metadata?: unknown }[] = [];
    for (const key of this.store.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        keys.push({ name: key });
      }
    }
    keys.sort((a, b) => a.name.localeCompare(b.name));
    return { keys, list_complete: true };
  }

  /** Helper for tests: raw access to the underlying value (ignores TTL). */
  _raw(key: string): string | undefined {
    return this.store.get(key)?.value;
  }

  /** Helper for tests: clear all entries. */
  _reset(): void {
    this.store.clear();
  }

  private peek(key: string): MockEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && Date.now() > entry.expiration) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEnv(): Env {
  return {
    SUBSCRIBERS: new MockKV() as unknown as KVNamespace,
    SOURCES: new MockKV() as unknown as KVNamespace,
    RATE_LIMIT: new MockKV() as unknown as KVNamespace,
    RESEND_API_KEY: 'test-resend-key',
    ADMIN_TOKEN: 'test-admin-token',
    ACTIONS_SECRET: 'test-actions-secret',
    GITHUB_TOKEN: undefined,
    WORKER_PUBLIC_BASE: 'https://worker.example.dev',
    RESEND_FROM: 'CyberSec Daily <digest@example.com>',
    GITHUB_REPO: 'user/cyber-security-news',
  };
}

const sampleDigest = {
  date: '2026-08-13',
  generated_at: '2026-08-13T01:05:00Z',
  stats: { items: 1, sources: 1 },
  items: [
    {
      title: 'Critical OpenSSL vulnerability patched',
      url: 'https://example.com/openssl',
      source: 'The Hacker News',
      published: '2026-08-13T09:12:00Z',
      summary: 'Maintainers urge immediate upgrades.',
      tags: ['vuln', 'patch'],
      lang: 'en',
    },
  ],
};

/** Mock global fetch: respond to Resend endpoints, 404 for everything else. */
function installFetchMock() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, method, body });

    if (url.includes('resend.com/emails/batch')) {
      return new Response(JSON.stringify([{ id: 'batch-id-1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('resend.com/emails')) {
      return new Response(JSON.stringify({ id: 'email-id-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('health', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok with cache-control', async () => {
    const env = makeEnv();
    const res = await app.request('/api/health', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    const json: any = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });
});

describe('POST /api/subscribe', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it('rejects a malformed email', async () => {
    const env = makeEnv();
    const res = await app.request(
      '/api/subscribe',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'not-an-email' }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing email field', async () => {
    const env = makeEnv();
    const res = await app.request('/api/subscribe', { method: 'POST', headers: JSON_HEADERS, body: '{}' }, env);
    expect(res.status).toBe(400);
  });

  it('creates a pending subscriber and sends a confirmation email (202)', async () => {
    const env = makeEnv();
    const res = await app.request(
      '/api/subscribe',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'Alice@Example.COM' }) },
      env,
    );
    expect(res.status).toBe(202);

    const raw = await env.SUBSCRIBERS.get('alice@example.com');
    expect(raw).not.toBeNull();
    const sub = JSON.parse(raw as string);
    expect(sub.status).toBe('pending');
    expect(sub.email).toBe('alice@example.com');
    expect(sub.confirm_token).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.lang).toBe('en');

    // Reverse token index stored.
    const indexedEmail = await env.SUBSCRIBERS.get(`token:${sub.confirm_token}`);
    expect(indexedEmail).toBe('alice@example.com');

    // Confirmation email was sent via Resend.
    const fetched = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const resendCall = fetched.find((call) => String(call[0]).includes('resend.com/emails'));
    expect(resendCall).toBeDefined();
    const sentBody = JSON.parse(resendCall![1].body as string);
    expect(sentBody.to).toBe('alice@example.com');
    expect(sentBody.html).toContain('/api/subscribe/confirm?token=');
  });

  it('is idempotent for an already-active subscriber (200)', async () => {
    const env = makeEnv();
    // Seed an active subscriber directly.
    await env.SUBSCRIBERS.put(
      'bob@example.com',
      JSON.stringify({ email: 'bob@example.com', status: 'active', confirm_token: 't', created_at: '2026-08-13T00:00:00Z', lang: 'en' }),
    );
    const res = await app.request(
      '/api/subscribe',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'bob@example.com' }) },
      env,
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.message).toMatch(/already subscribed/i);
  });

  it('returns 429 when the per-IP rate limit is exceeded', async () => {
    const env = makeEnv();
    const headers = { ...JSON_HEADERS, 'CF-Connecting-IP': '203.0.113.9' };
    // Exhaust the 5/min limit.
    for (let i = 0; i < 5; i++) {
      await app.request('/api/subscribe', { method: 'POST', headers, body: JSON.stringify({ email: `u${i}@example.com` }) }, env);
    }
    const res = await app.request('/api/subscribe', { method: 'POST', headers, body: JSON.stringify({ email: 'u5@example.com' }) }, env);
    expect(res.status).toBe(429);
  });
});

describe('GET /api/subscribe/confirm', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it('activates a pending subscriber', async () => {
    const env = makeEnv();
    await app.request('/api/subscribe', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'carol@example.com' }) }, env);
    const sub = JSON.parse((await env.SUBSCRIBERS.get('carol@example.com')) as string);
    expect(sub.status).toBe('pending');

    const res = await app.request(`/api/subscribe/confirm?token=${sub.confirm_token}`, { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('confirmed');

    const after = JSON.parse((await env.SUBSCRIBERS.get('carol@example.com')) as string);
    expect(after.status).toBe('active');
  });

  it('rejects an unknown token', async () => {
    const env = makeEnv();
    const res = await app.request('/api/subscribe/confirm?token=deadbeef', { method: 'GET' }, env);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/unsubscribe', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it('deactivates an active subscriber', async () => {
    const env = makeEnv();
    await app.request('/api/subscribe', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'dave@example.com' }) }, env);
    const sub = JSON.parse((await env.SUBSCRIBERS.get('dave@example.com')) as string);
    // Activate first.
    await app.request(`/api/subscribe/confirm?token=${sub.confirm_token}`, { method: 'GET' }, env);

    const res = await app.request(`/api/unsubscribe?token=${sub.confirm_token}`, { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Unsubscribed');

    const after = JSON.parse((await env.SUBSCRIBERS.get('dave@example.com')) as string);
    expect(after.status).toBe('inactive');
  });
});

describe('admin auth', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it('GET /api/subscribers rejects without a token (401)', async () => {
    const env = makeEnv();
    const res = await app.request('/api/subscribers', { method: 'GET' }, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/subscribers rejects a wrong token (401)', async () => {
    const env = makeEnv();
    const res = await app.request('/api/subscribers', {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-token' },
    }, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/subscribers succeeds with the correct token', async () => {
    const env = makeEnv();
    await env.SUBSCRIBERS.put(
      'eve@example.com',
      JSON.stringify({ email: 'eve@example.com', status: 'active', confirm_token: 'tok', created_at: '2026-08-13T00:00:00Z', lang: 'en' }),
    );
    const res = await app.request('/api/subscribers', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-admin-token' },
    }, env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.count).toBe(1);
    expect(json.subscribers[0].email).toBe('eve@example.com');
  });

  it('PUT /api/sources rejects without a token (401)', async () => {
    const env = makeEnv();
    const res = await app.request('/api/sources', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sources: [] }),
    }, env);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/sources', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 404 when sources are not seeded', async () => {
    const env = makeEnv();
    const res = await app.request('/api/sources', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  it('returns the cached source list with a 300s max-age', async () => {
    const env = makeEnv();
    const payload = { sources: [{ id: 'thn', name: 'The Hacker News', url: 'https://thn.example/feed', type: 'rss' }] };
    await env.SOURCES.put('sources', JSON.stringify(payload));
    const res = await app.request('/api/sources', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('content-type')).toContain('application/json');
    const json: any = await res.json();
    expect(json.sources[0].id).toBe('thn');
  });
});

describe('PUT /api/sources', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates the source mirror (admin-authed)', async () => {
    const env = makeEnv();
    const payload = { sources: [{ id: 'krebs', name: 'Krebs', url: 'https://krebs.example/feed', type: 'rss' }] };
    const res = await app.request('/api/sources', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify(payload),
    }, env);
    expect(res.status).toBe(200);
    const stored = await env.SOURCES.get('sources');
    expect(JSON.parse(stored as string).sources[0].id).toBe('krebs');
  });

  it('rejects an invalid source list (admin-authed)', async () => {
    const env = makeEnv();
    const res = await app.request('/api/sources', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ sources: [{ id: 'x' }] }), // missing name/url/type
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/send-daily', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it('rejects without a valid HMAC signature (401)', async () => {
    const env = makeEnv();
    const body = JSON.stringify(sampleDigest);
    const res = await app.request('/api/send-daily', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Actions-Signature': 'deadbeef' },
      body,
    }, env);
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature (401)', async () => {
    const env = makeEnv();
    const res = await app.request('/api/send-daily', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(sampleDigest),
    }, env);
    expect(res.status).toBe(401);
  });

  it('sends the digest to all active subscribers with a valid signature', async () => {
    const { calls } = installFetchMock();
    const env = makeEnv();

    // Create + confirm two active subscribers.
    for (const email of ['sub1@example.com', 'sub2@example.com']) {
      await app.request('/api/subscribe', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email }) }, env);
      const sub = JSON.parse((await env.SUBSCRIBERS.get(email)) as string);
      await app.request(`/api/subscribe/confirm?token=${sub.confirm_token}`, { method: 'GET' }, env);
    }

    const body = JSON.stringify(sampleDigest);
    const sig = await hmacSha256Hex(body, 'test-actions-secret');
    const res = await app.request('/api/send-daily', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Actions-Signature': sig },
      body,
    }, env);

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.sent).toBe(2);
    expect(json.date).toBe('2026-08-13');

    // Resend batch endpoint called once with 2 emails.
    const batchCall = calls.find((c) => c.url.includes('resend.com/emails/batch'));
    expect(batchCall).toBeDefined();
    const sentEmails = batchCall!.body as { to: string; html: string }[];
    expect(sentEmails).toHaveLength(2);
    expect(sentEmails[0].html).toContain('/api/unsubscribe?token=');
    expect(sentEmails.every((e) => e.html.includes('Critical OpenSSL vulnerability patched'))).toBe(true);
  });

  it('returns sent:0 when there are no active subscribers', async () => {
    const env = makeEnv();
    const body = JSON.stringify(sampleDigest);
    const sig = await hmacSha256Hex(body, 'test-actions-secret');
    const res = await app.request('/api/send-daily', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Actions-Signature': sig },
      body,
    }, env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.sent).toBe(0);
  });
});
