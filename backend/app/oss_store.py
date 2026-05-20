import hashlib
from pathlib import PurePosixPath
from typing import Any


class AliyunObjectStore:
    """Content-addressed workspace blob store backed by Aliyun OSS."""

    def __init__(
        self,
        *,
        access_key_id: str,
        access_key_secret: str,
        endpoint: str,
        bucket_name: str,
        key_prefix: str,
    ):
        self._ensure_config(access_key_id, access_key_secret, endpoint, bucket_name, key_prefix)
        self.key_prefix = self._normalize_prefix(key_prefix)

        try:
            import oss2
        except ImportError as exc:
            raise RuntimeError("Missing dependency: install backend requirements to enable Aliyun OSS") from exc

        self._oss2 = oss2
        auth = oss2.Auth(access_key_id, access_key_secret)
        self.bucket = oss2.Bucket(auth, endpoint, bucket_name)

    def put_bytes(self, data: bytes, content_type: str = "application/octet-stream") -> dict[str, Any]:
        digest = hashlib.sha256(data).hexdigest()
        key = self._build_object_key(digest)
        if not self.bucket.object_exists(key):
            self.bucket.put_object(key, data, headers={"Content-Type": content_type})
        return {"key": key, "sha256": digest, "size": len(data)}

    def put_text(self, text: str, content_type: str = "text/plain; charset=utf-8") -> dict[str, Any]:
        return self.put_bytes(text.encode("utf-8"), content_type=content_type)

    def read_bytes(self, key: str) -> bytes:
        normalized_key = self._normalize_key(key)
        try:
            return self.bucket.get_object(normalized_key).read()
        except self._oss2.exceptions.NoSuchKey as exc:
            raise FileNotFoundError(key) from exc

    def read_text(self, key: str) -> str:
        return self.read_bytes(key).decode("utf-8")

    def _build_object_key(self, digest: str) -> str:
        return f"{self.key_prefix}/objects/{digest[:2]}/{digest}"

    def _normalize_key(self, key: str) -> str:
        normalized = key.replace("\\", "/").lstrip("/")
        path = PurePosixPath(normalized)
        if not normalized or path.is_absolute() or any(part in {"..", ""} for part in path.parts):
            raise ValueError("Invalid OSS object key")
        if not normalized.startswith(f"{self.key_prefix}/"):
            raise ValueError("OSS object key is outside the configured prefix")
        return normalized

    @staticmethod
    def _normalize_prefix(prefix: str) -> str:
        normalized = prefix.replace("\\", "/").strip("/")
        path = PurePosixPath(normalized)
        if not normalized or path.is_absolute() or any(part in {"..", ""} for part in path.parts):
            raise ValueError("OSS key prefix must be a fixed relative prefix")
        return normalized

    @staticmethod
    def _ensure_config(*values: str) -> None:
        if not all(values):
            raise RuntimeError("Aliyun OSS is not configured; set OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_ENDPOINT, OSS_BUCKET_NAME, and OSS_KEY_PREFIX")
