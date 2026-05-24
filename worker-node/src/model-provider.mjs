import { encodingForModel, getEncoding } from "js-tiktoken";

import { event, postEvent } from "./protocol.mjs";

export function createModelProvider({ provider, debugModelRequests = false, synthesizeEmptyResponseOutput = false }) {
  return new RequestInspectingModelProvider({ provider, debugModelRequests, synthesizeEmptyResponseOutput });
}

class RequestInspectingModelProvider {
  constructor({ provider, debugModelRequests, synthesizeEmptyResponseOutput }) {
    this.provider = provider;
    this.debugModelRequests = debugModelRequests;
    this.synthesizeEmptyResponseOutput = Boolean(synthesizeEmptyResponseOutput);
  }

  async getModel(modelName) {
    const model = await this.provider.getModel(modelName);
    return new RequestInspectingModel({
      model,
      modelName,
      debugModelRequests: this.debugModelRequests,
      synthesizeEmptyResponseOutput: this.synthesizeEmptyResponseOutput,
    });
  }

  async close() {
    if (typeof this.provider.close === "function") {
      await this.provider.close();
    }
  }
}

class RequestInspectingModel {
  constructor({ model, modelName, debugModelRequests, synthesizeEmptyResponseOutput }) {
    this.model = model;
    this.modelName = modelName;
    this.debugModelRequests = debugModelRequests;
    this.synthesizeEmptyResponseOutput = Boolean(synthesizeEmptyResponseOutput);
    this.callIndex = 0;
  }

  async getResponse(request) {
    const call = await this.beforeCall("response", request);
    const response = this.synthesizeEmptyResponseOutput
      ? synthesizeResponseOutputFromProviderData(await this.model.getResponse(request), call)
      : await this.model.getResponse(request);
    await this.postUsageFromModelResponse(call, request, response);
    return response;
  }

  getStreamedResponse(request) {
    return this.streamWithUsage(request);
  }

  async *streamWithUsage(request) {
    const call = await this.beforeCall("stream", request);
    const outputSynthesizer = this.synthesizeEmptyResponseOutput ? new StreamOutputSynthesizer(call) : null;
    for await (const streamEvent of this.model.getStreamedResponse(request)) {
      const outgoingEvent = outputSynthesizer ? outputSynthesizer.rewrite(streamEvent) : streamEvent;
      if (outgoingEvent?.type === "response_done") {
        await this.postUsageFromStreamResponse(call, request, outgoingEvent.response);
      }
      yield outgoingEvent;
    }
  }

  getRetryAdvice(args) {
    if (typeof this.model.getRetryAdvice !== "function") {
      return undefined;
    }
    return this.model.getRetryAdvice.call(this.model, args);
  }

  logRequest(mode, request) {
    if (!this.debugModelRequests) {
      return;
    }
    console.error(`[model-request:${mode}] ${JSON.stringify(summarizeRequest(request))}`);
  }

  async beforeCall(mode, request) {
    this.callIndex += 1;
    const call = {
      callId: `model_call_${this.callIndex}`,
      callIndex: this.callIndex,
      model: this.modelName,
      mode,
    };
    this.logRequest(mode, request);
    await postEventSafe(
      event("context.estimated", estimateContextPayload({ call, request }), {
        itemId: call.callId,
        status: "estimated",
      })
    );
    return call;
  }

  async postUsageFromModelResponse(call, request, response) {
    const usage = normalizeUsage(response?.usage);
    if (!hasAnyUsage(usage)) {
      return;
    }
    await postEventSafe(
      event("model.usage", usagePayload({ call, request, usage, response }), {
        itemId: call.callId,
        status: "completed",
      })
    );
  }

  async postUsageFromStreamResponse(call, request, response) {
    const usage = normalizeUsage(response?.usage);
    if (!hasAnyUsage(usage)) {
      return;
    }
    await postEventSafe(
      event("model.usage", usagePayload({ call, request, usage, response }), {
        itemId: call.callId,
        status: "completed",
      })
    );
  }
}

class StreamOutputSynthesizer {
  constructor(call) {
    this.call = call;
    this.outputText = "";
    this.outputItems = [];
    this.outputItemKeys = new Map();
    this.partialFunctionCalls = new Map();
    this.outputSequence = 0;
  }

  rewrite(streamEvent) {
    this.recordStreamEvent(streamEvent);
    if (streamEvent?.type === "output_text_delta" && typeof streamEvent.delta === "string") {
      this.outputText += streamEvent.delta;
      return streamEvent;
    }
    if (streamEvent?.type !== "response_done") {
      return streamEvent;
    }
    return synthesizeResponseOutputFromStreamItems(streamEvent, this.outputItems, this.outputText, this.call);
  }

  recordStreamEvent(streamEvent) {
    if (streamEvent?.type !== "model" || !isRecord(streamEvent.event)) {
      return;
    }
    const rawEvent = streamEvent.event;
    if (rawEvent.type === "response.output_item.added" && isRecord(rawEvent.item)) {
      this.recordPartialFunctionCall(rawEvent.item);
      return;
    }
    if (rawEvent.type === "response.output_item.done" && isRecord(rawEvent.item)) {
      this.upsertOutputItem(rawEvent.item, numeric(rawEvent.output_index));
      return;
    }
    if (rawEvent.type === "response.function_call_arguments.done") {
      const callId = stringValue(rawEvent.call_id);
      const partial = callId ? this.partialFunctionCalls.get(callId) : null;
      const name = stringValue(rawEvent.name) || stringValue(partial?.name);
      if (!callId || !name) {
        return;
      }
      this.upsertOutputItem(
        {
          id: stringValue(rawEvent.item_id) || stringValue(partial?.id) || `fc_${callId}`,
          type: "function_call",
          status: "completed",
          call_id: callId,
          name,
          ...(typeof partial?.namespace === "string" ? { namespace: partial.namespace } : {}),
          arguments: typeof rawEvent.arguments === "string" ? rawEvent.arguments : "",
        },
        numeric(rawEvent.output_index)
      );
    }
  }

  recordPartialFunctionCall(rawItem) {
    if (rawItem?.type !== "function_call") {
      return;
    }
    const callId = stringValue(rawItem.call_id);
    if (!callId) {
      return;
    }
    this.partialFunctionCalls.set(callId, {
      id: stringValue(rawItem.id),
      call_id: callId,
      name: stringValue(rawItem.name),
      namespace: typeof rawItem.namespace === "string" ? rawItem.namespace : undefined,
    });
  }

  upsertOutputItem(rawItem, outputIndex) {
    const output = modelOutputFromRawResponseItem(rawItem);
    if (!output) {
      return;
    }
    const key = output.callId ?? output.id ?? `${output.type}_${this.outputSequence}`;
    const existingIndex = this.outputItemKeys.get(key);
    const entry = {
      index: Number.isFinite(outputIndex) ? outputIndex : Number.MAX_SAFE_INTEGER,
      sequence: this.outputSequence++,
      output,
    };
    if (existingIndex === undefined) {
      this.outputItemKeys.set(key, this.outputItems.length);
      this.outputItems.push(entry);
      return;
    }
    const existing = this.outputItems[existingIndex];
    this.outputItems[existingIndex] = {
      ...entry,
      sequence: existing?.sequence ?? entry.sequence,
      output: mergeModelOutput(existing?.output, output),
    };
  }
}

function synthesizeResponseOutputFromProviderData(response, call) {
  if (hasModelOutput(response)) {
    return response;
  }
  const providerText = providerOutputText(response?.providerData);
  if (!providerText) {
    return response;
  }
  return {
    ...response,
    output: [assistantMessageOutput(providerText, call)],
    providerData: {
      ...(response?.providerData ?? {}),
      synthesized_output_from_text: true,
    },
  };
}

function synthesizeResponseOutputFromText(streamEvent, outputText, call) {
  if (hasModelOutput(streamEvent?.response)) {
    return streamEvent;
  }
  const text = outputText || providerOutputText(streamEvent?.response?.providerData);
  if (!text) {
    return streamEvent;
  }
  return {
    ...streamEvent,
    response: {
      ...streamEvent.response,
      output: [assistantMessageOutput(text, call)],
      providerData: {
        ...(streamEvent.response?.providerData ?? {}),
        synthesized_output_from_text: true,
      },
    },
  };
}

function synthesizeResponseOutputFromStreamItems(streamEvent, collectedItems, outputText, call) {
  const output = collectedItems
    .slice()
    .sort((left, right) => left.index - right.index || left.sequence - right.sequence)
    .map((entry) => entry.output);
  if (hasModelOutput(streamEvent?.response)) {
    const mergedOutput = mergeResponseOutputItems(streamEvent.response.output, output);
    if (mergedOutput.length === streamEvent.response.output.length) {
      return streamEvent;
    }
    return {
      ...streamEvent,
      response: {
        ...streamEvent.response,
        output: mergedOutput,
        providerData: {
          ...(streamEvent.response.providerData ?? {}),
          synthesized_output_from_stream_items: true,
        },
      },
    };
  }
  if (output.length === 0) {
    return synthesizeResponseOutputFromText(streamEvent, outputText, call);
  }
  return {
    ...streamEvent,
    response: {
      ...streamEvent.response,
      output,
      providerData: {
        ...(streamEvent.response?.providerData ?? {}),
        synthesized_output_from_stream_items: true,
      },
    },
  };
}

function mergeResponseOutputItems(existingOutput, collectedOutput) {
  const merged = Array.isArray(existingOutput) ? [...existingOutput] : [];
  const existingKeys = new Set(merged.map(outputItemKey).filter(Boolean));
  for (const item of collectedOutput) {
    const key = outputItemKey(item);
    if (key && existingKeys.has(key)) {
      continue;
    }
    merged.push(item);
    if (key) {
      existingKeys.add(key);
    }
  }
  return merged;
}

function outputItemKey(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const type = typeof item.type === "string" ? item.type : "item";
  const callId = stringValue(item.callId ?? item.call_id);
  if (callId) {
    return `${type}:call:${callId}`;
  }
  const id = stringValue(item.id);
  return id ? `${type}:id:${id}` : "";
}

function assistantMessageOutput(text, call) {
  return {
    id: `msg_${call.callId}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function modelOutputFromRawResponseItem(item) {
  if (!isRecord(item) || typeof item.type !== "string") {
    return null;
  }
  if (item.type === "message") {
    return messageOutputFromRawResponseItem(item);
  }
  if (item.type === "function_call") {
    const callId = stringValue(item.call_id);
    const name = stringValue(item.name);
    if (!callId || !name) {
      return null;
    }
    return {
      id: stringValue(item.id) || undefined,
      type: "function_call",
      callId,
      name,
      ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
      status: stringValue(item.status) || "completed",
      arguments: typeof item.arguments === "string" ? item.arguments : "",
      providerData: providerDataWithout(item, ["id", "type", "call_id", "name", "namespace", "status", "arguments"]),
    };
  }
  if (item.type === "reasoning") {
    return {
      id: stringValue(item.id) || undefined,
      type: "reasoning",
      content: arrayOrEmpty(item.summary).map((content) => ({
        type: "input_text",
        text: stringValue(content?.text),
        providerData: providerDataWithout(content, ["text"]),
      })),
      providerData: providerDataWithout(item, ["id", "type", "summary"]),
    };
  }
  if (item.type === "shell_call") {
    return {
      id: stringValue(item.id) || undefined,
      type: "shell_call",
      callId: stringValue(item.call_id),
      status: stringValue(item.status) || "in_progress",
      action: {
        commands: arrayOrEmpty(item.action?.commands).map(String),
        ...(typeof item.action?.timeout_ms === "number" ? { timeoutMs: item.action.timeout_ms } : {}),
        ...(typeof item.action?.max_output_length === "number" ? { maxOutputLength: item.action.max_output_length } : {}),
      },
      providerData: providerDataWithout(item, ["id", "type", "call_id", "status", "action"]),
    };
  }
  if (item.type === "apply_patch_call") {
    return {
      id: stringValue(item.id) || undefined,
      type: "apply_patch_call",
      callId: stringValue(item.call_id),
      status: stringValue(item.status) || "in_progress",
      operation: item.operation,
      providerData: providerDataWithout(item, ["id", "type", "call_id", "status", "operation"]),
    };
  }
  return null;
}

function messageOutputFromRawResponseItem(item) {
  const content = arrayOrEmpty(item.content)
    .map((part) => {
      if (part?.type === "output_text") {
        return {
          type: "output_text",
          text: stringValue(part.text),
          providerData: providerDataWithout(part, ["type", "text"]),
        };
      }
      if (part?.type === "refusal") {
        return {
          type: "refusal",
          refusal: stringValue(part.refusal),
          providerData: providerDataWithout(part, ["type", "refusal"]),
        };
      }
      return null;
    })
    .filter(Boolean);
  if (content.length === 0) {
    return null;
  }
  return {
    id: stringValue(item.id) || undefined,
    type: "message",
    role: stringValue(item.role) || "assistant",
    status: stringValue(item.status) || "completed",
    content,
    providerData: providerDataWithout(item, ["id", "type", "role", "status", "content"]),
  };
}

function mergeModelOutput(existing, next) {
  if (!existing || existing.type !== "function_call" || next?.type !== "function_call") {
    return next;
  }
  return {
    ...existing,
    ...next,
    arguments: next.arguments || existing.arguments || "",
  };
}

function hasModelOutput(response) {
  return Array.isArray(response?.output) && response.output.length > 0;
}

function providerOutputText(providerData) {
  const value = providerData?.output_text ?? providerData?.text;
  return typeof value === "string" && value ? value : "";
}

function summarizeRequest(request) {
  const input = Array.isArray(request.input) ? request.input : [{ type: "text" }];
  return {
    previousResponseId: request.previousResponseId ?? null,
    conversationId: request.conversationId ?? null,
    store: request.modelSettings?.store ?? null,
    serviceTier: request.modelSettings?.providerData?.service_tier ?? null,
    reasoning: request.modelSettings?.reasoning ?? null,
    inputCount: input.length,
    inputTypes: input.map((item) => item?.type ?? typeof item),
    toolCount: request.tools?.length ?? 0,
  };
}

async function postEventSafe(eventBody) {
  try {
    await postEvent(eventBody);
  } catch (error) {
    console.error(`[usage-event] failed to post ${eventBody.type}: ${error.message}`);
  }
}

function estimateContextPayload({ call, request }) {
  const model = call.model ?? "unknown";
  const contextWindow = contextWindowForModel(model);
  const reservedOutputTokens = reservedOutputTokensForModel(model);
  const usableContextTokens = Math.max(contextWindow - reservedOutputTokens, 1);
  const breakdown = estimatePromptBreakdown({ request, model });
  const inputTokensEstimate = sumBreakdownTokens(breakdown);
  const usedPercent = clampPercent((inputTokensEstimate / usableContextTokens) * 100);
  const remainingTokens = Math.max(usableContextTokens - inputTokensEstimate, 0);

  return {
    callId: call.callId,
    callIndex: call.callIndex,
    mode: call.mode,
    model,
    provider: process.env.OPENAI_MODEL_PROVIDER ?? null,
    serviceTier: serviceTierFromRequest(request),
    contextWindow,
    reservedOutputTokens,
    usableContextTokens,
    inputTokensEstimate,
    remainingTokens,
    usedPercent,
    source: "local-estimate",
    tokenizer: tokenizerNameForModel(model),
    breakdown: withPercentages(breakdown, usableContextTokens),
  };
}

function usagePayload({ call, request, usage, response }) {
  const model = call.model ?? response?.providerData?.model ?? "unknown";
  const requestUsageEntry = firstRequestUsageEntry(response?.usage);
  const contextWindow = contextWindowForModel(model);
  const reservedOutputTokens = reservedOutputTokensForModel(model);
  const usableContextTokens = Math.max(contextWindow - reservedOutputTokens, 1);
  const inputTokens = usage.inputTokens;
  return {
    callId: call.callId,
    callIndex: call.callIndex,
    mode: call.mode,
    model,
    provider: process.env.OPENAI_MODEL_PROVIDER ?? null,
    serviceTier: serviceTierFromRequest(request) ?? response?.providerData?.service_tier ?? null,
    responseId: response?.responseId ?? response?.id ?? null,
    requestId: response?.requestId ?? null,
    contextWindow,
    reservedOutputTokens,
    usableContextTokens,
    remainingTokens: Math.max(usableContextTokens - inputTokens, 0),
    usedPercent: clampPercent((inputTokens / usableContextTokens) * 100),
    endpoint: requestUsageEntry?.endpoint ?? null,
    source: requestUsageEntry?.endpoint === "responses.compact" ? "responses.compact" : "provider-usage",
    usage,
  };
}

function estimatePromptBreakdown({ request, model }) {
  const inputItems = Array.isArray(request.input) ? request.input : [request.input].filter(Boolean);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const systemInstructions =
    request.systemInstructions ??
    request.instructions ??
    request.modelSettings?.instructions ??
    request.modelSettings?.systemInstructions ??
    "";
  const prompt = request.prompt ?? null;
  const inputParts = classifyInputItems(inputItems);
  const breakdown = [
    breakdownPart("system", "系统提示", systemInstructions, model),
    breakdownPart("prompt", "Prompt 模板", prompt, model),
    breakdownPart("tools", "工具定义", tools, model),
    breakdownPart("history", "历史对话", inputParts.history, model),
    breakdownPart("current_user", "当前输入", inputParts.currentUser, model),
    breakdownPart("tool_results", "工具结果", inputParts.toolResults, model),
    breakdownPart("workspace", "工作区上下文", inputParts.workspaceContext, model),
  ].filter((part) => part.tokens > 0);

  const protocolTokens = estimateProtocolOverhead({
    inputItemCount: inputItems.length,
    toolCount: tools.length,
    hasSystemInstructions: Boolean(stringifyForTokenCount(systemInstructions).trim()),
  });
  if (protocolTokens > 0) {
    breakdown.push({
      key: "protocol",
      label: "协议开销",
      tokens: protocolTokens,
      source: "heuristic",
    });
  }
  return breakdown;
}

function classifyInputItems(inputItems) {
  const history = [];
  const currentUser = [];
  const toolResults = [];
  const workspaceContext = [];

  inputItems.forEach((item, index) => {
    const text = textFromInputItem(item);
    if (!text) {
      return;
    }
    const type = item?.type ?? "";
    const role = item?.role ?? "";
    if (type.includes("tool") || role === "tool" || type === "function_call_output") {
      toolResults.push(text);
    } else if (looksLikeWorkspaceContext(text)) {
      workspaceContext.push(text);
    } else if (index === inputItems.length - 1 && role === "user") {
      currentUser.push(text);
    } else {
      history.push(text);
    }
  });

  return {
    history: history.join("\n"),
    currentUser: currentUser.join("\n"),
    toolResults: toolResults.join("\n"),
    workspaceContext: workspaceContext.join("\n"),
  };
}

function textFromInputItem(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return stringifyForTokenCount(item);
  }
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textFromContentPart).filter(Boolean).join("\n");
  }
  const output = item.output;
  if (typeof output === "string") {
    return output;
  }
  return stringifyForTokenCount(item);
}

function textFromContentPart(part) {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  return part.text ?? part.input_text ?? part.output_text ?? part.content ?? stringifyForTokenCount(part);
}

function looksLikeWorkspaceContext(text) {
  return /\b(workspace_|sandbox|file|path|blob_sha256|workspace_read|workspace_import|workspace_export)\b/i.test(text);
}

function breakdownPart(key, label, value, model) {
  const text = stringifyForTokenCount(value);
  return {
    key,
    label: stablePromptPartLabel(key, label),
    tokens: countTextTokens(text, model),
    source: "local-tokenizer",
  };
}

function stablePromptPartLabel(key, fallback) {
  const labels = {
    system: "System prompt",
    prompt: "Prompt template",
    tools: "Tool definitions",
    history: "Conversation history",
    current_user: "Current input",
    tool_results: "Tool results",
    workspace: "Workspace context",
    protocol: "Protocol overhead",
  };
  return labels[key] ?? fallback ?? key ?? "Other";
}

function stringifyForTokenCount(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function countTextTokens(text, model) {
  if (!text) {
    return 0;
  }
  const encoder = getEncoder(model);
  if (encoder) {
    return encoder.encode(text).length;
  }
  return estimateTokensByChars(text);
}

function getEncoder(model) {
  try {
    return encodingForModel(model);
  } catch {
    try {
      return getEncoding(tokenizerNameForModel(model));
    } catch {
      return null;
    }
  }
}

function tokenizerNameForModel(model) {
  const normalized = String(model ?? "").toLowerCase();
  if (
    normalized.startsWith("gpt-4o") ||
    normalized.startsWith("gpt-4.1") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return "o200k_base";
  }
  return "cl100k_base";
}

function estimateTokensByChars(text) {
  let tokens = 0;
  for (const char of text) {
    if (/\s/.test(char)) {
      tokens += 0.25;
    } else if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) {
      tokens += 0.9;
    } else {
      tokens += 0.35;
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

function estimateProtocolOverhead({ inputItemCount, toolCount, hasSystemInstructions }) {
  return inputItemCount * 3 + toolCount * 8 + (hasSystemInstructions ? 3 : 0) + 3;
}

function normalizeUsage(usage) {
  if (!usage) {
    return {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
  }
  const requestUsageEntry = firstRequestUsageEntry(usage);
  const inputTokens = numeric(requestUsageEntry?.inputTokens ?? requestUsageEntry?.input_tokens ?? usage.inputTokens ?? usage.input_tokens);
  const outputTokens = numeric(requestUsageEntry?.outputTokens ?? requestUsageEntry?.output_tokens ?? usage.outputTokens ?? usage.output_tokens);
  const totalTokens = numeric(requestUsageEntry?.totalTokens ?? requestUsageEntry?.total_tokens ?? usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens);
  const inputDetails = requestUsageEntry?.inputTokensDetails ?? requestUsageEntry?.input_tokens_details ?? usage.inputTokensDetails ?? usage.input_tokens_details ?? {};
  const outputDetails = requestUsageEntry?.outputTokensDetails ?? requestUsageEntry?.output_tokens_details ?? usage.outputTokensDetails ?? usage.output_tokens_details ?? {};
  return {
    inputTokens,
    cachedTokens: numeric(inputDetails.cachedTokens ?? inputDetails.cached_tokens),
    outputTokens,
    reasoningTokens: numeric(outputDetails.reasoningTokens ?? outputDetails.reasoning_tokens),
    totalTokens,
    inputTokensDetails: inputDetails,
    outputTokensDetails: outputDetails,
  };
}

function firstRequestUsageEntry(usage) {
  const entries = usage?.requestUsageEntries ?? usage?.request_usage_entries;
  return Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
}

function hasAnyUsage(usage) {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0;
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function providerDataWithout(source, keys) {
  if (!isRecord(source)) {
    return {};
  }
  const ignored = new Set(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !ignored.has(key)));
}

function sumBreakdownTokens(breakdown) {
  return breakdown.reduce((sum, part) => sum + numeric(part.tokens), 0);
}

function withPercentages(breakdown, denominator) {
  return breakdown.map((part) => ({
    ...part,
    label: stablePromptPartLabel(part.key, part.label),
    percent: clampPercent((part.tokens / denominator) * 100),
  }));
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function serviceTierFromRequest(request) {
  return request.modelSettings?.providerData?.service_tier ?? null;
}

function contextWindowForModel(model) {
  const normalized = String(model ?? "").toLowerCase();
  if (normalized.includes("gpt-5") || normalized.includes("gpt-4.1") || normalized.includes("gpt-4o")) {
    return 128000;
  }
  if (normalized.includes("o3") || normalized.includes("o4")) {
    return 128000;
  }
  return 128000;
}

function reservedOutputTokensForModel(_model) {
  return 8192;
}
