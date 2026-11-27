"""Mock Anthropic Claude Messages server for zero-cost team testing (Owner: Kisi 4)."""

from __future__ import annotations

import os
import random
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Fake Claude Upstream Server", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Return mock server health."""
    return {"status": "ok", "service": "fake_claude"}


@app.post("/v1/messages")
async def mock_messages(request: Request) -> JSONResponse:
    """Return a realistic Anthropic /v1/messages response with randomized token usage."""
    body: dict[str, Any] = await request.json()
    model = str(body.get("model") or "claude-3-5-haiku-20241022")
    messages = body.get("messages") or []

    last_user_text = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                last_user_text = " ".join(
                    str(part.get("text", "")) for part in content if isinstance(part, dict)
                )
            else:
                last_user_text = str(content)
            break

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
                        f"[Fake Claude • {model}] İsteğiniz proxy üzerinden güvenle ulaştı. "
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


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("FAKE_CLAUDE_PORT", "8001"))
    uvicorn.run("fake_claude:app", host="127.0.0.1", port=port, reload=True)
