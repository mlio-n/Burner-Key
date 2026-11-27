"""Mock AI upstream server supporting both Anthropic & OpenAI formats (Owner: Muzaffer)."""

from __future__ import annotations

import os
import random
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Burner Key Mock Upstream (Anthropic & OpenAI)", version="0.2.0")


def _extract_last_user_text(messages: list[dict[str, Any]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                return " ".join(
                    str(part.get("text", "")) for part in content if isinstance(part, dict)
                )
            return str(content)
    return ""


@app.get("/health")
def health() -> dict[str, str]:
    """Return mock server health."""
    return {"status": "ok", "service": "mock_ai_upstream"}


@app.post("/v1/messages")
async def mock_anthropic_messages(request: Request) -> JSONResponse:
    """Return a realistic Anthropic /v1/messages response with randomized token usage."""
    body: dict[str, Any] = await request.json()
    model = str(body.get("model") or "claude-3-5-haiku-20241022")
    messages = body.get("messages") or []

    last_user_text = _extract_last_user_text(messages)
    preview = last_user_text[:100] + ("..." if len(last_user_text) > 100 else "")
    input_tokens = random.randint(150, 450)
    output_tokens = random.randint(200, 600)

    return JSONResponse(
        status_code=200,
        content={
            "id": f"msg_fake_{uuid.uuid4().hex[:16]}",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"[Mock Upstream • {model}] İsteğiniz proxy üzerinden güvenle ulaştı. "
                        f"Sorunuzun özeti: \"{preview or 'Boş mesaj'}\""
                    ),
                }
            ],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        },
    )


@app.post("/v1/chat/completions")
async def mock_openai_chat_completions(request: Request) -> JSONResponse:
    """Return a realistic OpenAI /v1/chat/completions response with randomized token usage."""
    body: dict[str, Any] = await request.json()
    model = str(body.get("model") or "gpt-4o-mini")
    messages = body.get("messages") or []

    last_user_text = _extract_last_user_text(messages)
    preview = last_user_text[:100] + ("..." if len(last_user_text) > 100 else "")
    prompt_tokens = random.randint(120, 380)
    completion_tokens = random.randint(160, 480)

    return JSONResponse(
        status_code=200,
        content={
            "id": f"chatcmpl-mock-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": (
                            f"[Mock Upstream • {model}] OpenAI uyumlu isteğiniz proxy üzerinden işlendi. "
                            f"Sorunuzun özeti: \"{preview or 'Boş mesaj'}\""
                        ),
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("MOCK_UPSTREAM_PORT") or os.getenv("FAKE_CLAUDE_PORT", "8001"))
    uvicorn.run("mock_upstream:app", host="127.0.0.1", port=port, reload=True)
