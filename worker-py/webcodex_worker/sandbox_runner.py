from __future__ import annotations

import io
import shutil
import tarfile
from pathlib import Path
from typing import Any

from docker import from_env as docker_from_env
from openai.types.shared import Reasoning

from agents import ModelSettings, Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxPathGrant, SandboxRunConfig
from agents.sandbox.capabilities import Capabilities
from agents.sandbox.entries import LocalDir
from agents.sandbox.sandboxes.docker import DockerSandboxClient, DockerSandboxClientOptions

from .backend_client import BackendClient
from .config import WorkerSettings
from .events import event
from .sdk_events import SdkEventAdapter

WORKSPACE_ROOT = "/workspace"


async def run_sandbox_agent(
    *,
    settings: WorkerSettings,
    client: BackendClient,
    user_input: str,
    session: Any,
) -> str:
    manifest = build_manifest(settings.host_workspace_dir)
    agent = build_agent(settings=settings, manifest=manifest)
    docker_client = DockerSandboxClient(docker_from_env())
    sandbox = await docker_client.create(
        manifest=manifest,
        options=DockerSandboxClientOptions(image=settings.worker_docker_image),
    )
    final_output = ""
    try:
        async with sandbox:
            await client.post_event(
                settings.run_id,
                event(
                    "run.runtime.started",
                    {
                        "backend": "official-openai-agents-docker",
                        "containerId": sandbox_container_id(sandbox),
                    },
                    visibility="debug",
                ),
            )
            result = Runner.run_streamed(
                agent,
                user_input,
                session=session,
                max_turns=12,
                run_config=RunConfig(
                    sandbox=SandboxRunConfig(session=sandbox),
                    workflow_name="WebCodex Python sandbox run",
                ),
            )
            adapter = SdkEventAdapter()
            async for sdk_event in result.stream_events():
                for normalized_event in adapter.normalize(sdk_event):
                    await client.post_event(settings.run_id, normalized_event)
            final_output = stringify_final_output(result.final_output)
            archive = await sandbox.persist_workspace()
            payload = archive.read()
            if isinstance(payload, str):
                payload = payload.encode("utf-8")
            extract_workspace_archive(payload, settings.host_workspace_dir)
            try:
                archive.close()
            except Exception:
                pass
    finally:
        if not settings.worker_keep_container:
            await docker_client.delete(sandbox)
    return final_output


def build_manifest(workspace_dir: Path) -> Manifest:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    return Manifest(
        root=WORKSPACE_ROOT,
        entries={".": LocalDir(src=workspace_dir)},
        extra_path_grants=(
            SandboxPathGrant(
                path=str(workspace_dir),
                read_only=False,
                description="WebCodex materialized run workspace",
            ),
        ),
    )


def build_agent(*, settings: WorkerSettings, manifest: Manifest) -> SandboxAgent:
    settings.host_workspace_dir.joinpath("outputs").mkdir(parents=True, exist_ok=True)
    return SandboxAgent(
        name="WebCodex Python Sandbox Agent",
        model=settings.openai_model,
        instructions=(
            "You are running in an isolated sandbox workspace rooted at /workspace. "
            "Inspect files before making code or document changes. "
            "Write durable generated artifacts under /workspace/outputs. "
            "Do not mention internal upload implementation details unless relevant to the answer."
        ),
        default_manifest=manifest,
        capabilities=Capabilities.default(),
        model_settings=ModelSettings(
            reasoning=Reasoning(
                effort=settings.openai_reasoning_effort,
                summary=settings.openai_reasoning_summary,
            ),
            verbosity=settings.openai_text_verbosity,
            store=settings.openai_store,
            parallel_tool_calls=True,
            extra_body={"service_tier": settings.openai_service_tier} if settings.openai_service_tier else None,
        ),
    )


def extract_workspace_archive(payload: bytes, workspace_dir: Path) -> None:
    temp_dir = workspace_dir.with_name(f"{workspace_dir.name}.next")
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
            for member in archive.getmembers():
                target = (temp_dir / member.name).resolve()
                root = temp_dir.resolve()
                try:
                    target.relative_to(root)
                except ValueError as exc:
                    raise ValueError(f"Workspace archive member escapes root: {member.name}") from exc
                if member.issym() or member.islnk():
                    continue
                archive.extract(member, temp_dir)
        if workspace_dir.exists():
            shutil.rmtree(workspace_dir)
        temp_dir.replace(workspace_dir)
    except Exception:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        raise


def stringify_final_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def sandbox_container_id(sandbox: Any) -> str | None:
    state = getattr(getattr(sandbox, "_inner", None), "state", None)
    container_id = getattr(state, "container_id", None)
    return str(container_id) if container_id else None
