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
      return [
        event(
          "assistant.reasoning_summary.done",
          {
            text: data.text ?? "",
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
      const payload = text ? { text, source: "openai-agents" } : { itemType: item.type };
      return [
        event(
          "assistant.reasoning_summary.done",
          payload,
          {
            itemId: itemIdFor(item.rawItem?.id ?? "reasoning_1", "reasoning"),
            status: "completed",
            visibility: text ? "user" : "debug",
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
