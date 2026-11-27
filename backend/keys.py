"""SQLite vault, Fernet encryption, contract functions, and /admin API routes (Owner: Selcuk)."""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from pricing import (
    PROVIDER_PRESETS,
    SUPPORTED_MODELS,
    calculate_cost,
    detect_provider_from_key,
)

router = APIRouter(prefix="/admin", tags=["admin"])

BACKEND_DIR = Path(__file__).resolve().parent


def _get_db_path() -> Path:
    raw = os.getenv("DATABASE_PATH", "burner_keys.db").strip() or "burner_keys.db"
    path = Path(raw)
    if not path.is_absolute():
        path = BACKEND_DIR / path
    return path


def _get_fernet() -> Fernet:
    env_key = os.getenv("ENCRYPTION_KEY", "").strip()
    if env_key:
        return Fernet(env_key.encode("utf-8"))

    secret_file = BACKEND_DIR / ".secret.key"
    if secret_file.exists():
        key_bytes = secret_file.read_text(encoding="utf-8").strip().encode("utf-8")
    else:
        key_bytes = Fernet.generate_key()
        secret_file.write_text(key_bytes.decode("utf-8"), encoding="utf-8")
    return Fernet(key_bytes)


def encrypt_secret(raw_value: str) -> str:
    """Encrypt a master API key using Fernet."""
    return _get_fernet().encrypt(raw_value.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    """Decrypt a stored master API key."""
    try:
        return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError(
            "Master key could not be decrypted with current ENCRYPTION_KEY / .secret.key."
        ) from exc


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


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _mask_key(raw_key: str) -> str:
    cleaned = raw_key.strip()
    if len(cleaned) <= 12:
        return f"{cleaned[:4]}...{cleaned[-2:]}" if len(cleaned) > 6 else "***"
    return f"{cleaned[:8]}...{cleaned[-4:]}"


def init_db() -> None:
    """Create master_keys, burner_keys, and request_logs tables and seed default Mock vault."""
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS master_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                provider TEXT NOT NULL,
                base_url TEXT NOT NULL,
                encrypted_api_key TEXT NOT NULL,
                key_preview TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS burner_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                master_key_id INTEGER NOT NULL DEFAULT 1 REFERENCES master_keys(id) ON DELETE RESTRICT,
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

            CREATE TABLE IF NOT EXISTS reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                burner_key_id INTEGER NOT NULL REFERENCES burner_keys(id) ON DELETE CASCADE,
                amount_usd REAL NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_reservations_key ON reservations(burner_key_id);
            CREATE INDEX IF NOT EXISTS idx_burner_keys_api_key ON burner_keys(api_key);
            CREATE INDEX IF NOT EXISTS idx_request_logs_id ON request_logs(id DESC);
            """
        )

        # Safe migration for existing databases created before master_keys existed
        cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(burner_keys)").fetchall()
        }
        if "master_key_id" not in cols:
            conn.execute(
                "ALTER TABLE burner_keys ADD COLUMN master_key_id INTEGER NOT NULL DEFAULT 1"
            )

        existing_masters = conn.execute("SELECT COUNT(*) FROM master_keys").fetchone()[0]
        if existing_masters == 0:
            default_upstream = (
                os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8001").strip().rstrip("/")
            )
            mock_secret = os.getenv("ANTHROPIC_API_KEY", "sk-mock-burner-key").strip()
            conn.execute(
                """
                INSERT INTO master_keys (
                    name, provider, base_url, encrypted_api_key, key_preview, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    "Mock / Test Kasası (Ücretsiz)",
                    "mock",
                    default_upstream,
                    encrypt_secret(mock_secret),
                    _mask_key(mock_secret),
                    _now_utc().isoformat(),
                ),
            )


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
# Contract Functions (Muzaffer <-> Selcuk)
# ---------------------------------------------------------------------------


# In-flight budget reservations: stops parallel requests from overspending a budget.
RESERVATION_TTL_SECONDS = 120.0
DEFAULT_ESTIMATE_TOKENS = (500, 500)  # (input, output) used before a key has any history


def _estimate_request_cost(row: sqlite3.Row, model: str) -> float:
    """Estimate one request's cost: the key's average so far, or a default guess."""
    count = int(row["request_count"])
    if count > 0:
        return float(row["spent_usd"]) / count
    return calculate_cost(model, *DEFAULT_ESTIMATE_TOKENS)


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
        conn.execute("BEGIN IMMEDIATE")  # lock: check + reserve must be one atomic step
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
        if "*" not in allowed_models and model not in allowed_models:
            msg = f"Model '{model}' is not allowed for this burner key."
            _log_request(conn, row["id"], row["name"], model, 403, msg)
            return None, 403, msg

        spent = float(row["spent_usd"])
        budget = float(row["budget_limit_usd"])
        now_ts = time.time()
        conn.execute(
            "DELETE FROM reservations WHERE created_at < ?",
            (now_ts - RESERVATION_TTL_SECONDS,),
        )
        pending = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(amount_usd), 0.0) FROM reservations WHERE burner_key_id = ?",
            (row["id"],),
        ).fetchone()
        pending_count, pending_usd = int(pending[0]), float(pending[1])
        budget_cap = budget / 4.0  # a single reservation never holds more than 25% of the budget
        estimate = min(_estimate_request_cost(row, model), budget_cap)

        # Block when the budget is spent, or when requests already in flight
        # have reserved the rest of it.
        if spent >= budget or (pending_count > 0 and spent + pending_usd + estimate > budget):
            msg = "Burner key budget limit exceeded."
            _log_request(conn, row["id"], row["name"], model, 429, msg)
            return None, 429, msg

        conn.execute(
            "INSERT INTO reservations (burner_key_id, amount_usd, created_at) VALUES (?, ?, ?)",
            (row["id"], estimate, now_ts),
        )
        return int(row["id"]), None, None


def get_upstream_target(key_id: int) -> dict[str, str]:
    """Resolve and decrypt the upstream Master Key configuration for a Burner Key."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT mk.provider, mk.base_url, mk.encrypted_api_key
            FROM burner_keys bk
            LEFT JOIN master_keys mk ON bk.master_key_id = mk.id
            WHERE bk.id = ?
            """,
            (key_id,),
        ).fetchone()

        if not row or not row["provider"]:
            row = conn.execute(
                "SELECT provider, base_url, encrypted_api_key FROM master_keys ORDER BY id ASC LIMIT 1"
            ).fetchone()

    if not row:
        return {
            "provider": "mock",
            "protocol": "mock",
            "base_url": os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8001").strip().rstrip("/"),
            "api_key": os.getenv("ANTHROPIC_API_KEY", "sk-mock-burner-key").strip(),
        }

    provider = row["provider"]
    preset = PROVIDER_PRESETS.get(provider, PROVIDER_PRESETS["custom"])
    base_url = row["base_url"].strip().rstrip("/")
    if provider == "mock":
        env_upstream = os.getenv("UPSTREAM_BASE_URL", "").strip().rstrip("/")
        if env_upstream:
            base_url = env_upstream

    return {
        "provider": provider,
        "protocol": preset["protocol"],
        "base_url": base_url,
        "api_key": decrypt_secret(row["encrypted_api_key"]),
    }


def _release_oldest_reservation(conn: sqlite3.Connection, key_id: int) -> None:
    conn.execute(
        "DELETE FROM reservations WHERE id = "
        "(SELECT id FROM reservations WHERE burner_key_id = ? ORDER BY id LIMIT 1)",
        (key_id,),
    )


def release_reservation(key_id: int) -> None:
    """Free one pending reservation. Call it when an approved request fails upstream."""
    with get_db() as conn:
        _release_oldest_reservation(conn, key_id)


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
        _release_oldest_reservation(conn, key_id)
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


class CreateMasterKeyRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    provider: str = Field(default="auto", min_length=1, max_length=40)
    base_url: str | None = Field(default=None, max_length=300)
    api_key: str = Field(..., min_length=3, max_length=500)


class MasterKeyOut(BaseModel):
    id: int
    name: str
    provider: str
    protocol: str
    base_url: str
    key_preview: str
    created_at: str


class CreateKeyRequest(BaseModel):
    master_key_id: int | None = None
    name: str = Field(..., min_length=1, max_length=120)
    budget_limit_usd: float = Field(default=0.05, gt=0)
    ttl_minutes: int = Field(default=60, ge=1, le=43200)
    allowed_models: list[str] = Field(
        default_factory=lambda: ["claude-haiku-5-5"], min_length=1
    )


class KeySummaryOut(BaseModel):
    id: int
    master_key_id: int
    master_key_name: str
    provider: str
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


def _row_to_master_out(row: sqlite3.Row) -> MasterKeyOut:
    provider = row["provider"]
    preset = PROVIDER_PRESETS.get(provider, PROVIDER_PRESETS["custom"])
    return MasterKeyOut(
        id=int(row["id"]),
        name=row["name"],
        provider=provider,
        protocol=preset["protocol"],
        base_url=row["base_url"],
        key_preview=row["key_preview"],
        created_at=row["created_at"],
    )


def _row_to_summary(row: sqlite3.Row) -> KeySummaryOut:
    return KeySummaryOut(
        id=int(row["id"]),
        master_key_id=int(row["master_key_id"]),
        master_key_name=row["master_key_name"] or "Mock / Test Kasası",
        provider=row["provider"] or "mock",
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


@router.get("/providers", response_model=list[dict[str, Any]])
def list_providers() -> list[dict[str, Any]]:
    """Return supported AI providers, default base URLs, and preset models."""
    return list(PROVIDER_PRESETS.values())


@router.get("/models", response_model=list[str])
def list_supported_models(provider: str | None = Query(default=None)) -> list[str]:
    """Return supported models, optionally filtered by provider."""
    if provider and provider in PROVIDER_PRESETS:
        return list(PROVIDER_PRESETS[provider]["models"])
    return SUPPORTED_MODELS


@router.post("/master-keys", response_model=MasterKeyOut, status_code=status.HTTP_201_CREATED)
def create_master_key(payload: CreateMasterKeyRequest) -> MasterKeyOut:
    """Encrypt and store a new upstream Master API Key (OpenAI, Claude, Gemini, Groq, etc.)."""
    raw_key = payload.api_key.strip()
    provider = payload.provider.strip().lower()
    if provider == "auto":
        provider = detect_provider_from_key(raw_key)
    if provider not in PROVIDER_PRESETS:
        provider = "custom"

    preset = PROVIDER_PRESETS[provider]
    base_url = (payload.base_url or preset["default_base_url"]).strip().rstrip("/")
    encrypted = encrypt_secret(raw_key)
    preview = _mask_key(raw_key)
    created_at = _now_utc().isoformat()

    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO master_keys (
                name, provider, base_url, encrypted_api_key, key_preview, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.name.strip(),
                provider,
                base_url,
                encrypted,
                preview,
                created_at,
            ),
        )
        row = conn.execute(
            "SELECT * FROM master_keys WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return _row_to_master_out(row)


@router.get("/master-keys", response_model=list[MasterKeyOut])
def list_master_keys() -> list[MasterKeyOut]:
    """List all stored Master Keys without revealing raw secrets."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM master_keys ORDER BY id DESC").fetchall()
    return [_row_to_master_out(r) for r in rows]


@router.delete("/master-keys/{master_id}")
def delete_master_key(master_id: int) -> dict[str, Any]:
    """Delete an unused Master Key (keeps at least one vault entry)."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM master_keys WHERE id = ?", (master_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Master key not found.")

        total = conn.execute("SELECT COUNT(*) FROM master_keys").fetchone()[0]
        if total <= 1:
            raise HTTPException(
                status_code=400, detail="Cannot delete the last remaining master key."
            )

        in_use = conn.execute(
            "SELECT COUNT(*) FROM burner_keys WHERE master_key_id = ?", (master_id,)
        ).fetchone()[0]
        if in_use > 0:
            raise HTTPException(
                status_code=409,
                detail="Cannot delete a master key that still has linked burner keys.",
            )

        conn.execute("DELETE FROM master_keys WHERE id = ?", (master_id,))
    return {"deleted": True, "id": master_id}


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
        master_id = payload.master_key_id
        if master_id is None:
            default_master = conn.execute(
                "SELECT id FROM master_keys WHERE provider = 'mock' ORDER BY id ASC LIMIT 1"
            ).fetchone()
            if not default_master:
                default_master = conn.execute(
                    "SELECT id FROM master_keys ORDER BY id ASC LIMIT 1"
                ).fetchone()
            if not default_master:
                raise HTTPException(status_code=400, detail="No master key available.")
            master_id = int(default_master["id"])
        else:
            master_exists = conn.execute(
                "SELECT id FROM master_keys WHERE id = ?", (master_id,)
            ).fetchone()
            if not master_exists:
                raise HTTPException(status_code=404, detail="Master key not found.")

        cursor = conn.execute(
            """
            INSERT INTO burner_keys (
                master_key_id, name, api_key, key_preview, allowed_models,
                budget_limit_usd, spent_usd, request_count,
                expires_at, is_revoked, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 0.0, 0, ?, 0, ?)
            """,
            (
                master_id,
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
            """
            SELECT bk.*, mk.name AS master_key_name, mk.provider AS provider
            FROM burner_keys bk
            LEFT JOIN master_keys mk ON bk.master_key_id = mk.id
            WHERE bk.id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()

    summary = _row_to_summary(row)
    return CreateKeyOut(**summary.model_dump(), api_key=raw_key)


@router.get("/keys", response_model=list[KeySummaryOut])
def list_keys() -> list[KeySummaryOut]:
    """List all burner keys newest-first with live computed status."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT bk.*, mk.name AS master_key_name, mk.provider AS provider
            FROM burner_keys bk
            LEFT JOIN master_keys mk ON bk.master_key_id = mk.id
            ORDER BY bk.id DESC
            """
        ).fetchall()
    return [_row_to_summary(r) for r in rows]


@router.post("/keys/{key_id}/revoke", response_model=KeySummaryOut)
def revoke_key(key_id: int) -> KeySummaryOut:
    """Immediately revoke a burner key (Kill Switch)."""
    with get_db() as conn:
        row = conn.execute("SELECT id FROM burner_keys WHERE id = ?", (key_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Burner key not found.")
        conn.execute("UPDATE burner_keys SET is_revoked = 1 WHERE id = ?", (key_id,))
        updated = conn.execute(
            """
            SELECT bk.*, mk.name AS master_key_name, mk.provider AS provider
            FROM burner_keys bk
            LEFT JOIN master_keys mk ON bk.master_key_id = mk.id
            WHERE bk.id = ?
            """,
            (key_id,),
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
