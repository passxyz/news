# Cyber Security News Aggregation System — Implementation Plan

**Document version:** 1.1
**Date:** 2026-08-13
**Source requirements:** [requirements.md](file:///c:/Users/roger/src/tmp/cyber-security-news/requirements.md)
**Delivery model:** GitHub Actions (daily) + GitHub Pages (static output) + Cloudflare Workers (backend) + Resend (email)

---

## 1. Executive Summary

This plan implements an automated, daily cyber security news aggregation system that:

- Pulls content from a **user-maintained list of sources**.
- Extracts, filters, and aggregates relevant items into a coherent daily compilation.
- Publishes the compilation as a **static GitHub Pages site** with date-based navigation and historical archives.
- Runs **daily via GitHub Actions** with robust error handling and logging.
- Offers **email subscription** through **Resend** (free tier: 3,000/month, 100/day), with subscribe/unsubscribe and daily delivery.
- Uses **Cloudflare Workers** for any required backend logic (subscription management, source-list updates, dynamic content, edge caching, rate limiting).
- Optionally leverages **free-tier AI** services for summarization, classification, translation, and quality filtering.

The plan is organized into **10 phases (P0–P9)**, each with objectives, tasks, owners, dependencies, a **validation checkpoint**, and **success criteria**. A consolidated timeline, resource allocation, dependency map, risk register, and a full **requirements traceability matrix** are included.

> **Email provider note:** Resend was chosen over Agent Mail. Agent Mail is an AI-Agent mailbox service with a 50/day cap and mandatory per-send human confirmation — unsuitable for unattended subscriber delivery. Resend provides a clean HTTP API key that the Worker can call directly via `fetch`, plus DKIM/SPF, bounce webhooks, and per-recipient merge tags for unsubscribe links. The free tier caps the daily subscriber base at ~100 (see R3).

---

## 2. Scope & Requirements Traceability (Summary)

| # | Requirement (from requirements.md) | Primary Phase(s) | Verification Artifact |
|---|---|---|---|
| 1 | Structured method for maintaining/updating source list | P1 | `sources/sources.yaml` + schema + validation |
| 2 | Automated daily retrieval from sources | P2 | Fetcher module + daily run logs |
| 3 | Content extraction & filtering for cyber-security relevance | P2, P7 | Extractor + relevance filter + sample audit |
| 4 | Aggregation & formatting into coherent output | P2, P3 | Aggregator + rendered HTML daily page |
| 5 | Scheduling via GitHub Actions | P4 | `.github/workflows/daily.yml` + cron run |
| 6 | Error handling & logging for failed sources/retrieval | P2, P4 | Retry logic + structured logs + run report |
| 7 | GitHub Pages output (static, HTML, date nav, archives) | P3 | Live Pages site + archive index |
| 8 | Email subscription via Resend | P5 | Subscribe/unsubscribe + daily email send |
| 9 | Cloudflare Worker backend (APIs, caching, rate limiting, integration) | P6 | Worker deployed + endpoints tested |
| 10 | Optional free AI tools (summary/classify/translate/quality) | P7 | AI modules behind feature flags |

> Full mapping in **Appendix A — Requirements Traceability Matrix**.

---

## 3. System Architecture Overview

```
                 ┌──────────────────────────────────────────────┐
                 │                GitHub Repository               │
                 │  sources/sources.yaml  (user-maintained list)  │
                 │  scripts/  (fetch→extract→filter→aggregate)    │
                 │  site/     (generated static HTML + archives)  │
                 │  worker/   (Cloudflare Worker source)          │
                 │  .github/workflows/daily.yml (cron schedule)   │
                 └──────────────────────────────────────────────┘
                                       │  (daily cron, UTC)
                                       ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                    GitHub Actions Runner                     │
   │  checkout → install → fetch → extract → filter (AI opt) →    │
   │  aggregate → render HTML → update index/archive → publish     │
   │  → invoke Worker /send-daily → produce run report             │
   └─────────────────────────────────────────────────────────────┘
        │                                          │
        │ git push (Pages artifact / gh-pages)      │ HTTPS (API + secret)
        ▼                                          ▼
   ┌──────────────────┐                ┌──────────────────────────┐
   │   GitHub Pages    │  ◀─ embeds ──  │   Cloudflare Worker       │
   │  (static site,    │   subscribe    │  /api/subscribe           │
   │   date nav,       │   widget/links │  /api/unsubscribe         │
   │   archives)       │                │  /api/subscribers (admin) │
   └──────────────────┘                │  /api/sources (GET/PUT)    │
                                       │  /api/send-daily           │
                                       │  KV/D1: subscribers, sources│
                                       │  Edge cache + rate limit    │
                                       └─────────────┬──────────────┘
                                                     │ Resend API (HTTPS)
                                                     ▼
                                          ┌────────────────────┐
                                          │  Resend (HTTP API)  │
                                          │  daily digest delivery│
                                          └────────────────────┘
```

**Key design decisions**

- **Source list as code:** `sources/sources.yaml` is version-controlled, schema-validated, and editable via PR or via the Worker `/api/sources` endpoint (which opens/updates via GitHub API or writes to KV mirror).
- **Static-first output:** All daily HTML is generated at build time and served by GitHub Pages; the Worker only handles dynamic concerns (subscriptions, source management, dispatching email).
- **Email via Resend HTTP API:** the Worker's `/api/send-daily` calls Resend `POST /emails` with per-recipient merge tags for unsubscribe links. No SMTP; works natively from the Worker edge.
- **AI is optional and feature-flagged:** each AI capability (summarize, classify, translate, quality) can be enabled independently and degrades gracefully to "no AI" on quota/availability errors.
- **Reliability:** per-source timeouts, exponential-backoff retries, circuit-breaker skip on repeated failure, structured JSON logs, and a per-run summary report committed as an artifact.

---

## 4. Roles & Responsibilities

The plan uses **role-based ownership**. On a small project these map to one or two individuals.

| Role (RACI label) | Responsibilities |
|---|---|
| **Project Lead (PL)** | Scope, schedule, risk, stakeholder comms, sign-off at each checkpoint. |
| **Backend Engineer (BE)** | Source schema, fetcher, extractor, aggregator, Worker APIs, KV/D1, Resend integration. |
| **Pages/Frontend Engineer (FE)** | HTML templates, CSS, date navigation, archive index, responsive layout, subscribe widget. |
| **DevOps Engineer (DO)** | GitHub Actions workflows, secrets, cron, Cloudflare deployment, caching/rate-limit config, logging/monitoring. |
| **AI/Data Engineer (AI)** | Optional AI modules (summary/classify/translate/quality), prompt/inference design, fallbacks. |
| **QA Engineer (QA)** | Test plans, unit/integration tests, daily-run validation, dry-run audits. |

> Per the user's testing preference, **all modifications require unit and integration tests** (see P8).

---

## 5. Implementation Phases

Each phase ends with a **Validation Checkpoint (VC)** and explicit **Success Criteria (SC)**.

### Phase 0 — Repository & Tooling Foundation (P0)

**Objective:** Establish the project skeleton, conventions, CI scaffolding, and local/dev tooling.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P0-1 | Initialize Git repo; define branch model (`main`, `dev`); add `.gitignore`, `LICENSE`, `README` skeleton | PL | Repo + branch policy |
| P0-2 | Choose primary language (Python 3.11 recommended for scraping/NLP; Node for Worker) and pin versions | BE | `pyproject.toml`, `package.json` |
| P0-3 | Set up dependency management, linters, formatters, pre-commit hooks | BE | `ruff`/`black`, `pre-commit` config |
| P0-4 | Create directory layout: `sources/`, `scripts/`, `worker/`, `site/`, `templates/`, `tests/`, `docs/` | BE | Directory tree |
| P0-5 | Add CI scaffold workflow (lint + test on PR) | DO | `.github/workflows/ci.yml` |
| P0-6 | Define secrets strategy (GitHub Secrets, Cloudflare, Resend, AI keys) | DO | Secrets inventory doc |

**Dependencies:** None (entry point).
**VC-P0:** Repo builds locally; `ci.yml` passes on a sample PR; directory structure reviewed.
**SC-P0:** Reproducible local environment; CI green; documented secret list (no secrets committed).

---

### Phase 1 — Source List Management (P1)  *(Requirement 1)*

**Objective:** Provide a structured, validated, easily maintained source list.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P1-1 | Design `sources.yaml` schema: `id`, `name`, `url`, `type` (rss/html/api), `parser`, `lang`, `category`, `enabled`, `tags`, `fetch_opts` (headers, timeout) | BE | JSON Schema file |
| P1-2 | Implement schema validator (runs in CI and pre-fetch) | BE | `scripts/validate_sources.py` + unit tests |
| P1-3 | Seed an initial curated list (≥10 reputable cyber-security sources: RSS feeds, vendor blogs, advisories) | BE/PL | `sources/sources.yaml` |
| P1-4 | Document how maintainers add/edit/remove sources (PR workflow + field reference) | BE | `docs/SOURCES.md` |
| P1-5 | (Optional) Mirror source list to Cloudflare KV for runtime edits via Worker | BE | KV namespace + sync script |

**Dependencies:** P0.
**VC-P1:** Validator rejects malformed entries; seed list passes; documentation reviewed.
**SC-P1:** Any maintainer can add a source via a validated PR in <5 min; schema enforces required fields and safe fetch options.

---

### Phase 2 — Content Retrieval & Processing Pipeline (P2)  *(Requirements 2, 3, 4, 6)*

**Objective:** Fetch, extract, filter, aggregate, and log — resiliently.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P2-1 | Implement fetcher with per-source timeout, retries (exponential backoff), and circuit-breaker skip | BE | `scripts/fetch.py` + tests (mock sources) |
| P2-2 | Implement parsers: RSS/Atom (feedparser), HTML (selectolax/BeautifulSoup), JSON API | BE | `scripts/parse.py` + tests |
| P2-3 | Normalize items into a common `NewsItem` model (`title`, `url`, `source`, `published`, `summary_raw`, `lang`, `tags`) | BE | `scripts/models.py` |
| P2-4 | Implement cyber-security relevance filter (keyword/allowlist + optional AI classifier; see P7) | BE/AI | `scripts/filter.py` + tests |
| P2-5 | Implement deduplication (URL + title similarity hashing) | BE | `scripts/dedupe.py` + tests |
| P2-6 | Implement aggregator: group by date/category, cap items per source, produce a single `digest.json` | BE | `scripts/aggregate.py` |
| P2-7 | Implement structured logging (JSON lines) + per-run summary report (sources ok/failed, counts, errors) | BE/DO | `scripts/logging_config.py`, `reports/<date>.json` |
| P2-8 | Error handling: network errors, parse errors, empty feeds — classified, logged, non-fatal | BE | Error taxonomy + tests for each failure mode |

**Dependencies:** P1 (source list).
**VC-P2:** Dry run against seed sources produces a valid `digest.json`; failure injection (offline source) is logged and skipped without aborting the run.
**SC-P2:** ≥95% of enabled sources succeed on a clean run; every failure is logged with reason and classification; pipeline completes even if some sources fail.

---

### Phase 3 — GitHub Pages Generation (P3)  *(Requirement 7)*

**Objective:** Render daily compilations as static HTML with date navigation and archives.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P3-1 | Choose template engine (Jinja2) and base layout (responsive, accessible) | FE | `templates/base.html` |
| P3-2 | Build daily page template: headline list, per-item source/time/tags, link-out, optional AI summary | FE | `templates/daily.html` |
| P3-3 | Build index page: latest day + date-based navigation (prev/next, calendar/jump-to-date) | FE | `templates/index.html` |
| P3-4 | Build archive index: grouped by month, paginated, searchable (client-side) | FE | `templates/archive.html` |
| P3-5 | Implement static site generator step consuming `digest.json` → `site/` | FE | `scripts/build_site.py` |
| P3-6 | Styling: clean, minimal-menu UI (per user preference), light/dark, mobile-first CSS | FE | `site/assets/css` |
| P3-7 | Embed subscribe widget/links to Worker-hosted subscription endpoint | FE | Subscribe form component |
| P3-8 | Generate RSS feed of the daily digest for secondary consumption | FE | `site/feed.xml` |

**Dependencies:** P2 (digest output).
**VC-P3:** Local build renders a sample day, index, and archive; navigation works; Lighthouse accessibility ≥90.
**SC-P3:** Each run produces a dated page, updates index/archive, and all internal links resolve; site is responsive and readable on mobile.

---

### Phase 4 — GitHub Actions Scheduling, Error Handling & Logging (P4)  *(Requirements 5, 6)*

**Objective:** Automate daily execution with observability and resilience.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P4-1 | Author `daily.yml` workflow: cron schedule (e.g., `0 1 * * *` UTC), steps: checkout → setup → install → run pipeline → build site → publish → notify | DO | `.github/workflows/daily.yml` |
| P4-2 | Configure GitHub Pages deployment (Actions deploy artifact or `gh-pages` branch) | DO | Pages config + deploy step |
| P4-3 | Inject secrets (Resend, Cloudflare, AI keys) via `secrets` context | DO | Workflow env blocks |
| P4-4 | Implement job-level retry for transient failures; continue-on-error for non-critical sources | DO | Workflow retry strategy |
| P4-5 | Upload run report (`reports/<date>.json`) and logs as workflow artifacts (retention 30 days) | DO | Artifact upload step |
| P4-6 | Add failure notifications (GitHub issue auto-create or webhook to channel) on run failure | DO | Notification step |
| P4-7 | Add a manual `workflow_dispatch` trigger with date override for backfills | DO | Dispatch inputs |

**Dependencies:** P2, P3.
**VC-P4:** Manual dispatch produces a published Pages update and a downloadable run report; a forced failure raises a notification.
**SC-P4:** Daily cron runs unattended; failures are visible and recoverable; any single day can be backfilled manually.

---

### Phase 5 — Email Subscription via Resend (P5)  *(Requirement 8)*

**Objective:** Let users subscribe/unsubscribe and receive a daily digest email via Resend's HTTP API.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P5-1 | Study Resend API (https://resend.com/docs): API-key auth, `POST /emails` send endpoint, batch + merge tags, bounce/complaint webhooks, free-tier quota (100/day, 3,000/month) | BE | API integration notes |
| P5-2 | Design subscriber model (`email`, `status`, `confirm_token`, `created_at`, `lang`) | BE | Data model + KV/D1 schema |
| P5-3 | Implement subscribe flow: request → confirmation email (via Resend) → double opt-in → active | BE | Worker `/api/subscribe` + tests |
| P5-4 | Implement unsubscribe flow: tokenized link (in every email) → set inactive | BE | Worker `/api/unsubscribe` + tests |
| P5-5 | Implement daily send: render digest to email HTML, call Resend with per-recipient merge tags, record send log | BE | Worker `/api/send-daily` + tests |
| P5-6 | Build email template (subject, header, headlines, links, unsubscribe footer) | FE | `templates/email.html` |
| P5-7 | Add subscription UI on Pages site (form posts to Worker) + status pages | FE | Subscribe/unsubscribe pages |
| P5-8 | Handle bounces/complaints via Resend webhooks; suppress invalid addresses | BE | Suppression handling |

**Dependencies:** P3 (subscribe widget), P6 (Worker runtime) — P5 and P6 iterate together.
**VC-P5:** End-to-end test: subscribe → confirm → trigger daily send → receive email → unsubscribe stops further sends.
**SC-P5:** Subscribers receive exactly one digest per day; unsubscribe is immediate and honored; double opt-in prevents unauthorized subscriptions; daily send count stays within the 100/day free-tier cap.

---

### Phase 6 — Cloudflare Worker Backend (P6)  *(Requirement 9)*

**Objective:** Serverless APIs for subscription/source management/dynamic content with caching and rate limiting.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P6-1 | Scaffold Worker project (Wrangler), define routes, environment bindings (KV/D1, secrets) | DO | `worker/` + `wrangler.toml` |
| P6-2 | Implement endpoints: `POST /api/subscribe`, `GET/POST /api/unsubscribe`, `GET /api/subscribers` (admin-auth), `GET/PUT /api/sources`, `POST /api/send-daily` (Actions-auth) | BE | Route handlers + tests |
| P6-3 | Storage: Cloudflare KV (subscribers, source mirror) or D1 (SQL); include migrations | BE | Schema + migrations |
| P6-4 | Edge caching: cache `GET /api/sources` and dynamic digest fragments; cache-control headers | DO | Cache policy + tests |
| P6-5 | Rate limiting: per-IP limits on subscribe/send endpoints (Cloudflare native or in-Worker) | DO | Rate-limit config + tests |
| P6-6 | AuthN/AuthZ: admin token for management endpoints; HMAC/signed trigger from GitHub Actions for `/api/send-daily` | BE | Auth middleware + tests |
| P6-7 | Integration: Worker reads latest digest (from Pages artifact, KV, or GitHub API), renders email, and calls Resend | BE | Digest fetch + render + send |
| P6-8 | Observability: structured logs to Cloudflare, error tracking, uptime checks | DO | Logging + alert config |

**Dependencies:** P0 (secrets strategy); co-developed with P5.
**VC-P6:** All endpoints return expected status codes; rate limit blocks abusive calls; admin endpoints reject unauthenticated requests; `/api/send-daily` only honors signed Actions triggers.
**SC-P6:** Backend is serverless, cached, rate-limited, and integrates with both Pages and Resend; no secrets exposed; all endpoints covered by integration tests.

---

### Phase 7 — Optional AI Integration (P7)  *(Requirement 10)*

**Objective:** Enhance quality via free-tier AI, safely and reversibly.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P7-1 | Define feature flags: `AI_SUMMARIZE`, `AI_CLASSIFY`, `AI_TRANSLATE`, `AI_QUALITY` (env-driven, default off) | AI | Flag config + docs |
| P7-2 | Summarization: Llama 3 via Groq free tier / Qwen 2 via Alibaba Cloud free tier / Hugging Face Inference API (free) | AI | `scripts/ai_summarize.py` |
| P7-3 | Topic classification/relevance: Hugging Face zero-shot `facebook/bart-large-mnli` | AI | `scripts/ai_classify.py` |
| P7-4 | Translation (if multilingual): Google Translate free tier / DeepL free tier / NLLB via HF | AI | `scripts/ai_translate.py` |
| P7-5 | Quality filtering: DistilBERT-based classifier via HF Inference API | AI | `scripts/ai_quality.py` |
| P7-6 | Fallback/degradation: on quota/timeout/error → log and continue without AI (never block the run) | AI | Resilience wrappers + tests |
| P7-7 | Cost/quota monitoring: track free-tier usage, log calls, alert near limits | AI/DO | Usage log + alert |

**Dependencies:** P2 (pipeline hooks); can run in parallel from P2 onward but only enabled after P8 hardening.
**VC-P7:** With flags on, digest includes AI summaries and relevance scores; toggling off reverts to baseline; forced AI failure does not break the run.
**SC-P7:** AI features improve perceived quality (measured by sample audit) without affecting reliability or cost; all AI calls have fallbacks.

---

### Phase 8 — Integration, Testing & Hardening (P8)

**Objective:** Prove end-to-end correctness, security, and reliability.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P8-1 | Unit tests for all modules (target ≥80% coverage) | QA | Test suite in `tests/` |
| P8-2 | Integration tests: pipeline → site build → Worker APIs → Resend (sandbox) | QA | Integration test pack |
| P8-3 | End-to-end dry run: full daily workflow against a subset of sources on a feature branch | QA | Dry-run report |
| P8-4 | Security review: secret handling, input validation, SSRF protection on fetcher, admin auth, rate limits | BE/DO | Security checklist (use code-review/security skills) |
| P8-5 | Reliability test: simulate 3+ source failures, network timeouts, AI quota exhaustion | QA | Chaos test report |
| P8-6 | Performance: build time < target; Pages load budgets; Worker p95 latency | DO | Perf report |
| P8-7 | Accessibility & responsiveness audit of Pages site | FE/QA | Audit report |
| P8-8 | Documentation: setup, ops, troubleshooting, runbooks | PL/BE | `docs/` complete |

**Dependencies:** P2–P7.
**VC-P8:** All tests green; security review passed; chaos scenarios recoverable; docs reviewed by a fresh reader.
**SC-P8:** System meets reliability, security, and quality bars; no critical defects open; docs enable handover.

---

### Phase 9 — Deployment & Daily Ops Validation (P9)

**Objective:** Go live and validate unattended daily operation.

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P9-1 | Deploy Worker to Cloudflare production; configure DNS/routing if custom domain used | DO | Live Worker URL |
| P9-2 | Enable GitHub Pages on `main`; verify live site + archives | DO/FE | Public Pages URL |
| P9-3 | Configure production secrets (Resend, Cloudflare, AI keys) | DO | Secrets in GitHub + Cloudflare |
| P9-4 | Enable daily cron; monitor first 7 consecutive runs | DO/PL | Daily ops dashboard |
| P9-5 | Validate email delivery to real subscribers (test cohort) | BE/PL | Delivery report |
| P9-6 | Post-launch retro; update risk register; finalize runbooks | PL | Retro notes |

**Dependencies:** P8.
**VC-P9:** 7 consecutive successful daily runs; Pages updated each day; emails delivered; failures (if any) auto-notified and recoverable.
**SC-P9:** System runs daily without manual intervention, producing consistent, readable compilations and timely emails.

---

## 6. Timeline / Schedule

> Durations are planning estimates in **working days**, assuming 1–2 contributors. Phases P5/P6 and P7 overlap as noted. Sequential critical path is **P0 → P1 → P2 → P3 → P4 → P8 → P9**.

| Phase | Title | Est. days | Start (day) | End (day) | Overlap |
|---|---|---:|---:|---:|---|
| P0 | Repo & Tooling Foundation | 2 | 1 | 2 | — |
| P1 | Source List Management | 2 | 3 | 4 | — |
| P2 | Retrieval & Processing Pipeline | 5 | 5 | 9 | — |
| P3 | GitHub Pages Generation | 4 | 8 | 11 | overlaps P2 tail |
| P4 | Actions Scheduling & Logging | 3 | 11 | 13 | overlaps P3 tail |
| P6 | Cloudflare Worker Backend | 5 | 12 | 16 | parallel with P4/P5 |
| P5 | Email Subscription (Resend) | 5 | 14 | 18 | overlaps P6 |
| P7 | Optional AI Integration | 4 | 10 | 13 | parallel, flag-off |
| P8 | Integration, Testing & Hardening | 5 | 18 | 22 | after P2–P7 |
| P9 | Deployment & Daily Ops Validation | 7 (calendar) | 23 | 29 | includes 7-run watch |

**Total elapsed (planning): ~29 working days** to a validated live system. P7 (AI) can be deferred post-launch without blocking P9.

---

## 7. Resource Allocation

| Resource | Allocation | Notes |
|---|---|---|
| Project Lead | ~15% across project | Checkpoints, sign-off, retro |
| Backend Engineer | ~40% (P1, P2, P5, P6) | Core pipeline + Worker + Resend |
| Pages/Frontend Engineer | ~20% (P3, P5 UI) | Templates, styling, subscribe UI |
| DevOps Engineer | ~15% (P0, P4, P6 deploy, P9) | Actions, Cloudflare, secrets, monitoring |
| AI/Data Engineer | ~10% (P7) | Optional; can be deferred |
| QA Engineer | ~15% (P8 + per-phase tests) | Tests required for every modification |

**External services (free tiers):**
- GitHub Actions (free minutes for public/private repos), GitHub Pages.
- Cloudflare Workers (free tier: 100k requests/day), KV/D1 free tier.
- Resend (free tier: 3,000 emails/month, 100/day; verify QQ/163 inbox deliverability in P5-1).
- AI free tiers: Groq, Alibaba Cloud (Qwen 2), Hugging Face Inference API, Google Translate, DeepL.

**Tooling:** Python 3.11 (feedparser, selectolax/BeautifulSoup, Jinja2, httpx, pyyaml, jsonschema), Node.js (Wrangler/Worker), pytest, ruff/black, pre-commit.

---

## 8. Dependencies

**Technical (internal)**
- P1 → P2 (pipeline needs the source list).
- P2 → P3 (site needs `digest.json`).
- P2 + P3 → P4 (workflow orchestrates both).
- P0 → P6 (secrets strategy precedes Worker deploy).
- P3 ↔ P5 (subscribe widget ↔ Worker endpoints).
- P6 ↔ P5 (Worker hosts subscription logic used by email flow).
- P2 → P7 (AI hooks into pipeline).
- P2–P7 → P8 → P9.

**External**
- GitHub Actions, GitHub Pages availability.
- Cloudflare account + Workers/KV/D1 provisioning.
- Resend API access and free-tier quota (100/day; verify in P5-1).
- AI provider accounts and free-tier availability (optional).
- Source sites' RSS/HTML availability and robots/terms (respect `robots.txt`, rate-limit politely).

**Assumptions**
- Public, reputable sources permit aggregation with attribution and link-out.
- Free tiers are sufficient for a daily, modest-volume digest (validate in P8-6).
- Subscriber base fits within Resend's 100/day free tier, or a paid tier is adopted when exceeded.

---

## 9. Risk Assessment

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Source site changes HTML/feed structure → parser breaks | High | Med | Per-source parsers with tests; failure isolation; alerts; quick-add fixes | BE |
| R2 | Source blocks scraping (rate limit/403) | Med | Med | Polite rate limiting, `User-Agent`, caching, robots.txt respect; fail-soft | BE |
| R3 | Resend free-tier quota (100/day) exceeded | Med | High | Confirm limits early (P5-1); per-recipient sends cap base at ~100 subs; use BCC batching cautiously (loses per-recipient unsubscribe); upgrade tier or rotate sends; fallback to digest-on-site | BE |
| R4 | GitHub Actions minutes/Pages limits | Low | Med | Keep job efficient; cache deps; public repo if viable | DO |
| R5 | Cloudflare free-tier request cap hit | Low | Med | KV caching; rate limiting; monitor usage | DO |
| R6 | AI free-tier instability/quota exhaustion | High | Low | Feature flags; fallback to no-AI; never block run | AI |
| R7 | Secret leakage (API keys in logs/repo) | Low | High | GitHub/Cloudflare secrets only; redact logs; secret scanning; security review (P8-4) | DO |
| R8 | SSRF via malicious source URL in list | Low | High | URL allowlist/scheme validation; private-IP blocking; admin-only source edits | BE |
| R9 | Email marked spam / deliverability | Med | High | Double opt-in, unsubscribe footer, DKIM/SPF via Resend, verify QQ/163 delivery in P5-1 | BE |
| R10 | Run silently fails (no output, no alert) | Med | High | Mandatory run report artifact; failure notifications (P4-6); uptime checks (P6-8) | DO |
| R11 | Duplicate/flooding items dominate digest | Med | Low | Dedup (P2-5); per-source caps; quality filter (P7-5) | BE |
| R12 | Schedule drift / timezone confusion | Med | Low | Cron in UTC, documented; date keys in UTC; backfill via dispatch (P4-7) | DO |

---

## 10. Success Criteria

**Overall (project-level)**
1. Daily GitHub Actions run executes **without manual intervention** and publishes a dated Pages page + updated index/archive.
2. Every enabled source either contributes items or is logged with a classified failure; a single source failure never aborts the run.
3. Subscribers receive **exactly one** digest email per day; subscribe/unsubscribe (double opt-in) works end-to-end.
4. Cloudflare Worker endpoints are functional, cached, rate-limited, and secured.
5. Optional AI features, when enabled, improve quality and **never** reduce reliability.
6. All modifications are covered by unit and integration tests (per user preference).
7. Historical archives are browsable via date-based navigation.

**Per-phase success criteria** are listed under each phase (SC-Px) and validated at each **VC-Px** checkpoint.

---

## 11. Validation Checkpoints Summary

| Checkpoint | After Phase | Verifies | Sign-off |
|---|---|---|---|
| VC-P0 | P0 | Repo, CI, tooling, secrets strategy | PL |
| VC-P1 | P1 | Source schema, validator, seed list, docs | PL |
| VC-P2 | P2 | Pipeline produces `digest.json`; failures isolated & logged | BE/QA |
| VC-P3 | P3 | Pages render with navigation + archives; responsive | FE/QA |
| VC-P4 | P4 | Cron/dispatch works; report artifact; failure alerts | DO |
| VC-P5 | P5 | Subscribe→confirm→send→unsubscribe E2E | BE/QA |
| VC-P6 | P6 | Worker endpoints, cache, rate limit, auth | BE/DO |
| VC-P7 | P7 | AI improves quality; fallbacks safe; flags work | AI/QA |
| VC-P8 | P8 | Tests green; security pass; chaos recoverable; docs | PL/QA |
| VC-P9 | P9 | 7 consecutive unattended daily runs; emails delivered | PL |

**Requirement coverage at each checkpoint** ensures progress is continuously measured against requirements.md (see Appendix A).

---

## 12. Tech Stack & External Services Summary

| Layer | Choice |
|---|---|
| Pipeline language | Python 3.11 (feedparser, selectolax/bs4, httpx, Jinja2, pyyaml, jsonschema) |
| Worker language | JavaScript/TypeScript on Cloudflare Workers (Wrangler) |
| Storage | Cloudflare KV and/or D1 (subscribers, source mirror, send logs) |
| Scheduling | GitHub Actions (`cron` + `workflow_dispatch`) |
| Static hosting | GitHub Pages |
| Email | Resend API (HTTP, free tier: 100/day, 3,000/mo) |
| AI (optional) | Groq (Llama 3), Alibaba Cloud (Qwen 2), Hugging Face Inference (BART-large-MNLI, NLLB, DistilBERT), Google/DeepL translate |
| Testing | pytest (unit + integration); Worker tests via Vitest/Jest |
| Quality | ruff, black, pre-commit; code-review & security skills at P8 |

---

## Appendix A — Requirements Traceability Matrix

| Req | Requirement text (abridged) | Phase(s) | Key tasks | Verification |
|---|---|---|---|---|
| 1 | Structured method to maintain/update source list | P1 | P1-1..P1-5 | Schema + validator + docs; VC-P1 |
| 2 | Automated daily retrieval from sources | P2, P4 | P2-1, P4-1 | Fetcher + cron run; VC-P2/P4 |
| 3 | Extraction & filtering for cyber-security relevance | P2, P7 | P2-2..P2-4, P7-3 | Parsers + filter tests; VC-P2 |
| 4 | Aggregation & formatting into coherent output | P2, P3 | P2-6, P3-1..P3-5 | `digest.json` + HTML; VC-P2/P3 |
| 5 | Scheduling via GitHub Actions | P4 | P4-1..P4-7 | `daily.yml` + dispatch; VC-P4 |
| 6 | Error handling & logging for failures | P2, P4 | P2-7, P2-8, P4-4..P4-6 | Logs + report + alerts; VC-P2/P4 |
| 7 | GitHub Pages output (HTML, date nav, archives) | P3 | P3-1..P3-8 | Live site + archives; VC-P3 |
| 8 | Email subscription via Resend | P5 | P5-1..P5-8 | E2E subscribe/send/unsubscribe; VC-P5 |
| 9 | Cloudflare Worker backend (APIs, cache, rate limit, integration) | P6 | P6-1..P6-8 | Endpoints + security tests; VC-P6 |
| 10 | Optional free AI tools (summary/classify/translate/quality) | P7 | P7-1..P7-7 | Flag-gated modules + fallbacks; VC-P7 |

---

## Appendix B — Definition of Done (per phase)

- All tasks in the phase are complete and merged to `main`.
- Unit and integration tests for new/modified code are written and passing.
- The phase's **Validation Checkpoint (VC-Px)** is reviewed and signed off.
- The phase's **Success Criteria (SC-Px)** are demonstrably met.
- Relevant docs/runbooks are updated.
- Risk register updated if new risks surfaced.
