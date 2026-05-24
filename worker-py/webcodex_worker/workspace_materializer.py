from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
from pathlib import Path
from typing import Any

from .backend_client import BackendClient
from .paths import normalize_workspace_path, resolve_under


async def materialize_workspace(
    *,
    client: BackendClient,
    workspace_id: str,
    workspace_root: Path,
) -> dict[str, dict[str, Any]]:
    workspace_root.mkdir(parents=True, exist_ok=True)
    listing = await client.list_workspace_files(workspace_id)
    files = listing.get("files") if isinstance(listing.get("files"), list) else []
    baseline: dict[str, dict[str, Any]] = {}
    for file_record in files:
        path = normalize_workspace_path(str(file_record.get("path") or ""))
        data = await client.read_workspace_file_bytes(workspace_id, path)
        payload = base64.b64decode(str(data.get("content_base64") or ""), validate=True)
        target = resolve_under(workspace_root, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        baseline[path] = file_fingerprint(
            payload,
            content_type=str(file_record.get("content_type") or guess_content_type(path)),
        )
    return baseline


def scan_workspace(workspace_root: Path) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    if not workspace_root.exists():
        return result
    for path in sorted(item for item in workspace_root.rglob("*") if item.is_file()):
        rel = path.relative_to(workspace_root).as_posix()
        result[rel] = file_fingerprint(path.read_bytes(), content_type=guess_content_type(rel))
    return result


def save_baseline(path: Path, baseline: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"files": baseline}, ensure_ascii=False, indent=2), encoding="utf-8")


def file_fingerprint(payload: bytes, *, content_type: str) -> dict[str, Any]:
    return {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size": len(payload),
        "content_type": content_type,
    }


def guess_content_type(path: str) -> str:
    guessed, _encoding = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"
