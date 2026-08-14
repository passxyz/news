# CyberSec Daily

A daily cyber-security news aggregator and static site generator, with an
optional Cloudflare Worker backend for email subscriptions.

The pipeline fetches configured RSS/Atom sources, dedupes and filters items,
builds a per-day JSON "digest", and renders a static GitHub Pages site
(homepage, date archives, monthly archive, RSS feed). An optional AI step can
summarize/classify items. A Cloudflare Worker handles double opt-in email
subscriptions and daily digest delivery via Resend.

## Architecture

```
sources/sources.yaml        configured news sources (input)
        │
        ▼  scripts/run_pipeline.py  (fetch → parse → filter → dedupe → build)
data/digests/<date>.json    one digest per day (auto-generated; committed as content snapshot)
        │
        ▼  scripts/build_site.py    (Jinja2 templates)
site/                       static site output (build artifact; git-ignored)
        │
        ▼  GitHub Pages / Cloudflare Pages (deploy)

worker/                     Cloudflare Worker (subscriptions + email)  [optional, separate deploy]
```

## Project layout

| Path | Purpose |
|------|---------|
| `sources/sources.yaml` | Source list consumed by the pipeline |
| `scripts/` | Python pipeline: `run_pipeline.py`, `fetch.py`, `parse.py`, `filter.py`, `dedupe.py`, `aggregate.py`, `build_site.py`, `ai.py` / `ai_providers.py` |
| `data/digests/` | Generated per-day digest JSON (committed) |
| `templates/` | Jinja2 templates for the site |
| `site/` | Generated static site (git-ignored) |
| `worker/` | Cloudflare Worker backend (TypeScript) |
| `docs/` | Requirements & implementation plan |

## Local development

### Prerequisites
- Python 3.11+
- (optional) Node.js 18+ and `wrangler` for the Worker

### 1. Set up Python environment
```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Run the pipeline (fetch + build digest)
```bash
python -m scripts.run_pipeline --sources sources/sources.yaml --out data/digests
```

### 3. Build the static site
```bash
python -m scripts.build_site
# outputs into site/
```

### 4. (Optional) AI enrichment
Off by default. Enable per step via environment variables; failures never
block the run.
```bash
export AI_SUMMARIZE=1
export AI_CLASSIFY=1
export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY
python -m scripts.run_pipeline
```

### 5. (Optional) Preview the static site
Any static server works, e.g.:
```bash
python -m http.server -d site 8000
```
Then open http://localhost:8000.

## Git conventions

- **Committed**: `sources/`, `templates/`, `scripts/`, `worker/`, `data/digests/`
  (content snapshots), `site/assets/` (hand-written source), config.
- **Ignored** (` .gitignore`): `site/index.html`, `site/feed.xml`,
  `site/archive/`, `site/20??/` (build output), `reports/`, Python caches,
  virtualenvs, `.env`, `.wrangler/`.

## Deployment

### A. Static site → GitHub Pages

1. Create a GitHub repository and push this project.
2. In **Repository Settings → Pages**, set:
   - Source: **GitHub Actions** (recommended) — or "Deploy from a branch" →
     `main` + `/site` if you instead commit `site/` (not recommended here since
     `site/` is git-ignored).
3. Add a workflow `.github/workflows/deploy.yml`:

```yaml
name: Build and deploy site
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *"   # daily digest + rebuild (UTC)
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -r requirements.txt
      - name: Generate today's digest (if scheduled)
        env:
          AI_SUMMARIZE: ${{ vars.AI_SUMMARIZE }}
          AI_CLASSIFY: ${{ vars.AI_CLASSIFY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: python -m scripts.run_pipeline --sources sources/sources.yaml --out data/digests
      - run: python -m scripts.build_site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

> If the scheduled run generates a new `data/digests/<date>.json`, commit it
> back so the archive persists:
> ```yaml
>      - name: Commit digest
>        run: |
>          git config user.name "github-actions[bot]"
>          git config user.email "github-actions[bot]@users.noreply.github.com"
>          git add data/digests
>          git diff --cached --quiet || git commit -m "digest: $(date -u +%F)"
>          git push
> ```

### B. Static site → Cloudflare Pages

1. In Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Build command: `python -m scripts.build_site`
3. Build output directory: `site`
4. Add a Python build environment (Cloudflare Pages supports a build
   environment with `requirements.txt`).
5. (Optional) Add a Cron Trigger / GitHub Action to regenerate daily.

### C. Worker backend → Cloudflare (subscriptions + email)

The Worker is a **separate deploy** from the site. It uses KV (D1 schema in
`worker/schema.sql` as an alternative).

1. Install wrangler:
   ```bash
   npm install -g wrangler
   cd worker
   ```
2. Create KV namespaces and wire them in `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create SUBSCRIBERS
   npx wrangler kv namespace create SOURCES
   npx wrangler kv namespace create RATE_LIMIT
   ```
   Paste the returned IDs into `wrangler.toml` (`kv_namespaces`).
3. Set secrets:
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put ACTIONS_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put RESEND_FROM      # e.g. "CyberSec Daily <noreply@yourdomain.com>"
   npx wrangler secret put WORKER_PUBLIC_BASE   # e.g. https://your-worker.workers.dev
   npx wrangler secret put GITHUB_REPO      # e.g. owner/repo  (for digest fallback fetch)
   # GITHUB_TOKEN optional
   ```
4. (Optional) Seed the public sources mirror:
   ```bash
   curl -X PUT https://<worker>/api/sources \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     --data-binary @../sources/sources.json
   ```
5. Deploy:
   ```bash
   npx wrangler deploy
   ```

#### Wiring GitHub Actions → Worker (daily email)

Add a second job (or separate workflow) that calls the Worker after the site
build, using an HMAC-signed request:

```yaml
  send-daily:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Send daily digest email
        env:
          ACTIONS_SECRET: ${{ secrets.ACTIONS_SECRET }}
          WORKER_URL: ${{ secrets.WORKER_URL }}
        run: |
          BODY=$(cat data/digests/$(date -u +%F).json)
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$ACTIONS_SECRET" | awk '{print $2}')
          curl -X POST "$WORKER_URL/api/send-daily" \
            -H "X-Actions-Signature: $SIG" \
            -H "Content-Type: application/json" \
            --data-binary "$BODY"
```

Set `ACTIONS_SECRET` (same value as the Worker secret) and `WORKER_URL` as
GitHub Actions secrets.

## API (Worker)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/subscribe` | rate-limited | Create pending subscriber + send confirmation |
| GET | `/api/subscribe/confirm` | token | Activate (double opt-in) |
| GET | `/api/unsubscribe` | token | Deactivate |
| GET | `/api/subscribers` | `ADMIN_TOKEN` | List subscribers |
| GET | `/api/sources` | public (cached) | Source mirror |
| PUT | `/api/sources` | `ADMIN_TOKEN` | Update source mirror |
| POST | `/api/send-daily` | Actions HMAC | Render + send daily digest |
| GET | `/api/health` | — | Liveness |

## Notes

- `data/digests/` is committed as a content snapshot. It is regenerable via
  `run_pipeline.py`, but committing it keeps the archive intact and lets the
  site build without network access.
- `site/` is a build artifact and is git-ignored.
- AI enrichment is optional and fails safe.
- Subscriber data lives in Cloudflare KV; `worker/schema.sql` documents a D1
  alternative.
