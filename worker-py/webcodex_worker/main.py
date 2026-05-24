from __future__ import annotations

import asyncio
import traceback

from .attachments import materialize_attachments, user_text_with_attachment_paths
from .backend_client import BackendClient
from .config import WorkerSettings
from .diff import artifact_payloads, commit_workspace_changes, create_diff
from .events import event
from .session import BackendConversationSession
from .workspace_materializer import materialize_workspace, save_baseline, scan_workspace


async def main() -> None:
    settings = WorkerSettings()
    client = BackendClient(api_base_url=settings.api_base_url, worker_token=settings.worker_token)
    try:
        await run(settings=settings, client=client)
    except Exception as exc:
        await client.post_event(
            settings.run_id,
            event(
                "run.failed",
                {
                    "error": str(exc),
                    "name": exc.__class__.__name__,
                    "stack": traceback.format_exc(),
                },
                status="failed",
            ),
        )
        raise
    finally:
        await client.aclose()


async def run(*, settings: WorkerSettings, client: BackendClient) -> None:
    run_input = await client.get_run_input(settings.run_id)
    attachments = run_input.get("attachments") if isinstance(run_input.get("attachments"), list) else []
    input_payload = run_input.get("input") if isinstance(run_input.get("input"), dict) else {}
    prompt_text = str(input_payload.get("content") or input_payload.get("text") or "")

    settings.run_dir.mkdir(parents=True, exist_ok=True)
    baseline = await materialize_workspace(
        client=client,
        workspace_id=settings.workspace_id,
        workspace_root=settings.host_workspace_dir,
    )
    prepared_attachments = await materialize_attachments(
        client=client,
        run_id=settings.run_id,
        attachments=attachments,
        workspace_root=settings.host_workspace_dir,
    )
    baseline.update({
        path: fingerprint
        for path, fingerprint in scan_workspace(settings.host_workspace_dir).items()
        if path.startswith("attachments/")
    })
    save_baseline(settings.baseline_path, baseline)
    user_input = user_text_with_attachment_paths(prompt_text, prepared_attachments)

    session = BackendConversationSession(client=client, conversation_id=settings.conversation_id)
    session_items = await session.get_items()

    await client.post_event(
        settings.run_id,
        event(
            "run.started",
            {
                "runId": settings.run_id,
                "conversationId": settings.conversation_id,
                "workspaceId": settings.workspace_id,
                "runtime": "openai-agents-python",
                "runtimeMode": settings.worker_runtime,
                "sandboxScope": "run",
                "sandboxRoot": "/workspace",
                "artifactsRoot": "/workspace/outputs",
                "model": settings.openai_model,
                "reasoningEffort": settings.openai_reasoning_effort,
                "reasoningSummary": settings.openai_reasoning_summary,
                "textVerbosity": settings.openai_text_verbosity,
                "serviceTier": settings.openai_service_tier,
                "storeResponses": settings.openai_store,
                "apiProtocol": settings.openai_api_protocol,
                "providerProfile": settings.openai_provider_profile,
                "inputItemCount": 1,
                "attachmentCount": len(prepared_attachments),
                "sessionId": session.session_id,
                "sessionItemCount": len(session_items),
            },
        ),
    )
    await client.post_event(
        settings.run_id,
        event("assistant.message.created", {"role": "assistant"}, item_id="assistant_1"),
    )

    if settings.worker_py_dry_run:
        final_output = "Python worker dry run completed."
    else:
        from .sandbox_runner import run_sandbox_agent

        final_output = await run_sandbox_agent(
            settings=settings,
            client=client,
            user_input=user_input,
            session=session,
        )

    current = scan_workspace(settings.host_workspace_dir)
    workspace_diff = create_diff(baseline, current)
    await client.post_event(
        settings.run_id,
        event("workspace.diff.created", workspace_diff.as_payload(), visibility="debug"),
    )
    commit_result = await commit_workspace_changes(
        client=client,
        workspace_id=settings.workspace_id,
        workspace_root=settings.host_workspace_dir,
        diff=workspace_diff,
        run_id=settings.run_id,
    )
    if commit_result["committed"] or commit_result["deleted"]:
        await client.post_event(
            settings.run_id,
            event("workspace.commit.created", commit_result, visibility="debug"),
        )
    if commit_result["artifacts"]:
        await client.post_event(
            settings.run_id,
            event(
                "sandbox.exports.created",
                {"exports": sandbox_export_payloads(commit_result["artifacts"])},
            ),
        )
    for artifact_payload in artifact_payloads(settings.host_workspace_dir, workspace_diff.artifacts):
        await client.post_event(settings.run_id, event("artifact.created", artifact_payload, visibility="debug"))

    await client.post_event(
        settings.run_id,
        event(
            "assistant.message.done",
            {"text": final_output},
            item_id="assistant_1",
            status="completed",
        ),
    )
    await client.post_event(settings.run_id, event("run.completed", {"ok": True}))


def cli() -> None:
    asyncio.run(main())


def sandbox_export_payloads(files: list[dict]) -> list[dict]:
    exports = []
    for file_record in files:
        path = str(file_record.get("path") or "")
        exports.append(
            {
                "ok": True,
                "description": path.rsplit("/", 1)[-1] or path,
                "sandbox_path": path,
                "workspace_path": path,
                "content_type": file_record.get("content_type"),
                "size": file_record.get("size"),
                "sha256": file_record.get("blob_sha256") or file_record.get("sha256"),
            }
        )
    return exports


if __name__ == "__main__":
    cli()
