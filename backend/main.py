"""FastAPI entrypoint for Burner Key Universal BYOK proxy, SSH tunnel, & frontend (Owner: Muzaffer)."""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"

load_dotenv(BACKEND_DIR / ".env")
load_dotenv(BACKEND_DIR.parent / ".env", override=False)

from keys import init_db, router as admin_router  # noqa: E402
from proxy import router as proxy_router  # noqa: E402

ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9.-]+\.(?:lhr\.life|pinggy\.link)")


def _stop_process(proc: subprocess.Popen[str] | None) -> None:
    if not proc or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=2.0)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _run_tunnel_attempt(
    app: FastAPI,
    cmd: list[str],
    default_url: str,
    stop_event: threading.Event,
    timeout_sec: float = 8.0,
) -> bool:
    """Spawn an SSH tunnel subprocess, wait up to timeout_sec for URL, and keep draining stdout."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
    except OSError:
        return False

    app.state.tunnel_proc = proc
    found_event = threading.Event()

    def _drain_stdout() -> None:
        if not proc.stdout:
            return
        try:
            for raw_line in proc.stdout:
                if stop_event.is_set():
                    break
                clean_line = ANSI_ESCAPE_RE.sub("", raw_line)
                match = TUNNEL_URL_RE.search(clean_line)
                if match and not found_event.is_set():
                    app.state.public_url = match.group(0).rstrip(".")
                    found_event.set()
        except Exception:
            pass

    reader = threading.Thread(target=_drain_stdout, daemon=True)
    reader.start()

    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline and not stop_event.is_set():
        if found_event.is_set():
            break
        if proc.poll() is not None:
            break
        stop_event.wait(0.2)

    if not found_event.is_set():
        _stop_process(proc)
        if app.state.tunnel_proc is proc:
            app.state.tunnel_proc = None
        return False

    # Keep the active tunnel alive and reset public_url if it drops
    while not stop_event.is_set() and proc.poll() is None:
        stop_event.wait(0.5)

    _stop_process(proc)
    if app.state.tunnel_proc is proc:
        app.state.tunnel_proc = None
    app.state.public_url = default_url
    return True


def _tunnel_worker(app: FastAPI, port: int, stop_event: threading.Event) -> None:
    default_url = f"http://127.0.0.1:{port}"
    attempts = [
        [
            "ssh",
            "-T",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=30",
            "-R",
            f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
        ],
        [
            "ssh",
            "-T",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=30",
            "-p",
            "443",
            f"-R0:127.0.0.1:{port}",
            "a.pinggy.io",
        ],
    ]

    while not stop_event.is_set():
        for cmd in attempts:
            if stop_event.is_set():
                break
            _run_tunnel_attempt(app, cmd, default_url, stop_event, timeout_sec=8.0)
        if not stop_event.is_set():
            stop_event.wait(3.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    port = int(os.getenv("PORT", "8000"))
    default_url = f"http://127.0.0.1:{port}"
    app.state.public_url = default_url
    app.state.tunnel_proc = None

    stop_event = threading.Event()
    disable_tunnel = os.getenv("DISABLE_TUNNEL", "").strip().lower() in {"1", "true", "yes"}
    worker: threading.Thread | None = None
    if not disable_tunnel:
        worker = threading.Thread(
            target=_tunnel_worker,
            args=(app, port, stop_event),
            daemon=True,
        )
        worker.start()

    try:
        yield
    finally:
        stop_event.set()
        _stop_process(getattr(app.state, "tunnel_proc", None))
        app.state.tunnel_proc = None
        if worker and worker.is_alive():
            worker.join(timeout=2.0)


app = FastAPI(
    title="Burner Key — Universal AI BYOK Reverse Proxy",
    version="0.2.0",
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


@app.get("/health", tags=["system"])
def health_check(request: Request) -> dict[str, object]:
    """Return service health, proxy capabilities, and active public tunnel URL."""
    port = int(os.getenv("PORT", "8000"))
    default_url = f"http://127.0.0.1:{port}"
    return {
        "status": "ok",
        "upstream_base_url": os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8001"),
        "universal_proxy": True,
        "public_url": getattr(request.app.state, "public_url", default_url),
    }


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
