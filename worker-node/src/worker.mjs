import { Agent, OpenAIProvider, Runner, webSearchTool } from "@openai/agents";

import { event, mustEnv, optionalEnv, postEvent, postEvents } from "./protocol.mjs";
import { SdkEventNormalizer, toJsonSafe } from "./sdk-events.mjs";
import { createModelProvider } from "./model-provider.mjs";
import { BackendConversationSession } from "./session.mjs";
import { AttachmentClient, createOpenAIUploadClient } from "./attachments.mjs";
import { makeSandboxTools } from "./tools/sandbox.mjs";
import { makeWorkspaceTools } from "./tools/workspace.mjs";

const ASSISTANT_ITEM_ID = "assistant_1";

async function main() {
  const runId = mustEnv("RUN_ID");
  const conversationId = mustEnv("CONVERSATION_ID");
  const workspaceId = mustEnv("WORKSPACE_ID");
  const sandboxDir = mustEnv("SANDBOX_DIR");
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
  const session = new BackendConversationSession({ conversationId, apiBaseUrl, workerToken });
  const sessionItems = await session.getItems();
  const attachmentClient = new AttachmentClient({
    apiBaseUrl,
    workerToken,
    sandboxDir,
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
      sandboxDir,
      runtime: "openai-agents-js",
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
    sandboxDir,
    apiBaseUrl,
    workerToken,
    reasoningEffort,
    reasoningSummary,
    textVerbosity,
    serviceTier,
    storeResponses,
  });
  const provider = createModelProvider({
    provider: createOpenAIProvider(),
    debugModelRequests,
  });
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

  await provider.close();
}

function createCodexAgent({
  model,
  workspaceId,
  sandboxDir,
  apiBaseUrl,
  workerToken,
  reasoningEffort,
  reasoningSummary,
  textVerbosity,
  serviceTier,
  storeResponses,
}) {
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
      "Use sandbox tools for draft file creation, local file edits, bash commands, Python scripts, and verification.",
      "Use workspace_import to copy workspace files into the sandbox before editing them locally.",
      "Use workspace_read when you only need to inspect a workspace file without importing it.",
      "Use workspace_export to publish a sandbox file back to the WebCodex workspace.",
      "Use workspace_write only for direct simple workspace create/modify requests.",
      "Uploaded attachments are already copied into the sandbox at the paths listed in the user message and are also provided as model inputs when supported.",
      "Use sandbox_python or sandbox_bash to inspect, parse, convert, or analyze uploaded files and images.",
      "Use web_search for current public information from the web when freshness matters.",
      "Use sandbox_curl or the curl shell tool when you need to fetch or inspect a specific URL or HTTP endpoint.",
      "The curl shell tool only allows curl commands; use sandbox_bash for other local shell work.",
      "Only claim access to the run sandbox, web_search, curl, and workspace tools. Do not claim direct host filesystem access.",
      "When you write or export a file, briefly mention the path and purpose.",
      `Current workspace id: ${workspaceId}.`,
      `Current sandbox directory: ${sandboxDir}.`,
    ].join("\n"),
    tools: [
      webSearchTool({
        searchContextSize: "medium",
      }),
      ...makeSandboxTools({ sandboxDir, apiBaseUrl, workerToken, workspaceId }),
      ...makeWorkspaceTools({ apiBaseUrl, workerToken, workspaceId }),
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
