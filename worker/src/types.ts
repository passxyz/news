// Shared types for the CyberSec Daily Cloudflare Worker.

/** A single news item in a daily digest (matches data/digests/<date>.json). */
export interface DigestItem {
  title: string;
  url: string;
  source: string;
  published: string;
  summary: string;
  tags: string[];
  lang: string;
}

/** Full digest document produced by the Python pipeline. */
export interface Digest {
  date: string;
  generated_at: string;
  stats: { items: number; sources: number };
  items: DigestItem[];
}

/** Subscriber lifecycle states. */
export type SubscriberStatus = 'pending' | 'active' | 'inactive';

/** Subscriber record stored in the SUBSCRIBERS KV namespace. */
export interface Subscriber {
  email: string;
  status: SubscriberStatus;
  confirm_token: string;
  created_at: string;
  lang: string;
}

/** A source entry mirrored from sources/sources.yaml into the SOURCES KV. */
export interface Source {
  id: string;
  name: string;
  url: string;
  type: 'rss' | 'html' | 'api';
  enabled?: boolean;
  lang?: string;
  category?: string;
  tags?: string[];
}

/** Wrapper stored under the SOURCES KV `sources` key. */
export interface SourceList {
  sources: Source[];
}

/** A single email payload for the Resend API. */
export interface ResendEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  tags?: { name: string; value: string }[];
}

/** Worker environment bindings (KV namespaces + secrets + vars). */
export interface Env {
  // KV namespaces
  SUBSCRIBERS: KVNamespace;
  SOURCES: KVNamespace;
  RATE_LIMIT: KVNamespace;

  // Secrets
  RESEND_API_KEY: string;
  ADMIN_TOKEN: string;
  ACTIONS_SECRET: string;
  GITHUB_TOKEN?: string;

  // Vars (non-secret)
  WORKER_PUBLIC_BASE: string;
  RESEND_FROM: string;
  GITHUB_REPO: string;
}
