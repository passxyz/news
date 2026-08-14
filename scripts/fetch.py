"""HTTP fetching with timeouts, retries, and a basic SSRF guard."""
from __future__ import annotations

import ipaddress
import logging
import time
from urllib.parse import urlparse

import httpx

from .models import FetchResult

DEFAULT_UA = "CyberSecDailyBot/0.1 (+https://github.com/example/cyber-security-news)"
# Status codes that justify a retry with backoff.
RETRYABLE = {429, 500, 502, 503, 504}


def is_safe_url(url: str) -> tuple[bool, str]:
    """Reject non-http(s) URLs and private/loopback IP literals (SSRF guard).

    Note: this only inspects the literal host. DNS-rebinding protection would
    require resolving the host before connecting and is out of scope here; the
    fetcher runs in GitHub Actions against an explicit allowlist of sources.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, f"scheme not allowed: {parsed.scheme!r}"
    host = (parsed.hostname or "").lower()
    if not host:
        return False, "no host"
    if host in {"localhost"}:
        return False, "localhost not allowed"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True, ""  # a DNS hostname — allowed
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
        return False, f"non-routable IP not allowed: {host}"
    return True, ""


def _headers(source: dict) -> dict[str, str]:
    opts = source.get("fetch_opts") or {}
    headers = {
        "User-Agent": opts.get("user_agent", DEFAULT_UA),
        "Accept": (
            "application/rss+xml, application/atom+xml, application/xml, "
            "text/xml, text/html, application/json;q=0.9, */*;q=0.5"
        ),
    }
    headers.update(opts.get("headers") or {})
    return headers


def fetch_source(
    source: dict,
    client: httpx.Client,
    logger: logging.Logger,
    max_retries: int = 2,
) -> FetchResult:
    """Fetch a single source with exponential backoff on transient failures."""
    sid = source["id"]
    url = source["url"]
    opts = source.get("fetch_opts") or {}
    timeout = opts.get("timeout", 15)

    ok, reason = is_safe_url(url)
    if not ok:
        logger.warning(
            "url rejected",
            extra={"source_id": sid, "event": "ssrf_block", "error": reason},
        )
        return FetchResult(source_id=sid, ok=False, error=f"ssrf: {reason}")

    attempt = 0
    last_err = ""
    while attempt <= max_retries:
        try:
            r = client.get(url, headers=_headers(source), timeout=timeout, follow_redirects=True)
            ct = r.headers.get("content-type", "")
            if r.status_code >= 400:
                last_err = f"http {r.status_code}"
                if r.status_code in RETRYABLE and attempt < max_retries:
                    attempt += 1
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                return FetchResult(
                    source_id=sid, ok=False, status_code=r.status_code,
                    content_type=ct, error=last_err,
                )
            return FetchResult(
                source_id=sid, ok=True, content=r.content,
                content_type=ct, status_code=r.status_code,
            )
        except httpx.HTTPError as exc:  # network / timeout / tls
            last_err = f"{type(exc).__name__}: {exc}"
            if attempt < max_retries:
                attempt += 1
                time.sleep(0.5 * (2 ** attempt))
                continue
            return FetchResult(source_id=sid, ok=False, error=last_err)

    return FetchResult(source_id=sid, ok=False, error=last_err or "unknown")
