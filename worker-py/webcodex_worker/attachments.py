from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from .backend_client import BackendClient
from .paths import resolve_under, safe_filename

ATTACHMENT_INCLUDED_AS = "sandbox"


async def materialize_attachments(
    *,
    client: BackendClient,
    run_id: str,
    attachments: list[dict[str, Any]],
    workspace_root: Path,
) -> list[dict[str, Any]]:
    prepared = []
    for attachment in attachments:
        attachment_id = str(attachment.get("id") or "").strip()
        if not attachment_id:
            continue
        try:
            data = await client.read_attachment_bytes(attachment_id)
            payload = base64.b64decode(str(data.get("content_base64") or ""), validate=True)
            filename = safe_filename(
                attachment.get("safe_name") or attachment.get("original_name") or attachment.get("filename"),
                fallback=f"{attachment_id}.bin",
            )
            sandbox_path = f"attachments/{attachment_id}/{filename}"
            target = resolve_under(workspace_root, sandbox_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            await client.update_run_attachment(
                run_id=run_id,
                attachment_id=attachment_id,
                included_as=ATTACHMENT_INCLUDED_AS,
            )
            prepared.append({**attachment, "sandbox_path": sandbox_path})
        except Exception as exc:
            await client.update_run_attachment(
                run_id=run_id,
                attachment_id=attachment_id,
                included_as=None,
                error=str(exc),
            )
            raise
    return prepared


def user_text_with_attachment_paths(text: str, attachments: list[dict[str, Any]]) -> str:
    lines = [text.strip() or "Please analyze the uploaded files."]
    if attachments:
        lines.extend(["", "Uploaded files are available in the sandbox workspace:"])
        for attachment in attachments:
            sandbox_path = str(attachment.get("sandbox_path") or "").strip()
            if not sandbox_path:
                continue
            details = ", ".join(
                part
                for part in [
                    str(attachment.get("content_type") or "").strip(),
                    f"{attachment.get('size')} bytes" if attachment.get("size") is not None else "",
                ]
                if part
            )
            lines.append(f"- {sandbox_path} ({details})" if details else f"- {sandbox_path}")
    return "\n".join(lines)
