from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .backend_client import BackendClient
from .workspace_materializer import guess_content_type


@dataclass
class WorkspaceDiff:
    added: list[str]
    modified: list[str]
    deleted: list[str]
    unchanged: list[str]
    artifacts: list[str]

    def as_payload(self) -> dict[str, Any]:
        return {
            "added": self.added,
            "modified": self.modified,
            "deleted": self.deleted,
            "unchanged": self.unchanged,
            "artifacts": self.artifacts,
        }


def create_diff(
    baseline: dict[str, dict[str, Any]],
    current: dict[str, dict[str, Any]],
) -> WorkspaceDiff:
    added: list[str] = []
    modified: list[str] = []
    deleted: list[str] = []
    unchanged: list[str] = []
    artifacts: list[str] = []

    baseline_paths = set(baseline)
    current_paths = set(current)
    for path in sorted(current_paths - baseline_paths):
        if is_attachment(path):
            continue
        if is_artifact(path):
            artifacts.append(path)
        else:
            added.append(path)
    for path in sorted(baseline_paths - current_paths):
        if not is_attachment(path) and not is_artifact(path):
            deleted.append(path)
    for path in sorted(baseline_paths & current_paths):
        if is_attachment(path) or is_artifact(path):
            continue
        if baseline[path].get("sha256") == current[path].get("sha256"):
            unchanged.append(path)
        else:
            modified.append(path)
    return WorkspaceDiff(added=added, modified=modified, deleted=deleted, unchanged=unchanged, artifacts=artifacts)


async def commit_workspace_changes(
    *,
    client: BackendClient,
    workspace_id: str,
    workspace_root: Path,
    diff: WorkspaceDiff,
    run_id: str,
) -> dict[str, Any]:
    committed: list[dict[str, Any]] = []
    artifact_paths = set(diff.artifacts)
    artifact_records: list[dict[str, Any]] = []
    for path in [*diff.added, *diff.modified, *diff.artifacts]:
        payload = (workspace_root / path).read_bytes()
        response = await client.write_workspace_file_bytes(
            workspace_id=workspace_id,
            path=path,
            content_base64=base64.b64encode(payload).decode("ascii"),
            content_type=guess_content_type(path),
            message=f"agent run {run_id} {path}",
        )
        file_record = response.get("file", {"path": path})
        committed.append(file_record)
        if path in artifact_paths:
            artifact_records.append(file_record)
    return {
        "committed": committed,
        "artifacts": artifact_records,
        "deleted": diff.deleted,
        "deleteUnsupported": bool(diff.deleted),
    }


def artifact_payloads(workspace_root: Path, artifact_paths: list[str]) -> list[dict[str, Any]]:
    payloads = []
    for path in artifact_paths:
        full_path = workspace_root / path
        if not full_path.is_file():
            continue
        stat = full_path.stat()
        payloads.append({
            "path": path,
            "size": stat.st_size,
            "content_type": guess_content_type(path),
        })
    return payloads


def is_attachment(path: str) -> bool:
    return path == "attachments" or path.startswith("attachments/")


def is_artifact(path: str) -> bool:
    return path == "outputs" or path.startswith("outputs/")
