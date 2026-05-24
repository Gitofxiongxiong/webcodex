from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx


class BackendClient:
    def __init__(self, *, api_base_url: str, worker_token: str, timeout: float = 120.0) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.worker_token = worker_token
        self._client = httpx.AsyncClient(
            base_url=self.api_base_url,
            timeout=timeout,
            headers={"authorization": f"Bearer {worker_token}"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self._client.request(method, path, json=json_body, params=params)
        text = response.text
        try:
            payload = response.json() if text else {}
        except ValueError:
            payload = {"raw": text}
        if response.is_error:
            detail = payload.get("detail", text)
            raise RuntimeError(f"Backend {method} {path} failed: {response.status_code} {detail}")
        return payload

    async def post_event(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self.request_json("POST", f"/internal/runs/{run_id}/events", json_body=body)

    async def get_run_input(self, run_id: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/internal/runs/{run_id}/input")

    async def update_run_attachment(
        self,
        *,
        run_id: str,
        attachment_id: str,
        included_as: str | None,
        error: str | None = None,
    ) -> None:
        await self.request_json(
            "PATCH",
            f"/internal/runs/{run_id}/attachments/{attachment_id}",
            json_body={"included_as": included_as, "error": error},
        )

    async def read_attachment_bytes(self, attachment_id: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/internal/attachments/{attachment_id}/bytes")

    async def list_workspace_files(self, workspace_id: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/internal/workspaces/{workspace_id}/files")

    async def read_workspace_file_bytes(self, workspace_id: str, path: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/internal/workspaces/{workspace_id}/file-bytes/{encode_path(path)}")

    async def write_workspace_file_bytes(
        self,
        *,
        workspace_id: str,
        path: str,
        content_base64: str,
        content_type: str,
        message: str,
    ) -> dict[str, Any]:
        return await self.request_json(
            "PUT",
            f"/internal/workspaces/{workspace_id}/file-bytes/{encode_path(path)}",
            json_body={
                "content_base64": content_base64,
                "content_type": content_type,
                "message": message,
            },
        )

    async def get_session_items(self, conversation_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        params = {"limit": limit} if limit else None
        data = await self.request_json(
            "GET",
            f"/internal/conversations/{conversation_id}/agent-session/items",
            params=params,
        )
        items = data.get("items")
        return items if isinstance(items, list) else []

    async def add_session_items(self, conversation_id: str, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        await self.request_json(
            "POST",
            f"/internal/conversations/{conversation_id}/agent-session/items",
            json_body={"items": items},
        )

    async def pop_session_item(self, conversation_id: str) -> dict[str, Any] | None:
        data = await self.request_json(
            "POST",
            f"/internal/conversations/{conversation_id}/agent-session/pop",
        )
        item = data.get("item")
        return item if isinstance(item, dict) else None

    async def clear_session(self, conversation_id: str) -> None:
        await self.request_json("DELETE", f"/internal/conversations/{conversation_id}/agent-session")


def encode_path(path: str) -> str:
    return "/".join(quote(part, safe="") for part in path.replace("\\", "/").split("/"))
