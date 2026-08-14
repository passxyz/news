#!/usr/bin/env python3
"""Validate sources/sources.yaml against sources/sources.schema.json.

Usage:
  python scripts/validate_sources.py [--sources PATH] [--schema PATH]

Exits non-zero on validation failure. Also usable as a library:
  from scripts.validate_sources import validate, load_sources
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES = ROOT / "sources" / "sources.yaml"
DEFAULT_SCHEMA = ROOT / "sources" / "sources.schema.json"


def load_sources(path: Path = DEFAULT_SOURCES) -> dict[str, Any]:
    """Load and return the raw sources document (a dict with a 'sources' list)."""
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping with a 'sources' key")
    return data


def validate(path: Path = DEFAULT_SOURCES, schema: Path = DEFAULT_SCHEMA) -> list[str]:
    """Validate the sources file. Returns a list of human-readable error strings
    (empty when valid). Raises FileNotFoundError if files are missing."""
    data = load_sources(path)
    with schema.open(encoding="utf-8") as f:
        schema_obj = yaml.safe_load(f)  # schema is JSON, YAML parses JSON too

    validator = jsonschema.Draft202012Validator(
        schema_obj, format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER
    )
    errors: list[str] = []
    for err in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        loc = ".".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"{loc}: {err.message}")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate sources.yaml against its schema.")
    ap.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    ap.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    args = ap.parse_args()

    if not args.sources.exists():
        print(f"sources file not found: {args.sources}", file=sys.stderr)
        return 2
    if not args.schema.exists():
        print(f"schema file not found: {args.schema}", file=sys.stderr)
        return 2

    errors = validate(args.sources, args.schema)
    if errors:
        print(f"INVALID: {len(errors)} error(s) in {args.sources}", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    data = load_sources(args.sources)
    enabled = sum(1 for s in data["sources"] if s.get("enabled", True))
    print(f"OK: {len(data['sources'])} source(s) ({enabled} enabled)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
