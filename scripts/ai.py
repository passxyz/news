"""Optional AI enrichment, feature-flagged via environment variables.

Flags (default off): AI_SUMMARIZE, AI_CLASSIFY. Every provider call is wrapped
so a failure (quota/timeout/missing key) is logged and the original item is
kept — the pipeline never blocks on AI.
"""
from __future__ import annotations

import logging
import os

from .models import NewsItem


def _flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


def enrich(items: list[NewsItem], logger: logging.Logger) -> list[NewsItem]:
    if not items:
        return items
    if _flag("AI_SUMMARIZE"):
        items = _apply(_summarize, items, logger, "summarize")
    if _flag("AI_CLASSIFY"):
        items = _apply(_classify, items, logger, "classify")
    return items


def _apply(fn, items: list[NewsItem], logger: logging.Logger, label: str) -> list[NewsItem]:
    out: list[NewsItem] = []
    for it in items:
        try:
            fn(it)
        except Exception as exc:  # never let AI break the run
            logger.warning(
                "ai failed, keeping original",
                extra={"event": f"ai_{label}", "error": str(exc), "source_id": it.source_id},
            )
        out.append(it)
    return out


def _summarize(item: NewsItem) -> None:
    from .ai_providers import summarize

    text = summarize(item.title, item.summary)
    if text:
        item.summary = text


def _classify(item: NewsItem) -> None:
    from .ai_providers import classify

    tags = classify(item.title, item.summary)
    for t in tags:
        if t not in item.tags:
            item.tags.append(t)
    item.tags = item.tags[:4]
