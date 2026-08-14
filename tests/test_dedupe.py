from scripts.dedupe import dedupe, normalize_url
from scripts.models import NewsItem


def _item(title: str, url: str) -> NewsItem:
    return NewsItem(title=title, url=url, source="S", source_id="s")


def test_normalize_url_strips_query_and_www():
    assert normalize_url("https://www.example.com/a?utm_source=x") == "https://example.com/a"


def test_dedupe_by_normalized_url():
    items = [
        _item("A", "https://x.test/a?ref=1"),
        _item("A again", "https://x.test/a?ref=2"),
    ]
    assert len(dedupe(items)) == 1


def test_dedupe_by_fuzzy_title():
    items = [
        _item("Ransomware crew leaks data after breach", "https://x.test/1"),
        _item("Ransomware crew leaks data after a breach", "https://x.test/2"),
    ]
    assert len(dedupe(items)) == 1


def test_distinct_stories_kept():
    items = [
        _item("OpenSSL vulnerability patched", "https://x.test/openssl"),
        _item("CISA KEV advisory updated", "https://x.test/cisa"),
    ]
    assert len(dedupe(items)) == 2
