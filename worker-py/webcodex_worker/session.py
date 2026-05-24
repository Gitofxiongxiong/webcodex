from __future__ import annotations

from typing import Any

from agents.memory.session import SessionABC

from .backend_client import BackendClient


class BackendConversationSession(SessionABC):
    def __init__(self, *, client: BackendClient, conversation_id: str) -> None:
        self.client = client
        self.session_id = conversation_id

    async def get_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        return await self.client.get_session_items(self.session_id, limit)

    async def add_items(self, items: list[dict[str, Any]]) -> None:
        await self.client.add_session_items(self.session_id, items)

    async def pop_item(self) -> dict[str, Any] | None:
        return await self.client.pop_session_item(self.session_id)

    async def clear_session(self) -> None:
        await self.client.clear_session(self.session_id)
