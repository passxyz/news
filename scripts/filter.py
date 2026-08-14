"""Cyber-security relevance filtering and topic tagging.

A keyword allowlist keeps only security-relevant items; a small blocklist
removes obvious off-topic noise. Content-derived tags (vuln/patch/breach/...)
are merged with the source's own tags so the UI tag chips stay meaningful.
"""
from __future__ import annotations

import re
from typing import Any

from .models import NewsItem

# A broad allowlist of security-relevant terms.
KEYWORDS = {
    "cyber", "cybersecurity", "security", "vulnerability", "vulnerabilities",
    "cve", "malware", "ransomware", "exploit", "exploited", "zero-day", "zeroday",
    "0day", "phishing", "breach", "breached", "leak", "leaked", "exposed",
    "patch", "patched", "backdoor", "botnet", "trojan", "worm", "rootkit",
    "ddos", "apt", "firewall", "encryption", "openssl", "siem", "soc",
    "threat", "attack", "attacker", "hacker", " hacking", "intrusion",
    "xss", "sqli", "rce", "csrf", "ssrf", "privilege", "escalation",
    "credential", "credentials", "stealer", "infostealer", "keylogger",
    "advisory", "advisories", "kev", "cisa", "nvd", "sbom", "supply-chain",
    "telemetry", "implant", "payload", "obfuscation", "exfiltration",
    "authentication", "mfa", "2fa", "sso", "oauth", "jwt", "tls", "pki",
}

# Terms that, if they dominate, suggest off-topic content.
BLOCKLIST = {"coupon", "discount", "sale", "subscribe-to-our", "sponsored-giveaway"}

# Map keyword groups to the tag vocabulary used by the UI/CSS.
TAG_RULES: list[tuple[set[str], str]] = [
    ({"vulnerability", "vulnerabilities", "cve", "vuln", "zero-day", "zeroday",
      "0day", "rce", "xss", "sqli", "privilege", "escalation", "backdoor"}, "vuln"),
    ({"patch", "patched", "update", "upgrade", "fix", "critical", "out-of-band"}, "patch"),
    ({"breach", "breached", "leak", "leaked", "exposed", "compromised", "exfiltration",
      "phishing", "stealer", "infostealer", "credential", "credentials"}, "breach"),
    ({"advisory", "advisories", "kev", "cisa", "nvd", "bulletin"}, "advisory"),
    ({"research", "paper", "analysis", "study", "researchers", "telemetry"}, "research"),
]


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9][a-z0-9-]*", text.lower()))


def _assign_tags(item: NewsItem, tokens: set[str]) -> list[str]:
    tags: list[str] = list(item.tags)
    for keywords, tag in TAG_RULES:
        if keywords & tokens and tag not in tags:
            tags.append(tag)
    # De-dup, keep order, cap at 4.
    seen: set[str] = set()
    out: list[str] = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            out.append(t)
        if len(out) >= 4:
            break
    return out


def is_relevant(item: NewsItem, tokens: set[str] | None = None) -> bool:
    tokens = tokens if tokens is not None else _tokens(f"{item.title} {item.summary}")
    if not tokens:
        return False
    if tokens & BLOCKLIST and not (tokens & KEYWORDS):
        return False
    return bool(tokens & KEYWORDS)


def filter_items(items: list[NewsItem], config: Any = None) -> list[NewsItem]:
    """Return only relevant items, annotated with score and content-derived tags."""
    out: list[NewsItem] = []
    for item in items:
        tokens = _tokens(f"{item.title} {item.summary}")
        hits = tokens & KEYWORDS
        if not hits:
            continue
        item.tags = _assign_tags(item, tokens)
        item.score = round(min(1.0, 0.2 * len(hits)), 2)
        out.append(item)
    return out
