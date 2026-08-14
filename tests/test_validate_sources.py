from pathlib import Path

from scripts.validate_sources import load_sources, validate

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources" / "sources.yaml"
SCHEMA = ROOT / "sources" / "sources.schema.json"


def test_seed_sources_are_valid():
    errors = validate(SOURCES, SCHEMA)
    assert errors == [], "\n".join(errors)


def test_seed_has_at_least_eight_sources():
    data = load_sources(SOURCES)
    assert len(data["sources"]) >= 8


def test_validator_rejects_bad_id(tmp_path):
    bad = tmp_path / "sources.yaml"
    bad.write_text(
        "sources:\n  - id: 'Bad ID'\n    name: x\n    url: http://x.test\n    type: rss\n",
        encoding="utf-8",
    )
    assert validate(bad, SCHEMA)  # pattern violation -> non-empty error list
