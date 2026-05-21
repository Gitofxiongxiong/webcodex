import asyncio
import fnmatch
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import uuid
from collections.abc import AsyncIterator
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
ACCOUNT_PATTERN = re.compile(r"^[A-Za-z0-9._@+-]{3,64}$")
SERVICE_TIER_BY_SPEED_MODE = {
    "standard": "default",
    "fast": "priority",
}


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
    message: str = Field(min_length=1)
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


class WorkspaceGrepRequest(BaseModel):
    pattern: str = Field(min_length=1)
    path_glob: str | None = None
    case_sensitive: bool = True
    max_matches: int = Field(default=50, ge=1, le=200)


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
    workspace_id = body.id or default_workspace_id(current_user["id"])
    try:
        return store.create_workspace(user_id=current_user["id"], workspace_id=workspace_id, name=body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        return {"files": store.list_workspace_files(workspace_id=workspace_id, version_id=version_id)}
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


@app.get("/internal/workspaces/{workspace_id}/files")
def worker_list_workspace_files(
    workspace_id: str,
    version_id: str | None = None,
    _authorized: None = Depends(require_worker_token),
) -> dict:
    try:
        files = store.list_workspace_files(workspace_id=workspace_id, version_id=version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"workspace_id": workspace_id, "files": files}


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
    run_settings = resolve_run_settings(body, settings)
    run_id = f"run_{uuid.uuid4().hex}"
    previous_messages = store.list_messages(conversation_id)
    try:
        seeded_session_item_count = store.ensure_agent_session_seeded_from_messages(conversation_id, previous_messages)
        store.create_run(run_id=run_id, conversation_id=conversation_id, user_message=body.message)
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
                **run_settings.model_dump(),
            },
        },
    )
    asyncio.create_task(
        start_node_worker(
            run_id=run_id,
            conversation_id=conversation_id,
            message=body.message,
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
    if not store.get_run(run_id):
        raise HTTPException(status_code=404, detail="Run not found")

    event = store.append_event(run_id, body.model_dump(exclude_none=True))

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


async def start_node_worker(
    run_id: str,
    conversation_id: str,
    message: str,
    workspace_id: str,
    run_settings: RunExecutionSettings,
) -> None:
    store.set_run_status(run_id, "running")
    worker_entry = settings.worker_entry_path
    sandbox_dir = settings.worker_sandbox_root_path / run_id
    sandbox_dir.mkdir(parents=True, exist_ok=True)
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
            "USER_MESSAGE": message,
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
    stdout_text, stderr_text = process.communicate()
    for name, text_block in (("stdout", stdout_text), ("stderr", stderr_text)):
        for text in text_block.splitlines()[-80:]:
            text = text.rstrip()
            if text:
                print(f"[worker:{run_id}:{name}] {text}", file=sys.stderr)
    return process.returncode


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


def normalize_workspace_path(file_path: str) -> str:
    raw_path = file_path.replace("\\", "/").strip()
    path = PurePosixPath(raw_path)
    if not raw_path or path.is_absolute() or any(part in {"..", ""} for part in path.parts):
        raise HTTPException(status_code=400, detail="Invalid workspace file path")
    normalized = path.as_posix()
    if normalized in {".", ""}:
        raise HTTPException(status_code=400, detail="Invalid workspace file path")
    return normalized
