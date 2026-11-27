"""SQLite persistence, key contract functions, and /admin API routes (Owner: Kisi 2)."""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from pricing import SUPPORTED_MODELS, calculate_cost

router = APIRouter(prefix="/admin", tags=["admin"])


def _get_db_path() -> Path:
    raw = os.getenv("DATABASE_PATH", "burner_keys.db").strip() or "burner_keys.db"
    path = Path(raw)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent / path
    return path


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    """Open a WAL-mode SQLite connection and handle commit/rollback cleanly."""
    db_path = _get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create burner_keys and request_logs tables if they do not exist."""
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS burner_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                api_key TEXT UNIQUE NOT NULL,
                key_preview TEXT NOT NULL,
                allowed_models TEXT NOT NULL,
                budget_limit_usd REAL NOT NULL,
                spent_usd REAL NOT NULL DEFAULT 0.0,
                request_count INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NOT NULL,
                is_revoked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                burner_key_id INTEGER REFERENCES burner_keys(id) ON DELETE SET NULL,
                burner_key_name TEXT,
                model TEXT,
                status_code INTEGER NOT NULL,
                error_message TEXT,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_burner_keys_api_key ON burner_keys(api_key);
            CREATE INDEX IF NOT EXISTS idx_request_logs_id ON request_logs(id DESC);
            """
        )


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _mask_key(raw_key: str) -> str:
    if len(raw_key) <= 14:
        return f"{raw_key[:6]}...{raw_key[-2:]}"
    return f"{raw_key[:12]}...{raw_key[-4:]}"


def _compute_status(row: sqlite3.Row, now: datetime | None = None) -> str:
    current = now or _now_utc()
    if bool(row["is_revoked"]):
        return "revoked"
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if current >= expires_at:
        return "expired"
    if float(row["spent_usd"]) >= float(row["budget_limit_usd"]):
        return "budget_exceeded"
    return "active"


def _log_request(
    conn: sqlite3.Connection,
    burner_key_id: int | None,
    burner_key_name: str | None,
    model: str | None,
    status_code: int,
    error_message: str | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
) -> None:
    conn.execute(
        """
        INSERT INTO request_logs (
            burner_key_id, burner_key_name, model, status_code, error_message,
            input_tokens, output_tokens, cost_usd, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            burner_key_id,
            burner_key_name,
            model,
            status_code,
            error_message,
            input_tokens,
            output_tokens,
            cost_usd,
            _now_utc().isoformat(),
        ),
    )


# ---------------------------------------------------------------------------
# Contract Functions (Kisi 1 <-> Kisi 2)
# ---------------------------------------------------------------------------


def check_key(key: str, model: str) -> tuple[int | None, int | None, str | None]:
    """Validate a burner key for a target model.

    Returns:
        (key_id, None, None) if valid.
        (None, status_code, error_message) if invalid (401/403/429).
    """
    cleaned_key = (key or "").strip()
    if not cleaned_key:
        with get_db() as conn:
            _log_request(conn, None, None, model, 401, "Missing API key.")
        return None, 401, "Missing burner API key."

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM burner_keys WHERE api_key = ?", (cleaned_key,)
        ).fetchone()

        if not row:
            _log_request(conn, None, None, model, 401, "Invalid burner API key.")
            return None, 401, "Invalid burner API key."

        if bool(row["is_revoked"]):
            msg = "Burner key has been revoked."
            _log_request(conn, row["id"], row["name"], model, 401, msg)
            return None, 401, msg

        expires_at = datetime.fromisoformat(row["expires_at"])
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if _now_utc() >= expires_at:
            msg = "Burner key has expired."
            _log_request(conn, row["id"], row["name"], model, 401, msg)
            return None, 401, msg

        allowed_models = json.loads(row["allowed_models"])
        if model not in allowed_models:
            msg = f"Model '{model}' is not allowed for this burner key."
            _log_request(conn, row["id"], row["name"], model, 403, msg)
            return None, 403, msg

        if float(row["spent_usd"]) >= float(row["budget_limit_usd"]):
            msg = "Burner key budget limit exceeded."
            _log_request(conn, row["id"], row["name"], model, 429, msg)
            return None, 429, msg

        return int(row["id"]), None, None


def add_spend(key_id: int, model: str, input_tokens: int, output_tokens: int) -> float:
    """Record token usage and USD spend for an approved request."""
    cost_usd = calculate_cost(model, input_tokens, output_tokens)
    with get_db() as conn:
        row = conn.execute(
            "SELECT name FROM burner_keys WHERE id = ?", (key_id,)
        ).fetchone()
        key_name = row["name"] if row else None
        conn.execute(
            """
            UPDATE burner_keys
            SET spent_usd = ROUND(spent_usd + ?, 6),
                request_count = request_count + 1
            WHERE id = ?
            """,
            (cost_usd, key_id),
        )
        _log_request(
            conn=conn,
            burner_key_id=key_id,
            burner_key_name=key_name,
            model=model,
            status_code=200,
            error_message=None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
        )
    return cost_usd


# ---------------------------------------------------------------------------
# Admin Schemas & Endpoints
# ---------------------------------------------------------------------------


class CreateKeyRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    budget_limit_usd: float = Field(default=0.10, gt=0)
    ttl_minutes: int = Field(default=60, ge=1, le=43200)
    allowed_models: list[str] = Field(
        default_factory=lambda: ["claude-3-5-haiku-20241022"], min_length=1
    )


class KeySummaryOut(BaseModel):
    id: int
    name: str
    key_preview: str
    allowed_models: list[str]
    budget_limit_usd: float
    spent_usd: float
    request_count: int
    expires_at: str
    is_revoked: bool
    status: str
    created_at: str


class CreateKeyOut(KeySummaryOut):
    api_key: str


class RequestLogOut(BaseModel):
    id: int
    burner_key_id: int | None
    burner_key_name: str | None
    model: str | None
    status_code: int
    error_message: str | None
    input_tokens: int
    output_tokens: int
    cost_usd: float
    created_at: str


def _row_to_summary(row: sqlite3.Row) -> KeySummaryOut:
    return KeySummaryOut(
        id=int(row["id"]),
        name=row["name"],
        key_preview=row["key_preview"],
        allowed_models=json.loads(row["allowed_models"]),
        budget_limit_usd=float(row["budget_limit_usd"]),
        spent_usd=round(float(row["spent_usd"]), 6),
        request_count=int(row["request_count"]),
        expires_at=row["expires_at"],
        is_revoked=bool(row["is_revoked"]),
        status=_compute_status(row),
        created_at=row["created_at"],
    )


@router.get("/models", response_model=list[str])
def list_supported_models() -> list[str]:
    """Return supported Claude models for UI selection."""
    return SUPPORTED_MODELS


@router.post("/keys", response_model=CreateKeyOut, status_code=status.HTTP_201_CREATED)
def create_key(payload: CreateKeyRequest) -> CreateKeyOut:
    """Create a new scoped, budget-limited, expiring burner key."""
    cleaned_models = [m.strip() for m in payload.allowed_models if m.strip()]
    if not cleaned_models:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one allowed model must be selected.",
        )

    now = _now_utc()
    created_at = now.isoformat()
    expires_at = (now + timedelta(minutes=payload.ttl_minutes)).isoformat()
    raw_key = f"brk_live_{secrets.token_urlsafe(24)}"
    preview = _mask_key(raw_key)

    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO burner_keys (
                name, api_key, key_preview, allowed_models,
                budget_limit_usd, spent_usd, request_count,
                expires_at, is_revoked, created_at
            )
            VALUES (?, ?, ?, ?, ?, 0.0, 0, ?, 0, ?)
            """,
            (
                payload.name.strip(),
                raw_key,
                preview,
                json.dumps(cleaned_models),
                float(payload.budget_limit_usd),
                expires_at,
                created_at,
            ),
        )
        row = conn.execute(
            "SELECT * FROM burner_keys WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()

    summary = _row_to_summary(row)
    return CreateKeyOut(**summary.model_dump(), api_key=raw_key)


@router.get("/keys", response_model=list[KeySummaryOut])
def list_keys() -> list[KeySummaryOut]:
    """List all burner keys newest-first with live computed status."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM burner_keys ORDER BY id DESC").fetchall()
    return [_row_to_summary(r) for r in rows]


@router.post("/keys/{key_id}/revoke", response_model=KeySummaryOut)
def revoke_key(key_id: int) -> KeySummaryOut:
    """Immediately revoke a burner key (Kill Switch)."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM burner_keys WHERE id = ?", (key_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Burner key not found.")
        conn.execute("UPDATE burner_keys SET is_revoked = 1 WHERE id = ?", (key_id,))
        updated = conn.execute(
            "SELECT * FROM burner_keys WHERE id = ?", (key_id,)
        ).fetchone()
    return _row_to_summary(updated)


@router.get("/logs", response_model=list[RequestLogOut])
def list_logs(limit: int = Query(default=50, ge=1, le=200)) -> list[RequestLogOut]:
    """Return recent proxy request logs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM request_logs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [
        RequestLogOut(
            id=int(r["id"]),
            burner_key_id=r["burner_key_id"],
            burner_key_name=r["burner_key_name"],
            model=r["model"],
            status_code=int(r["status_code"]),
            error_message=r["error_message"],
            input_tokens=int(r["input_tokens"]),
            output_tokens=int(r["output_tokens"]),
            cost_usd=round(float(r["cost_usd"]), 6),
            created_at=r["created_at"],
        )
        for r in rows
    ]
