from scripts.filter import filter_items
from scripts.models import NewsItem


def _item(title: str, summary: str = "") -> NewsItem:
    return NewsItem(
        title=title,
        url="https://x.test/" + title[:5].lower(),
        source="S",
        summary=summary,
        source_id="s",
    )


def test_keeps_relevant_drops_offtopic():
    items = [
        _item("Critical vulnerability patched in library", "severe bug fixed"),
        _item("Weekend cookbook sale - 50% discount", "cheap books"),
    ]
    out = filter_items(items)
    titles = [i.title for i in out]
    assert "Critical vulnerability patched in library" in titles
    assert "Weekend cookbook sale - 50% discount" not in titles


def test_assigns_vuln_tag_and_score():
    out = filter_items([_item("Zero-day RCE exploit in the wild", "attackers exploit")])
    assert out
    assert "vuln" in out[0].tags
    assert out[0].score > 0.0


def test_empty_input_returns_empty():
    assert filter_items([]) == []
