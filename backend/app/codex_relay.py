import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse


CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth"


class CodexCredentialError(RuntimeError):
    pass


class CodexCredentialStore:
    def __init__(
        self,
        auth_file: Path,
        refresh_margin_seconds: int = 300,
        timeout_seconds: int = 20,
    ) -> None:
        self.auth_file = auth_file
        self.refresh_margin = timedelta(seconds=max(refresh_margin_seconds, 0))
        self.timeout_seconds = timeout_seconds

    async def get_credential(self) -> dict[str, str]:
        payload = self._load_auth_file()
        token_bucket = self._token_bucket(payload)
        refresh_token = str(token_bucket.get("refresh_token") or "").strip()
        access_token = str(token_bucket.get("access_token") or "").strip()

        if not access_token:
            raise CodexCredentialError("codex auth file is missing access_token")
        if self._should_refresh(access_token) and refresh_token:
            token_bucket = await self._refresh_and_save(payload, token_bucket, refresh_token)
            access_token = str(token_bucket.get("access_token") or "").strip()

        account_id = self._resolve_account_id(token_bucket, access_token)
        if not account_id:
            raise CodexCredentialError("codex auth file is missing account_id")
        if not access_token:
            raise CodexCredentialError("codex auth file is missing access_token")

        return {
            "access_token": access_token,
            "account_id": account_id,
        }

    def _load_auth_file(self) -> dict[str, Any]:
        if not self.auth_file.exists():
            raise CodexCredentialError(f"codex auth file not found: {self.auth_file}")
        try:
            return json.loads(self.auth_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CodexCredentialError("codex auth file is not valid JSON") from exc

    def _token_bucket(self, payload: dict[str, Any]) -> dict[str, Any]:
        tokens = payload.get("tokens")
        if isinstance(tokens, dict):
            return tokens
        return payload

    def _should_refresh(self, access_token: str) -> bool:
        exp = self._jwt_exp(access_token)
        if exp is None:
            return False
        refresh_at = exp - self.refresh_margin
        return datetime.now(UTC) >= refresh_at

    async def _refresh_and_save(
        self,
        payload: dict[str, Any],
        token_bucket: dict[str, Any],
        refresh_token: str,
    ) -> dict[str, Any]:
        form = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CODEX_OAUTH_CLIENT_ID,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    CODEX_OAUTH_TOKEN_URL,
                    data=form,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
        except httpx.HTTPError as exc:
            raise CodexCredentialError("failed to refresh codex credential") from exc

        if response.status_code < 200 or response.status_code >= 300:
            raise CodexCredentialError(f"codex credential refresh failed: status={response.status_code}")

        data = response.json()
        access_token = str(data.get("access_token") or "").strip()
        new_refresh_token = str(data.get("refresh_token") or "").strip()
        expires_in = int(data.get("expires_in") or 0)
        if not access_token or not new_refresh_token or expires_in <= 0:
            raise CodexCredentialError("codex credential refresh response is missing fields")

        token_bucket["access_token"] = access_token
        token_bucket["refresh_token"] = new_refresh_token
        token_bucket["account_id"] = self._resolve_account_id(token_bucket, access_token)
        token_bucket["last_refresh"] = datetime.now(UTC).isoformat()
        token_bucket["expired"] = (datetime.now(UTC) + timedelta(seconds=expires_in)).isoformat()
        if not token_bucket.get("type"):
            token_bucket["type"] = "codex"
        payload["last_refresh"] = token_bucket["last_refresh"]

        self._atomic_write(payload)
        return token_bucket

    def _atomic_write(self, payload: dict[str, Any]) -> None:
        self.auth_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.auth_file.with_suffix(self.auth_file.suffix + ".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.auth_file)

    def _resolve_account_id(self, token_bucket: dict[str, Any], access_token: str) -> str:
        explicit = str(token_bucket.get("account_id") or "").strip()
        if explicit:
            return explicit
        claims = self._jwt_claims(access_token)
        auth_claim = claims.get(CODEX_ACCOUNT_CLAIM)
        if isinstance(auth_claim, dict):
            return str(auth_claim.get("chatgpt_account_id") or "").strip()
        return ""

    def _jwt_exp(self, token: str) -> datetime | None:
        claims = self._jwt_claims(token)
        exp = claims.get("exp")
        if isinstance(exp, (int, float)):
            return datetime.fromtimestamp(exp, UTC)
        return None

    def _jwt_claims(self, token: str) -> dict[str, Any]:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        try:
            payload = parts[1] + "=" * (-len(parts[1]) % 4)
            raw = base64.urlsafe_b64decode(payload.encode("ascii"))
            claims = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return claims if isinstance(claims, dict) else {}


class CodexRelay:
    def __init__(
        self,
        credential_store: CodexCredentialStore,
        upstream_base_url: str = "https://chatgpt.com",
        timeout_seconds: int = 120,
    ) -> None:
        self.credential_store = credential_store
        self.upstream_base_url = upstream_base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def responses(self, request: Request) -> Response:
        body = await self._read_json(request)
        body = self._prepare_responses_body(body)
        credential = await self.credential_store.get_credential()
        upstream_url = f"{self.upstream_base_url}/backend-api/codex/responses"
        headers = self._upstream_headers(body, credential)

        if body.get("stream") is True:
            return await self._stream_upstream(upstream_url, body, headers)
        return await self._post_upstream(upstream_url, body, headers)

    async def _read_json(self, request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Request body must be JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Request body must be a JSON object")
        return body

    def _prepare_responses_body(self, body: dict[str, Any]) -> dict[str, Any]:
        prepared = self._drop_nulls(dict(body))
        if "instructions" not in prepared:
            prepared["instructions"] = ""
        prepared["store"] = False
        service_tier = str(prepared.get("service_tier") or "").strip().lower()
        if service_tier == "fast":
            prepared["service_tier"] = "priority"
        elif service_tier in {"default", "priority", "flex", "auto"}:
            prepared["service_tier"] = service_tier
        else:
            prepared.pop("service_tier", None)
        prepared.pop("max_output_tokens", None)
        prepared.pop("temperature", None)
        return prepared

    def _drop_nulls(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {k: self._drop_nulls(v) for k, v in value.items() if v is not None}
        if isinstance(value, list):
            return [self._drop_nulls(item) for item in value if item is not None]
        return value

    def _upstream_headers(self, body: dict[str, Any], credential: dict[str, str]) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {credential['access_token']}",
            "chatgpt-account-id": credential["account_id"],
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if body.get("stream") is True else "application/json",
        }
        return headers

    async def _post_upstream(self, url: str, body: dict[str, Any], headers: dict[str, str]) -> Response:
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                upstream = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="Codex upstream request failed") from exc
        if upstream.status_code < 200 or upstream.status_code >= 300:
            raise self._upstream_exception(upstream.status_code, upstream.content)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
            headers=self._response_headers(upstream.headers),
        )

    async def _stream_upstream(self, url: str, body: dict[str, Any], headers: dict[str, str]) -> StreamingResponse:
        client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_seconds, read=None))
        stream_context = client.stream("POST", url, json=body, headers=headers)
        try:
            upstream = await stream_context.__aenter__()
        except httpx.HTTPError as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail="Codex upstream stream failed") from exc

        if upstream.status_code < 200 or upstream.status_code >= 300:
            content = await upstream.aread()
            await stream_context.__aexit__(None, None, None)
            await client.aclose()
            raise self._upstream_exception(upstream.status_code, content)

        async def iterator():
            try:
                async for chunk in upstream.aiter_raw():
                    if chunk:
                        yield chunk
            finally:
                await stream_context.__aexit__(None, None, None)
                await client.aclose()

        return StreamingResponse(
            iterator(),
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "text/event-stream"),
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                **self._response_headers(upstream.headers),
            },
        )

    def _upstream_exception(self, status_code: int, content: bytes) -> HTTPException:
        detail: Any = "Codex upstream rejected the request"
        if content:
            try:
                detail = json.loads(content.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = content.decode("utf-8", errors="replace")[:1000]
        return HTTPException(status_code=status_code, detail=detail)

    def _response_headers(self, upstream_headers: httpx.Headers) -> dict[str, str]:
        passthrough = {}
        for name in ("x-request-id", "openai-processing-ms"):
            value = upstream_headers.get(name)
            if value:
                passthrough[name] = value
        return passthrough
