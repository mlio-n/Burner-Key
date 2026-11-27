"""FastAPI entrypoint for Burner Key reverse proxy and static UI (Owner: Kisi 1)."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from keys import init_db, router as admin_router  # noqa: E402
from proxy import router as proxy_router  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Burner Key — Claude BYOK Reverse Proxy",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(proxy_router)
app.include_router(admin_router)

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def serve_index() -> FileResponse:
    """Serve the single-file admin dashboard."""
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health", tags=["system"])
def health_check() -> dict[str, str]:
    """Return service health and configured upstream URL."""
    return {
        "status": "ok",
        "upstream_base_url": os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8001"),
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
