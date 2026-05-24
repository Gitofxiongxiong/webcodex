from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterable
from typing import Any

from pydantic import BaseModel

from .events import event

ASSISTANT_ITEM_ID = "assistant_1"
MAX_TOOL_OUTPUT_CHARS = 120_000


class SdkEventAdapter:
    def __init__(self, *, assistant_item_id: str = ASSISTANT_ITEM_ID) -> None:
        self.assistant_item_id = assistant_item_id
        self.tool_calls: dict[str, dict[str, Any]] = {}

    def normalize(self, sdk_event: Any) -> list[dict[str, Any]]:
        event_type = attr(sdk_event, "type")
        if event_type in {"raw_model_stream_event", "raw_response_event"}:
            return self._normalize_raw_model_event(attr(sdk_event, "data"))
        if event_type == "run_item_stream_event":
            return self._normalize_run_item_event(sdk_event)
        if event_type == "agent_updated_stream_event":
            agent = attr(sdk_event, "new_agent") or attr(sdk_event, "agent")
            return [
                event(
                    "agent.changed",
                    {"name": attr(agent, "name")},
                    visibility="debug",
                )
            ]
        return [
            event(
                "sdk.event",
                {"sdkType": event_type, "raw": to_json_safe(sdk_event)},
                visibility="debug",
            )
        ]

    def _normalize_raw_model_event(self, data: Any) -> list[dict[str, Any]]:
        if data is None:
            return []

        data_type = raw_get(data, "type")
        if data_type == "model":
            return self._normalize_wrapped_responses_event(raw_get(data, "event"))

        if data_type in {"output_text_delta", "response.output_text.delta"} and raw_get(data, "delta"):
            return [
                event(
                    "assistant.message.delta",
                    {"text": raw_get(data, "delta"), "source": "openai-agents-python"},
                    item_id=self.assistant_item_id,
                    status="running",
                )
            ]

        return self._normalize_wrapped_responses_event(data)

    def _normalize_wrapped_responses_event(self, data: Any) -> list[dict[str, Any]]:
        if data is None:
            return []

        data_type = raw_get(data, "type")
        if data_type == "response.reasoning_summary_text.delta" and raw_get(data, "delta"):
            return [
                event(
                    "assistant.reasoning_summary.delta",
                    {"text": raw_get(data, "delta"), "source": "openai-agents-python"},
                    item_id=item_id_for(raw_get(data, "item_id") or "reasoning_1", "reasoning"),
                    status="running",
                )
            ]

        if data_type == "response.reasoning_summary_text.done":
            text = raw_get(data, "text") if isinstance(raw_get(data, "text"), str) else ""
            if not text.strip():
                return []
            return [
                event(
                    "assistant.reasoning_summary.done",
                    {"text": text, "source": "openai-agents-python"},
                    item_id=item_id_for(raw_get(data, "item_id") or "reasoning_1", "reasoning"),
                    status="completed",
                )
            ]

        if data_type == "response.reasoning_text.delta" and raw_get(data, "delta"):
            return [
                event(
                    "assistant.reasoning_text.delta",
                    {"text": raw_get(data, "delta"), "source": "openai-agents-python"},
                    item_id=item_id_for(raw_get(data, "item_id") or "reasoning_raw_1", "reasoning"),
                    status="running",
                    visibility="hidden",
                )
            ]

        if data_type == "response.function_call_arguments.delta" and raw_get(data, "delta"):
            call_id = raw_get(data, "call_id")
            return [
                event(
                    "tool.call.args.delta",
                    {"callId": call_id, "delta": raw_get(data, "delta"), "source": "openai-agents-python"},
                    item_id=item_id_for(call_id, "tool"),
                    status="running",
                    visibility="debug",
                )
            ]

        if data_type == "response.completed":
            response = raw_get(data, "response")
            usage = raw_get(response, "usage")
            if usage:
                input_details = raw_get(usage, "input_tokens_details") or {}
                output_details = raw_get(usage, "output_tokens_details") or {}
                response_id = raw_get(response, "id")
                return [
                    event(
                        "model.usage",
                        {
                            "callId": response_id,
                            "model": raw_get(response, "model"),
                            "serviceTier": raw_get(response, "service_tier"),
                            "responseId": response_id,
                            "source": "response.completed",
                            "usage": {
                                "inputTokens": numeric(raw_get(usage, "input_tokens")),
                                "cachedTokens": numeric(raw_get(input_details, "cached_tokens")),
                                "outputTokens": numeric(raw_get(usage, "output_tokens")),
                                "reasoningTokens": numeric(raw_get(output_details, "reasoning_tokens")),
                                "totalTokens": numeric(raw_get(usage, "total_tokens")),
                                "inputTokensDetails": to_json_safe(input_details),
                                "outputTokensDetails": to_json_safe(output_details),
                            },
                        },
                        item_id=item_id_for(response_id, "model_usage"),
                        status="completed",
                        visibility="debug",
                    )
                ]

        return []

    def _normalize_run_item_event(self, sdk_event: Any) -> list[dict[str, Any]]:
        item = attr(sdk_event, "item")
        name = attr(sdk_event, "name")
        if item is None:
            return []

        if name == "tool_called":
            return [self._tool_started_event(item)]
        if name == "tool_output":
            return [self._tool_completed_event(item)]
        if name == "tool_search_called":
            raw = raw_item(item)
            return [
                event(
                    "tool.call.started",
                    {"name": "tool_search", "kind": attr(item, "type"), "raw": to_json_safe(raw)},
                    item_id=item_id_for(raw_get(raw, "id") or raw_get(raw, "callId"), "tool"),
                    status="running",
                )
            ]
        if name == "tool_search_output_created":
            raw = raw_item(item)
            return [
                event(
                    "tool.call.completed",
                    {"name": "tool_search", "kind": attr(item, "type"), "output": to_json_safe(raw)},
                    item_id=item_id_for(raw_get(raw, "id") or raw_get(raw, "callId"), "tool"),
                    status="completed",
                )
            ]
        if name == "reasoning_item_created":
            text = reasoning_summary_text(item)
            if not text:
                return []
            raw = raw_item(item)
            return [
                event(
                    "assistant.reasoning_summary.done",
                    {"text": text, "source": "openai-agents-python"},
                    item_id=item_id_for(raw_get(raw, "id") or "reasoning_1", "reasoning"),
                    status="completed",
                )
            ]
        if name in {"tool_approval_requested", "mcp_approval_requested"}:
            raw = raw_item(item)
            return [
                event(
                    "tool.call.approval_required",
                    {
                        "name": attr(item, "name") or attr(item, "tool_name") or raw_get(raw, "name"),
                        "args": parse_json_maybe(attr(item, "arguments") or raw_get(raw, "arguments")),
                        "raw": to_json_safe(raw),
                    },
                    item_id=item_id_for(raw_get(raw, "callId") or raw_get(raw, "call_id") or raw_get(raw, "id"), "tool"),
                    status="blocked",
                )
            ]
        if name in {"handoff_requested", "handoff_occurred", "handoff_occured"}:
            return [
                event(
                    "agent.changed",
                    {
                        "sdkEventName": name,
                        "itemType": attr(item, "type"),
                        "raw": to_json_safe(raw_item(item)),
                    },
                    visibility="debug",
                )
            ]
        return []

    def _tool_started_event(self, item: Any) -> dict[str, Any]:
        raw = raw_item(item)
        call_id = attr(item, "call_id") or raw_get(raw, "call_id") or raw_get(raw, "callId") or raw_get(raw, "id")
        name = attr(item, "tool_name") or raw_get(raw, "name") or "unknown_tool"
        args = parse_json_maybe(raw_get(raw, "arguments"))
        if call_id:
            self.tool_calls[str(call_id)] = {"name": name, "args": args}

        raw_type = raw_get(raw, "type") or attr(item, "type")
        if raw_type == "shell_call" or name == "shell" or raw_type == "local_shell_call":
            action = raw_get(raw, "action") or args
            return event(
                "codex.command.started",
                {
                    "name": "shell",
                    "displayName": "bash (/workspace)",
                    "toolProtocol": "openai.shell",
                    "executor": "bash",
                    "runtime": "official-docker",
                    "callId": call_id,
                    "command": shell_command_text(action),
                    "cwd": "/workspace",
                    "action": to_json_safe(action),
                    "source": "openai-agents-python",
                },
                item_id=item_id_for(call_id, "command"),
                status="running",
            )

        if raw_type == "apply_patch_call" or name == "apply_patch":
            operation = raw_get(raw, "operation") or args
            return event(
                "codex.patch.started",
                {
                    "name": "apply_patch",
                    "toolProtocol": "openai.apply_patch",
                    "callId": call_id,
                    "operation": to_json_safe(operation),
                    "path": raw_get(operation, "path"),
                    "type": raw_get(operation, "type"),
                    "source": "openai-agents-python",
                },
                item_id=item_id_for(call_id, "patch"),
                status="running",
            )

        return event(
            "tool.call.started",
            {"name": name, "args": to_json_safe(args), "callId": call_id, "source": "openai-agents-python"},
            item_id=item_id_for(call_id, "tool"),
            status="running",
        )

    def _tool_completed_event(self, item: Any) -> dict[str, Any]:
        raw = raw_item(item)
        call_id = attr(item, "call_id") or raw_get(raw, "call_id") or raw_get(raw, "callId") or raw_get(raw, "id")
        remembered = self.tool_calls.get(str(call_id)) if call_id else None
        output = attr(item, "output") if hasattr(item, "output") else raw_get(raw, "output")
        raw_type = raw_get(raw, "type") or attr(item, "type")

        if raw_type == "shell_call_output" or remembered and remembered.get("name") == "shell":
            summary = shell_output_summary(output)
            return event(
                "codex.command.completed",
                {
                    "name": "shell",
                    "displayName": "bash (/workspace)",
                    "toolProtocol": "openai.shell",
                    "executor": "bash",
                    "runtime": "official-docker",
                    "callId": call_id,
                    **summary,
                    "output": truncate_large_output(to_json_safe(output)),
                    "source": "openai-agents-python",
                },
                item_id=item_id_for(call_id, "command"),
                status="completed" if summary["ok"] else "failed",
            )

        if raw_type == "apply_patch_call_output" or remembered and remembered.get("name") == "apply_patch":
            status = raw_get(raw, "status")
            return event(
                "codex.patch.completed",
                {
                    "name": "apply_patch",
                    "callId": call_id,
                    "status": status,
                    "output": truncate_large_output(to_json_safe(output)),
                    "source": "openai-agents-python",
                },
                item_id=item_id_for(call_id, "patch"),
                status="failed" if status == "failed" else "completed",
            )

        return event(
            "tool.call.completed",
            {
                "name": raw_get(raw, "name") or (remembered.get("name") if remembered else "unknown_tool"),
                "callId": call_id,
                "output": truncate_large_output(to_json_safe(output)),
                "source": "openai-agents-python",
            },
            item_id=item_id_for(call_id, "tool"),
            status="completed",
        )


def attr(value: Any, name: str, default: Any = None) -> Any:
    return getattr(value, name, default)


def raw_get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def raw_item(item: Any) -> Any:
    return attr(item, "raw_item", attr(item, "rawItem", {}))


def parse_json_maybe(value: Any) -> Any:
    if value is None or value == "":
        return {}
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value


def to_json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_unset=True)
    if dataclasses.is_dataclass(value):
        return to_json_safe(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {str(key): to_json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)):
        return value
    try:
        return json.loads(json.dumps(value))
    except (TypeError, ValueError):
        return str(value)


def item_id_for(value: Any, fallback_prefix: str) -> str:
    raw = str(value) if value else f"{fallback_prefix}_unknown"
    return "".join(char if char.isalnum() or char in "_.:-" else "_" for char in raw)


def shell_command_text(action: Any) -> str:
    if isinstance(action, str):
        return action
    commands = raw_get(action, "commands")
    if isinstance(commands, Iterable) and not isinstance(commands, (str, bytes, dict)):
        return "\n".join(str(command) for command in commands)
    command = raw_get(action, "cmd") or raw_get(action, "command")
    return str(command or "")


def shell_output_summary(output: Any) -> dict[str, Any]:
    normalized = normalize_shell_output(output)
    rows = normalized["rows"]
    last = rows[-1] if rows else {}
    outcome = raw_get(last, "outcome") or {}
    exit_code = raw_get(outcome, "exitCode", raw_get(outcome, "exit_code"))
    timed_out = any(raw_get(raw_get(row, "outcome") or {}, "type") == "timeout" for row in rows)
    stdout = "\n".join(str(raw_get(row, "stdout") or "") for row in rows if raw_get(row, "stdout"))
    stderr_parts = [str(raw_get(row, "stderr") or "") for row in rows if raw_get(row, "stderr")]
    if normalized["error"]:
        stderr_parts.append(str(normalized["error"]))
    stderr = "\n".join(part for part in stderr_parts if part)
    ok = not normalized["error"] and not timed_out and all(
        raw_get(raw_get(row, "outcome") or {}, "type") == "exit"
        and numeric(raw_get(raw_get(row, "outcome") or {}, "exitCode", raw_get(raw_get(row, "outcome") or {}, "exit_code"))) == 0
        for row in rows
    )
    return {
        "ok": ok,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "durationMs": numeric(raw_get(last, "duration_ms")),
        "stdout": stdout,
        "stderr": stderr,
    }


def normalize_shell_output(output: Any) -> dict[str, Any]:
    parsed = parse_json_maybe(output)
    if isinstance(parsed, list):
        return {"rows": parsed, "error": None}
    if isinstance(raw_get(parsed, "output"), list):
        return {
            "rows": raw_get(parsed, "output"),
            "error": raw_get(parsed, "error") if raw_get(parsed, "ok") is False else None,
        }
    if raw_get(parsed, "output"):
        return normalize_shell_output(raw_get(parsed, "output"))
    if parsed and not isinstance(parsed, str):
        if raw_get(parsed, "stdout") is not None or raw_get(parsed, "stderr") is not None or raw_get(parsed, "outcome") is not None:
            return {"rows": [parsed], "error": None}
        if raw_get(parsed, "ok") is False or raw_get(parsed, "error"):
            return {"rows": [], "error": raw_get(parsed, "error") or "Tool execution failed"}
    if isinstance(parsed, str) and parsed.strip():
        return {"rows": [], "error": parsed}
    return {"rows": [], "error": None}


def reasoning_summary_text(item: Any) -> str:
    raw = raw_item(item)
    chunks: list[str] = []
    for entry in array_or_empty(raw_get(raw, "content")):
        text = raw_get(entry, "text")
        if isinstance(text, str):
            chunks.append(text)
    for entry in array_or_empty(raw_get(raw, "summary")):
        text = raw_get(entry, "text")
        if isinstance(text, str):
            chunks.append(text)
    return "".join(chunks).strip()


def array_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def truncate_large_output(value: Any) -> Any:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    if len(text) <= MAX_TOOL_OUTPUT_CHARS:
        return value
    return {
        "truncated": True,
        "chars": len(text),
        "preview": text[:MAX_TOOL_OUTPUT_CHARS],
    }


def numeric(value: Any) -> int | float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(number) if number.is_integer() else number
