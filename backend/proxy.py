"""Universal dual-protocol reverse proxy (/v1/messages & /v1/chat/completions) (Owner: Muzaffer)."""

from __future__ import annotations

import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from keys import add_spend, check_key, get_upstream_target

router = APIRouter(tags=["proxy"])


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


async def _handle_proxy_request(request: Request, caller_protocol: str) -> JSONResponse:
    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        return _protocol_error(
            caller_protocol, 400, "invalid_request_error", "Request body must be valid JSON."
        )

    if body.get("stream") is True:
        return _protocol_error(
            caller_protocol,
            400,
            "invalid_request_error",
            "Streaming (stream=true) is not supported in this MVP. Set stream=false.",
        )

    model = str(body.get("model") or "").strip()
    if not model:
        return _protocol_error(
            caller_protocol, 400, "invalid_request_error", "Field 'model' is required."
        )

    burner_key = _extract_burner_key(request)
    key_id, err_status, err_msg = check_key(burner_key, model)
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
        return _protocol_error(
            caller_protocol, 500, "api_error", "Master API key is empty for this vault."
        )

    if upstream_protocol == "anthropic":
        upstream_url = _build_anthropic_url(base_url)
        headers = {
            "x-api-key": upstream_key,
            "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
            "content-type": "application/json",
        }
        forward_body = (
            body if caller_protocol == "anthropic" else _openai_to_anthropic_body(body)
        )
    else:
        upstream_url = _build_openai_url(base_url, provider)
        headers = {
            "Authorization": f"Bearer {upstream_key}",
            "content-type": "application/json",
        }
        forward_body = (
            body if caller_protocol == "openai" else _anthropic_to_openai_body(body)
        )

    forward_body["stream"] = False

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            upstream_res = await client.post(
                upstream_url,
                headers=headers,
                json=forward_body,
            )
    except httpx.HTTPError as exc:
        return _protocol_error(
            caller_protocol,
            502,
            "api_error",
            f"Upstream server ({upstream_url}) unreachable: {exc}",
        )

    try:
        raw_response = upstream_res.json()
    except ValueError:
        return _protocol_error(
            caller_protocol,
            upstream_res.status_code,
            "api_error",
            upstream_res.text or "Non-JSON response from upstream.",
        )

    if upstream_res.status_code != 200:
        return JSONResponse(status_code=upstream_res.status_code, content=raw_response)

    if upstream_protocol == "anthropic":
        usage = raw_response.get("usage") or {}
        input_tokens = int(usage.get("input_tokens", 0))
        output_tokens = int(usage.get("output_tokens", 0))
        final_body = (
            raw_response
            if caller_protocol == "anthropic"
            else _anthropic_resp_to_openai(raw_response, model)
        )
    else:
        usage = raw_response.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens", 0))
        output_tokens = int(usage.get("completion_tokens", 0))
        final_body = (
            raw_response
            if caller_protocol == "openai"
            else _openai_resp_to_anthropic(raw_response, model)
        )

    add_spend(key_id, model, input_tokens, output_tokens)
    return JSONResponse(status_code=200, content=final_body)


@router.post("/v1/messages")
async def proxy_anthropic_messages(request: Request) -> JSONResponse:
    """Anthropic-compatible /v1/messages proxy endpoint (routes to any Master Key)."""
    return await _handle_proxy_request(request, caller_protocol="anthropic")


@router.post("/v1/chat/completions")
async def proxy_openai_chat_completions(request: Request) -> JSONResponse:
    """OpenAI-compatible /v1/chat/completions proxy endpoint (routes to any Master Key)."""
    return await _handle_proxy_request(request, caller_protocol="openai")
