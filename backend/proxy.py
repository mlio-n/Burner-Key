"""Universal dual-protocol reverse proxy (/v1/messages & /v1/chat/completions) (Owner: Muzaffer)."""

from __future__ import annotations

import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from keys import add_spend, check_key, get_db, get_upstream_target, release_reservation
from pricing import SUPPORTED_MODELS

router = APIRouter(tags=["proxy"])


def _extract_upstream_error(raw_response) -> str:
    """Pull a readable message out of any provider's error body (dict or list)."""
    item = raw_response[0] if isinstance(raw_response, list) and raw_response else raw_response
    if isinstance(item, dict):
        err = item.get("error", item)
        if isinstance(err, dict):
            msg = err.get("message") or err.get("status") or ""
            if msg:
                return str(msg)[:500]
        elif err:
            return str(err)[:500]
    return str(raw_response)[:500]


def _protocol_error(
    caller_protocol: str, status_code: int, err_type: str, message: str
) -> JSONResponse:
    if caller_protocol == "openai":
        return JSONResponse(
            status_code=status_code,
            content={
                "error": {
                    "message": message,
                    "type": "burner_key_error",
                    "code": err_type,
                }
            },
        )
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


def _build_openai_url(base_url: str, provider: str) -> str:
    clean = base_url.rstrip("/")
    if clean.endswith("/chat/completions"):
        return clean
    if provider == "mock" and not clean.endswith("/v1"):
        return f"{clean}/v1/chat/completions"
    if clean.endswith(("/v1", "/openai", "/v1beta/openai")):
        return f"{clean}/chat/completions"
    return f"{clean}/v1/chat/completions"


def _build_anthropic_url(base_url: str) -> str:
    clean = base_url.rstrip("/")
    if clean.endswith("/messages"):
        return clean
    if clean.endswith("/v1"):
        return f"{clean}/messages"
    return f"{clean}/v1/messages"


def _flatten_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if "text" in item:
                    parts.append(str(item["text"]))
                elif item.get("type") == "text":
                    parts.append(str(item.get("content", "")))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    return str(content or "")


def _anthropic_to_openai_body(body: dict[str, Any]) -> dict[str, Any]:
    messages: list[dict[str, Any]] = []
    system_prompt = body.get("system")
    if system_prompt:
        messages.append({"role": "system", "content": _flatten_content(system_prompt)})

    for msg in body.get("messages") or []:
        messages.append(
            {
                "role": msg.get("role", "user"),
                "content": _flatten_content(msg.get("content")),
            }
        )

    out: dict[str, Any] = {
        "model": body["model"],
        "messages": messages,
        "stream": False,
    }
    if "max_tokens" in body:
        out["max_tokens"] = body["max_tokens"]
    if "temperature" in body:
        out["temperature"] = body["temperature"]
    return out


def _openai_to_anthropic_body(body: dict[str, Any]) -> dict[str, Any]:
    system_parts: list[str] = []
    messages: list[dict[str, Any]] = []
    for msg in body.get("messages") or []:
        role = msg.get("role", "user")
        text = _flatten_content(msg.get("content"))
        if role == "system":
            if text:
                system_parts.append(text)
        else:
            messages.append(
                {
                    "role": "assistant" if role == "assistant" else "user",
                    "content": text,
                }
            )

    out: dict[str, Any] = {
        "model": body["model"],
        "max_tokens": int(body.get("max_tokens") or 1024),
        "messages": messages or [{"role": "user", "content": ""}],
        "stream": False,
    }
    if system_parts:
        out["system"] = "\n\n".join(system_parts)
    if "temperature" in body:
        out["temperature"] = body["temperature"]
    return out


def _openai_resp_to_anthropic(data: dict[str, Any], model: str) -> dict[str, Any]:
    choices = data.get("choices") or []
    text = ""
    if choices:
        text = _flatten_content((choices[0].get("message") or {}).get("content"))
    usage = data.get("usage") or {}
    return {
        "id": data.get("id") or f"msg_{uuid.uuid4().hex[:16]}",
        "type": "message",
        "role": "assistant",
        "model": data.get("model") or model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": int(usage.get("prompt_tokens", 0)),
            "output_tokens": int(usage.get("completion_tokens", 0)),
        },
    }


def _anthropic_resp_to_openai(data: dict[str, Any], model: str) -> dict[str, Any]:
    blocks = data.get("content") or []
    text = "\n".join(
        str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("text")
    )
    usage = data.get("usage") or {}
    in_tok = int(usage.get("input_tokens", 0))
    out_tok = int(usage.get("output_tokens", 0))
    return {
        "id": data.get("id") or f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": data.get("model") or model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": in_tok,
            "completion_tokens": out_tok,
            "total_tokens": in_tok + out_tok,
        },
    }


def _chunk_text(text: str) -> list[str]:
    """Split text into small word+whitespace chunks for smooth SSE streaming."""
    if not text:
        return []
    return re.findall(r"\S+\s*|\s+", text)


def _iter_openai_sse(
    final_body: dict[str, Any], include_usage: bool = False
) -> Iterator[str]:
    """Yield OpenAI-compatible Server-Sent Events from a completed response."""
    chunk_id = final_body.get("id") or f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(final_body.get("created") or time.time())
    model = final_body.get("model") or ""
    choices = final_body.get("choices") or []
    content = ""
    if choices:
        content = _flatten_content((choices[0].get("message") or {}).get("content"))

    base = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
    }

    yield f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': None}]})}\n\n"
    for piece in _chunk_text(content):
        yield f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': {'content': piece}, 'finish_reason': None}]})}\n\n"
    yield f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"

    if include_usage and final_body.get("usage"):
        yield f"data: {json.dumps({**base, 'choices': [], 'usage': final_body['usage']})}\n\n"

    yield "data: [DONE]\n\n"


def _iter_anthropic_sse(final_body: dict[str, Any]) -> Iterator[str]:
    """Yield Anthropic-compatible Server-Sent Events from a completed response."""
    msg_id = final_body.get("id") or f"msg_{uuid.uuid4().hex[:16]}"
    model = final_body.get("model") or ""
    usage = final_body.get("usage") or {}
    in_tok = int(usage.get("input_tokens", 0))
    out_tok = int(usage.get("output_tokens", 0))

    blocks = final_body.get("content") or []
    text = "\n".join(
        str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("text")
    )

    def _evt(name: str, payload: dict[str, Any]) -> str:
        return f"event: {name}\ndata: {json.dumps(payload)}\n\n"

    yield _evt(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": in_tok, "output_tokens": 0},
            },
        },
    )
    yield _evt(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    )
    for piece in _chunk_text(text):
        yield _evt(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": piece},
            },
        )
    yield _evt("content_block_stop", {"type": "content_block_stop", "index": 0})
    yield _evt(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": out_tok},
        },
    )
    yield _evt("message_stop", {"type": "message_stop"})


COMPAT_OPENAI_MODELS: tuple[str, ...] = ("gpt-4o-mini", "gpt-4o")
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
EXCLUDED_GEMINI_MODELS = {"gemini-2.0-flash"}


def _resolve_gemini_target_model(key_id: int) -> str:
    """Pick the first active gemini-* model for this key, or fall back to gemini-3.8-flash."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT allowed_models FROM burner_keys WHERE id = ?", (key_id,)
        ).fetchone()
    if row:
        allowed = json.loads(row["allowed_models"])
        for candidate in allowed:
            if (
                isinstance(candidate, str)
                and candidate.startswith("gemini-")
                and candidate not in EXCLUDED_GEMINI_MODELS
            ):
                return candidate
    return DEFAULT_GEMINI_MODEL


async def _handle_proxy_request(request: Request, caller_protocol: str) -> Response:
    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        return _protocol_error(
            caller_protocol, 400, "invalid_request_error", "Request body must be valid JSON."
        )

    want_stream = body.get("stream") is True
    stream_opts = body.get("stream_options")
    include_usage = isinstance(stream_opts, dict) and bool(stream_opts.get("include_usage"))

    requested_model = str(body.get("model") or "").strip()
    if not requested_model:
        return _protocol_error(
            caller_protocol, 400, "invalid_request_error", "Field 'model' is required."
        )

    burner_key = _extract_burner_key(request)
    key_id, err_status, err_msg = check_key(burner_key, requested_model)
    if err_status is not None or key_id is None:
        err_type = {
            401: "authentication_error",
            403: "permission_error",
            429: "rate_limit_error",
        }.get(err_status or 401, "burner_key_error")
        return _protocol_error(
            caller_protocol, err_status or 401, err_type, err_msg or "Access denied."
        )

    target = get_upstream_target(key_id)
    provider = target["provider"]
    upstream_protocol = caller_protocol if target["protocol"] == "mock" else target["protocol"]
    base_url = target["base_url"]
    upstream_key = target["api_key"]

    if not upstream_key and provider != "custom":
        release_reservation(key_id)
        return _protocol_error(
            caller_protocol, 500, "api_error", "Master API key is empty for this vault."
        )

    upstream_model = (
        _resolve_gemini_target_model(key_id)
        if (
            provider == "gemini"
            and (not requested_model.startswith("gemini-") or requested_model in EXCLUDED_GEMINI_MODELS)
        )
        else requested_model
    )

    if upstream_protocol == "anthropic":
        upstream_url = _build_anthropic_url(base_url)
        headers = {
            "x-api-key": upstream_key,
            "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
            "content-type": "application/json",
        }
        forward_body = (
            dict(body) if caller_protocol == "anthropic" else _openai_to_anthropic_body(body)
        )
    else:
        upstream_url = _build_openai_url(base_url, provider)
        headers = {
            "Authorization": f"Bearer {upstream_key}",
            "content-type": "application/json",
        }
        forward_body = (
            dict(body) if caller_protocol == "openai" else _anthropic_to_openai_body(body)
        )

    forward_body["model"] = upstream_model
    forward_body["stream"] = False
    forward_body.pop("stream_options", None)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            upstream_res = await client.post(
                upstream_url,
                headers=headers,
                json=forward_body,
            )
    except httpx.HTTPError as exc:
        release_reservation(key_id)
        return _protocol_error(
            caller_protocol,
            502,
            "api_error",
            f"Upstream server ({upstream_url}) unreachable: {exc}",
        )

    try:
        raw_response = upstream_res.json()
    except ValueError:
        release_reservation(key_id)
        return _protocol_error(
            caller_protocol,
            upstream_res.status_code,
            "api_error",
            upstream_res.text or "Non-JSON response from upstream.",
        )

    if upstream_res.status_code != 200:
        release_reservation(key_id)
        return _protocol_error(
            caller_protocol,
            upstream_res.status_code,
            "api_error",
            f"Upstream error: {_extract_upstream_error(raw_response)}",
        )

    if upstream_protocol == "anthropic":
        usage = raw_response.get("usage") or {}
        input_tokens = int(usage.get("input_tokens", 0))
        output_tokens = int(usage.get("output_tokens", 0))
        final_body = (
            dict(raw_response)
            if caller_protocol == "anthropic"
            else _anthropic_resp_to_openai(raw_response, requested_model)
        )
    else:
        usage = raw_response.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens", 0))
        output_tokens = int(usage.get("completion_tokens", 0))
        final_body = (
            dict(raw_response)
            if caller_protocol == "openai"
            else _openai_resp_to_anthropic(raw_response, requested_model)
        )

    final_body["model"] = requested_model
    add_spend(key_id, upstream_model, input_tokens, output_tokens)

    if want_stream:
        stream_gen = (
            _iter_openai_sse(final_body, include_usage=include_usage)
            if caller_protocol == "openai"
            else _iter_anthropic_sse(final_body)
        )
        return StreamingResponse(
            stream_gen,
            status_code=200,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return JSONResponse(status_code=200, content=final_body)


@router.get("/v1/models")
def list_burner_models(request: Request) -> JSONResponse:
    """OpenAI-compatible /v1/models listing allowed models for the caller's Burner Key."""
    burner_key = _extract_burner_key(request)
    if burner_key:
        with get_db() as conn:
            row = conn.execute(
                "SELECT allowed_models, expires_at, is_revoked FROM burner_keys WHERE api_key = ?",
                (burner_key,),
            ).fetchone()

        if not row or bool(row["is_revoked"]):
            return _protocol_error(
                "openai", 401, "authentication_error", "Invalid or revoked burner API key."
            )

        expires_at = datetime.fromisoformat(row["expires_at"])
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) >= expires_at:
            return _protocol_error(
                "openai", 401, "authentication_error", "Burner key has expired."
            )

        allowed = json.loads(row["allowed_models"])
        if "*" in allowed:
            models = list(dict.fromkeys([*SUPPORTED_MODELS, *COMPAT_OPENAI_MODELS]))
        else:
            models = list(dict.fromkeys(allowed))
    else:
        models = list(dict.fromkeys([*SUPPORTED_MODELS, *COMPAT_OPENAI_MODELS]))

    return JSONResponse(
        status_code=200,
        content={
            "object": "list",
            "data": [
                {
                    "id": m,
                    "object": "model",
                    "created": 1700000000,
                    "owned_by": "burner-key",
                }
                for m in models
            ],
        },
    )


@router.post("/v1/messages")
async def proxy_anthropic_messages(request: Request) -> Response:
    """Anthropic-compatible /v1/messages proxy endpoint (routes to any Master Key)."""
    return await _handle_proxy_request(request, caller_protocol="anthropic")


@router.post("/v1/chat/completions")
async def proxy_openai_chat_completions(request: Request) -> Response:
    """OpenAI-compatible /v1/chat/completions proxy endpoint (routes to any Master Key)."""
    return await _handle_proxy_request(request, caller_protocol="openai")
