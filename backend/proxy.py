"""Anthropic /v1/messages reverse proxy route (Owner: Muzaffer)."""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from keys import add_spend, check_key

router = APIRouter(tags=["proxy"])


def _anthropic_error(status_code: int, err_type: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "type": "error",
            "error": {
                "type": err_type,
                "message": message,
            },
        },
    )


def _extract_burner_key(request: Request) -> str:
    x_api_key = request.headers.get("x-api-key", "").strip()
    if x_api_key:
        return x_api_key
    auth = request.headers.get("authorization", "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


@router.post("/v1/messages")
async def proxy_messages(request: Request) -> JSONResponse:
    """Validate burner key, forward request to Anthropic/fake Claude, and record spend."""
    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        return _anthropic_error(400, "invalid_request_error", "Request body must be valid JSON.")

    if body.get("stream") is True:
        return _anthropic_error(
            400,
            "invalid_request_error",
            "Streaming (stream=true) is not supported in this MVP. Set stream=false.",
        )

    model = str(body.get("model") or "").strip()
    if not model:
        return _anthropic_error(400, "invalid_request_error", "Field 'model' is required.")

    burner_key = _extract_burner_key(request)
    key_id, err_status, err_msg = check_key(burner_key, model)
    if err_status is not None or key_id is None:
        err_type = {
            401: "authentication_error",
            403: "permission_error",
            429: "rate_limit_error",
        }.get(err_status or 401, "burner_key_error")
        return _anthropic_error(err_status or 401, err_type, err_msg or "Access denied.")

    upstream_base = os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8001").strip().rstrip("/")
    upstream_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not upstream_key:
        return _anthropic_error(
            500,
            "api_error",
            "ANTHROPIC_API_KEY is not configured in backend/.env.",
        )

    upstream_url = f"{upstream_base}/v1/messages"
    anthropic_version = request.headers.get("anthropic-version", "2023-06-01")

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            upstream_res = await client.post(
                upstream_url,
                headers={
                    "x-api-key": upstream_key,
                    "anthropic-version": anthropic_version,
                    "content-type": "application/json",
                },
                json=body,
            )
    except httpx.HTTPError as exc:
        return _anthropic_error(
            502,
            "api_error",
            f"Upstream server ({upstream_url}) unreachable: {exc}",
        )

    try:
        response_data = upstream_res.json()
    except ValueError:
        return _anthropic_error(
            upstream_res.status_code,
            "api_error",
            upstream_res.text or "Non-JSON response from upstream.",
        )

    if upstream_res.status_code != 200:
        return JSONResponse(status_code=upstream_res.status_code, content=response_data)

    usage = response_data.get("usage") or {}
    input_tokens = int(usage.get("input_tokens", 0))
    output_tokens = int(usage.get("output_tokens", 0))
    add_spend(key_id, model, input_tokens, output_tokens)

    return JSONResponse(status_code=200, content=response_data)
