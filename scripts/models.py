"""Common data models for the news pipeline."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class NewsItem:
    """A single normalized news item.

    The first seven fields are the public digest schema; the rest are internal
    pipeline metadata not emitted to the site/email.
    """

    title: str
    url: str
    source: str  # display name
    published: str = ""  # ISO-8601
    summary: str = ""
    tags: list[str] = field(default_factory=list)
    lang: str = "en"
    # internal:
    source_id: str = ""
    score: float = 0.0  # relevance score 0..1
    fetched_at: str = field(default_factory=_now_iso)

    def to_digest_dict(self) -> dict:
        """Emit the public schema consumed by build_site.py and the Worker email."""
        return {
            "title": self.title,
            "url": self.url,
            "source": self.source,
            "published": self.published,
            "summary": self.summary,
            "tags": list(self.tags),
            "lang": self.lang,
        }

    def title_hash(self) -> str:
        norm = " ".join(self.title.lower().split())
        return hashlib.sha1(norm.encode("utf-8")).hexdigest()


@dataclass
class FetchResult:
    """Outcome of fetching one source."""

    source_id: str
    ok: bool
    content: bytes = b""
    content_type: str = ""
    status_code: int = 0
    error: str = ""

    @property
    def text(self) -> str:
        try:
            return self.content.decode("utf-8")
        except UnicodeDecodeError:
            return self.content.decode("utf-8", errors="replace")


@dataclass
class SourceResult:
    """Per-source outcome recorded in the run report."""

    source_id: str
    name: str
    status: str  # "ok" | "error" | "skipped" | "empty"
    items: int = 0
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "name": self.name,
            "status": self.status,
            "items": self.items,
            "error": self.error,
        }
