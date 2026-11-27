"""Multi-provider AI catalog, key auto-detection, and token pricing (Owner: Selcuk)."""

from __future__ import annotations

from typing import Any

PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "mock": {
        "id": "mock",
        "name": "Mock / Test Sunucusu (Ücretsiz)",
        "protocol": "mock",
        "default_base_url": "http://127.0.0.1:8001",
        "key_hint": "Ücretsiz yerel test (kredi harcamaz)",
        "models": [
            "claude-haiku-5-5",
            "gpt-4o-mini",
            "gemini-3.8-flash",
        ],
    },
    "openai": {
        "id": "openai",
        "name": "OpenAI",
        "protocol": "openai",
        "default_base_url": "https://api.openai.com/v1",
        "key_hint": "sk-... veya sk-proj-...",
        "models": [
            "gpt-4o-mini",
            "gpt-4o",
            "gpt-4.1-mini",
            "o3-mini",
        ],
    },
    "anthropic": {
        "id": "anthropic",
        "name": "Anthropic (Claude)",
        "protocol": "anthropic",
        "default_base_url": "https://api.anthropic.com",
        "key_hint": "sk-ant-...",
        "models": [
            "claude-haiku-5-5",
            "claude-sonnet-5-5",
            "claude-opus-5-5",
            "claude-fable-5-2",
        ],
    },
    "gemini": {
        "id": "gemini",
        "name": "Google Gemini",
        "protocol": "openai",
        "default_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_hint": "AIza...",
        "models": [
            "gemini-4-hydrogen",
            "gemini-3.8-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
        ],
    },
    "groq": {
        "id": "groq",
        "name": "Groq",
        "protocol": "openai",
        "default_base_url": "https://api.groq.com/openai/v1",
        "key_hint": "gsk_...",
        "models": [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
        ],
    },
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek",
        "protocol": "openai",
        "default_base_url": "https://api.deepseek.com/v1",
        "key_hint": "sk-...",
        "models": [
            "deepseek-chat",
            "deepseek-reasoner",
        ],
    },
    "openrouter": {
        "id": "openrouter",
        "name": "OpenRouter",
        "protocol": "openai",
        "default_base_url": "https://openrouter.ai/api/v1",
        "key_hint": "sk-or-v1-...",
        "models": [
            "openai/gpt-4o-mini",
            "anthropic/claude-3.5-sonnet",
            "google/gemini-2.5-flash",
        ],
    },
    "custom": {
        "id": "custom",
        "name": "Özel (OpenAI Uyumlu / Ollama)",
        "protocol": "openai",
        "default_base_url": "http://127.0.0.1:11434/v1",
        "key_hint": "İsteğe bağlı özel endpoint anahtarı",
        "models": [
            "gpt-4o-mini",
            "llama3.2",
        ],
    },
}

# USD pricing per 1,000,000 tokens: (input_usd_per_1m, output_usd_per_1m)
MODEL_PRICING_PER_1M: dict[str, tuple[float, float]] = {
    # Anthropic (source: https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-27)
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-fable-5-2": (8.00, 40.00),
    # OpenAI
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "o3-mini": (1.10, 4.40),
    # Google Gemini
    "gemini-4-hydrogen": (1.50, 7.50),  # paid-tier rate; free tier is $0 (ai.google.dev pricing)
    "gemini-3.8-flash": (0.75, 3.75),  # intro rate, valid through 2026-12-31 (ai.google.dev)
    "gemini-2.5-flash": (0.15, 0.60),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.0-flash": (0.10, 0.40),
    # Groq
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "llama-3.1-8b-instant": (0.05, 0.08),
    # DeepSeek
    "deepseek-chat": (0.27, 1.10),
    "deepseek-reasoner": (0.55, 2.19),
    # OpenRouter
    "openai/gpt-4o-mini": (0.15, 0.60),
    "anthropic/claude-3.5-sonnet": (3.00, 15.00),
    "google/gemini-2.5-flash": (0.15, 0.60),
}

DEFAULT_PRICING_PER_1M: tuple[float, float] = (2.00, 8.00)

# Claude Haiku 5.5 costs more when the prompt is over 100,000 input tokens.
LONG_PROMPT_THRESHOLD_TOKENS = 100_000
LONG_PROMPT_PRICING_PER_1M: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.50, 2.50),
}

# Keep backward-compatible default model list (Anthropic + popular multi-provider models)
SUPPORTED_MODELS: list[str] = [
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-2",
    "gpt-4o-mini",
    "gpt-4o",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "llama-3.3-70b-versatile",
    "deepseek-chat",
]


def detect_provider_from_key(raw_key: str) -> str:
    """Infer AI provider from common API key prefixes."""
    cleaned = (raw_key or "").strip()
    if cleaned.startswith("sk-ant-"):
        return "anthropic"
    if cleaned.startswith("AIza"):
        return "gemini"
    if cleaned.startswith("gsk_"):
        return "groq"
    if cleaned.startswith("sk-or-"):
        return "openrouter"
    if cleaned.startswith("sk-mock"):
        return "mock"
    if cleaned.startswith("sk-"):
        return "openai"
    return "custom"


def _resolve_pricing(model: str) -> tuple[float, float]:
    if model in MODEL_PRICING_PER_1M:
        return MODEL_PRICING_PER_1M[model]
    lowered = model.lower()
    if "opus" in lowered:
        return (15.00, 75.00)
    if any(tag in lowered for tag in ("haiku", "mini", "flash", "instant")):
        return (0.25, 1.00)
    return DEFAULT_PRICING_PER_1M


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Calculate USD cost for a request given model and token counts."""
    in_per_1m, out_per_1m = _resolve_pricing(model)
    if input_tokens > LONG_PROMPT_THRESHOLD_TOKENS:
        in_per_1m, out_per_1m = LONG_PROMPT_PRICING_PER_1M.get(model, (in_per_1m, out_per_1m))
    cost = (max(0, input_tokens) / 1_000_000.0) * in_per_1m + (
        max(0, output_tokens) / 1_000_000.0
    ) * out_per_1m
    return round(cost, 6)
