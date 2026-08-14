"""Deduplication by normalized URL and fuzzy title similarity (Jaccard)."""
from __future__ import annotations

from urllib.parse import urlparse, urlunparse

from .models import NewsItem


def normalize_url(url: str) -> str:
    """Reduce a URL to its host+path, dropping tracking query params.

    Two items pointing at the same article often differ only by query params
    (utm_*, ref, etc.), so we drop the query entirely for the dedup key.
    """
    p = urlparse(url.strip())
    host = (p.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path.rstrip("/") or "/"
    return urlunparse(("https", host, path, "", "", ""))


def _title_tokens(title: str) -> set[str]:
    return set(" ".join(title.lower().split()).split())


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def dedupe(items: list[NewsItem], threshold: float = 0.85) -> list[NewsItem]:
    """Remove duplicates, keeping the first occurrence of each story."""
    seen_urls: set[str] = set()
    seen_titles: list[set[str]] = []
    out: list[NewsItem] = []

    for item in items:
        key = normalize_url(item.url)
        if key in seen_urls:
            continue
        tokens = _title_tokens(item.title)
        if any(_jaccard(tokens, prev) >= threshold for prev in seen_titles):
            continue
        seen_urls.add(key)
        seen_titles.append(tokens)
        out.append(item)

    return out
