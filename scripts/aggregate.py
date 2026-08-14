"""Aggregate filtered items into the daily digest schema."""
from __future__ import annotations

from datetime import datetime, timezone

from .models import NewsItem


def build_digest(
    date: str,
    items: list[NewsItem],
    max_per_source: int = 10,
    max_total: int = 100,
) -> dict:
    """Sort by recency, cap per source and total, and emit the digest dict.

    The returned dict matches the schema consumed by scripts/build_site.py and
    the Cloudflare Worker email renderer.
    """
    # Most recent first; items without a timestamp sort last.
    ordered = sorted(items, key=lambda it: it.published or "", reverse=True)

    per_source: dict[str, int] = {}
    capped: list[NewsItem] = []
    for it in ordered:
        if per_source.get(it.source_id, 0) >= max_per_source:
            continue
        per_source[it.source_id] = per_source.get(it.source_id, 0) + 1
        capped.append(it)
        if len(capped) >= max_total:
            break

    return {
        "date": date,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stats": {
            "items": len(capped),
            "sources": len({it.source for it in capped}),
        },
        "items": [it.to_digest_dict() for it in capped],
    }
