from __future__ import annotations

from pathlib import Path, PurePosixPath


def safe_filename(filename: str | None, fallback: str = "attachment") -> str:
    name = str(filename or fallback).replace("\\", "/").rsplit("/", 1)[-1].strip().strip(".")
    if not name:
        name = fallback
    chars = []
    for char in name:
        if char.isalnum() or char in "._ -":
            chars.append(char)
        else:
            chars.append("_")
    safe = " ".join("".join(chars).split()).strip()
    if not safe or safe in {".", ".."}:
        safe = fallback
    if len(safe) > 120:
        stem, dot, suffix = safe.rpartition(".")
        if dot and len(suffix) <= 16:
            safe = f"{stem[: max(1, 119 - len(suffix))]}.{suffix}"
        else:
            safe = safe[:120]
    return safe


def normalize_workspace_path(value: str) -> str:
    raw = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not raw:
        raise ValueError("Workspace path is empty")
    posix = PurePosixPath(raw)
    if posix.is_absolute() or any(part in {"", ".", ".."} for part in posix.parts):
        raise ValueError(f"Invalid workspace path: {value}")
    return posix.as_posix()


def resolve_under(root: Path, relative_path: str) -> Path:
    normalized = normalize_workspace_path(relative_path)
    target = (root / normalized).resolve()
    root = root.resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Path escapes root: {relative_path}") from exc
    return target
