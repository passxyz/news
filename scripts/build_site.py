#!/usr/bin/env python3
"""Build the static GitHub Pages site from data/digests/*.json using Jinja2.

Reads:  data/digests/*.json
Writes: site/index.html, site/<YYYY>/<MM>/<DD>/index.html,
        site/archive/index.html, site/feed.xml

Env overrides:
  SITE_TITLE     - site wordmark/title (default "CyberSec Daily")
  SUBSCRIBE_URL  - Worker endpoint the subscribe form posts to
  BASE_URL       - absolute site URL for RSS (e.g. https://user.github.io/repo)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "digests"
TMPL_DIR = ROOT / "templates"
OUT_DIR = ROOT / "site"

SITE_TITLE = os.environ.get("SITE_TITLE", "CyberSec Daily")
SUBSCRIBE_URL = os.environ.get("SUBSCRIBE_URL", "WORKER_URL_PLACEHOLDER/api/subscribe")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")


def load_digests() -> list[dict]:
    digests = []
    for p in sorted(DATA_DIR.glob("*.json")):
        with p.open(encoding="utf-8") as f:
            d = json.load(f)
        enrich(d)
        digests.append(d)
    digests.sort(key=lambda d: d["date"], reverse=True)  # newest first
    return digests


def enrich(d: dict) -> None:
    dt = datetime.strptime(d["date"], "%Y-%m-%d")
    d["date_obj"] = dt
    d["date_label"] = f"{dt.strftime('%A, %B')} {dt.day}{dt.strftime(', %Y')}"
    for it in d.get("items", []):
        pub = it.get("published", "")
        try:
            pdt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            it["time_label"] = pdt.strftime("%H:%M") + " UTC"
            it["pub_rfc"] = pdt.strftime("%a, %d %b %Y %H:%M:%S +0000")
        except ValueError:
            it["time_label"] = ""
            it["pub_rfc"] = ""
    stats = d.setdefault("stats", {})
    stats.setdefault("items", len(d.get("items", [])))
    stats.setdefault("sources", len({it.get("source") for it in d.get("items", [])}))


def rel_root(depth: int) -> str:
    return "../" * depth


def helpers(root: str) -> dict:
    return {"url": lambda p: root + p, "asset": lambda p: root + p}


def link(d: dict, root: str) -> dict:
    y, m, dd = d["date"].split("-")
    dt = d["date_obj"]
    return {"url": root + f"{y}/{m}/{dd}/index.html", "label": f"{dt:%b} {dt.day}"}


def write(rel_path: str, content: str) -> None:
    target = OUT_DIR / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def render_daily(env: Environment, d: dict, prev: dict | None, nxt: dict | None,
                 rel: str, depth: int) -> None:
    root = rel_root(depth)
    ctx = {
        "site_title": SITE_TITLE,
        "subscribe_url": SUBSCRIBE_URL,
        "digest": d,
        "prev": link(prev, root) if prev else None,
        "next": link(nxt, root) if nxt else None,
        "today_url": root + "index.html",
        **helpers(root),
    }
    write(rel, env.get_template("daily.html").render(**ctx))


def render_archive(env: Environment, digests: list[dict]) -> None:
    root = rel_root(1)
    months: dict[str, list[dict]] = {}
    for d in digests:
        dt = d["date_obj"]
        key = f"{dt:%B} {dt.year}"
        y, m, dd = d["date"].split("-")
        months.setdefault(key, []).append({
            "date": d["date"],
            "label": f"{dt.strftime('%B')} {dt.day}{dt.strftime(', %Y')}",
            "url": root + f"{y}/{m}/{dd}/index.html",
            "count": d["stats"]["items"],
        })
    ctx = {"site_title": SITE_TITLE, "months": list(months.items()), **helpers(root)}
    write("archive/index.html", env.get_template("archive.html").render(**ctx))


def render_feed(env: Environment, latest: dict) -> None:
    ctx = {
        "site_title": SITE_TITLE,
        "base_url": BASE_URL,
        "digest": latest,
        "build_date": datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000"),
    }
    write("feed.xml", env.get_template("feed.xml").render(**ctx))


def build() -> None:
    env = Environment(
        loader=FileSystemLoader(str(TMPL_DIR)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    digests = load_digests()
    if not digests:
        print(f"No digests found in {DATA_DIR}", file=sys.stderr)
        sys.exit(1)

    # Index = latest day (no "next"/newer).
    render_daily(env, digests[0], digests[1] if len(digests) > 1 else None, None,
                 "index.html", depth=0)

    # Per-date pages.
    for i, d in enumerate(digests):
        prev = digests[i + 1] if i + 1 < len(digests) else None
        nxt = digests[i - 1] if i - 1 >= 0 else None
        y, m, dd = d["date"].split("-")
        render_daily(env, d, prev, nxt, f"{y}/{m}/{dd}/index.html", depth=3)

    render_archive(env, digests)
    render_feed(env, digests[0])
    print(f"Built {len(digests)} daily page(s) + index + archive + feed into {OUT_DIR}")


if __name__ == "__main__":
    build()
