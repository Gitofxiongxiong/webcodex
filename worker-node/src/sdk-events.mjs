import { event } from "./protocol.mjs";

export class SdkEventNormalizer {
  constructor({ assistantItemId = "assistant_1" } = {}) {
    this.assistantItemId = assistantItemId;
    this.toolCalls = new Map();
  }

  normalize(sdkEvent) {
    if (!sdkEvent || typeof sdkEvent !== "object") {
      return [];
    }

    if (sdkEvent.type === "raw_model_stream_event") {
      return this.normalizeRawModelEvent(sdkEvent.data);
    }

    if (sdkEvent.type === "run_item_stream_event") {
      return this.normalizeRunItemEvent(sdkEvent);
    }

    if (sdkEvent.type === "agent_updated_stream_event") {
      return [
        event(
          "agent.changed",
          {
            name: sdkEvent.agent?.name,
          },
          { visibility: "debug" }
        ),
      ];
    }

    return [
      event(
        "sdk.event",
        {
          sdkType: sdkEvent.type,
          raw: toJsonSafe(sdkEvent),
        },
        { visibility: "debug" }
      ),
    ];
  }

  normalizeRawModelEvent(data) {
    if (!data || typeof data !== "object") {
      return [];
    }

    if (data.type === "output_text_delta" && data.delta) {
      return [
        event(
          "assistant.message.delta",
          {
            text: data.delta,
            source: "openai-agents",
          },
          { itemId: this.assistantItemId, status: "running" }
        ),
      ];
    }

    if (data.type === "model") {
      return this.normalizeWrappedResponsesEvent(data.event);
    }

    if (data.type === "response.output_text.delta" && data.delta) {
      return [
        event(
          "assistant.message.delta",
          {
            text: data.delta,
            source: "openai-agents",
          },
          { itemId: this.assistantItemId, status: "running" }
        ),
      ];
    }

    return this.normalizeWrappedResponsesEvent(data);
  }

  normalizeWrappedResponsesEvent(data) {
    if (!data || typeof data !== "object") {
      return [];
    }

    if (data.type === "response.reasoning_summary_text.delta" && data.delta) {
      return [
        event(
          "assistant.reasoning_summary.delta",
          {
            text: data.delta,
            source: "openai-agents",
          },
          { itemId: itemIdFor(data.item_id ?? "reasoning_1", "reasoning"), status: "running" }
        ),
      ];
    }

    if (data.type === "response.reasoning_summary_text.done") {
      const text = typeof data.text === "string" ? data.text : "";
      if (!text.trim()) {
        return [];
      }
      return [
        event(
          "assistant.reasoning_summary.done",
          {
            text,
            source: "openai-agents",
          },
          { itemId: itemIdFor(data.item_id ?? "reasoning_1", "reasoning"), status: "completed" }
        ),
      ];
    }

    if (data.type === "response.reasoning_text.delta" && data.delta) {
      return [
        event(
          "assistant.reasoning_text.delta",
          {
            text: data.delta,
            source: "openai-agents",
          },
          { itemId: itemIdFor(data.item_id ?? "reasoning_raw_1", "reasoning"), status: "running", visibility: "hidden" }
        ),
      ];
    }

    if (data.type === "response.function_call_arguments.delta" && data.delta) {
      return [
        event(
          "tool.call.args.delta",
          {
            callId: data.call_id,
            delta: data.delta,
            source: "openai-agents",
          },
          { itemId: itemIdFor(data.call_id, "tool"), status: "running", visibility: "debug" }
        ),
      ];
    }

    if (data.type === "response.completed" && data.response?.usage) {
      const response = data.response;
      const usage = response.usage ?? {};
      const inputDetails = usage.input_tokens_details ?? {};
      const outputDetails = usage.output_tokens_details ?? {};
      return [
        event(
          "model.usage",
          {
            callId: response.id,
            model: response.model,
            provider: process.env.OPENAI_MODEL_PROVIDER ?? null,
            serviceTier: response.service_tier ?? null,
            responseId: response.id,
            source: "response.completed",
            usage: {
              inputTokens: numeric(usage.input_tokens),
              cachedTokens: numeric(inputDetails.cached_tokens),
              outputTokens: numeric(usage.output_tokens),
              reasoningTokens: numeric(outputDetails.reasoning_tokens),
              totalTokens: numeric(usage.total_tokens),
              inputTokensDetails: inputDetails,
              outputTokensDetails: outputDetails,
            },
          },
          { itemId: itemIdFor(response.id, "model_usage"), status: "completed", visibility: "debug" }
        ),
      ];
    }

    return [];
  }

  normalizeRunItemEvent(sdkEvent) {
    const item = sdkEvent.item;
    if (!item) {
      return [];
    }

    if (sdkEvent.name === "tool_called") {
      return [this.toolStartedEvent(item)];
    }

    if (sdkEvent.name === "tool_output") {
      return [this.toolCompletedEvent(item)];
    }

    if (sdkEvent.name === "tool_search_called") {
      return [
        event(
          "tool.call.started",
          {
            name: "tool_search",
            kind: item.type,
            raw: toJsonSafe(item.rawItem),
          },
          { itemId: itemIdFor(item.rawItem?.id ?? item.rawItem?.callId, "tool"), status: "running" }
        ),
      ];
    }

    if (sdkEvent.name === "tool_search_output_created") {
      return [
        event(
          "tool.call.completed",
          {
            name: "tool_search",
            kind: item.type,
            output: toJsonSafe(item.rawItem),
          },
          { itemId: itemIdFor(item.rawItem?.id ?? item.rawItem?.callId, "tool"), status: "completed" }
        ),
      ];
    }

    if (sdkEvent.name === "reasoning_item_created") {
      const text = reasoningSummaryText(sdkEvent.item);
      if (!text) {
        return [];
      }
      return [
        event(
          "assistant.reasoning_summary.done",
          { text, source: "openai-agents" },
          {
            itemId: itemIdFor(item.rawItem?.id ?? "reasoning_1", "reasoning"),
            status: "completed",
          }
        ),
      ];
    }

    if (sdkEvent.name === "tool_approval_requested") {
      const raw = item.rawItem ?? {};
      return [
        event(
          "tool.call.approval_required",
          {
            name: item.name ?? item.toolName ?? raw.name,
            args: parseJsonMaybe(item.arguments ?? raw.arguments),
            raw: toJsonSafe(raw),
          },
          { itemId: itemIdFor(raw.callId ?? raw.id, "tool"), status: "blocked" }
        ),
      ];
    }

    if (sdkEvent.name === "handoff_requested" || sdkEvent.name === "handoff_occurred") {
      return [
        event(
          "agent.changed",
          {
            sdkEventName: sdkEvent.name,
            itemType: item.type,
            raw: toJsonSafe(item.rawItem),
          },
          { visibility: "debug" }
        ),
      ];
    }

    return [];
  }

  toolStartedEvent(item) {
    const raw = item.rawItem ?? {};
    const callId = item.callId ?? raw.callId ?? raw.id;
    const name = item.toolName ?? raw.name ?? "unknown_tool";
    const args = parseJsonMaybe(raw.arguments);
    const normalized = { name, args };
    if (callId) {
      this.toolCalls.set(callId, normalized);
    }

    if (raw.type === "shell_call" || item.type === "shell_call") {
      const action = raw.action ?? args;
      return event(
        "codex.command.started",
        {
          name: "shell",
          displayName: "bash (/sandbox)",
          toolProtocol: "openai.shell",
          executor: "bash",
          runtime: "docker",
          callId,
          command: shellCommandText(action),
          cwd: "/sandbox",
          action: toJsonSafe(action),
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "command"), status: "running" }
      );
    }

    if (raw.type === "apply_patch_call" || item.type === "apply_patch_call") {
      const operation = raw.operation ?? args;
      return event(
        "codex.patch.started",
        {
          name: "apply_patch",
          callId,
          operation: toJsonSafe(operation),
          path: operation?.path,
          type: operation?.type,
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "patch"), status: "running" }
      );
    }

    if (name === "shell" && Array.isArray(args?.commands)) {
      return event(
        "codex.command.started",
        {
          name: "shell",
          displayName: "bash (/sandbox)",
          toolProtocol: "function.shell",
          executor: "bash",
          runtime: "docker",
          callId,
          command: shellCommandText(args),
          cwd: "/sandbox",
          action: toJsonSafe(args),
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "command"), status: "running" }
      );
    }

    if (name === "apply_patch" && args?.type) {
      return event(
        "codex.patch.started",
        {
          name: "apply_patch",
          toolProtocol: "function.apply_patch",
          callId,
          operation: toJsonSafe(args),
          path: args?.path,
          type: args?.type,
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "patch"), status: "running" }
      );
    }

    return event(
      "tool.call.started",
      {
        name,
        args,
        callId,
        source: "openai-agents",
      },
      { itemId: itemIdFor(callId, "tool"), status: "running" }
    );
  }

  toolCompletedEvent(item) {
    const raw = item.rawItem ?? {};
    const callId = item.callId ?? raw.callId ?? raw.id;
    const remembered = callId ? this.toolCalls.get(callId) : undefined;
    const output = "output" in item ? item.output : raw.output;

    if (raw.type === "shell_call_output" || remembered?.name === "shell") {
      const summary = shellOutputSummary(output);
      return event(
        "codex.command.completed",
        {
          name: "shell",
          displayName: "bash (/sandbox)",
          toolProtocol: raw.type === "shell_call_output" ? "openai.shell" : "function.shell",
          executor: "bash",
          runtime: "docker",
          callId,
          ...summary,
          output: toJsonSafe(output),
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "command"), status: summary.ok ? "completed" : "failed" }
      );
    }

    if (raw.type === "apply_patch_call_output" || remembered?.name === "apply_patch") {
      return event(
        "codex.patch.completed",
        {
          name: "apply_patch",
          callId,
          status: raw.status,
          output: toJsonSafe(output),
          source: "openai-agents",
        },
        { itemId: itemIdFor(callId, "patch"), status: raw.status === "failed" ? "failed" : "completed" }
      );
    }

    if (remembered?.name === "workspace_export") {
      const parsed = parseJsonMaybe(output);
      const payload = typeof parsed === "string" ? parseJsonMaybe(parsed) : parsed;
      if (payload?.version_id || payload?.exported) {
        return event(
          "workspace.version.created",
          {
            name: "workspace_export",
            callId,
            versionId: payload.version_id,
            exported: payload.exported,
            output: toJsonSafe(payload),
            source: "openai-agents",
          },
          { itemId: itemIdFor(callId, "workspace_version"), status: "completed" }
        );
      }
    }

    return event(
      "tool.call.completed",
      {
        name: remembered?.name ?? raw.name ?? "unknown_tool",
        callId,
        output: toJsonSafe(output),
        source: "openai-agents",
      },
      { itemId: itemIdFor(callId, "tool"), status: "completed" }
    );
  }
}

function shellCommandText(action) {
  const commands = Array.isArray(action?.commands) ? action.commands : [];
  return commands.join("\n");
}

function shellOutputSummary(output) {
  const normalized = normalizeShellOutput(output);
  const rows = normalized.rows;
  const last = rows.at(-1) ?? {};
  const exitCode = last.outcome?.type === "exit" ? last.outcome.exitCode : null;
  const timedOut = rows.some((row) => row?.outcome?.type === "timeout");
  const stdout = rows.map((row) => row?.stdout ?? "").filter(Boolean).join("\n");
  const stderr = [
    rows.map((row) => row?.stderr ?? "").filter(Boolean).join("\n"),
    normalized.error,
  ].filter(Boolean).join("\n");
  return {
    ok: !normalized.error && !timedOut && rows.every((row) => row?.outcome?.type === "exit" && row.outcome.exitCode === 0),
    exitCode,
    timedOut,
    durationMs: numeric(last.duration_ms),
    stdout,
    stderr,
  };
}

function normalizeShellOutput(output) {
  const parsed = parseJsonMaybe(output);
  if (Array.isArray(parsed)) {
    return { rows: parsed, error: null };
  }
  if (Array.isArray(parsed?.output)) {
    return { rows: parsed.output, error: parsed.ok === false ? parsed.error ?? "Tool execution failed" : null };
  }
  if (parsed?.output) {
    return normalizeShellOutput(parsed.output);
  }
  if (parsed && typeof parsed === "object") {
    if ("stdout" in parsed || "stderr" in parsed || "outcome" in parsed) {
      return { rows: [parsed], error: null };
    }
    if (parsed.ok === false || parsed.error) {
      return { rows: [], error: parsed.error ?? "Tool execution failed" };
    }
  }
  if (typeof parsed === "string" && parsed.trim()) {
    return { rows: [], error: parsed };
  }
  return { rows: [], error: null };
}

export function itemIdFor(value, fallbackPrefix) {
  const raw = value ? String(value) : `${fallbackPrefix}_unknown`;
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

export function parseJsonMaybe(value) {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toJsonSafe(value) {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function reasoningSummaryText(item) {
  const raw = item?.rawItem ?? {};
  const chunks = [];
  for (const entry of arrayOrEmpty(raw.content)) {
    if (typeof entry?.text === "string") {
      chunks.push(entry.text);
    }
  }
  for (const entry of arrayOrEmpty(raw.summary)) {
    if (typeof entry?.text === "string") {
      chunks.push(entry.text);
    }
  }
  return chunks.join("").trim();
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
