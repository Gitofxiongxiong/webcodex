import { Agent, OpenAIProvider, Runner, applyPatchTool, shellTool, webSearchTool } from "@openai/agents";

import { event, mustEnv, optionalEnv, postEvent, postEvents } from "./protocol.mjs";
import { SdkEventNormalizer, toJsonSafe } from "./sdk-events.mjs";
import { createModelProvider } from "./model-provider.mjs";
import { BackendConversationSession } from "./session.mjs";
import { AttachmentClient, createOpenAIUploadClient } from "./attachments.mjs";
import { createAgentRuntime, RuntimeShellExecutor } from "./runtime/docker-runtime.mjs";
import { RuntimeWorkspaceEditor } from "./runtime/workspace-editor.mjs";
import { makeRuntimeWorkspaceTools } from "./tools/runtime-workspace.mjs";
import { makeViewTool2 } from "./tools/view-tool2.mjs";
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
  const model = optionalEnv("OPENAI_MODEL", "gpt-5.4");
  const reasoningEffort = optionalEnv("OPENAI_REASONING_EFFORT", "xhigh");
  const reasoningSummary = optionalEnv("OPENAI_REASONING_SUMMARY", "detailed");
  const textVerbosity = optionalEnv("OPENAI_TEXT_VERBOSITY", "low");
  const serviceTier = optionalEnv("OPENAI_SERVICE_TIER", "priority");
  const speedMode = optionalEnv("OPENAI_SPEED_MODE", serviceTier === "priority" ? "fast" : "standard");
  const storeResponses = optionalEnv("OPENAI_STORE", "false") === "true";
  const providerLabel = optionalEnv("OPENAI_MODEL_PROVIDER", "openai");
  const debugModelRequests = optionalEnv("WORKER_DEBUG_MODEL_REQUESTS", "false") === "true";
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
    openaiClient: createOpenAIUploadClient(),
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
      runWorkspaceDir,
      runArtifactsDir,
      containerName: runtime.containerName,
      containerId: runtime.containerId,
      model,
      reasoningEffort,
      reasoningSummary,
      textVerbosity,
      serviceTier,
      speedMode,
      storeResponses,
      provider: providerLabel,
      inputItemCount: runInput.length,
      attachmentCount: runInputPayload.attachments?.length ?? 0,
      sessionId: await session.getSessionId(),
      sessionItemCount: sessionItems.length,
    })
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
    providerLabel,
  });
  const provider = createModelProvider({
    provider: createOpenAIProvider(),
    debugModelRequests,
  });
  try {
    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      workflowName: "WebCodex SDK run",
      traceIncludeSensitiveData: false,
    });
    const normalizer = new SdkEventNormalizer({ assistantItemId: ASSISTANT_ITEM_ID });
    const stream = await runner.run(agent, runInput, {
      stream: true,
      session,
      sessionInputCallback: (historyItems, newItems) => attachmentClient.sessionInputCallback(historyItems, newItems),
      maxTurns: positiveIntEnv("OPENAI_MAX_TURNS", 12),
      reasoningItemIdPolicy: "omit",
      callModelInputFilter: omitReasoningItemsFromReplay,
    });

    for await (const sdkEvent of stream) {
      await postEvents(normalizer.normalize(sdkEvent));
    }

    await stream.completed;

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
  providerLabel,
}) {
  const nativeRuntimeTools = providerLabel === "codex-relay"
    ? makeRuntimeFunctionTools({ runtime })
    : [
      shellTool({
        name: "shell",
        shell: new RuntimeShellExecutor({ runtime }),
        needsApproval: false,
      }),
      applyPatchTool({
        editor: new RuntimeWorkspaceEditor({ runtime }),
        needsApproval: false,
      }),
    ];
  const hostedTools = providerLabel === "codex-relay"
    ? []
    : [
      webSearchTool({
        searchContextSize: "medium",
      }),
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
    }),
    instructions: [
      "You are the first real SDK-backed worker for WebCodex.",
      "Answer the user's coding request clearly and concretely.",
      "Use workspace_tree and workspace_rg to discover files in the persistent WebCodex workspace.",
      "Use workspace_import to copy workspace files into Docker /sandbox before inspecting or editing them locally.",
      "Use the shell tool for bash, Python, curl, rg, npm, tests, builds, HTML generation, and verification inside Docker /sandbox.",
      "Use apply_patch for file edits inside Docker /sandbox.",
      "Use viewTool2 only for bounded text, image, PDF, and metadata inspection of files that already exist inside Docker /sandbox.",
      "viewTool2 cannot inspect host filesystem paths, /artifacts paths, or persistent WebCodex workspace paths directly; use workspace_import first when needed.",
      "Use workspace_export to publish final Docker /sandbox files back to the WebCodex workspace.",
      "Uploaded attachments are already copied into the sandbox at the paths listed in the user message and are also provided as model inputs when supported.",
      "Use shell or viewTool2 to inspect, parse, convert, or analyze uploaded files and images.",
      "Use web_search for current public information from the web when freshness matters.",
      "Use curl through the shell tool when you need to fetch or inspect a specific URL or HTTP endpoint.",
      "Only claim access to Docker /sandbox, /artifacts, web_search, and workspace bridge tools. Do not claim direct host filesystem access.",
      "When you write or export a file, briefly mention the path and purpose.",
      `Current workspace id: ${workspaceId}.`,
      "Current Docker working directory: /sandbox.",
    ].join("\n"),
    tools: [
      ...hostedTools,
      ...nativeRuntimeTools,
      ...makeRuntimeWorkspaceTools({ runtime, apiBaseUrl, workerToken, workspaceId }),
      makeViewTool2({ runtime }),
    ],
  });
}

function modelSettingsFromEnv({ reasoningEffort, reasoningSummary, textVerbosity, serviceTier, storeResponses }) {
  return {
    reasoning: {
      effort: reasoningEffort,
      summary: reasoningSummary,
    },
    text: {
      verbosity: textVerbosity,
    },
    providerData: {
      service_tier: serviceTier,
    },
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

function createOpenAIProvider() {
  const apiKey = optionalEnv("OPENAI_API_KEY", "");
  const baseURL = optionalEnv("OPENAI_BASE_URL", "");
  return new OpenAIProvider({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    useResponses: true,
    useResponsesWebSocket: false,
    cacheResponsesWebSocketModels: false,
  });
}

function positiveIntEnv(name, fallback) {
  const value = Number(optionalEnv(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

main().catch(async (error) => {
  console.error(error);
  try {
    await postEvent(
      event(
        "run.failed",
        {
          error: error.message,
          name: error.name,
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
