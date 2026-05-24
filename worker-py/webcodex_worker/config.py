from __future__ import annotations

from functools import cached_property
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    api_base_url: str = Field(validation_alias="API_BASE_URL")
    worker_token: str = Field(validation_alias="WORKER_TOKEN")
    run_id: str = Field(validation_alias="RUN_ID")
    conversation_id: str = Field(validation_alias="CONVERSATION_ID")
    workspace_id: str = Field(validation_alias="WORKSPACE_ID")

    worker_runtime: str = Field(default="official_docker", validation_alias="WORKER_RUNTIME")
    worker_docker_image: str = Field(
        default="webcodex-agent-runtime:latest",
        validation_alias="WORKER_DOCKER_IMAGE",
    )
    worker_run_root: Path = Field(default=Path("../data/runs"), validation_alias="WORKER_RUN_ROOT")
    worker_keep_container: bool = Field(default=False, validation_alias="WORKER_KEEP_CONTAINER")
    worker_py_dry_run: bool = Field(default=False, validation_alias="WORKER_PY_DRY_RUN")

    openai_model: str = Field(default="gpt-5.5", validation_alias="OPENAI_MODEL")
    openai_api_protocol: str = Field(default="responses", validation_alias="OPENAI_API_PROTOCOL")
    openai_provider_profile: str = Field(default="official", validation_alias="OPENAI_PROVIDER_PROFILE")
    openai_reasoning_effort: str = Field(default="xhigh", validation_alias="OPENAI_REASONING_EFFORT")
    openai_reasoning_summary: str = Field(default="detailed", validation_alias="OPENAI_REASONING_SUMMARY")
    openai_text_verbosity: str = Field(default="low", validation_alias="OPENAI_TEXT_VERBOSITY")
    openai_service_tier: str = Field(default="priority", validation_alias="OPENAI_SERVICE_TIER")
    openai_store: bool = Field(default=False, validation_alias="OPENAI_STORE")

    model_config = SettingsConfigDict(extra="ignore")

    @cached_property
    def run_dir(self) -> Path:
        root = self.worker_run_root
        if not root.is_absolute():
            root = (Path.cwd() / root).resolve()
        return root / self.run_id

    @cached_property
    def host_workspace_dir(self) -> Path:
        return self.run_dir / "workspace"

    @cached_property
    def baseline_path(self) -> Path:
        return self.run_dir / "baseline.json"
