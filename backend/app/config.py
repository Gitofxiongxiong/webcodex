from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///../data/webcodex_demo.db"
    api_base_url: str = "http://127.0.0.1:8000"
    worker_token: str = "dev-worker-token"
    python_worker_entry: str = "../worker-py/webcodex_worker/main.py"
    worker_sandbox_root: str = "../data/sandboxes"
    worker_runs_root: str = Field(default="../data/runs", validation_alias=AliasChoices("WORKER_RUNS_ROOT", "WORKER_RUN_ROOT"))
    worker_runtime: str = "docker"
    worker_docker_image: str = "webcodex-agent-runtime:latest"
    worker_docker_auto_build: bool = True
    worker_docker_network: str = "bridge"
    worker_docker_cpus: str = "2"
    worker_docker_memory: str = "4g"
    worker_docker_pids_limit: str = "512"
    worker_keep_container: bool = False
    worker_keep_run_dir: bool = True
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_api_protocol: str = "responses"
    openai_provider_profile: str = "auto"
    openai_responses_relay_mode: str = "auto"
    openai_send_service_tier: str = "auto"
    openai_model: str = "gpt-5.5"
    openai_compaction_enabled: bool = True
    openai_reasoning_effort: str = "xhigh"
    openai_reasoning_summary: str = "detailed"
    openai_text_verbosity: str = "low"
    openai_service_tier: str = "priority"
    openai_store: bool = False
    model_prices_usd_per_1m_json: str = ""
    billing_usd_to_credits_rate: float = 7.0
    openrouter_models_url: str = "https://openrouter.ai/api/v1/models"
    openrouter_pricing_cache_seconds: int = 3600
    codex_relay_enabled: bool = True
    codex_relay_api_key: str = "webcodex-local-token"
    codex_relay_auth_file: str = "../docs/auth.json"
    codex_relay_model: str = "gpt-5.5"
    codex_relay_upstream_base_url: str = "https://chatgpt.com"
    codex_relay_refresh_margin_seconds: int = 300
    codex_relay_timeout_seconds: int = 120
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = "https://oss-cn-shenzhen.aliyuncs.com"
    oss_bucket_name: str = ""
    oss_key_prefix: str = Field(
        default="beta",
        validation_alias=AliasChoices("OSS_KEY_PREFIX", "OSS_BASE_URL"),
    )

    model_config = SettingsConfigDict(env_file="../.env", env_file_encoding="utf-8", extra="ignore")

    @property
    def sqlite_path(self) -> Path:
        prefix = "sqlite:///"
        if not self.database_url.startswith(prefix):
            raise ValueError("Demo only supports sqlite:/// DATABASE_URL")
        path = Path(self.database_url[len(prefix) :])
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @property
    def python_worker_entry_path(self) -> Path:
        path = Path(self.python_worker_entry)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @property
    def worker_sandbox_root_path(self) -> Path:
        path = Path(self.worker_sandbox_root)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @property
    def worker_runs_root_path(self) -> Path:
        path = Path(self.worker_runs_root)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @property
    def codex_relay_auth_path(self) -> Path:
        path = Path(self.codex_relay_auth_file)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @property
    def oss_configured(self) -> bool:
        return all(
            [
                self.oss_access_key_id,
                self.oss_access_key_secret,
                self.oss_endpoint,
                self.oss_bucket_name,
                self.oss_key_prefix,
            ]
        )

    @property
    def openai_configured(self) -> bool:
        return bool(self.openai_api_key and self.openai_api_key != "your-openai-api-key")

    @property
    def codex_relay_configured(self) -> bool:
        return bool(
            self.codex_relay_enabled
            and self.codex_relay_api_key
            and self.codex_relay_auth_path.exists()
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
