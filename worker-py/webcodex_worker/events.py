from __future__ import annotations

from typing import Any


def event(
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    visibility: str = "user",
    item_id: str | None = None,
    parent_id: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": event_type,
        "visibility": visibility,
        "payload": payload or {},
    }
    if item_id:
        body["itemId"] = item_id
    if parent_id:
        body["parentId"] = parent_id
    if status:
        body["status"] = status
    return body
