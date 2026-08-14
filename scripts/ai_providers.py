"""Free-tier AI provider calls (Groq for summarization, Hugging Face for
classification/translation/quality). Each function raises on any error so the
ai.enrich() wrapper falls back to the original content.

Env keys:
  GROQ_API_KEY, GROQ_MODEL (summarization via Llama 3)
  HF_TOKEN (Hugging Face Inference API)
"""
from __future__ import annotations

import os

import httpx

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
HF_URL = "https://api-inference.huggingface.co/models/{model}"
_TIMEOUT = 20.0


def summarize(title: str, summary: str) -> str | None:
    """One-sentence summary via Groq (Llama 3, free tier)."""
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")
    prompt = (
        "Summarize in one concise sentence (max 200 chars) for a security news digest.\n"
        f"Title: {title}\nBody: {summary}"
    )
    payload = {
        "model": os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant"),
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 80,
        "temperature": 0.3,
    }
    r = httpx.post(
        GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=_TIMEOUT
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip() or None


def classify(title: str, summary: str) -> list[str]:
    """Zero-shot topic classification via facebook/bart-large-mnli (HF free tier)."""
    key = os.environ.get("HF_TOKEN")
    if not key:
        raise RuntimeError("HF_TOKEN not set")
    candidates = ["vuln", "patch", "breach", "advisory", "research"]
    payload = {"inputs": f"{title}. {summary}", "parameters": {"candidate_labels": candidates}}
    url = HF_URL.format(model="facebook/bart-large-mnli")
    r = httpx.post(
        url, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=_TIMEOUT
    )
    r.raise_for_status()
    data = r.json()
    labels = data.get("labels", [])
    scores = data.get("scores", [])
    return [lbl for lbl, sc in zip(labels, scores, strict=False) if sc >= 0.4][:2]


def quality(title: str, summary: str) -> bool:
    """Quality gate hook (DistilBERT via HF). Currently a pass-through hook;
    replace the model with a trained quality classifier when available."""
    key = os.environ.get("HF_TOKEN")
    if not key:
        raise RuntimeError("HF_TOKEN not set")
    url = HF_URL.format(model="distilbert-base-uncased-finetuned-sst-2-english")
    r = httpx.post(
        url, headers={"Authorization": f"Bearer {key}"}, json={"inputs": title}, timeout=_TIMEOUT
    )
    r.raise_for_status()
    return True  # placeholder decision; kept as an integration point


def translate(text: str, target: str = "eng_Latn") -> str:
    """Translation via NLLB-200 (HF free tier). target uses NLLB FLORES codes."""
    key = os.environ.get("HF_TOKEN")
    if not key:
        raise RuntimeError("HF_TOKEN not set")
    url = HF_URL.format(model="facebook/nllb-200-distilled-600M")
    r = httpx.post(
        url,
        headers={"Authorization": f"Bearer {key}"},
        json={"inputs": text},
        params={"src_lang": "auto", "tgt_lang": target},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return data[0]["translation_text"] if data else text
