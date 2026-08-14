"""Source parsers: RSS/Atom, HTML (CSS selectors), and JSON API."""
from __future__ import annotations

import json
import logging
import time as _time
from typing import Any

import feedparser
from bs4 import BeautifulSoup

from .models import FetchResult, NewsItem

SUMMARY_MAX = 300


def _clean(text: Any) -> str:
    return " ".join((str(text or "")).split())


def _entry_iso(entry: Any) -> str:
    tm = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if tm:
        try:
            return _time.strftime("%Y-%m-%dT%H:%M:%SZ", tm)
        except (TypeError, ValueError):
            return ""
    return ""


def _truncate(text: str) -> str:
    if len(text) > SUMMARY_MAX:
        return text[: SUMMARY_MAX - 3] + "..."
    return text


def _make(source: dict, *, title: str, url: str, summary: str, published: str) -> NewsItem | None:
    title = _clean(title)
    url = _clean(url)
    if not title or not url:
        return None
    return NewsItem(
        title=title,
        url=url,
        source=source["name"],
        published=published,
        summary=_truncate(_clean(summary)),
        tags=list(source.get("tags", [])),
        lang=source.get("lang", "en"),
        source_id=source["id"],
    )


def parse_source(
    source: dict, fetch_result: FetchResult, logger: logging.Logger
) -> list[NewsItem]:
    """Dispatch to a parser based on source['type']. Returns [] on any failure."""
    if not fetch_result.ok:
        return []
    stype = source.get("type", "rss")
    try:
        if stype == "rss":
            return _parse_rss(source, fetch_result.text)
        if stype == "html":
            return _parse_html(source, fetch_result.text, logger)
        if stype == "api":
            return _parse_api(source, fetch_result.text, logger)
        logger.warning("unknown source type", extra={"source_id": source["id"], "event": "parse"})
        return []
    except Exception as exc:  # never let a parser crash the whole run
        logger.warning(
            "parse error",
            extra={"source_id": source["id"], "event": "parse_error", "error": str(exc)},
        )
        return []


def _parse_rss(source: dict, text: str) -> list[NewsItem]:
    feed = feedparser.parse(text)
    items: list[NewsItem] = []
    for entry in feed.entries:
        summary = getattr(entry, "summary", "") or getattr(entry, "description", "")
        item = _make(
            source,
            title=getattr(entry, "title", ""),
            url=getattr(entry, "link", ""),
            summary=summary,
            published=_entry_iso(entry),
        )
        if item:
            items.append(item)
    return items


def _parse_html(source: dict, text: str, logger: logging.Logger) -> list[NewsItem]:
    cfg = source.get("parser") or {}
    item_sel = cfg.get("item")
    if not item_sel:
        logger.warning(
            "html source missing parser.item selector",
            extra={"source_id": source["id"], "event": "parse_config"},
        )
        return []
    soup = BeautifulSoup(text, "html.parser")
    out: list[NewsItem] = []
    for node in soup.select(item_sel)[:50]:
        title_el = node.select_one(cfg["title"]) if cfg.get("title") else node
        title = title_el.get_text(" ") if title_el else ""

        link = ""
        if cfg.get("link"):
            link_el = node.select_one(cfg["link"])
            if link_el and link_el.has_attr("href"):
                link = link_el["href"]
        elif title_el and title_el.name == "a" and title_el.has_attr("href"):
            link = title_el["href"]

        summary = ""
        if cfg.get("summary"):
            s = node.select_one(cfg["summary"])
            summary = s.get_text(" ") if s else ""

        item = _make(source, title=title, url=link, summary=summary, published="")
        if item:
            out.append(item)
    return out


def _parse_api(source: dict, text: str, logger: logging.Logger) -> list[NewsItem]:
    cfg = source.get("parser") or {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("api json decode failed", extra={"source_id": source["id"], "event": "parse"})
        return []
    rows = data if isinstance(data, list) else data.get(cfg.get("items_key", "items"), [])
    out: list[NewsItem] = []
    for row in rows:
        item = _make(
            source,
            title=row.get(cfg.get("title", "title"), ""),
            url=row.get(cfg.get("link", "link"), ""),
            summary=row.get(cfg.get("summary", "summary"), ""),
            published=row.get(cfg.get("published", "published"), ""),
        )
        if item:
            out.append(item)
    return out
