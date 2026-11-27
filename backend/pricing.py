"""Anthropic Claude model pricing table and cost calculation (Owner: Selcuk)."""

from __future__ import annotations

# USD pricing per 1,000,000 tokens: (input_usd_per_1m, output_usd_per_1m)
MODEL_PRICING_PER_1M: dict[str, tuple[float, float]] = {
    "claude-3-5-haiku-20241022": (0.80, 4.00),
    "claude-3-5-sonnet-20241022": (3.00, 15.00),
    "claude-3-7-sonnet-20250219": (3.00, 15.00),
    "claude-3-opus-20240229": (15.00, 75.00),
    "claude-3-haiku-20240307": (0.25, 1.25),
}

DEFAULT_PRICING_PER_1M: tuple[float, float] = (3.00, 15.00)
SUPPORTED_MODELS: list[str] = list(MODEL_PRICING_PER_1M.keys())


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Calculate USD cost for a request given model and token counts."""
    in_per_1m, out_per_1m = MODEL_PRICING_PER_1M.get(model, DEFAULT_PRICING_PER_1M)
    cost = (max(0, input_tokens) / 1_000_000.0) * in_per_1m + (
        max(0, output_tokens) / 1_000_000.0
    ) * out_per_1m
    return round(cost, 6)
