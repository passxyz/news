import logging
from pathlib import Path

from scripts.models import FetchResult
from scripts.parse import parse_source

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sample_rss.xml"
logger = logging.getLogger("test")

SRC = {
    "id": "t",
    "name": "Test Security Feed",
    "url": "https://example.test/feed",
    "type": "rss",
    "lang": "en",
    "tags": ["news"],
}


def test_parse_rss_fixture():
    fr = FetchResult(
        source_id="t",
        ok=True,
        content=FIXTURE.read_bytes(),
        content_type="application/rss+xml",
    )
    items = parse_source(SRC, fr, logger)
    assert len(items) == 4
    assert items[0].title.startswith("Critical vulnerability")
    assert items[0].published.startswith("2026-08-13")
    assert items[0].source == "Test Security Feed"


def test_parse_failed_fetch_returns_empty():
    fr = FetchResult(source_id="t", ok=False, error="boom")
    assert parse_source(SRC, fr, logger) == []


def test_parse_html_with_selectors():
    html = """
    <html><body>
      <article class="post"><h2><a href="/a">First vulnerability</a></h2><p>summary one</p></article>
      <article class="post"><h2><a href="/b">Second breach</a></h2><p>summary two</p></article>
    </body></html>
    """
    src = {**SRC, "type": "html", "parser": {"item": "article.post", "title": "h2 a", "summary": "p"}}
    fr = FetchResult(source_id="t", ok=True, content=html.encode("utf-8"), content_type="text/html")
    items = parse_source(src, fr, logger)
    assert len(items) == 2
    assert items[0].url.endswith("/a")
