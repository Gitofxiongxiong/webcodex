import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class DemoStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.RLock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self._lock, self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    current_version_id TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS workspace_versions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    parent_version_id TEXT,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
                );

                CREATE TABLE IF NOT EXISTS workspace_files (
                    workspace_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    blob_key TEXT NOT NULL,
                    blob_sha256 TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    content_type TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY(workspace_id, version_id, path),
                    FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
                    FOREIGN KEY(version_id) REFERENCES workspace_versions(id)
                );

                CREATE TABLE IF NOT EXISTS file_ops (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    op TEXT NOT NULL,
                    path TEXT NOT NULL,
                    old_path TEXT,
                    blob_sha256 TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
                    FOREIGN KEY(version_id) REFERENCES workspace_versions(id)
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    title TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(user_id) REFERENCES users(id),
                    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    run_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
                );

                CREATE TABLE IF NOT EXISTS conversation_agent_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL,
                    item_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
                );

                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    user_message TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
                );

                CREATE TABLE IF NOT EXISTS run_events (
                    run_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    item_id TEXT,
                    parent_id TEXT,
                    status TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY(run_id, seq),
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                );

                CREATE INDEX IF NOT EXISTS idx_workspace_files_current
                    ON workspace_files(workspace_id, version_id, path);

                CREATE INDEX IF NOT EXISTS idx_file_ops_workspace_version
                    ON file_ops(workspace_id, version_id);

                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                    ON messages(conversation_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_conversation_agent_items_conversation
                    ON conversation_agent_items(conversation_id, id);

                CREATE INDEX IF NOT EXISTS idx_run_events_run_seq
                    ON run_events(run_id, seq);
                """
            )

    def upsert_user(self, user_id: str, name: str | None = None) -> dict[str, Any]:
        display_name = name or user_id
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO users(id, name)
                VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name
                """,
                (user_id, display_name),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row)

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

    def ensure_workspace(self, user_id: str, workspace_id: str, name: str | None = None) -> dict[str, Any]:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO users(id, name)
                VALUES (?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (user_id, user_id),
            )
            workspace = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
            if workspace:
                if workspace["user_id"] != user_id:
                    raise ValueError("Workspace belongs to another user")
                return dict(workspace)

            version_id = f"ver_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO workspaces(id, user_id, name, current_version_id)
                VALUES (?, ?, ?, ?)
                """,
                (workspace_id, user_id, name or workspace_id, version_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_versions(id, workspace_id, parent_version_id, message)
                VALUES (?, ?, NULL, 'initial workspace')
                """,
                (version_id, workspace_id),
            )
            row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        return dict(row)

    def create_workspace(self, user_id: str, workspace_id: str, name: str) -> dict[str, Any]:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO users(id, name)
                VALUES (?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (user_id, user_id),
            )
            if conn.execute("SELECT 1 FROM workspaces WHERE id = ?", (workspace_id,)).fetchone():
                raise ValueError("Workspace already exists")

            version_id = f"ver_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO workspaces(id, user_id, name, current_version_id)
                VALUES (?, ?, ?, ?)
                """,
                (workspace_id, user_id, name, version_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_versions(id, workspace_id, parent_version_id, message)
                VALUES (?, ?, NULL, 'initial workspace')
                """,
                (version_id, workspace_id),
            )
            row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        return dict(row)

    def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        return dict(row) if row else None

    def list_workspace_files(self, workspace_id: str, version_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            resolved_version_id = self._resolve_version_id(conn, workspace_id, version_id)
            rows = conn.execute(
                """
                SELECT path, blob_key, blob_sha256, size, content_type, updated_at
                FROM workspace_files
                WHERE workspace_id = ? AND version_id = ? AND deleted = 0
                ORDER BY path
                """,
                (workspace_id, resolved_version_id),
            ).fetchall()
        files = [dict(row) for row in rows]
        for file_record in files:
            file_record["version_id"] = resolved_version_id
        return files

    def get_workspace_file(
        self,
        workspace_id: str,
        path: str,
        version_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self.connect() as conn:
            resolved_version_id = self._resolve_version_id(conn, workspace_id, version_id)
            row = conn.execute(
                """
                SELECT path, blob_key, blob_sha256, size, content_type, updated_at
                FROM workspace_files
                WHERE workspace_id = ? AND version_id = ? AND path = ? AND deleted = 0
                """,
                (workspace_id, resolved_version_id, path),
            ).fetchone()
        if not row:
            return None
        file_record = dict(row)
        file_record["version_id"] = resolved_version_id
        return file_record

    def write_workspace_file(
        self,
        workspace_id: str,
        path: str,
        blob_key: str,
        blob_sha256: str,
        size: int,
        content_type: str,
        message: str,
    ) -> dict[str, Any]:
        with self._lock, self.connect() as conn:
            parent_version_id = self._resolve_version_id(conn, workspace_id, None)
            version_id = f"ver_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO workspace_versions(id, workspace_id, parent_version_id, message)
                VALUES (?, ?, ?, ?)
                """,
                (version_id, workspace_id, parent_version_id, message),
            )
            conn.execute(
                """
                INSERT INTO workspace_files(
                    workspace_id, version_id, path, blob_key, blob_sha256, size, content_type, deleted, updated_at
                )
                SELECT workspace_id, ?, path, blob_key, blob_sha256, size, content_type, deleted, datetime('now')
                FROM workspace_files
                WHERE workspace_id = ? AND version_id = ? AND deleted = 0
                """,
                (version_id, workspace_id, parent_version_id),
            )
            existing = conn.execute(
                """
                SELECT 1
                FROM workspace_files
                WHERE workspace_id = ? AND version_id = ? AND path = ? AND deleted = 0
                """,
                (workspace_id, version_id, path),
            ).fetchone()
            op = "modified" if existing else "created"
            conn.execute(
                """
                INSERT INTO workspace_files(
                    workspace_id, version_id, path, blob_key, blob_sha256, size, content_type, deleted, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
                ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET
                    blob_key = excluded.blob_key,
                    blob_sha256 = excluded.blob_sha256,
                    size = excluded.size,
                    content_type = excluded.content_type,
                    deleted = 0,
                    updated_at = datetime('now')
                """,
                (workspace_id, version_id, path, blob_key, blob_sha256, size, content_type),
            )
            conn.execute(
                """
                INSERT INTO file_ops(id, workspace_id, version_id, op, path, blob_sha256)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (f"fop_{uuid.uuid4().hex}", workspace_id, version_id, op, path, blob_sha256),
            )
            conn.execute(
                """
                UPDATE workspaces
                SET current_version_id = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (version_id, workspace_id),
            )
            row = conn.execute(
                """
                SELECT path, blob_key, blob_sha256, size, content_type, updated_at
                FROM workspace_files
                WHERE workspace_id = ? AND version_id = ? AND path = ?
                """,
                (workspace_id, version_id, path),
            ).fetchone()
        file_record = dict(row)
        file_record["version_id"] = version_id
        file_record["op"] = op
        return file_record

    def list_file_ops(self, workspace_id: str, version_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            resolved_version_id = self._resolve_version_id(conn, workspace_id, version_id)
            rows = conn.execute(
                """
                SELECT *
                FROM file_ops
                WHERE workspace_id = ? AND version_id = ?
                ORDER BY created_at ASC
                """,
                (workspace_id, resolved_version_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_conversation(self, conversation_id: str, user_id: str, workspace_id: str, title: str | None) -> None:
        self.ensure_workspace(user_id=user_id, workspace_id=workspace_id, name=workspace_id)
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO conversations(id, user_id, workspace_id, title)
                VALUES (?, ?, ?, ?)
                """,
                (conversation_id, user_id, workspace_id, title),
            )

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return dict(row) if row else None

    def list_conversations(
        self,
        user_id: str | None = None,
        workspace_id: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        filters = []
        params: list[Any] = []
        if user_id:
            filters.append("c.user_id = ?")
            params.append(user_id)
        if workspace_id:
            filters.append("c.workspace_id = ?")
            params.append(workspace_id)
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    c.*,
                    COUNT(m.id) AS message_count,
                    COALESCE(MAX(m.created_at), c.created_at) AS updated_at,
                    (
                        SELECT lm.role
                        FROM messages lm
                        WHERE lm.conversation_id = c.id
                        ORDER BY lm.created_at DESC, lm.rowid DESC
                        LIMIT 1
                    ) AS last_message_role,
                    (
                        SELECT lm.content
                        FROM messages lm
                        WHERE lm.conversation_id = c.id
                        ORDER BY lm.created_at DESC, lm.rowid DESC
                        LIMIT 1
                    ) AS last_message_content
                FROM conversations c
                LEFT JOIN messages m ON m.conversation_id = c.id
                {where}
                GROUP BY c.id
                ORDER BY updated_at DESC, c.created_at DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_run(self, run_id: str, conversation_id: str, user_message: str) -> None:
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            conn.execute(
                """
                INSERT INTO runs(id, conversation_id, status, user_message)
                VALUES (?, ?, 'queued', ?)
                """,
                (run_id, conversation_id, user_message),
            )
            conn.execute(
                """
                INSERT INTO messages(id, conversation_id, run_id, role, content)
                VALUES (?, ?, ?, 'user', ?)
                """,
                (f"msg_{uuid.uuid4().hex}", conversation_id, run_id, user_message),
            )

    def set_run_status(self, run_id: str, status: str) -> None:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (status, run_id),
            )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def append_message(self, conversation_id: str, role: str, content: str, run_id: str | None = None) -> None:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO messages(id, conversation_id, run_id, role, content)
                VALUES (?, ?, ?, ?, ?)
                """,
                (f"msg_{uuid.uuid4().hex}", conversation_id, run_id, role, content),
            )

    def list_messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at ASC, rowid ASC
                """,
                (conversation_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def ensure_agent_session_seeded_from_messages(
        self,
        conversation_id: str,
        messages: list[dict[str, Any]],
    ) -> int:
        items = [item for message in messages if (item := self._message_to_agent_item(message)) is not None]
        if not items:
            return 0
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            existing = conn.execute(
                "SELECT COUNT(*) AS count FROM conversation_agent_items WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            if int(existing["count"]) > 0:
                return 0
            self._insert_agent_session_items(conn, conversation_id, items)
            return len(items)

    def list_agent_session_items(self, conversation_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            if limit is not None:
                rows = conn.execute(
                    """
                    SELECT item_json
                    FROM conversation_agent_items
                    WHERE conversation_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (conversation_id, limit),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = conn.execute(
                    """
                    SELECT item_json
                    FROM conversation_agent_items
                    WHERE conversation_id = ?
                    ORDER BY id ASC
                    """,
                    (conversation_id,),
                ).fetchall()
        return [json.loads(row["item_json"]) for row in rows]

    def append_agent_session_items(self, conversation_id: str, items: list[dict[str, Any]]) -> int:
        if not items:
            return 0
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            self._insert_agent_session_items(conn, conversation_id, items)
            return len(items)

    def pop_agent_session_item(self, conversation_id: str) -> dict[str, Any] | None:
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            row = conn.execute(
                """
                SELECT id, item_json
                FROM conversation_agent_items
                WHERE conversation_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
            if not row:
                return None
            conn.execute("DELETE FROM conversation_agent_items WHERE id = ?", (row["id"],))
        return json.loads(row["item_json"])

    def clear_agent_session_items(self, conversation_id: str) -> int:
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                raise ValueError("Conversation not found")
            row = conn.execute(
                "SELECT COUNT(*) AS count FROM conversation_agent_items WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            conn.execute("DELETE FROM conversation_agent_items WHERE conversation_id = ?", (conversation_id,))
            return int(row["count"])

    def append_event(self, run_id: str, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self.connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            seq = int(row["next_seq"])
            payload = event.get("payload") or {}
            normalized = {
                "runId": run_id,
                "seq": seq,
                "type": event["type"],
                "visibility": event.get("visibility", "user"),
                "itemId": event.get("itemId"),
                "parentId": event.get("parentId"),
                "status": event.get("status"),
                "payload": payload,
            }
            conn.execute(
                """
                INSERT INTO run_events(
                    run_id, seq, type, visibility, item_id, parent_id, status, payload_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    seq,
                    normalized["type"],
                    normalized["visibility"],
                    normalized["itemId"],
                    normalized["parentId"],
                    normalized["status"],
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            return normalized

    def list_events(self, run_id: str, after: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM run_events
                WHERE run_id = ? AND seq > ?
                ORDER BY seq ASC
                LIMIT ?
                """,
                (run_id, after, limit),
            ).fetchall()
        return [self._event_from_row(row) for row in rows]

    def _insert_agent_session_items(
        self,
        conn: sqlite3.Connection,
        conversation_id: str,
        items: list[dict[str, Any]],
    ) -> None:
        conn.executemany(
            """
            INSERT INTO conversation_agent_items(conversation_id, item_json)
            VALUES (?, ?)
            """,
            [
                (conversation_id, json.dumps(item, ensure_ascii=False, separators=(",", ":")))
                for item in items
            ],
        )

    def _message_to_agent_item(self, message: dict[str, Any]) -> dict[str, Any] | None:
        content = str(message.get("content") or "")
        if not content:
            return None
        role = str(message.get("role") or "")
        if role == "user":
            return {
                "type": "message",
                "role": "user",
                "content": content,
            }
        if role == "assistant":
            return {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": content}],
            }
        return None

    def _resolve_version_id(
        self,
        conn: sqlite3.Connection,
        workspace_id: str,
        version_id: str | None,
    ) -> str:
        if version_id:
            row = conn.execute(
                "SELECT id FROM workspace_versions WHERE workspace_id = ? AND id = ?",
                (workspace_id, version_id),
            ).fetchone()
            if not row:
                raise ValueError("Workspace version not found")
            return version_id

        row = conn.execute(
            "SELECT current_version_id FROM workspaces WHERE id = ?",
            (workspace_id,),
        ).fetchone()
        if not row:
            raise ValueError("Workspace not found")
        return row["current_version_id"]

    def _event_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "runId": row["run_id"],
            "seq": row["seq"],
            "type": row["type"],
            "visibility": row["visibility"],
            "itemId": row["item_id"],
            "parentId": row["parent_id"],
            "status": row["status"],
            "payload": json.loads(row["payload_json"]),
        }
