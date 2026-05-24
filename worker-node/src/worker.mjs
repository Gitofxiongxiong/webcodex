import path from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, OpenAIProvider, OpenAIResponsesCompactionSession, Runner, applyPatchTool, shellTool, webSearchTool } from "@openai/agents";
import OpenAI from "openai";

import { event, mustEnv, optionalEnv, postEvent, postEvents } from "./protocol.mjs";
import { SdkEventNormalizer, toJsonSafe } from "./sdk-events.mjs";
import { createModelProvider } from "./model-provider.mjs";
import { BackendConversationSession } from "./session.mjs";
import { AttachmentClient, createOpenAIUploadClient } from "./attachments.mjs";
import { createAgentRuntime, RuntimeShellExecutor } from "./runtime/docker-runtime.mjs";
import { RuntimeWorkspaceEditor } from "./runtime/workspace-editor.mjs";
import { makeRuntimeWorkspaceTools } from "./tools/runtime-workspace.mjs";
import { makeRuntimeFunctionTools } from "./tools/runtime-fallback.mjs";

const ASSISTANT_ITEM_ID = "assistant_1";

async function main() {
  const runId = mustEnv("RUN_ID");
  const conversationId = mustEnv("CONVERSATION_ID");
  const workspaceId = mustEnv("WORKSPACE_ID");
  const runWorkspaceDir = mustEnv("RUN_WORKSPACE_DIR");
  const runArtifactsDir = mustEnv("RUN_ARTIFACTS_DIR");
  const apiBaseUrl = mustEnv("API_BASE_URL");
  const workerToken = mustEnv("WORKER_TOKEN");
  const model = optionalEnv("OPENAI_MODEL", "gpt-5.5");
  const reasoningEffort = optionalEnv("OPENAI_REASONING_EFFORT", "xhigh");
  const reasoningSummary = optionalEnv("OPENAI_REASONING_SUMMARY", "detailed");
  const textVerbosity = optionalEnv("OPENAI_TEXT_VERBOSITY", "low");
  const serviceTier = optionalEnv("OPENAI_SERVICE_TIER", "priority");
  const speedMode = optionalEnv("OPENAI_SPEED_MODE", serviceTier === "priority" ? "fast" : "standard");
  const storeResponses = optionalEnv("OPENAI_STORE", "false") === "true";
  const apiProtocol = normalizeApiProtocol(optionalEnv("OPENAI_API_PROTOCOL", "responses"));
  const providerLabel = optionalEnv("OPENAI_MODEL_PROVIDER", "openai");
  const providerDefaults = providerDefaultsFor({ providerLabel, providerProfile: optionalEnv("OPENAI_PROVIDER_PROFILE", "auto") });
  const responsesRelayMode = apiProtocol === "responses" && resolveAutoBool(
    optionalEnv("OPENAI_RESPONSES_RELAY_MODE", "auto"),
    providerDefaults.responsesRelayMode
  );
  const sendServiceTier = resolveAutoBool(
    optionalEnv("OPENAI_SEND_SERVICE_TIER", "auto"),
    providerDefaults.sendServiceTier && !responsesRelayMode
  );
  const providerCapabilities = capabilitiesForProvider({
    apiProtocol,
    providerProfile: providerDefaults.providerProfile,
    responsesRelayMode,
    sendServiceTier,
  });
  const compactionModel = model;
  const compactionEnabled = apiProtocol === "responses" &&
    providerCapabilities.compaction &&
    optionalEnv("OPENAI_COMPACTION_ENABLED", "true") === "true";
  const debugModelRequests = optionalEnv("WORKER_DEBUG_MODEL_REQUESTS", "false") === "true";
  const runtimeToolMode = resolveRuntimeToolMode({
    value: optionalEnv("WORKER_RUNTIME_TOOL_MODE", "auto"),
    apiProtocol,
    providerCapabilities,
  });
  const runtime = await createAgentRuntime({
    mode: optionalEnv("WORKER_RUNTIME", "docker"),
    runId,
    workspaceDir: runWorkspaceDir,
    artifactsDir: runArtifactsDir,
    image: optionalEnv("WORKER_DOCKER_IMAGE", "webcodex-agent-runtime:latest"),
    containerName: optionalEnv("WORKER_CONTAINER_NAME", ""),
    autoBuild: optionalEnv("WORKER_DOCKER_AUTO_BUILD", "true") === "true",
    dockerfilePath: optionalEnv("WORKER_DOCKERFILE", ""),
    network: optionalEnv("WORKER_DOCKER_NETWORK", "bridge"),
    cpus: optionalEnv("WORKER_DOCKER_CPUS", "2"),
    memory: optionalEnv("WORKER_DOCKER_MEMORY", "4g"),
    pidsLimit: optionalEnv("WORKER_DOCKER_PIDS_LIMIT", "512"),
    keepContainer: optionalEnv("WORKER_KEEP_CONTAINER", "false") === "true",
  });
  const session = new BackendConversationSession({ conversationId, apiBaseUrl, workerToken });
  const sessionItems = await session.getItems();
  const attachmentClient = new AttachmentClient({
    apiBaseUrl,
    workerToken,
    sandboxDir: runWorkspaceDir,
    openaiClient: createOpenAIUploadClient({ uploadFiles: providerCapabilities.uploadFiles }),
    apiProtocol,
    relayMode: providerCapabilities.attachmentRelayMode,
  });
  const runInputPayload = await attachmentClient.getRunInput(runId);
  const runInput = await attachmentClient.buildRunInput({
    runId,
    input: runInputPayload.input,
    attachments: runInputPayload.attachments,
  });

  await postEvent(
    event("run.started", {
      runId,
      conversationId,
      workspaceId,
      runtime: "openai-agents-js",
      runtimeMode: runtime.mode,
      sandboxScope: "conversation",
      sandboxRoot: "/sandbox",
      artifactsRoot: "/artifacts",
      model,
      reasoningEffort,
      reasoningSummary,
      textVerbosity,
      serviceTier,
      speedMode,
      storeResponses,
      apiProtocol,
      compactionEnabled,
      compactionModel,
      responsesRelayMode,
      sendServiceTier,
      provider: providerLabel,
      providerProfile: providerCapabilities.providerProfile,
      runtimeToolMode,
      runtimeToolProtocol: runtimeToolProtocol(runtimeToolMode),
      runtimeToolModeReason: runtimeToolModeReason(runtimeToolMode, providerCapabilities, apiProtocol),
      inputItemCount: runInput.length,
      attachmentCount: runInputPayload.attachments?.length ?? 0,
      sessionId: await session.getSessionId(),
      sessionItemCount: sessionItems.length,
    })
  );
  await postEvent(
    event("run.runtime.started", {
      runWorkspaceDir,
      runArtifactsDir,
      containerName: runtime.containerName,
      containerId: runtime.containerId,
    }, { visibility: "debug" })
  );
  await postEvent(event("assistant.message.created", { role: "assistant" }, { itemId: ASSISTANT_ITEM_ID }));

  const agent = createCodexAgent({
    model,
    workspaceId,
    runtime,
    apiBaseUrl,
    workerToken,
    reasoningEffort,
    reasoningSummary,
    textVerbosity,
    serviceTier,
    storeResponses,
    apiProtocol,
    providerLabel,
    providerCapabilities,
    sendServiceTier,
    runtimeToolMode,
  });
  const openAIClient = createOpenAIClient();
  const provider = createModelProvider({
    provider: createOpenAIProvider(openAIClient),
    debugModelRequests,
    synthesizeEmptyResponseOutput: providerCapabilities.outputSynthesis,
  });
  try {
    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      workflowName: "WebCodex SDK run",
      traceIncludeSensitiveData: false,
    });
    const normalizer = new SdkEventNormalizer({ assistantItemId: ASSISTANT_ITEM_ID });
    const runSession = compactionEnabled && apiProtocol === "responses"
      ? new OpenAIResponsesCompactionSession({
        client: openAIClient,
        underlyingSession: session,
        model: compactionModel,
        compactionMode: "auto",
      })
      : session;
    const stream = await runner.run(agent, runInput, {
      stream: true,
      session: runSession,
      sessionInputCallback: (historyItems, newItems) => attachmentClient.sessionInputCallback(historyItems, newItems),
      maxTurns: positiveIntEnv("OPENAI_MAX_TURNS", 12),
      reasoningItemIdPolicy: "omit",
      callModelInputFilter: omitReasoningItemsFromReplay,
    });

    for await (const sdkEvent of stream) {
      await postEvents(normalizer.normalize(sdkEvent));
    }

    await stream.completed;
    await postCompactionUsageEvents({
      usage: stream.runContext?.usage,
      model: compactionModel,
      serviceTier,
      providerLabel,
    });

    await postEvent(
      event(
        "assistant.message.done",
        {
          text: stringifyFinalOutput(stream.finalOutput),
          lastAgent: stream.lastAgent?.name,
          lastResponseId: stream.lastResponseId,
        },
        { itemId: ASSISTANT_ITEM_ID, status: "completed" }
      )
    );
    await postEvent(
      event("run.completed", {
        ok: true,
        lastAgent: stream.lastAgent?.name,
        lastResponseId: stream.lastResponseId,
      })
    );
  } finally {
    await provider.close();
    await runtime.stop();
  }
}

function createCodexAgent({
  model,
  workspaceId,
  runtime,
  apiBaseUrl,
  workerToken,
  reasoningEffort,
  reasoningSummary,
  textVerbosity,
  serviceTier,
  storeResponses,
  apiProtocol,
  providerCapabilities,
  sendServiceTier,
  runtimeToolMode,
}) {
  const runtimeTools = runtimeToolMode === "function"
    ? makeRuntimeFunctionTools({ runtime })
    : [
      shellTool({
        name: "shell",
        environment: { type: "local" },
        shell: new RuntimeShellExecutor({ runtime }),
        needsApproval: false,
      }),
      applyPatchTool({
        editor: new RuntimeWorkspaceEditor({ runtime }),
        needsApproval: false,
      }),
    ];
  const hostedTools = providerCapabilities.hostedTools
    ? [
      webSearchTool({
        searchContextSize: "medium",
      }),
    ]
    : [];
  const instructions = [
    "You are the SDK-backed worker for WebCodex.",
    "Answer the user's coding request clearly and concretely.",
    "Use workspace_tree and workspace_rg to discover files in the persistent WebCodex workspace.",
    "Use workspace_import to copy workspace files into the active Docker /sandbox before inspecting or editing them locally.",
    "The active Docker /sandbox persists for the current conversation across turns; verify files with shell before relying on paths from older messages.",
    "Use the shell tool for bash, Python, curl, rg, file inspection, npm, tests, builds, HTML generation, and verification inside Docker /sandbox.",
    "Use apply_patch for file edits inside Docker /sandbox.",
    "IMPORTANT: For all user-visible math formulas, use KaTeX-compatible Markdown delimiters only: inline math must use `$...$`, and display math must use `$$...$$`. Do not use LaTeX delimiters `\\(...\\)` or `\\[...\\]` in final answers or generated Markdown.",
    "IMPORTANT: To give the user any generated file for download, write it under `/sandbox/outputs/` first, then include an export signal in the final answer exactly as Markdown image syntax: `![short description](sandbox://outputs/filename.ext)`. This syntax is required even for non-image files.",
    "IMPORTANT: The WebCodex backend only exports final-answer `sandbox://` references in that exact syntax. Use paths relative to `/sandbox` after `sandbox://`; do not use a leading slash, do not write `sandbox:///...`, and do not provide only a bare `/sandbox/...` path or inline-code path as the file handoff.",
    "Uploaded attachments are already copied into the sandbox at the paths listed in the user message and are also provided as model inputs when supported.",
    "Use shell commands such as cat, sed, file, Python, or other native CLI tools to inspect, parse, convert, or analyze uploaded files and images.",
    hostedTools.length
      ? "Use web_search for current public information from the web when freshness matters."
      : "When freshness matters, use curl through the shell tool to fetch or inspect public HTTP resources.",
    "Use curl through the shell tool when you need to fetch or inspect a specific URL or HTTP endpoint.",
    hostedTools.length
      ? "Only claim access to Docker /sandbox, /artifacts, web_search, and workspace bridge tools. Do not claim direct host filesystem access."
      : "Only claim access to Docker /sandbox, /artifacts, and workspace bridge tools. Do not claim direct host filesystem access or hosted web_search.",
    "When you write or export a file, briefly mention the path and purpose.",
    `Current workspace id: ${workspaceId}.`,
    "Current Docker working directory: /sandbox.",
  ];
  return new Agent({
    name: "WebCodex Coding Agent",
    model,
    modelSettings: modelSettingsFromEnv({
      reasoningEffort,
      reasoningSummary,
      textVerbosity,
      serviceTier,
      storeResponses,
      sendServiceTier,
    }),
    instructions: instructions.join("\n"),
    tools: [
      ...hostedTools,
      ...runtimeTools,
      ...makeRuntimeWorkspaceTools({ runtime, apiBaseUrl, workerToken, workspaceId }),
    ],
  });
}

function modelSettingsFromEnv({ reasoningEffort, reasoningSummary, textVerbosity, serviceTier, storeResponses, sendServiceTier }) {
  return {
    reasoning: {
      effort: reasoningEffort,
      summary: reasoningSummary,
    },
    text: {
      verbosity: textVerbosity,
    },
    providerData: sendServiceTier ? { service_tier: serviceTier } : {},
    parallelToolCalls: true,
    store: storeResponses,
  };
}

function stringifyFinalOutput(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(toJsonSafe(value));
}

function omitReasoningItemsFromReplay({ modelData }) {
  return {
    ...modelData,
    input: modelData.input.filter((item) => item?.type !== "reasoning"),
  };
}

function createOpenAIClient() {
  const apiKey = optionalEnv("OPENAI_API_KEY", "");
  const baseURL = optionalEnv("OPENAI_BASE_URL", "");
  return new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
}

function createOpenAIProvider(openAIClient) {
  const apiProtocol = normalizeApiProtocol(optionalEnv("OPENAI_API_PROTOCOL", "responses"));
  return new OpenAIProvider({
    openAIClient,
    useResponses: apiProtocol === "responses",
    useResponsesWebSocket: false,
    cacheResponsesWebSocketModels: false,
  });
}

export function providerDefaultsFor({ providerLabel, providerProfile }) {
  const normalizedProvider = String(providerLabel ?? "openai").trim().toLowerCase();
  const normalizedProfile = String(providerProfile ?? "auto").trim().toLowerCase();
  const defaultProfile = ["codex-relay", "new-api-codex"].includes(normalizedProvider)
    ? "codex-responses"
    : "official";
  const resolvedProfile = normalizedProfile && normalizedProfile !== "auto" ? normalizedProfile : defaultProfile;
  const codexResponses = resolvedProfile === "codex-responses";
  return {
    providerProfile: resolvedProfile,
    responsesRelayMode: codexResponses,
    sendServiceTier: !codexResponses,
  };
}

export function capabilitiesForProvider({ apiProtocol, providerProfile, responsesRelayMode, sendServiceTier }) {
  const responses = apiProtocol === "responses";
  const relayMode = responses && Boolean(responsesRelayMode);
  return {
    providerProfile,
    responsesRelayMode: relayMode,
    outputSynthesis: relayMode,
    hostedTools: responses && !relayMode,
    compaction: responses && !relayMode,
    uploadFiles: !relayMode,
    attachmentRelayMode: relayMode,
    sendServiceTier,
    officialRuntimeTools: responses && !relayMode,
  };
}

export function resolveRuntimeToolMode({ value, apiProtocol, providerCapabilities }) {
  const normalized = String(value ?? "auto").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "sdk" || normalized === "official" || normalized === "native") {
    if (apiProtocol === "chat_completions") {
      throw new Error("WORKER_RUNTIME_TOOL_MODE=sdk requires OPENAI_API_PROTOCOL=responses");
    }
    return "sdk";
  }
  if (normalized === "function" || normalized === "functions" || normalized === "legacy" || normalized === "compat") {
    return "function";
  }
  if (normalized && normalized !== "auto") {
    throw new Error(`Unsupported WORKER_RUNTIME_TOOL_MODE: ${value}`);
  }
  if (apiProtocol === "chat_completions") {
    return "function";
  }
  return providerCapabilities?.officialRuntimeTools ? "sdk" : "function";
}

export function runtimeToolProtocol(runtimeToolMode) {
  return runtimeToolMode === "sdk" ? "openai.shell/apply_patch" : "function.shell/apply_patch";
}

export function runtimeToolModeReason(runtimeToolMode, providerCapabilities, apiProtocol) {
  if (apiProtocol === "chat_completions") {
    return "Chat Completions does not support Responses shell/apply_patch tools.";
  }
  if (runtimeToolMode === "sdk") {
    if (!providerCapabilities?.officialRuntimeTools) {
      return "Forced by WORKER_RUNTIME_TOOL_MODE=sdk; the current provider profile may reject official shell/apply_patch tool definitions.";
    }
    return "Provider profile supports official Responses shell/apply_patch tools.";
  }
  if (providerCapabilities?.responsesRelayMode) {
    return "Responses relay mode uses function tools because the upstream relay does not accept official shell/apply_patch tool definitions.";
  }
  return "Function tools selected by configuration.";
}

async function postCompactionUsageEvents({ usage, model, serviceTier, providerLabel }) {
  const entries = usage?.requestUsageEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  const compactionEntries = entries.filter((entry) => entry?.endpoint === "responses.compact");
  for (const [index, entry] of compactionEntries.entries()) {
    await postEvent(
      event(
        "model.usage",
        {
          callId: `responses_compact_${index + 1}`,
          callIndex: null,
          mode: "compact",
          model,
          provider: providerLabel,
          serviceTier,
          endpoint: "responses.compact",
          source: "responses.compact",
          usage: normalizeRequestUsageEntry(entry),
        },
        { itemId: `responses_compact_${index + 1}`, status: "completed", visibility: "debug" }
      )
    );
  }
}

function normalizeRequestUsageEntry(entry) {
  const inputTokens = numeric(entry?.inputTokens ?? entry?.input_tokens);
  const outputTokens = numeric(entry?.outputTokens ?? entry?.output_tokens);
  const inputDetails = entry?.inputTokensDetails ?? entry?.input_tokens_details ?? {};
  const outputDetails = entry?.outputTokensDetails ?? entry?.output_tokens_details ?? {};
  return {
    inputTokens,
    cachedTokens: numeric(inputDetails.cachedTokens ?? inputDetails.cached_tokens),
    outputTokens,
    reasoningTokens: numeric(outputDetails.reasoningTokens ?? outputDetails.reasoning_tokens),
    totalTokens: numeric(entry?.totalTokens ?? entry?.total_tokens ?? inputTokens + outputTokens),
    inputTokensDetails: inputDetails,
    outputTokensDetails: outputDetails,
  };
}

export function normalizeApiProtocol(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "chat" || normalized === "chat_completions") {
    return "chat_completions";
  }
  return "responses";
}

function resolveAutoBool(value, fallback) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "auto" || normalized === "") {
    return Boolean(fallback);
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function positiveIntEnv(name, fallback) {
  const value = Number(optionalEnv(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

if (isEntrypoint(import.meta.url)) {
  main().catch(async (error) => {
    console.error(error);
    try {
      await postEvent(
        event(
          "run.failed",
          {
            error: error.message,
            name: error.name,
            ...modelErrorDiagnostics(error),
            stack: error.stack,
          },
          { status: "failed" }
        )
      );
    } catch (postError) {
      console.error(postError);
    }
    process.exit(1);
  });
}

function isEntrypoint(metaUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(fileURLToPath(metaUrl)) === path.resolve(entry);
}

function modelErrorDiagnostics(error) {
  const headers = headersToRecord(error?.headers);
  const upstream = isRecord(error?.error) ? error.error : null;
  return {
    status: typeof error?.status === "number" ? error.status : null,
    code: stringOrNull(error?.code ?? upstream?.code),
    type: stringOrNull(error?.type ?? upstream?.type),
    param: stringOrNull(error?.param ?? upstream?.param),
    requestId: stringOrNull(error?.requestID ?? headers["x-request-id"]),
    upstreamRequestId: stringOrNull(headers["x-oneapi-request-id"]),
    upstreamVersion: stringOrNull(headers["x-new-api-version"]),
    upstreamError: upstream
      ? {
        message: stringOrNull(upstream.message),
        type: stringOrNull(upstream.type),
        param: stringOrNull(upstream.param),
        code: stringOrNull(upstream.code),
      }
      : null,
  };
}

function headersToRecord(headers) {
  const result = {};
  if (!headers) {
    return result;
  }
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      if (typeof key === "string") {
        result[key.toLowerCase()] = String(value);
      }
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (typeof key === "string") {
        result[key.toLowerCase()] = String(value);
      }
    }
  }
  return result;
}

function stringOrNull(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
