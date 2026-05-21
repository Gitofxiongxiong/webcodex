import asyncio
import base64
import binascii
import fnmatch
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .codex_relay import CodexCredentialError, CodexCredentialStore, CodexRelay
from .config import Settings, get_settings
from .db import DemoStore
from .oss_store import AliyunObjectStore


app = FastAPI(title="WebCodex Demo API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

settings = get_settings()
store = DemoStore(settings.sqlite_path)

ReasoningEffort = Literal["low", "medium", "high", "xhigh"]
SpeedMode = Literal["standard", "fast"]

MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
SUPPORTED_MODELS = {"gpt-5.4", "gpt-5.5"}
ACCOUNT_PATTERN = re.compile(r"^[A-Za-z0-9._@+-]{3,64}$")
SERVICE_TIER_BY_SPEED_MODE = {
    "standard": "default",
    "fast": "priority",
}
DEFAULT_CONTEXT_WINDOW = 128000
DEFAULT_RESERVED_OUTPUT_TOKENS = 8192
OPENROUTER_PROVIDER_PREFIX = "openai/"
_openrouter_price_cache: tuple[float, dict[str, dict[str, float]]] | None = None
TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled"}
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 20
IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
run_processes: dict[str, subprocess.Popen] = {}
run_processes_lock = threading.RLock()


@lru_cache
def get_object_store() -> AliyunObjectStore:
    return AliyunObjectStore(
        access_key_id=settings.oss_access_key_id,
        access_key_secret=settings.oss_access_key_secret,
        endpoint=settings.oss_endpoint,
        bucket_name=settings.oss_bucket_name,
        key_prefix=settings.oss_key_prefix,
    )


def require_object_store() -> AliyunObjectStore:
    try:
        return get_object_store()
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@lru_cache
def get_codex_relay() -> CodexRelay:
    return CodexRelay(
        credential_store=CodexCredentialStore(
            auth_file=settings.codex_relay_auth_path,
            refresh_margin_seconds=settings.codex_relay_refresh_margin_seconds,
            timeout_seconds=min(settings.codex_relay_timeout_seconds, 30),
        ),
        upstream_base_url=settings.codex_relay_upstream_base_url,
        timeout_seconds=settings.codex_relay_timeout_seconds,
    )


def require_codex_relay_token(authorization: str | None, app_settings: Settings) -> None:
    expected = f"Bearer {app_settings.codex_relay_api_key}"
    if not app_settings.codex_relay_enabled:
        raise HTTPException(status_code=404, detail="Codex relay is disabled")
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid Codex relay token")


def require_worker_token(
    authorization: str | None = Header(default=None),
    app_settings: Settings = Depends(get_settings),
) -> None:
    expected = f"Bearer {app_settings.worker_token}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid worker token")


def get_current_user(
    authorization: str | None = Header(default=None),
    access_token: str | None = Query(default=None),
) -> dict:
    token_hash = auth_token_hash_from_request(authorization, access_token)
    user = store.get_user_by_session(token_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


def auth_token_hash_from_request(authorization: str | None, access_token: str | None = None) -> str:
    token = (access_token or "").strip()
    if not token and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            token = value.strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return token_hash(token)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_account(account: str) -> str:
    normalized = account.strip().lower()
    if not ACCOUNT_PATTERN.fullmatch(normalized):
        raise HTTPException(
            status_code=400,
            detail="Account must be 3-64 characters and use letters, numbers, '.', '_', '@', '+' or '-'",
        )
    return normalized


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    iterations = 120_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        algorithm, iterations, salt_hex, digest_hex = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def issue_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    store.create_auth_session(user_id=user_id, token_hash=token_hash(token))
    return token


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "account": user.get("account"),
        "name": user["name"],
        "created_at": user["created_at"],
    }


def model_catalog_payload(app_settings: Settings) -> dict:
    return {
        "models": sorted(SUPPORTED_MODELS),
        "contextWindow": DEFAULT_CONTEXT_WINDOW,
        "reservedOutputTokens": DEFAULT_RESERVED_OUTPUT_TOKENS,
        "pricing": {
            "source": "openrouter",
            "basis": "per_token",
            "usdPrices": openrouter_price_catalog(app_settings),
            "overrideUsdPricesPer1M": configured_usd_price_catalog(app_settings),
            "url": app_settings.openrouter_models_url,
        },
    }


def configured_usd_price_catalog(app_settings: Settings) -> dict[str, dict[str, float]]:
    return supported_price_catalog(normalize_price_catalog(load_json_object(app_settings.model_prices_usd_per_1m_json)))


def supported_price_catalog(catalog: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    return {model: rates for model, rates in catalog.items() if model in SUPPORTED_MODELS}


def openrouter_price_catalog(app_settings: Settings) -> dict[str, dict[str, float]]:
    global _openrouter_price_cache
    now = time.monotonic()
    ttl = max(app_settings.openrouter_pricing_cache_seconds, 60)
    if _openrouter_price_cache and now - _openrouter_price_cache[0] < ttl:
        return _openrouter_price_cache[1]

    catalog: dict[str, dict[str, float]] = {}
    try:
        with httpx.Client(timeout=10) as client:
            response = client.get(app_settings.openrouter_models_url)
            response.raise_for_status()
            models = response.json().get("data", [])
    except Exception as exc:
        print(f"[pricing] failed to fetch OpenRouter model prices: {exc}", file=sys.stderr)
        if _openrouter_price_cache:
            return _openrouter_price_cache[1]
        return {}

    for item in models if isinstance(models, list) else []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "")
        if not model_id.startswith(OPENROUTER_PROVIDER_PREFIX):
            continue
        model = normalize_model_key(model_id.removeprefix(OPENROUTER_PROVIDER_PREFIX))
        if model not in SUPPORTED_MODELS:
            continue
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        rates = {
            "input": numeric_or_zero_float(pricing.get("prompt")),
            "cached": numeric_or_zero_float(pricing.get("input_cache_read") or pricing.get("prompt")),
            "output": numeric_or_zero_float(pricing.get("completion")),
        }
        if rates["input"] > 0 or rates["output"] > 0:
            catalog[model] = {
                **rates,
                "contextWindow": numeric_or_zero_float(item.get("context_length")),
            }

    _openrouter_price_cache = (now, catalog)
    return catalog


def load_json_object(raw: str) -> dict:
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalize_price_catalog(raw: dict) -> dict[str, dict[str, float]]:
    catalog: dict[str, dict[str, float]] = {}
    for model_name, rates in raw.items():
        if not isinstance(model_name, str) or not isinstance(rates, dict):
            continue
        normalized_rates = {}
        for key in ("input", "cached", "output"):
            number = numeric_or_none(rates.get(key))
            if number is not None:
                normalized_rates[key] = number
        if normalized_rates:
            catalog[normalize_model_key(model_name)] = normalized_rates
    return catalog


def enrich_usage_payload(payload: dict, app_settings: Settings) -> dict:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    model = str(payload.get("model") or "").strip()
    input_tokens = numeric_or_zero(usage.get("inputTokens") or usage.get("input_tokens"))
    cached_tokens = numeric_or_zero(usage.get("cachedTokens") or usage.get("cached_tokens"))
    output_tokens = numeric_or_zero(usage.get("outputTokens") or usage.get("output_tokens"))
    billable_input_tokens = max(input_tokens - cached_tokens, 0)

    enriched = dict(payload)
    usd_pricing = price_for_model(configured_usd_price_catalog(app_settings), model)
    price_source = "MODEL_PRICES_USD_PER_1M_JSON"
    price_basis = "per_1m_tokens"
    if not usd_pricing:
        usd_pricing = price_for_model(openrouter_price_catalog(app_settings), model)
        price_source = "openrouter"
        price_basis = "per_token"
    if usd_pricing:
        enriched["costMicroUsd"] = calculate_micro_cost(
            billable_input_tokens=billable_input_tokens,
            cached_tokens=cached_tokens,
            output_tokens=output_tokens,
            rates=usd_pricing,
            basis=price_basis,
        )
        enriched["pricing"] = {
            **(enriched.get("pricing") if isinstance(enriched.get("pricing"), dict) else {}),
            "unit": "usd",
            "basis": price_basis,
            "rates": usd_pricing,
            "source": price_source,
            "billableInputTokens": billable_input_tokens,
        }
    return enriched


def usage_payload_with_context(payload: dict, context: dict | None) -> dict:
    if not context:
        return payload
    enriched = dict(payload)
    for key in (
        "contextWindow",
        "reservedOutputTokens",
        "usableContextTokens",
        "model",
        "serviceTier",
    ):
        if enriched.get(key) is None and context.get(key) is not None:
            enriched[key] = context[key]
    if not enriched.get("breakdown") and context.get("breakdown"):
        enriched["breakdown"] = context["breakdown"]

    usage = enriched.get("usage") if isinstance(enriched.get("usage"), dict) else {}
    input_tokens = numeric_or_zero(usage.get("inputTokens") or usage.get("input_tokens"))
    usable_context = numeric_or_zero(enriched.get("usableContextTokens"))
    if usable_context > 0:
        if enriched.get("remainingTokens") is None:
            enriched["remainingTokens"] = max(usable_context - input_tokens, 0)
        if enriched.get("usedPercent") is None:
            enriched["usedPercent"] = round(max(0.0, min(100.0, (input_tokens / usable_context) * 100)), 2)
    return enriched


def price_for_model(catalog: dict[str, dict[str, float]], model: str) -> dict[str, float] | None:
    normalized = normalize_model_key(model)
    if normalized in catalog:
        return catalog[normalized]
    openrouter_key = f"{OPENROUTER_PROVIDER_PREFIX}{normalized}"
    if openrouter_key in catalog:
        return catalog[openrouter_key]
    for key, rates in catalog.items():
        if normalized.startswith(key):
            return rates
    return None


def normalize_model_key(model: str) -> str:
    return model.strip().lower()


def calculate_micro_cost(
    *,
    billable_input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    rates: dict[str, float],
    basis: str,
) -> int:
    input_cost = billable_input_tokens * rates.get("input", 0.0)
    cached_cost = cached_tokens * rates.get("cached", rates.get("input", 0.0))
    output_cost = output_tokens * rates.get("output", 0.0)
    if basis == "per_token":
        return int(round((input_cost + cached_cost + output_cost) * 1_000_000))
    return int(round(input_cost + cached_cost + output_cost))


def numeric_or_none(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def numeric_or_zero_float(value) -> float:
    number = numeric_or_none(value)
    return number if number is not None else 0.0


def numeric_or_zero(value) -> int:
    number = numeric_or_none(value)
    return int(number) if number is not None else 0


def default_workspace_id(user_id: str) -> str:
    return f"workspace_{user_id}"


def ensure_user_workspace(user: dict) -> dict:
    return store.ensure_workspace(
        user_id=user["id"],
        workspace_id=default_workspace_id(user["id"]),
        name="Default Workspace",
    )


def require_workspace_owner(workspace_id: str, user: dict) -> dict:
    workspace = store.get_workspace(workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if workspace["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


def require_conversation_owner(conversation_id: str, user: dict) -> dict:
    conversation = store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conversation["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


def require_run_owner(run_id: str, user: dict) -> tuple[dict, dict]:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    conversation = require_conversation_owner(run["conversation_id"], user)
    return run, conversation


def require_attachment_owner(attachment_id: str, user: dict) -> dict:
    attachment = store.get_attachment(attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if attachment["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return attachment


def require_run_attachments(attachment_ids: list[str], user: dict, workspace_id: str) -> list[dict]:
    attachments = store.list_attachments(attachment_ids)
    if len(attachments) != len(attachment_ids):
        raise HTTPException(status_code=404, detail="Attachment not found")
    for attachment in attachments:
        if attachment["user_id"] != user["id"] or attachment["workspace_id"] != workspace_id:
            raise HTTPException(status_code=404, detail="Attachment not found")
    return attachments


def unique_attachment_ids(attachment_ids: list[str]) -> list[str]:
    seen = set()
    result = []
    for value in attachment_ids:
        attachment_id = str(value or "").strip()
        if not attachment_id or attachment_id in seen:
            continue
        seen.add(attachment_id)
        result.append(attachment_id)
    return result


class AuthRequest(BaseModel):
    account: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=4, max_length=128)


class RegisterRequest(AuthRequest):
    name: str | None = Field(default=None, max_length=80)


class CreateUserRequest(BaseModel):
    id: str = "demo-user"
    name: str | None = "Demo User"


class CreateWorkspaceRequest(BaseModel):
    id: str | None = None
    user_id: str | None = None
    name: str = "Default Workspace"


class CreateConversationRequest(BaseModel):
    user_id: str | None = None
    workspace_id: str | None = None
    title: str | None = "Demo Conversation"


class CreateConversationResponse(BaseModel):
    conversation_id: str


class CreateRunRequest(BaseModel):
    message: str = Field(default="", max_length=200000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS_PER_MESSAGE)
    model: str | None = Field(default=None, min_length=1, max_length=80)
    reasoning_effort: ReasoningEffort | None = None
    speed_mode: SpeedMode = "fast"


class RunExecutionSettings(BaseModel):
    model: str
    reasoning_effort: ReasoningEffort
    reasoning_summary: str
    text_verbosity: str
    speed_mode: SpeedMode
    service_tier: str


class CreateRunResponse(BaseModel):
    run_id: str
    events_url: str
    settings: RunExecutionSettings


class WorkerEventRequest(BaseModel):
    type: str
    visibility: str = "user"
    itemId: str | None = None
    parentId: str | None = None
    status: str | None = None
    payload: dict = Field(default_factory=dict)


class AgentSessionItemsRequest(BaseModel):
    items: list[dict] = Field(default_factory=list)


class WriteWorkspaceFileRequest(BaseModel):
    content: str
    message: str = "write file"
    content_type: str = "text/plain; charset=utf-8"


class WriteWorkspaceFileBytesRequest(BaseModel):
    content_base64: str
    message: str = "write file"
    content_type: str = "application/octet-stream"


class CreateWorkspaceFolderRequest(BaseModel):
    path: str = Field(min_length=1, max_length=500)


class WorkspaceEntryOperationRequest(BaseModel):
    source_path: str = Field(min_length=1, max_length=500)
    target_path: str = Field(min_length=1, max_length=500)


class UpdateAttachmentOpenAIFileRequest(BaseModel):
    openai_file_id: str | None = None
    openai_status: str = Field(pattern="^(pending|uploaded|failed|skipped)$")
    openai_error: str | None = None
    openai_purpose: str | None = None


class UpdateRunAttachmentRequest(BaseModel):
    included_as: str | None = None
    error: str | None = None


class WorkspaceGrepRequest(BaseModel):
    pattern: str = Field(min_length=1)
    path_glob: str | None = None
    case_sensitive: bool = True
    max_matches: int = Field(default=50, ge=1, le=200)


class WorkspaceRgRequest(BaseModel):
    pattern: str = Field(min_length=1)
    path_glob: str | None = None
    case_sensitive: bool = True
    context_before: int = Field(default=0, ge=0, le=3)
    context_after: int = Field(default=0, ge=0, le=3)
    max_matches: int = Field(default=50, ge=1, le=200)
    max_line_chars: int = Field(default=240, ge=40, le=1000)
    cursor: str | None = None


class WorkspaceSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    path_glob: str | None = None
    max_results: int = Field(default=50, ge=1, le=200)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "database": str(settings.sqlite_path),
        "oss": {
            "provider": "aliyun",
            "endpoint": settings.oss_endpoint,
            "bucket": settings.oss_bucket_name,
            "key_prefix": settings.oss_key_prefix,
            "configured": settings.oss_configured,
        },
        "worker": {
            "runtime": "openai-agents-js",
            "model": settings.openai_model,
            "sandbox_root": str(settings.worker_sandbox_root_path),
            "reasoning_effort": settings.openai_reasoning_effort,
            "reasoning_summary": settings.openai_reasoning_summary,
            "text_verbosity": settings.openai_text_verbosity,
            "service_tier": settings.openai_service_tier,
            "openai_configured": settings.openai_configured,
            "run_settings": {
                "speed_modes": list(SERVICE_TIER_BY_SPEED_MODE.keys()),
                "reasoning_efforts": ["low", "medium", "high", "xhigh"],
            },
            "usage": model_catalog_payload(settings),
        },
        "codex_relay": {
            "enabled": settings.codex_relay_enabled,
            "configured": settings.codex_relay_configured,
            "auth_file_exists": settings.codex_relay_auth_path.exists(),
            "model": settings.codex_relay_model,
            "upstream_base_url": settings.codex_relay_upstream_base_url,
        },
    }


@app.post("/codex-relay/v1/responses")
async def codex_relay_responses(
    request: Request,
    authorization: str | None = Header(default=None),
    app_settings: Settings = Depends(get_settings),
):
    require_codex_relay_token(authorization, app_settings)
    try:
        return await get_codex_relay().responses(request)
    except CodexCredentialError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/register")
def register(body: RegisterRequest) -> dict:
    account = normalize_account(body.account)
    display_name = (body.name or account).strip() or account
    if store.get_user_by_account(account):
        raise HTTPException(status_code=400, detail="Account already exists")
    try:
        user = store.create_user_account(
            account=account,
            name=display_name,
            password_hash=password_hash(body.password),
        )
        workspace = ensure_user_workspace(user)
        token = issue_session(user["id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"token": token, "user": public_user(user), "workspace": workspace}


@app.post("/api/auth/login")
def login(body: AuthRequest) -> dict:
    account = normalize_account(body.account)
    user = store.get_user_by_account(account)
    if not user or not verify_password(body.password, user.get("password_hash")):
        raise HTTPException(status_code=401, detail="Invalid account or password")
    try:
        workspace = ensure_user_workspace(user)
        token = issue_session(user["id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"token": token, "user": public_user(user), "workspace": workspace}


@app.get("/api/auth/me")
def auth_me(current_user: dict = Depends(get_current_user)) -> dict:
    workspace = ensure_user_workspace(current_user)
    return {"user": public_user(current_user), "workspace": workspace}


@app.get("/api/models/catalog")
def get_model_catalog(current_user: dict = Depends(get_current_user)) -> dict:
    _ = current_user
    return model_catalog_payload(settings)


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict:
    store.delete_auth_session(auth_token_hash_from_request(authorization))
    return {"ok": True}


@app.post("/api/users")
def upsert_user(body: CreateUserRequest) -> dict:
    return public_user(store.upsert_user(user_id=body.id, name=body.name))


@app.get("/api/users/{user_id}")
def get_user(user_id: str) -> dict:
    user = store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return public_user(user)


@app.post("/api/workspaces")
def create_workspace(body: CreateWorkspaceRequest, current_user: dict = Depends(get_current_user)) -> dict:
    workspace_id = body.id or f"workspace_{uuid.uuid4().hex}"
    try:
        return store.create_workspace(user_id=current_user["id"], workspace_id=workspace_id, name=body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/workspaces")
def list_workspaces(current_user: dict = Depends(get_current_user)) -> dict:
    ensure_user_workspace(current_user)
    return {"workspaces": store.list_workspaces(user_id=current_user["id"])}


@app.get("/api/workspaces/{workspace_id}")
def get_workspace(workspace_id: str, current_user: dict = Depends(get_current_user)) -> dict:
    return require_workspace_owner(workspace_id, current_user)


@app.get("/api/workspaces/{workspace_id}/files")
def list_workspace_files(
    workspace_id: str,
    version_id: str | None = None,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    try:
        return {
            "files": store.list_workspace_files(workspace_id=workspace_id, version_id=version_id),
            "folders": store.list_workspace_folders(workspace_id=workspace_id, version_id=version_id),
        }
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/workspaces/{workspace_id}/file-ops")
def list_workspace_file_ops(
    workspace_id: str,
    version_id: str | None = None,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    try:
        return {"ops": store.list_file_ops(workspace_id=workspace_id, version_id=version_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workspaces/{workspace_id}/folders")
def create_workspace_folder(
    workspace_id: str,
    body: CreateWorkspaceFolderRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    path = normalize_workspace_path(body.path)
    try:
        return {"folder": store.create_workspace_folder(workspace_id=workspace_id, path=path)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workspaces/{workspace_id}/upload")
async def upload_workspace_files(
    workspace_id: str,
    target_path: str = Form(default=""),
    files: list[UploadFile] = File(...),
    current_user: dict = Depends(get_current_user),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")
    target_folder = normalize_optional_workspace_folder(target_path)
    uploaded = []
    for file in files:
        uploaded.append(
            await store_workspace_upload(
                workspace_id=workspace_id,
                target_folder=target_folder,
                file=file,
                object_store=object_store,
            )
        )
    return {"files": uploaded}


@app.post("/api/workspaces/{workspace_id}/copy")
def copy_workspace_entry(
    workspace_id: str,
    body: WorkspaceEntryOperationRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    source_path = normalize_workspace_path(body.source_path)
    target_path = normalize_workspace_path(body.target_path)
    try:
        return store.copy_workspace_entry(
            workspace_id=workspace_id,
            source_path=source_path,
            target_path=target_path,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workspaces/{workspace_id}/move")
def move_workspace_entry(
    workspace_id: str,
    body: WorkspaceEntryOperationRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    source_path = normalize_workspace_path(body.source_path)
    target_path = normalize_workspace_path(body.target_path)
    try:
        return store.move_workspace_entry(
            workspace_id=workspace_id,
            source_path=source_path,
            target_path=target_path,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/attachments")
async def upload_attachments(
    workspace_id: str | None = Query(default=None),
    files: list[UploadFile] = File(...),
    current_user: dict = Depends(get_current_user),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")
    if len(files) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(status_code=400, detail=f"At most {MAX_ATTACHMENTS_PER_MESSAGE} files can be uploaded")

    workspace = ensure_user_workspace(current_user)
    target_workspace_id = workspace_id or workspace["id"]
    require_workspace_owner(target_workspace_id, current_user)

    attachments = []
    for file in files:
        attachments.append(
            await store_uploaded_attachment(
                file=file,
                user=current_user,
                workspace_id=target_workspace_id,
                object_store=object_store,
            )
        )
    return {"attachments": [public_attachment(item) for item in attachments]}


@app.get("/api/attachments/{attachment_id}/content")
def read_attachment_content(
    attachment_id: str,
    current_user: dict = Depends(get_current_user),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> Response:
    attachment = require_attachment_owner(attachment_id, current_user)
    try:
        data = object_store.read_bytes(attachment["oss_blob_key"])
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Attachment blob is missing from Aliyun OSS") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type=attachment["content_type"] or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{attachment["safe_name"]}"',
            "Cache-Control": "private, max-age=3600",
        },
    )


@app.get("/internal/workspaces/{workspace_id}/files")
def worker_list_workspace_files(
    workspace_id: str,
    version_id: str | None = None,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        files = store.list_workspace_files(workspace_id=workspace_id, version_id=version_id)
        folders = store.list_workspace_folders(workspace_id=workspace_id, version_id=version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"workspace_id": workspace_id, "files": files, "folders": folders}


@app.get("/internal/workspaces/{workspace_id}/files/{file_path:path}")
def worker_read_workspace_file(
    workspace_id: str,
    file_path: str,
    version_id: str | None = None,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    return read_workspace_file_content(
        workspace_id=workspace_id,
        file_path=file_path,
        version_id=version_id,
        object_store=object_store,
    )


@app.get("/internal/workspaces/{workspace_id}/file-bytes/{file_path:path}")
def worker_read_workspace_file_bytes(
    workspace_id: str,
    file_path: str,
    version_id: str | None = None,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    return read_workspace_file_bytes(
        workspace_id=workspace_id,
        file_path=file_path,
        version_id=version_id,
        object_store=object_store,
    )


@app.put("/internal/workspaces/{workspace_id}/files/{file_path:path}")
def worker_write_workspace_file(
    workspace_id: str,
    file_path: str,
    body: WriteWorkspaceFileRequest,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    return write_workspace_file_content(
        workspace_id=workspace_id,
        file_path=file_path,
        body=body,
        object_store=object_store,
    )


@app.put("/internal/workspaces/{workspace_id}/file-bytes/{file_path:path}")
def worker_write_workspace_file_bytes(
    workspace_id: str,
    file_path: str,
    body: WriteWorkspaceFileBytesRequest,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    return write_workspace_file_bytes(
        workspace_id=workspace_id,
        file_path=file_path,
        body=body,
        object_store=object_store,
    )


@app.post("/internal/workspaces/{workspace_id}/grep")
def worker_grep_workspace(
    workspace_id: str,
    body: WorkspaceGrepRequest,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    try:
        pattern = re.compile(body.pattern, 0 if body.case_sensitive else re.IGNORECASE)
    except re.error as exc:
        raise HTTPException(status_code=400, detail=f"Invalid grep pattern: {exc}") from exc

    matches = []
    for file_record, content in iter_workspace_text_files(workspace_id, body.path_glob, object_store):
        for line_number, line in enumerate(content.splitlines(), start=1):
            match = pattern.search(line)
            if not match:
                continue
            matches.append(
                {
                    "path": file_record["path"],
                    "line": line_number,
                    "text": line,
                    "match": match.group(0),
                    "blob_sha256": file_record["blob_sha256"],
                }
            )
            if len(matches) >= body.max_matches:
                return {"workspace_id": workspace_id, "matches": matches, "truncated": True}

    return {"workspace_id": workspace_id, "matches": matches, "truncated": False}


@app.post("/internal/workspaces/{workspace_id}/rg")
def worker_rg_workspace(
    workspace_id: str,
    body: WorkspaceRgRequest,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    try:
        pattern = re.compile(body.pattern, 0 if body.case_sensitive else re.IGNORECASE)
    except re.error as exc:
        raise HTTPException(status_code=400, detail=f"Invalid rg pattern: {exc}") from exc

    all_matches = []
    for file_record, content in iter_workspace_text_files(workspace_id, body.path_glob, object_store):
        lines = content.splitlines()
        for line_index, line in enumerate(lines):
            match = pattern.search(line)
            if not match:
                continue
            before_start = max(0, line_index - body.context_before)
            after_end = min(len(lines), line_index + body.context_after + 1)
            all_matches.append(
                {
                    "path": file_record["path"],
                    "line": line_index + 1,
                    "text": truncate_text(line, body.max_line_chars),
                    "before": [
                        truncate_text(item, body.max_line_chars)
                        for item in lines[before_start:line_index]
                    ] or None,
                    "after": [
                        truncate_text(item, body.max_line_chars)
                        for item in lines[line_index + 1 : after_end]
                    ] or None,
                }
            )

    start = decode_int_cursor(body.cursor)
    matches = []
    total_chars = 0
    max_response_chars = 32 * 1024
    for item in all_matches[start:]:
        item_chars = len(json.dumps(item, ensure_ascii=False))
        if len(matches) >= body.max_matches or (matches and total_chars + item_chars > max_response_chars):
            break
        matches.append({key: value for key, value in item.items() if value is not None})
        total_chars += item_chars

    next_index = start + len(matches)
    truncated = next_index < len(all_matches)
    return {
        "ok": True,
        "workspace_id": workspace_id,
        "matches": matches,
        "next_cursor": encode_int_cursor(next_index) if truncated else None,
        "truncated": truncated,
    }


@app.post("/internal/workspaces/{workspace_id}/search")
def worker_search_workspace(
    workspace_id: str,
    body: WorkspaceSearchRequest,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    needle = body.query.casefold()
    results = []
    for file_record, content in iter_workspace_text_files(workspace_id, body.path_glob, object_store):
        path = file_record["path"]
        path_hit = needle in path.casefold()
        content_index = content.casefold().find(needle)
        if not path_hit and content_index < 0:
            continue

        results.append(
            {
                "path": path,
                "reason": "path" if path_hit else "content",
                "snippet": snippet_around(content, content_index) if content_index >= 0 else "",
                "blob_sha256": file_record["blob_sha256"],
            }
        )
        if len(results) >= body.max_results:
            return {"workspace_id": workspace_id, "results": results, "truncated": True}

    return {"workspace_id": workspace_id, "results": results, "truncated": False}


@app.get("/api/workspaces/{workspace_id}/files/{file_path:path}")
def read_workspace_file(
    workspace_id: str,
    file_path: str,
    version_id: str | None = None,
    current_user: dict = Depends(get_current_user),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    return read_workspace_file_content(
        workspace_id=workspace_id,
        file_path=file_path,
        version_id=version_id,
        object_store=object_store,
    )


def read_workspace_file_content(
    workspace_id: str,
    file_path: str,
    version_id: str | None,
    object_store: AliyunObjectStore,
) -> dict:
    path = normalize_workspace_path(file_path)
    try:
        file_record = store.get_workspace_file(workspace_id=workspace_id, path=path, version_id=version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        content = object_store.read_text(file_record["blob_key"])
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Blob is missing from Aliyun OSS") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"file": file_record, "content": content}


def read_workspace_file_bytes(
    workspace_id: str,
    file_path: str,
    version_id: str | None,
    object_store: AliyunObjectStore,
) -> dict:
    path = normalize_workspace_path(file_path)
    try:
        file_record = store.get_workspace_file(workspace_id=workspace_id, path=path, version_id=version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        data = object_store.read_bytes(file_record["blob_key"])
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Blob is missing from Aliyun OSS") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "file": file_record,
        "content_base64": base64.b64encode(data).decode("ascii"),
    }


@app.put("/api/workspaces/{workspace_id}/files/{file_path:path}")
def write_workspace_file(
    workspace_id: str,
    file_path: str,
    body: WriteWorkspaceFileRequest,
    current_user: dict = Depends(get_current_user),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    require_workspace_owner(workspace_id, current_user)
    return write_workspace_file_content(
        workspace_id=workspace_id,
        file_path=file_path,
        body=body,
        object_store=object_store,
    )


def write_workspace_file_content(
    workspace_id: str,
    file_path: str,
    body: WriteWorkspaceFileRequest,
    object_store: AliyunObjectStore,
) -> dict:
    path = normalize_workspace_path(file_path)
    if not store.get_workspace(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    blob = object_store.put_text(body.content, content_type=body.content_type)
    try:
        file_record = store.write_workspace_file(
            workspace_id=workspace_id,
            path=path,
            blob_key=blob["key"],
            blob_sha256=blob["sha256"],
            size=blob["size"],
            content_type=body.content_type,
            message=body.message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"file": file_record, "blob": blob}


def write_workspace_file_bytes(
    workspace_id: str,
    file_path: str,
    body: WriteWorkspaceFileBytesRequest,
    object_store: AliyunObjectStore,
) -> dict:
    path = normalize_workspace_path(file_path)
    if not store.get_workspace(workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 content") from exc
    blob = object_store.put_bytes(data, content_type=body.content_type)
    try:
        file_record = store.write_workspace_file(
            workspace_id=workspace_id,
            path=path,
            blob_key=blob["key"],
            blob_sha256=blob["sha256"],
            size=blob["size"],
            content_type=body.content_type,
            message=body.message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"file": file_record, "blob": blob}


async def store_workspace_upload(
    *,
    workspace_id: str,
    target_folder: str,
    file: UploadFile,
    object_store: AliyunObjectStore,
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {file.filename or 'unnamed'}")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail=f"Uploaded file is too large: {file.filename or 'unnamed'}")

    safe_name = safe_filename(file.filename or "upload")
    content_type = detect_content_type(data, safe_name, file.content_type)
    workspace_path = f"{target_folder}/{safe_name}" if target_folder else safe_name
    blob = object_store.put_bytes(data, content_type=content_type)
    try:
        return store.write_workspace_file(
            workspace_id=workspace_id,
            path=workspace_path,
            blob_key=blob["key"],
            blob_sha256=blob["sha256"],
            size=blob["size"],
            content_type=content_type,
            message=f"upload file {workspace_path}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/conversations", response_model=CreateConversationResponse)
def create_conversation(
    body: CreateConversationRequest,
    current_user: dict = Depends(get_current_user),
) -> CreateConversationResponse:
    conversation_id = f"conv_{uuid.uuid4().hex}"
    workspace = ensure_user_workspace(current_user)
    workspace_id = body.workspace_id or workspace["id"]
    require_workspace_owner(workspace_id, current_user)
    try:
        store.create_conversation(
            conversation_id=conversation_id,
            user_id=current_user["id"],
            workspace_id=workspace_id,
            title=body.title,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CreateConversationResponse(conversation_id=conversation_id)


@app.get("/api/conversations")
def list_conversations(
    workspace_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
) -> dict:
    if workspace_id:
        require_workspace_owner(workspace_id, current_user)
    return {
        "conversations": store.list_conversations(
            user_id=current_user["id"],
            workspace_id=workspace_id,
            limit=limit,
        )
    }


@app.get("/api/conversations/{conversation_id}/messages")
def list_conversation_messages(
    conversation_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    require_conversation_owner(conversation_id, current_user)
    return {"messages": store.list_messages(conversation_id)}


@app.post("/api/conversations/{conversation_id}/runs", response_model=CreateRunResponse)
async def create_run(
    conversation_id: str,
    body: CreateRunRequest,
    current_user: dict = Depends(get_current_user),
) -> CreateRunResponse:
    conversation = require_conversation_owner(conversation_id, current_user)
    message_text = body.message.strip()
    attachment_ids = unique_attachment_ids(body.attachment_ids)
    if not message_text and not attachment_ids:
        raise HTTPException(status_code=400, detail="Message or attachments are required")
    if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(status_code=400, detail=f"At most {MAX_ATTACHMENTS_PER_MESSAGE} attachments can be sent")
    attachments = require_run_attachments(
        attachment_ids=attachment_ids,
        user=current_user,
        workspace_id=conversation["workspace_id"],
    )
    input_payload = {
        "text": message_text,
        "attachments": [public_attachment(attachment) for attachment in attachments],
    }
    run_settings = resolve_run_settings(body, settings)
    run_id = f"run_{uuid.uuid4().hex}"
    previous_messages = store.list_messages(conversation_id)
    try:
        seeded_session_item_count = store.ensure_agent_session_seeded_from_messages(conversation_id, previous_messages)
        store.create_run(
            run_id=run_id,
            conversation_id=conversation_id,
            user_message=message_text,
            input_payload=input_payload,
            attachments=input_payload["attachments"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    store.append_event(
        run_id,
        {
            "type": "run.queued",
            "payload": {
                "conversationId": conversation_id,
                "workspaceId": conversation["workspace_id"],
                "historyMessageCount": len(previous_messages) + 1,
                "sessionSeedItemCount": seeded_session_item_count,
                "attachmentCount": len(attachments),
                **run_settings.model_dump(),
            },
        },
    )
    asyncio.create_task(
        start_node_worker(
            run_id=run_id,
            conversation_id=conversation_id,
            workspace_id=conversation["workspace_id"],
            run_settings=run_settings,
        )
    )
    return CreateRunResponse(
        run_id=run_id,
        events_url=f"/api/runs/{run_id}/events",
        settings=run_settings,
    )


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, current_user: dict = Depends(get_current_user)) -> dict:
    run, _conversation = require_run_owner(run_id, current_user)
    return run


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str, current_user: dict = Depends(get_current_user)) -> dict:
    run, _conversation = require_run_owner(run_id, current_user)
    if run["status"] in TERMINAL_RUN_STATUSES:
        return {"ok": True, "status": run["status"]}

    store.set_run_status(run_id, "cancelled")
    store.append_event(
        run_id,
        {
            "type": "run.cancelled",
            "visibility": "user",
            "status": "cancelled",
            "payload": {"reason": "user_cancelled"},
        },
    )
    terminated = terminate_worker_process(run_id)
    return {"ok": True, "status": "cancelled", "terminated": terminated}


@app.get("/api/runs/{run_id}/usage")
def get_run_usage(run_id: str, current_user: dict = Depends(get_current_user)) -> dict:
    require_run_owner(run_id, current_user)
    return store.get_run_usage_summary(run_id)


@app.get("/api/runs/{run_id}/events")
async def stream_run_events(
    request: Request,
    run_id: str,
    after: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
) -> StreamingResponse:
    require_run_owner(run_id, current_user)
    return StreamingResponse(
        event_stream(request, run_id=run_id, after=after),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/internal/runs/{run_id}/events")
def append_worker_event(
    run_id: str,
    body: WorkerEventRequest,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] in TERMINAL_RUN_STATUSES:
        return {"ok": True, "ignored": True, "status": run["status"]}

    event_body = body.model_dump(exclude_none=True)
    if body.type == "model.usage":
        context = store.get_context_snapshot(run_id, body.payload.get("callId"))
        event_body["payload"] = enrich_usage_payload(usage_payload_with_context(body.payload, context), settings)

    event = store.append_event(run_id, event_body)

    if body.type == "context.estimated":
        store.record_context_estimate(run_id, event_body["payload"])

    if body.type == "model.usage":
        store.record_model_usage(run_id, event_body["payload"], visibility=body.visibility)

    if body.type == "assistant.message.done":
        run = store.get_run(run_id)
        text = str(body.payload.get("text") or "")
        if run and text:
            store.append_message(run["conversation_id"], "assistant", text, run_id=run_id)

    if body.type == "run.completed":
        store.set_run_status(run_id, "completed")
    elif body.type == "run.failed":
        store.set_run_status(run_id, "failed")
    elif body.type == "run.started":
        store.set_run_status(run_id, "running")

    return {"ok": True, "event": event}


@app.get("/internal/runs/{run_id}/input")
def get_worker_run_input(
    run_id: str,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    data = store.get_run_input(run_id)
    if not data:
        raise HTTPException(status_code=404, detail="Run not found")
    return data


@app.patch("/internal/runs/{run_id}/attachments/{attachment_id}")
def update_worker_run_attachment(
    run_id: str,
    attachment_id: str,
    body: UpdateRunAttachmentRequest,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    if not store.get_run(run_id):
        raise HTTPException(status_code=404, detail="Run not found")
    if not store.get_attachment(attachment_id):
        raise HTTPException(status_code=404, detail="Attachment not found")
    store.set_run_attachment_result(
        run_id=run_id,
        attachment_id=attachment_id,
        included_as=body.included_as,
        error=body.error,
    )
    return {"ok": True}


@app.get("/internal/attachments/{attachment_id}")
def get_worker_attachment(
    attachment_id: str,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    attachment = store.get_attachment(attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return {"attachment": public_attachment(attachment, include_internal=True)}


@app.get("/internal/attachments/{attachment_id}/bytes")
def read_worker_attachment_bytes(
    attachment_id: str,
    _authorized: None = Depends(require_worker_token),
    object_store: AliyunObjectStore = Depends(require_object_store),
) -> dict:
    attachment = store.get_attachment(attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    try:
        data = object_store.read_bytes(attachment["oss_blob_key"])
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Attachment blob is missing from Aliyun OSS") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "attachment": public_attachment(attachment, include_internal=True),
        "content_base64": base64.b64encode(data).decode("ascii"),
    }


@app.patch("/internal/attachments/{attachment_id}/openai-file")
def update_worker_attachment_openai_file(
    attachment_id: str,
    body: UpdateAttachmentOpenAIFileRequest,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    attachment = store.update_attachment_openai_file(
        attachment_id=attachment_id,
        openai_file_id=body.openai_file_id,
        openai_status=body.openai_status,
        openai_error=body.openai_error,
        openai_purpose=body.openai_purpose,
    )
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return {"attachment": public_attachment(attachment, include_internal=True)}


@app.get("/internal/conversations/{conversation_id}/agent-session/items")
def list_agent_session_items(
    conversation_id: str,
    limit: int | None = Query(default=None, ge=1, le=5000),
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        items = store.list_agent_session_items(conversation_id, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"sessionId": conversation_id, "items": items}


@app.post("/internal/conversations/{conversation_id}/agent-session/items")
def append_agent_session_items(
    conversation_id: str,
    body: AgentSessionItemsRequest,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        count = store.append_agent_session_items(conversation_id, body.items)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "count": count}


@app.post("/internal/conversations/{conversation_id}/agent-session/pop")
def pop_agent_session_item(
    conversation_id: str,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        item = store.pop_agent_session_item(conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"item": item}


@app.delete("/internal/conversations/{conversation_id}/agent-session")
def clear_agent_session_items(
    conversation_id: str,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        count = store.clear_agent_session_items(conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "count": count}


async def event_stream(request: Request, run_id: str, after: int) -> AsyncIterator[str]:
    cursor = after
    while True:
        events = store.list_events(run_id=run_id, after=cursor, limit=100)
        for event in events:
            cursor = int(event["seq"])
            yield sse(event)
            if event["type"] in {"run.completed", "run.failed", "run.cancelled"}:
                return

        if await request.is_disconnected():
            return

        yield ": heartbeat\n\n"
        await asyncio.sleep(0.5)


def sse(event: dict) -> str:
    return "\n".join(
        [
            f"id: {event['seq']}",
            f"event: {event['type']}",
            f"data: {json.dumps(event, ensure_ascii=True)}",
            "",
            "",
        ]
    )


def resolve_run_settings(body: CreateRunRequest, app_settings: Settings) -> RunExecutionSettings:
    model = (body.model or default_worker_model(app_settings)).strip()
    if not MODEL_ID_PATTERN.fullmatch(model):
        raise HTTPException(
            status_code=400,
            detail="Model must contain only letters, numbers, '.', '_', ':' or '-' and be at most 80 characters",
        )
    if normalize_model_key(model) not in SUPPORTED_MODELS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported model. Supported models: gpt-5.4, gpt-5.5",
        )

    reasoning_effort = body.reasoning_effort or cast_reasoning_effort(app_settings.openai_reasoning_effort)
    reasoning_summary = app_settings.openai_reasoning_summary
    service_tier = SERVICE_TIER_BY_SPEED_MODE[body.speed_mode]
    return RunExecutionSettings(
        model=model,
        reasoning_effort=reasoning_effort,
        reasoning_summary=reasoning_summary,
        text_verbosity=app_settings.openai_text_verbosity,
        speed_mode=body.speed_mode,
        service_tier=service_tier,
    )


def default_worker_model(app_settings: Settings) -> str:
    if not app_settings.openai_configured and app_settings.codex_relay_configured and app_settings.codex_relay_model:
        return app_settings.codex_relay_model
    return app_settings.openai_model


def cast_reasoning_effort(value: str) -> ReasoningEffort:
    if value in {"low", "medium", "high", "xhigh"}:
        return value  # type: ignore[return-value]
    return "medium"


async def store_uploaded_attachment(
    *,
    file: UploadFile,
    user: dict,
    workspace_id: str,
    object_store: AliyunObjectStore,
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {file.filename or 'unnamed'}")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail=f"Uploaded file is too large: {file.filename or 'unnamed'}")

    original_name = file.filename or "attachment"
    safe_name = safe_filename(original_name)
    content_type = detect_content_type(data, original_name, file.content_type)
    model_kind = attachment_model_kind(content_type, safe_name)
    image_detail = "original" if model_kind == "image" else None
    openai_purpose = "vision" if model_kind == "image" else "user_data"

    blob = object_store.put_bytes(data, content_type=content_type)
    attachment_id = f"att_{uuid.uuid4().hex}"
    workspace_path = attachment_workspace_path(attachment_id, safe_name)
    try:
        store.write_workspace_file(
            workspace_id=workspace_id,
            path=workspace_path,
            blob_key=blob["key"],
            blob_sha256=blob["sha256"],
            size=blob["size"],
            content_type=content_type,
            message=f"upload attachment {safe_name}",
        )
        return store.create_attachment(
            attachment_id=attachment_id,
            user_id=user["id"],
            workspace_id=workspace_id,
            original_name=original_name,
            safe_name=safe_name,
            content_type=content_type,
            size=blob["size"],
            sha256=blob["sha256"],
            oss_blob_key=blob["key"],
            workspace_path=workspace_path,
            model_kind=model_kind,
            image_detail=image_detail,
            openai_purpose=openai_purpose,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def safe_filename(filename: str) -> str:
    name = filename.replace("\\", "/").rsplit("/", 1)[-1].strip().strip(".")
    if not name:
        name = "attachment"
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
    safe = re.sub(r"\s+", " ", safe).strip()
    if not safe or safe in {".", ".."}:
        safe = "attachment"
    if len(safe) > 120:
        stem, dot, suffix = safe.rpartition(".")
        if dot and len(suffix) <= 16:
            safe = f"{stem[: max(1, 119 - len(suffix))]}.{suffix}"
        else:
            safe = safe[:120]
    return safe


def attachment_workspace_path(attachment_id: str, safe_name: str) -> str:
    date_part = datetime.now(UTC).strftime("%Y%m%d")
    return f"attachments/{date_part}/{attachment_id}-{safe_name}"


def detect_content_type(data: bytes, filename: str, provided: str | None) -> str:
    guessed, _encoding = mimetypes.guess_type(filename)
    if guessed and guessed != "application/zip":
        return guessed
    sniffed = sniff_content_type(data)
    if sniffed:
        return sniffed
    if guessed:
        return guessed
    provided_type = (provided or "").split(";", 1)[0].strip().lower()
    if provided_type and provided_type != "application/octet-stream":
        return provided_type
    return "application/octet-stream"


def sniff_content_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"PK\x03\x04"):
        guessed, _encoding = mimetypes.guess_type("")
        return guessed or "application/zip"
    return None


def attachment_model_kind(content_type: str, filename: str) -> str:
    normalized = content_type.split(";", 1)[0].lower()
    if normalized in IMAGE_CONTENT_TYPES:
        return "image"
    if normalized.startswith("text/"):
        return "file"
    if normalized in {
        "application/pdf",
        "application/json",
        "application/xml",
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return "file"
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json", ".xml", ".html", ".css", ".js", ".ts", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".sql", ".yaml", ".yml", ".pdf", ".docx", ".xlsx", ".pptx"}:
        return "file"
    return "file"


def public_attachment(attachment: dict, include_internal: bool = False) -> dict:
    result = {
        "id": attachment["id"],
        "filename": attachment["original_name"],
        "safe_name": attachment["safe_name"],
        "content_type": attachment["content_type"],
        "size": attachment["size"],
        "sha256": attachment["sha256"],
        "workspace_path": attachment["workspace_path"],
        "model_kind": attachment["model_kind"],
        "image_detail": attachment.get("image_detail"),
        "openai_file_id": attachment.get("openai_file_id"),
        "openai_purpose": attachment.get("openai_purpose"),
        "openai_status": attachment.get("openai_status"),
        "openai_error": attachment.get("openai_error"),
        "created_at": attachment.get("created_at"),
    }
    if include_internal:
        result["oss_blob_key"] = attachment.get("oss_blob_key")
        result["user_id"] = attachment.get("user_id")
        result["workspace_id"] = attachment.get("workspace_id")
    return result


async def start_node_worker(
    run_id: str,
    conversation_id: str,
    workspace_id: str,
    run_settings: RunExecutionSettings,
) -> None:
    run = store.get_run(run_id)
    if not run or run["status"] in TERMINAL_RUN_STATUSES:
        return
    store.set_run_status(run_id, "running")
    worker_entry = settings.worker_entry_path
    sandbox_dir = settings.worker_sandbox_root_path / run_id
    run_dir = settings.worker_runs_root_path / run_id
    run_workspace_dir = run_dir / "workspace"
    run_artifacts_dir = run_dir / "artifacts"
    sandbox_dir.mkdir(parents=True, exist_ok=True)
    run_workspace_dir.mkdir(parents=True, exist_ok=True)
    run_artifacts_dir.mkdir(parents=True, exist_ok=True)
    if not worker_entry.exists():
        store.append_event(
            run_id,
            {
                "type": "run.failed",
                "visibility": "user",
                "payload": {"error": f"Node worker not found: {worker_entry}"},
            },
        )
        store.set_run_status(run_id, "failed")
        return

    env = os.environ.copy()
    env.update(
        {
            "API_BASE_URL": settings.api_base_url,
            "WORKER_TOKEN": settings.worker_token,
            "RUN_ID": run_id,
            "CONVERSATION_ID": conversation_id,
            "WORKSPACE_ID": workspace_id,
            "SANDBOX_DIR": str(sandbox_dir),
            "RUN_WORKSPACE_DIR": str(run_workspace_dir),
            "RUN_ARTIFACTS_DIR": str(run_artifacts_dir),
            "WORKER_RUNTIME": settings.worker_runtime,
            "WORKER_DOCKER_IMAGE": settings.worker_docker_image,
            "WORKER_DOCKER_AUTO_BUILD": str(settings.worker_docker_auto_build).lower(),
            "WORKER_DOCKER_NETWORK": settings.worker_docker_network,
            "WORKER_DOCKER_CPUS": settings.worker_docker_cpus,
            "WORKER_DOCKER_MEMORY": settings.worker_docker_memory,
            "WORKER_DOCKER_PIDS_LIMIT": settings.worker_docker_pids_limit,
            "WORKER_KEEP_CONTAINER": str(settings.worker_keep_container).lower(),
            "OPENAI_MODEL": run_settings.model,
            "OPENAI_REASONING_EFFORT": run_settings.reasoning_effort,
            "OPENAI_REASONING_SUMMARY": run_settings.reasoning_summary,
            "OPENAI_TEXT_VERBOSITY": run_settings.text_verbosity,
            "OPENAI_SERVICE_TIER": run_settings.service_tier,
            "OPENAI_SPEED_MODE": run_settings.speed_mode,
            "OPENAI_MODEL_PROVIDER": "openai",
            "OPENAI_AGENTS_DISABLE_TRACING": "1",
        }
    )
    if settings.openai_configured:
        env["OPENAI_API_KEY"] = settings.openai_api_key
        if settings.openai_base_url:
            env["OPENAI_BASE_URL"] = settings.openai_base_url
            env["OPENAI_MODEL_PROVIDER"] = "openai-compatible"
    elif settings.codex_relay_configured:
        env["OPENAI_API_KEY"] = settings.codex_relay_api_key
        env["OPENAI_BASE_URL"] = f"{settings.api_base_url.rstrip('/')}/codex-relay/v1"
        env["OPENAI_MODEL_PROVIDER"] = "codex-relay"

    node_executable = shutil.which("node")
    if not node_executable:
        store.append_event(
            run_id,
            {
                "type": "run.failed",
                "visibility": "user",
                "payload": {"error": "Node.js executable was not found in PATH"},
            },
        )
        store.set_run_status(run_id, "failed")
        return

    run = store.get_run(run_id)
    if not run or run["status"] in TERMINAL_RUN_STATUSES:
        return

    try:
        code = await asyncio.to_thread(
            run_worker_process,
            run_id=run_id,
            node_executable=node_executable,
            worker_entry=worker_entry,
            env=env,
        )
    except Exception as exc:
        store.append_event(
            run_id,
            {
                "type": "run.failed",
                "visibility": "user",
                "payload": {"error": f"Node worker failed to start: {exc}"},
            },
        )
        store.set_run_status(run_id, "failed")
        return

    run = store.get_run(run_id)
    if run and run["status"] == "cancelled":
        return

    if code != 0:
        store.append_event(
            run_id,
            {
                "type": "run.failed",
                "visibility": "user",
                "payload": {"error": f"Node worker exited with code {code}"},
            },
        )
        store.set_run_status(run_id, "failed")


def run_worker_process(
    *,
    run_id: str,
    node_executable: str,
    worker_entry,
    env: dict[str, str],
) -> int:
    process = subprocess.Popen(
        [node_executable, str(worker_entry)],
        cwd=str(worker_entry.parent),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    register_worker_process(run_id, process)
    try:
        stdout_text, stderr_text = process.communicate()
        for name, text_block in (("stdout", stdout_text), ("stderr", stderr_text)):
            for text in text_block.splitlines()[-80:]:
                text = text.rstrip()
                if text:
                    print(f"[worker:{run_id}:{name}] {text}", file=sys.stderr)
        return process.returncode
    finally:
        unregister_worker_process(run_id, process)


def register_worker_process(run_id: str, process: subprocess.Popen) -> None:
    with run_processes_lock:
        run_processes[run_id] = process


def unregister_worker_process(run_id: str, process: subprocess.Popen) -> None:
    with run_processes_lock:
        if run_processes.get(run_id) is process:
            run_processes.pop(run_id, None)


def terminate_worker_process(run_id: str) -> bool:
    with run_processes_lock:
        process = run_processes.get(run_id)
    if not process or process.poll() is not None:
        return False

    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    return True


def iter_workspace_text_files(
    workspace_id: str,
    path_glob: str | None,
    object_store: AliyunObjectStore,
) -> list[tuple[dict, str]]:
    try:
        files = store.list_workspace_files(workspace_id=workspace_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    matched = []
    for file_record in files:
        path = file_record["path"]
        if path_glob and not fnmatch.fnmatch(path, path_glob):
            continue
        try:
            content = object_store.read_text(file_record["blob_key"])
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail=f"Blob is missing from Aliyun OSS: {path}") from exc
        except UnicodeDecodeError:
            continue
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        matched.append((file_record, content))
    return matched


def snippet_around(content: str, index: int, radius: int = 80) -> str:
    start = max(index - radius, 0)
    end = min(index + radius, len(content))
    snippet = content[start:end].replace("\r", "").replace("\n", " ")
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(content) else ""
    return f"{prefix}{snippet}{suffix}"


def truncate_text(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[:max_chars]}[line truncated]"


def decode_int_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        value = base64.urlsafe_b64decode(cursor.encode("ascii") + b"===").decode("utf-8")
        number = int(value)
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return 0
    return max(number, 0)


def encode_int_cursor(value: int) -> str:
    return base64.urlsafe_b64encode(str(value).encode("utf-8")).decode("ascii").rstrip("=")


def normalize_workspace_path(file_path: str) -> str:
    raw_path = file_path.replace("\\", "/").strip()
    path = PurePosixPath(raw_path)
    if not raw_path or path.is_absolute() or any(part in {"..", ""} for part in path.parts):
        raise HTTPException(status_code=400, detail="Invalid workspace file path")
    normalized = path.as_posix()
    if normalized in {".", ""}:
        raise HTTPException(status_code=400, detail="Invalid workspace file path")
    return normalized


def normalize_optional_workspace_folder(folder_path: str | None) -> str:
    raw_path = (folder_path or "").replace("\\", "/").strip().strip("/")
    if not raw_path:
        return ""
    return normalize_workspace_path(raw_path)
