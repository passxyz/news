#!/usr/bin/env python3
"""Daily pipeline orchestrator: fetch -> parse -> filter -> (AI opt) -> dedupe -> aggregate.

Run as a module from the repo root:
    python -m scripts.run_pipeline            # live fetch
    python -m scripts.run_pipeline --mock     # local fixture (no network)

Writes:
    data/digests/<date>.json   (the digest consumed by build_site.py + Worker)
    reports/<date>.json        (structured run report)
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .aggregate import build_digest
from .dedupe import dedupe
from .fetch import fetch_source
from .filter import filter_items
from .logging_config import RunReport, setup_logging
from .models import FetchResult, SourceResult
from .parse import parse_source
from .validate_sources import load_sources

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES = ROOT / "sources" / "sources.yaml"
DEFAULT_OUT = ROOT / "data" / "digests"
DEFAULT_REPORTS = ROOT / "reports"
FIXTURE = ROOT / "tests" / "fixtures" / "sample_rss.xml"


def _mock_fetch(source: dict, logger) -> FetchResult:
    """Return a local RSS fixture for every source (offline testing)."""
    if not FIXTURE.exists():
        return FetchResult(source_id=source["id"], ok=False, error="mock fixture missing")
    return FetchResult(
        source_id=source["id"],
        ok=True,
        content=FIXTURE.read_bytes(),
        content_type="application/rss+xml",
        status_code=200,
    )


def _maybe_ai_enrich(items, logger):
    """Apply optional AI enrichment (feature-flagged). Never blocks the run."""
    if not items:
        return items
    try:
        from . import ai
    except Exception:  # AI optional/unavailable
        return items
    return ai.enrich(items, logger)


def run(
    date: str | None = None,
    sources_path: Path = DEFAULT_SOURCES,
    out_dir: Path = DEFAULT_OUT,
    reports_dir: Path = DEFAULT_REPORTS,
    mock: bool = False,
    client: httpx.Client | None = None,
):
    logger = setup_logging()
    date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report = RunReport(date)

    data = load_sources(sources_path)
    sources = [s for s in data["sources"] if s.get("enabled", True)]
    logger.info(
        "pipeline start",
        extra={"event": "start", "count": len(sources), "source_id": "-", "status": "-"},
    )

    owns_client = client is None and not mock
    if owns_client:
        client = httpx.Client(timeout=30, follow_redirects=True)

    all_items: list = []
    try:
        for s in sources:
            fr = _mock_fetch(s, logger) if mock else fetch_source(s, client, logger)
            if not fr.ok:
                report.add(SourceResult(s["id"], s["name"], "error", 0, fr.error))
                logger.warning(
                    "fetch failed",
                    extra={"source_id": s["id"], "event": "fetch_failed", "error": fr.error},
                )
                continue
            items = parse_source(s, fr, logger)
            if not items:
                report.add(SourceResult(s["id"], s["name"], "empty", 0))
            else:
                report.add(SourceResult(s["id"], s["name"], "ok", len(items)))
                all_items.extend(items)
    finally:
        if owns_client:
            client.close()

    relevant = filter_items(all_items)
    report.total_filtered = len(relevant)

    relevant = _maybe_ai_enrich(relevant, logger)

    final = dedupe(relevant)
    report.total_deduped = len(final)

    digest = build_digest(date, final)
    out_dir.mkdir(parents=True, exist_ok=True)
    digest_path = out_dir / f"{date}.json"
    digest_path.write_text(
        json.dumps(digest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report.digest_path = str(digest_path)
    report.finish()
    report.write(reports_dir)

    logger.info(
        "pipeline done",
        extra={"event": "done", "count": len(final), "source_id": "-", "status": "-"},
    )
    return digest_path, report


def main() -> None:
    ap = argparse.ArgumentParser(description="Run the daily news aggregation pipeline.")
    ap.add_argument("--date", help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--reports", type=Path, default=DEFAULT_REPORTS)
    ap.add_argument("--mock", action="store_true", help="use local fixture instead of network")
    args = ap.parse_args()

    digest_path, report = run(
        args.date, args.sources, args.out, args.reports, args.mock
    )
    print(f"digest: {digest_path}  items: {report.total_deduped}  report: {report.written_to}")


if __name__ == "__main__":
    main()
