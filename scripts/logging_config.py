"""Structured JSON logging and run-report generation."""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import SourceResult

LOGGER_NAME = "csn"


class JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line for easy ingestion/inspection."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc)
            .isoformat(timespec="seconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Attach any extra fields passed via logger.<level>(..., extra={...}).
        for key in ("source_id", "event", "status", "error", "count"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging(level: str = "INFO") -> logging.Logger:
    """Configure and return the shared logger. Safe to call once per process."""
    logger = logging.getLogger(LOGGER_NAME)
    if logger.handlers:  # avoid duplicate handlers on re-init
        return logger
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(level.upper())
    logger.propagate = False
    return logger


class RunReport:
    """Collects per-source results and writes reports/<date>.json."""

    def __init__(self, date: str) -> None:
        self.date = date
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.sources: list[SourceResult] = []
        self.total_fetched = 0
        self.total_filtered = 0
        self.total_deduped = 0
        self.written_to: str | None = None
        self.digest_path: str | None = None

    def add(self, result: SourceResult) -> None:
        self.sources.append(result)
        if result.status == "ok":
            self.total_fetched += result.items

    def finish(self) -> None:
        self.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "started_at": self.started_at,
            "finished_at": getattr(self, "finished_at", None),
            "total_fetched": self.total_fetched,
            "total_filtered": self.total_filtered,
            "total_deduped": self.total_deduped,
            "digest_path": self.digest_path,
            "sources": [s.to_dict() for s in self.sources],
        }

    def write(self, out_dir: Path) -> Path:
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f"{self.date}.json"
        target.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.written_to = str(target)
        return target
