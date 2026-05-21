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
                    account TEXT,
                    name TEXT NOT NULL,
                    password_hash TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                    expires_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id)
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
                    payload_json TEXT,
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
                    input_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
                );

                CREATE TABLE IF NOT EXISTS attachments (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    safe_name TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    oss_blob_key TEXT NOT NULL,
                    workspace_path TEXT NOT NULL,
                    model_kind TEXT NOT NULL,
                    image_detail TEXT,
                    openai_file_id TEXT,
                    openai_purpose TEXT,
                    openai_status TEXT NOT NULL DEFAULT 'pending',
                    openai_error TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY(user_id) REFERENCES users(id),
                    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
                );

                CREATE TABLE IF NOT EXISTS message_attachments (
                    message_id TEXT NOT NULL,
                    attachment_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    PRIMARY KEY(message_id, attachment_id),
                    FOREIGN KEY(message_id) REFERENCES messages(id),
                    FOREIGN KEY(attachment_id) REFERENCES attachments(id)
                );

                CREATE TABLE IF NOT EXISTS run_attachments (
                    run_id TEXT NOT NULL,
                    attachment_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    included_as TEXT,
                    error TEXT,
                    PRIMARY KEY(run_id, attachment_id),
                    FOREIGN KEY(run_id) REFERENCES runs(id),
                    FOREIGN KEY(attachment_id) REFERENCES attachments(id)
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

                CREATE TABLE IF NOT EXISTS run_context_snapshots (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    call_id TEXT NOT NULL,
                    call_index INTEGER,
                    mode TEXT,
                    model TEXT,
                    service_tier TEXT,
                    tokenizer TEXT,
                    context_window INTEGER,
                    reserved_output_tokens INTEGER,
                    usable_context_tokens INTEGER,
                    input_tokens_estimate INTEGER,
                    remaining_tokens INTEGER,
                    used_percent REAL,
                    breakdown_json TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(run_id, call_id),
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                );

                CREATE TABLE IF NOT EXISTS model_usage_events (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    call_id TEXT NOT NULL,
                    call_index INTEGER,
                    source TEXT NOT NULL,
                    mode TEXT,
                    visibility TEXT NOT NULL,
                    model TEXT,
                    service_tier TEXT,
                    response_id TEXT,
                    request_id TEXT,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    cached_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    context_window INTEGER,
                    reserved_output_tokens INTEGER,
                    usable_context_tokens INTEGER,
                    remaining_tokens INTEGER,
                    used_percent REAL,
                    cost_micro_usd INTEGER,
                    cost_micro_credits INTEGER,
                    pricing_json TEXT NOT NULL,
                    prompt_breakdown_json TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(run_id, call_id, source),
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                );

                CREATE INDEX IF NOT EXISTS idx_workspace_files_current
                    ON workspace_files(workspace_id, version_id, path);

                CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
                    ON auth_sessions(user_id, expires_at);

                CREATE INDEX IF NOT EXISTS idx_file_ops_workspace_version
                    ON file_ops(workspace_id, version_id);

                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                    ON messages(conversation_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_attachments_workspace
                    ON attachments(workspace_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_message_attachments_message
                    ON message_attachments(message_id, ordinal);

                CREATE INDEX IF NOT EXISTS idx_run_attachments_run
                    ON run_attachments(run_id, ordinal);

                CREATE INDEX IF NOT EXISTS idx_conversation_agent_items_conversation
                    ON conversation_agent_items(conversation_id, id);

                CREATE INDEX IF NOT EXISTS idx_run_events_run_seq
                    ON run_events(run_id, seq);

                CREATE INDEX IF NOT EXISTS idx_run_context_snapshots_run
                    ON run_context_snapshots(run_id, call_index, created_at);

                CREATE INDEX IF NOT EXISTS idx_model_usage_events_run
                    ON model_usage_events(run_id, call_index, created_at);
                """
            )
            self._migrate_user_auth_columns(conn)
            self._migrate_usage_columns(conn)
            self._migrate_multimodal_columns(conn)

    def _migrate_user_auth_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "account" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN account TEXT")
        if "password_hash" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account
                ON users(account)
                WHERE account IS NOT NULL
            """
        )

    def _migrate_usage_columns(self, conn: sqlite3.Connection) -> None:
        model_usage_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(model_usage_events)").fetchall()
        }
        if model_usage_columns and "cost_micro_credits" not in model_usage_columns:
            conn.execute("ALTER TABLE model_usage_events ADD COLUMN cost_micro_credits INTEGER")

    def _migrate_multimodal_columns(self, conn: sqlite3.Connection) -> None:
        message_columns = {row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
        if message_columns and "payload_json" not in message_columns:
            conn.execute("ALTER TABLE messages ADD COLUMN payload_json TEXT")

        run_columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
        if run_columns and "input_json" not in run_columns:
            conn.execute("ALTER TABLE runs ADD COLUMN input_json TEXT")

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

    def create_user_account(self, account: str, name: str, password_hash: str) -> dict[str, Any]:
        user_id = f"user_{uuid.uuid4().hex}"
        with self._lock, self.connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO users(id, account, name, password_hash)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user_id, account, name, password_hash),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("Account already exists") from exc
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row)

    def get_user_by_account(self, account: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE account = ?", (account,)).fetchone()
        return dict(row) if row else None

    def create_auth_session(self, user_id: str, token_hash: str, ttl_days: int = 30) -> None:
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
                raise ValueError("User not found")
            conn.execute(
                """
                INSERT INTO auth_sessions(token_hash, user_id, expires_at)
                VALUES (?, ?, datetime('now', ?))
                """,
                (token_hash, user_id, f"+{ttl_days} days"),
            )

    def get_user_by_session(self, token_hash: str) -> dict[str, Any] | None:
        with self._lock, self.connect() as conn:
            row = conn.execute(
                """
                SELECT u.*
                FROM auth_sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > datetime('now')
                """,
                (token_hash,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                """
                UPDATE auth_sessions
                SET last_seen_at = datetime('now')
                WHERE token_hash = ?
                """,
                (token_hash,),
            )
        return dict(row)

    def delete_auth_session(self, token_hash: str) -> None:
        with self._lock, self.connect() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,))

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

    def list_workspaces(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    w.*,
                    (
                        SELECT COUNT(*)
                        FROM conversations c
                        WHERE c.workspace_id = w.id
                    ) AS conversation_count,
                    (
                        SELECT COUNT(*)
                        FROM workspace_files wf
                        WHERE wf.workspace_id = w.id
                            AND wf.version_id = w.current_version_id
                            AND wf.deleted = 0
                    ) AS file_count,
                    (
                        SELECT COALESCE(SUM(wf.size), 0)
                        FROM workspace_files wf
                        WHERE wf.workspace_id = w.id
                            AND wf.version_id = w.current_version_id
                            AND wf.deleted = 0
                    ) AS total_size
                FROM workspaces w
                WHERE w.user_id = ?
                ORDER BY w.updated_at DESC, w.created_at DESC
                """,
                (user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

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

    def create_attachment(
        self,
        *,
        attachment_id: str,
        user_id: str,
        workspace_id: str,
        original_name: str,
        safe_name: str,
        content_type: str,
        size: int,
        sha256: str,
        oss_blob_key: str,
        workspace_path: str,
        model_kind: str,
        image_detail: str | None = None,
        openai_purpose: str | None = None,
    ) -> dict[str, Any]:
        with self._lock, self.connect() as conn:
            if not conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
                raise ValueError("User not found")
            workspace = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
            if not workspace:
                raise ValueError("Workspace not found")
            if workspace["user_id"] != user_id:
                raise ValueError("Workspace belongs to another user")
            conn.execute(
                """
                INSERT INTO attachments(
                    id, user_id, workspace_id, original_name, safe_name, content_type,
                    size, sha256, oss_blob_key, workspace_path, model_kind, image_detail,
                    openai_purpose, openai_status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                """,
                (
                    attachment_id,
                    user_id,
                    workspace_id,
                    original_name,
                    safe_name,
                    content_type,
                    size,
                    sha256,
                    oss_blob_key,
                    workspace_path,
                    model_kind,
                    image_detail,
                    openai_purpose,
                ),
            )
            row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        return dict(row)

    def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        return dict(row) if row else None

    def list_attachments(self, attachment_ids: list[str]) -> list[dict[str, Any]]:
        if not attachment_ids:
            return []
        placeholders = ",".join("?" for _ in attachment_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM attachments WHERE id IN ({placeholders})",
                tuple(attachment_ids),
            ).fetchall()
        by_id = {row["id"]: dict(row) for row in rows}
        return [by_id[attachment_id] for attachment_id in attachment_ids if attachment_id in by_id]

    def update_attachment_openai_file(
        self,
        *,
        attachment_id: str,
        openai_file_id: str | None,
        openai_status: str,
        openai_error: str | None = None,
        openai_purpose: str | None = None,
    ) -> dict[str, Any] | None:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                UPDATE attachments
                SET openai_file_id = COALESCE(?, openai_file_id),
                    openai_status = ?,
                    openai_error = ?,
                    openai_purpose = COALESCE(?, openai_purpose)
                WHERE id = ?
                """,
                (openai_file_id, openai_status, openai_error, openai_purpose, attachment_id),
            )
            row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
        return dict(row) if row else None

    def create_run(
        self,
        run_id: str,
        conversation_id: str,
        user_message: str,
        input_payload: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        attachments = attachments or []
        payload = input_payload or {"text": user_message, "attachments": attachments}
        with self._lock, self.connect() as conn:
            conversation = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if not conversation:
                raise ValueError("Conversation not found")
            conn.execute(
                """
                INSERT INTO runs(id, conversation_id, status, user_message, input_json)
                VALUES (?, ?, 'queued', ?, ?)
                """,
                (run_id, conversation_id, user_message, json.dumps(payload, ensure_ascii=False)),
            )
            message_id = f"msg_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO messages(id, conversation_id, run_id, role, content, payload_json)
                VALUES (?, ?, ?, 'user', ?, ?)
                """,
                (message_id, conversation_id, run_id, user_message, json.dumps(payload, ensure_ascii=False)),
            )
            for index, attachment in enumerate(attachments):
                attachment_id = attachment["id"]
                conn.execute(
                    """
                    INSERT INTO message_attachments(message_id, attachment_id, ordinal)
                    VALUES (?, ?, ?)
                    """,
                    (message_id, attachment_id, index),
                )
                conn.execute(
                    """
                    INSERT INTO run_attachments(run_id, attachment_id, ordinal, included_as)
                    VALUES (?, ?, ?, ?)
                    """,
                    (run_id, attachment_id, index, attachment.get("included_as")),
                )
        return message_id

    def set_run_attachment_result(
        self,
        *,
        run_id: str,
        attachment_id: str,
        included_as: str | None,
        error: str | None = None,
    ) -> None:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                UPDATE run_attachments
                SET included_as = ?, error = ?
                WHERE run_id = ? AND attachment_id = ?
                """,
                (included_as, error, run_id, attachment_id),
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

    def append_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        run_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO messages(id, conversation_id, run_id, role, content, payload_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    f"msg_{uuid.uuid4().hex}",
                    conversation_id,
                    run_id,
                    role,
                    content,
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                ),
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
        messages = [dict(row) for row in rows]
        if not messages:
            return []
        message_ids = [message["id"] for message in messages]
        placeholders = ",".join("?" for _ in message_ids)
        with self.connect() as conn:
            attachment_rows = conn.execute(
                f"""
                SELECT ma.message_id, ma.ordinal, a.*
                FROM message_attachments ma
                JOIN attachments a ON a.id = ma.attachment_id
                WHERE ma.message_id IN ({placeholders})
                ORDER BY ma.message_id, ma.ordinal
                """,
                tuple(message_ids),
            ).fetchall()
        grouped: dict[str, list[dict[str, Any]]] = {message_id: [] for message_id in message_ids}
        for row in attachment_rows:
            item = dict(row)
            message_id = item.pop("message_id")
            item.pop("ordinal", None)
            grouped.setdefault(message_id, []).append(item)
        for message in messages:
            message["attachments"] = grouped.get(message["id"], [])
            message["payload"] = self._json_or_none(message.get("payload_json"))
        return messages

    def get_run_input(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT r.*, c.workspace_id, c.user_id
                FROM runs r
                JOIN conversations c ON c.id = r.conversation_id
                WHERE r.id = ?
                """,
                (run_id,),
            ).fetchone()
            if not row:
                return None
            attachment_rows = conn.execute(
                """
                SELECT ra.ordinal, ra.included_as, ra.error, a.*
                FROM run_attachments ra
                JOIN attachments a ON a.id = ra.attachment_id
                WHERE ra.run_id = ?
                ORDER BY ra.ordinal
                """,
                (run_id,),
            ).fetchall()
        run = dict(row)
        payload = self._json_or_none(run.get("input_json")) or {"text": run.get("user_message") or ""}
        attachments = []
        for attachment_row in attachment_rows:
            item = dict(attachment_row)
            item["run_included_as"] = item.pop("included_as")
            item["run_error"] = item.pop("error")
            item.pop("ordinal", None)
            attachments.append(item)
        return {
            "run": run,
            "input": payload,
            "attachments": attachments,
        }

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

    def record_context_estimate(self, run_id: str, payload: dict[str, Any]) -> None:
        call_id = str(payload.get("callId") or f"context_{uuid.uuid4().hex}")
        breakdown = payload.get("breakdown") if isinstance(payload.get("breakdown"), list) else []
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO run_context_snapshots(
                    id, run_id, call_id, call_index, mode, model, service_tier, tokenizer,
                    context_window, reserved_output_tokens, usable_context_tokens,
                    input_tokens_estimate, remaining_tokens, used_percent,
                    breakdown_json, payload_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(run_id, call_id) DO UPDATE SET
                    call_index = excluded.call_index,
                    mode = excluded.mode,
                    model = excluded.model,
                    service_tier = excluded.service_tier,
                    tokenizer = excluded.tokenizer,
                    context_window = excluded.context_window,
                    reserved_output_tokens = excluded.reserved_output_tokens,
                    usable_context_tokens = excluded.usable_context_tokens,
                    input_tokens_estimate = excluded.input_tokens_estimate,
                    remaining_tokens = excluded.remaining_tokens,
                    used_percent = excluded.used_percent,
                    breakdown_json = excluded.breakdown_json,
                    payload_json = excluded.payload_json,
                    created_at = datetime('now')
                """,
                (
                    f"ctx_{uuid.uuid4().hex}",
                    run_id,
                    call_id,
                    self._int_or_none(payload.get("callIndex")),
                    self._str_or_none(payload.get("mode")),
                    self._str_or_none(payload.get("model")),
                    self._str_or_none(payload.get("serviceTier")),
                    self._str_or_none(payload.get("tokenizer")),
                    self._int_or_none(payload.get("contextWindow")),
                    self._int_or_none(payload.get("reservedOutputTokens")),
                    self._int_or_none(payload.get("usableContextTokens")),
                    self._int_or_none(payload.get("inputTokensEstimate")),
                    self._int_or_none(payload.get("remainingTokens")),
                    self._float_or_none(payload.get("usedPercent")),
                    json.dumps(breakdown, ensure_ascii=False),
                    json.dumps(payload, ensure_ascii=False),
                ),
            )

    def record_model_usage(self, run_id: str, payload: dict[str, Any], visibility: str = "user") -> None:
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        call_id = str(payload.get("callId") or payload.get("responseId") or f"usage_{uuid.uuid4().hex}")
        source = str(payload.get("source") or "unknown")
        input_tokens = self._int_or_zero(usage.get("inputTokens") or usage.get("input_tokens"))
        cached_tokens = self._int_or_zero(usage.get("cachedTokens") or usage.get("cached_tokens"))
        output_tokens = self._int_or_zero(usage.get("outputTokens") or usage.get("output_tokens"))
        reasoning_tokens = self._int_or_zero(usage.get("reasoningTokens") or usage.get("reasoning_tokens"))
        total_tokens = self._int_or_zero(usage.get("totalTokens") or usage.get("total_tokens"))
        if total_tokens == 0 and (input_tokens or output_tokens):
            total_tokens = input_tokens + output_tokens
        pricing = payload.get("pricing") if isinstance(payload.get("pricing"), dict) else {}
        breakdown = payload.get("breakdown") if isinstance(payload.get("breakdown"), list) else []

        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO model_usage_events(
                    id, run_id, call_id, call_index, source, mode, visibility, model, service_tier,
                    response_id, request_id, input_tokens, cached_tokens, output_tokens,
                    reasoning_tokens, total_tokens, context_window, reserved_output_tokens,
                    usable_context_tokens, remaining_tokens, used_percent, cost_micro_usd,
                    cost_micro_credits,
                    pricing_json, prompt_breakdown_json, payload_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(run_id, call_id, source) DO UPDATE SET
                    call_index = excluded.call_index,
                    mode = excluded.mode,
                    visibility = excluded.visibility,
                    model = excluded.model,
                    service_tier = excluded.service_tier,
                    response_id = excluded.response_id,
                    request_id = excluded.request_id,
                    input_tokens = excluded.input_tokens,
                    cached_tokens = excluded.cached_tokens,
                    output_tokens = excluded.output_tokens,
                    reasoning_tokens = excluded.reasoning_tokens,
                    total_tokens = excluded.total_tokens,
                    context_window = excluded.context_window,
                    reserved_output_tokens = excluded.reserved_output_tokens,
                    usable_context_tokens = excluded.usable_context_tokens,
                    remaining_tokens = excluded.remaining_tokens,
                    used_percent = excluded.used_percent,
                    cost_micro_usd = excluded.cost_micro_usd,
                    cost_micro_credits = excluded.cost_micro_credits,
                    pricing_json = excluded.pricing_json,
                    prompt_breakdown_json = excluded.prompt_breakdown_json,
                    payload_json = excluded.payload_json,
                    created_at = datetime('now')
                """,
                (
                    f"usage_{uuid.uuid4().hex}",
                    run_id,
                    call_id,
                    self._int_or_none(payload.get("callIndex")),
                    source,
                    self._str_or_none(payload.get("mode")),
                    visibility,
                    self._str_or_none(payload.get("model")),
                    self._str_or_none(payload.get("serviceTier")),
                    self._str_or_none(payload.get("responseId")),
                    self._str_or_none(payload.get("requestId")),
                    input_tokens,
                    cached_tokens,
                    output_tokens,
                    reasoning_tokens,
                    total_tokens,
                    self._int_or_none(payload.get("contextWindow")),
                    self._int_or_none(payload.get("reservedOutputTokens")),
                    self._int_or_none(payload.get("usableContextTokens")),
                    self._int_or_none(payload.get("remainingTokens")),
                    self._float_or_none(payload.get("usedPercent")),
                    self._int_or_none(payload.get("costMicroUsd")),
                    self._int_or_none(payload.get("costMicroCredits")),
                    json.dumps(pricing, ensure_ascii=False),
                    json.dumps(breakdown, ensure_ascii=False),
                    json.dumps(payload, ensure_ascii=False),
                ),
            )

    def get_context_snapshot(self, run_id: str, call_id: str | None = None) -> dict[str, Any] | None:
        with self.connect() as conn:
            if call_id:
                row = conn.execute(
                    """
                    SELECT *
                    FROM run_context_snapshots
                    WHERE run_id = ? AND call_id = ?
                    LIMIT 1
                    """,
                    (run_id, call_id),
                ).fetchone()
                if row:
                    return self._context_snapshot_from_row(row)
            row = conn.execute(
                """
                SELECT *
                FROM run_context_snapshots
                WHERE run_id = ?
                ORDER BY COALESCE(call_index, 0) DESC, created_at DESC, rowid DESC
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
        return self._context_snapshot_from_row(row) if row else None

    def get_latest_context_snapshot(self, run_id: str) -> dict[str, Any] | None:
        return self.get_context_snapshot(run_id)

    def list_model_usage_events(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM model_usage_events
                WHERE run_id = ?
                ORDER BY COALESCE(call_index, 0) ASC, created_at ASC, rowid ASC
                """,
                (run_id,),
            ).fetchall()
        return [self._model_usage_from_row(row) for row in rows]

    def get_run_usage_summary(self, run_id: str) -> dict[str, Any]:
        usage_events = self.list_model_usage_events(run_id)
        provider_events = [item for item in usage_events if item["source"] == "provider-usage"]
        completed_events = [item for item in usage_events if item["source"] == "response.completed"]
        billable_events = provider_events or completed_events or usage_events
        cost_values = [item["costMicroUsd"] for item in billable_events if item.get("costMicroUsd") is not None]
        credit_values = [
            item["costMicroCredits"]
            for item in billable_events
            if item.get("costMicroCredits") is not None
        ]
        cost_micro_usd = sum(cost_values) if cost_values else None
        cost_micro_credits = sum(credit_values) if credit_values else None
        totals = {
            "requests": len(billable_events),
            "inputTokens": sum(item["inputTokens"] for item in billable_events),
            "cachedTokens": sum(item["cachedTokens"] for item in billable_events),
            "outputTokens": sum(item["outputTokens"] for item in billable_events),
            "reasoningTokens": sum(item["reasoningTokens"] for item in billable_events),
            "totalTokens": sum(item["totalTokens"] for item in billable_events),
            "costMicroUsd": cost_micro_usd,
            "costUsd": round(cost_micro_usd / 1_000_000, 6) if cost_micro_usd is not None else None,
            "costMicroCredits": cost_micro_credits,
            "costCredits": round(cost_micro_credits / 1_000_000, 6) if cost_micro_credits is not None else None,
            "pricingConfigured": cost_micro_usd is not None,
            "billingSource": (
                "provider-usage"
                if provider_events
                else "response.completed"
                if completed_events
                else "none"
            ),
        }
        return {
            "runId": run_id,
            "context": self.get_latest_context_snapshot(run_id),
            "totals": totals,
            "usageEvents": usage_events,
        }

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
        role = str(message.get("role") or "")
        payload = self._json_or_none(message.get("payload_json")) or message.get("payload")
        if role == "user" and isinstance(payload, dict):
            item = payload.get("agent_item")
            if isinstance(item, dict):
                return item
            text = str(payload.get("text") or content or "")
            parts: list[dict[str, Any]] = []
            if text:
                parts.append({"type": "input_text", "text": text})
            payload_attachments = payload.get("attachments") if isinstance(payload.get("attachments"), list) else []
            message_attachments = message.get("attachments") if isinstance(message.get("attachments"), list) else []
            for attachment in message_attachments or payload_attachments:
                if not isinstance(attachment, dict):
                    continue
                openai_file_id = str(attachment.get("openai_file_id") or "").strip()
                model_kind = str(attachment.get("model_kind") or "")
                if not openai_file_id:
                    continue
                if model_kind == "image":
                    parts.append({
                        "type": "input_image",
                        "image": {"id": openai_file_id},
                        "detail": attachment.get("image_detail") or "auto",
                    })
                else:
                    parts.append({
                        "type": "input_file",
                        "file": {"id": openai_file_id},
                        "filename": attachment.get("safe_name") or attachment.get("original_name"),
                    })
            if parts:
                return {
                    "type": "message",
                    "role": "user",
                    "content": parts,
                }
        if not content:
            return None
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

    @staticmethod
    def _json_or_none(value: Any) -> Any:
        if not value:
            return None
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(str(value))
        except (TypeError, ValueError, json.JSONDecodeError):
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

    def _context_snapshot_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "runId": row["run_id"],
            "callId": row["call_id"],
            "callIndex": row["call_index"],
            "mode": row["mode"],
            "model": row["model"],
            "serviceTier": row["service_tier"],
            "tokenizer": row["tokenizer"],
            "contextWindow": row["context_window"],
            "reservedOutputTokens": row["reserved_output_tokens"],
            "usableContextTokens": row["usable_context_tokens"],
            "inputTokensEstimate": row["input_tokens_estimate"],
            "remainingTokens": row["remaining_tokens"],
            "usedPercent": row["used_percent"],
            "breakdown": json.loads(row["breakdown_json"]),
            "payload": json.loads(row["payload_json"]),
            "createdAt": row["created_at"],
        }

    def _model_usage_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        cost_micro_usd = row["cost_micro_usd"]
        cost_micro_credits = row["cost_micro_credits"]
        return {
            "runId": row["run_id"],
            "callId": row["call_id"],
            "callIndex": row["call_index"],
            "source": row["source"],
            "mode": row["mode"],
            "visibility": row["visibility"],
            "model": row["model"],
            "serviceTier": row["service_tier"],
            "responseId": row["response_id"],
            "requestId": row["request_id"],
            "inputTokens": row["input_tokens"],
            "cachedTokens": row["cached_tokens"],
            "outputTokens": row["output_tokens"],
            "reasoningTokens": row["reasoning_tokens"],
            "totalTokens": row["total_tokens"],
            "contextWindow": row["context_window"],
            "reservedOutputTokens": row["reserved_output_tokens"],
            "usableContextTokens": row["usable_context_tokens"],
            "remainingTokens": row["remaining_tokens"],
            "usedPercent": row["used_percent"],
            "costMicroUsd": cost_micro_usd,
            "costUsd": round(cost_micro_usd / 1_000_000, 6) if cost_micro_usd is not None else None,
            "costMicroCredits": cost_micro_credits,
            "costCredits": round(cost_micro_credits / 1_000_000, 6) if cost_micro_credits is not None else None,
            "pricing": json.loads(row["pricing_json"]),
            "breakdown": json.loads(row["prompt_breakdown_json"]),
            "payload": json.loads(row["payload_json"]),
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _str_or_none(value: Any) -> str | None:
        if value is None:
            return None
        return str(value)

    @staticmethod
    def _int_or_none(value: Any) -> int | None:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _int_or_zero(cls, value: Any) -> int:
        return cls._int_or_none(value) or 0

    @staticmethod
    def _float_or_none(value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
