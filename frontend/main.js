const apiBaseUrl = "http://127.0.0.1:8000";

const composer = document.querySelector("#composer");
const runButton = document.querySelector("#run");
const newChatButton = document.querySelector("#new-chat");
const messageInput = document.querySelector("#message");
const messages = document.querySelector("#messages");
const conversationList = document.querySelector("#conversation-list");
const historyEmpty = document.querySelector("#history-empty");
const runStatus = document.querySelector("#run-status");
const modelInput = document.querySelector("#model");
const reasoningEffortSelect = document.querySelector("#reasoning-effort");
const speedModeInputs = [...document.querySelectorAll('input[name="speed-mode"]')];

let conversationId = null;
let conversations = [];
let source = null;
let activeAssistant = null;
let running = false;

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || runButton.disabled) {
    return;
  }

  const settings = runtimeSettings();
  appendUserMessage(text);
  activeAssistant = appendAssistantMessage(settings);
  setRunning(true, "排队中");

  try {
    conversationId ??= await createConversation(text);
    renderConversationList();
    const run = await createRun(conversationId, text, settings);
    connectEvents(run.run_id);
    messageInput.value = "";
    resizeComposer();
  } catch (error) {
    appendError(activeAssistant, error.message);
    setRunning(false, "失败");
  }
});

newChatButton.addEventListener("click", () => {
  source?.close();
  source = null;
  conversationId = null;
  activeAssistant = null;
  messages.textContent = "";
  setRunning(false, runtimeLabel(runtimeSettings()));
  renderConversationList();
  messageInput.focus();
});

for (const control of [modelInput, reasoningEffortSelect, ...speedModeInputs]) {
  control.addEventListener("change", syncStatusFromControls);
  control.addEventListener("input", syncStatusFromControls);
}

messageInput.addEventListener("input", resizeComposer);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

initialize().catch((error) => {
  appendSystemNotice(error.message);
});

async function initialize() {
  resizeComposer();
  syncStatusFromControls();
  await refreshConversations();
}

async function createConversation(initialMessage = "") {
  const response = await fetch(`${apiBaseUrl}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: "demo-user",
      workspace_id: "demo-workspace",
      title: conversationTitle(initialMessage),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail ?? "创建对话失败");
  }
  await refreshConversations(body.conversation_id);
  return body.conversation_id;
}

async function refreshConversations(activeId = conversationId) {
  const response = await fetch(`${apiBaseUrl}/api/conversations?user_id=demo-user&workspace_id=demo-workspace&limit=80`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail ?? "加载历史失败");
  }
  conversations = body.conversations ?? [];
  renderConversationList(activeId);
}

function renderConversationList(activeId = conversationId) {
  conversationList.textContent = "";
  historyEmpty.hidden = conversations.length > 0;

  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.dataset.id = conversation.id;
    button.disabled = running;
    button.setAttribute("aria-current", conversation.id === activeId ? "true" : "false");
    button.innerHTML = `
      <span class="conversation-title">${escapeHtml(displayConversationTitle(conversation))}</span>
      <span class="conversation-snippet">${escapeHtml(conversation.last_message_content ?? "")}</span>
      <span class="conversation-meta">${escapeHtml(formatConversationMeta(conversation))}</span>
    `;
    button.addEventListener("click", () => selectConversation(conversation.id));
    conversationList.appendChild(button);
  }
}

async function selectConversation(targetConversationId) {
  if (running || targetConversationId === conversationId) {
    return;
  }
  source?.close();
  source = null;
  activeAssistant = null;
  conversationId = targetConversationId;
  messages.textContent = "";
  setRunning(false, "加载中");
  renderConversationList();

  try {
    const response = await fetch(`${apiBaseUrl}/api/conversations/${targetConversationId}/messages`);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "加载消息失败");
    }
    renderStoredMessages(body.messages ?? []);
    setRunning(false, runtimeLabel(runtimeSettings()));
  } catch (error) {
    appendSystemNotice(error.message);
    setRunning(false, "加载失败");
  }
}

async function createRun(targetConversationId, message, settings) {
  const response = await fetch(`${apiBaseUrl}/api/conversations/${targetConversationId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      model: settings.model,
      reasoning_effort: settings.reasoningEffort,
      speed_mode: settings.speedMode,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail ?? "创建运行失败");
  }
  return body;
}

function connectEvents(runId) {
  source?.close();
  source = new EventSource(`${apiBaseUrl}/api/runs/${runId}/events`);
  source.onmessage = (message) => handleEvent(JSON.parse(message.data));
  source.onerror = () => {
    appendError(activeAssistant, "事件流连接中断");
    setRunning(false, "连接中断");
    source?.close();
  };

  for (const type of eventTypes()) {
    source.addEventListener(type, (message) => handleEvent(JSON.parse(message.data)));
  }
}

function eventTypes() {
  return [
    "run.queued",
    "run.started",
    "assistant.message.created",
    "assistant.message.delta",
    "assistant.message.done",
    "assistant.reasoning_summary.delta",
    "assistant.reasoning_summary.done",
    "agent.changed",
    "tool.call.started",
    "tool.call.args.delta",
    "tool.call.args.done",
    "tool.call.completed",
    "tool.call.failed",
    "tool.call.approval_required",
    "codex.command.started",
    "codex.command.output.delta",
    "codex.command.completed",
    "codex.file.changed",
    "run.completed",
    "run.failed",
  ];
}

function handleEvent(event) {
  if (!activeAssistant) {
    activeAssistant = appendAssistantMessage(eventSettings(event.payload));
  }

  if (event.type === "run.queued") {
    setRunning(true, "排队中");
  } else if (event.type === "run.started") {
    const settings = eventSettings(event.payload);
    setRunning(true, `${runtimeLabel(settings)} · 运行中`);
    updateAssistantRuntime(activeAssistant, settings);
  } else if (event.type === "assistant.reasoning_summary.delta") {
    appendReasoning(activeAssistant, event.payload?.text ?? "");
  } else if (event.type === "assistant.reasoning_summary.done") {
    ensureReasoning(activeAssistant, event.payload?.text ?? "");
    markSectionDone(activeAssistant.reasoningPanel);
  } else if (event.type === "assistant.message.delta") {
    appendAnswer(activeAssistant, event.payload?.text ?? "");
  } else if (event.type === "assistant.message.done") {
    ensureFinalAnswer(activeAssistant, event.payload?.text ?? "");
  } else if (event.type.startsWith("tool.call.")) {
    updateTool(activeAssistant, event);
  } else if (event.type === "agent.changed") {
    appendMeta(activeAssistant, `agent: ${event.payload?.name ?? "updated"}`);
  } else if (event.type === "run.completed") {
    setRunning(false, "完成");
    source?.close();
    refreshConversations();
  } else if (event.type === "run.failed") {
    appendError(activeAssistant, event.payload?.error ?? "运行失败");
    setRunning(false, "失败");
    source?.close();
    refreshConversations();
  }

  scrollToBottom();
}

function renderStoredMessages(items) {
  messages.textContent = "";
  for (const item of items) {
    if (item.role === "user") {
      appendUserMessage(item.content);
    } else if (item.role === "assistant") {
      appendStoredAssistantMessage(item.content);
    }
  }
  activeAssistant = null;
  scrollToBottom();
}

function appendUserMessage(text) {
  const item = document.createElement("article");
  item.className = "message user-message";
  item.innerHTML = `
    <div class="avatar">你</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  messages.appendChild(item);
  scrollToBottom();
}

function appendStoredAssistantMessage(text) {
  const target = appendAssistantMessage(runtimeSettings());
  target.runtime.textContent = "历史消息";
  ensureFinalAnswer(target, text);
  return target;
}

function appendSystemNotice(text) {
  const item = document.createElement("article");
  item.className = "system-notice";
  item.textContent = text;
  messages.appendChild(item);
}

function appendAssistantMessage(settings) {
  const item = document.createElement("article");
  item.className = "message assistant-message";
  item.innerHTML = `
    <div class="avatar">AI</div>
    <div class="assistant-stack">
      <div class="runtime-line"></div>
      <section class="process-panel reasoning-panel is-empty">
        <header><span>思考</span><small>running</small></header>
        <div class="process-text"></div>
      </section>
      <section class="process-panel tools-panel is-empty">
        <header><span>工具</span><small>waiting</small></header>
        <ol class="tool-list"></ol>
      </section>
      <section class="answer-panel">
        <div class="answer-text"></div>
      </section>
      <div class="meta-line"></div>
    </div>
  `;
  messages.appendChild(item);
  const target = {
    root: item,
    runtime: item.querySelector(".runtime-line"),
    reasoningPanel: item.querySelector(".reasoning-panel"),
    reasoning: item.querySelector(".reasoning-panel .process-text"),
    toolsPanel: item.querySelector(".tools-panel"),
    tools: item.querySelector(".tool-list"),
    answer: item.querySelector(".answer-text"),
    meta: item.querySelector(".meta-line"),
    toolItems: new Map(),
  };
  updateAssistantRuntime(target, settings);
  return target;
}

function updateAssistantRuntime(target, settings) {
  if (!target?.runtime || !settings) {
    return;
  }
  target.runtime.textContent = runtimeLabel(settings);
}

function appendReasoning(target, text) {
  if (!text) {
    return;
  }
  target.reasoningPanel.classList.remove("is-empty");
  target.reasoningPanel.querySelector("small").textContent = "streaming";
  target.reasoning.textContent += text;
}

function ensureReasoning(target, text) {
  if (!text) {
    return;
  }
  target.reasoningPanel.classList.remove("is-empty");
  if (!target.reasoning.textContent.trim()) {
    target.reasoning.textContent = text;
  }
}

function appendAnswer(target, text) {
  if (!text) {
    return;
  }
  target.answer.textContent += text;
}

function ensureFinalAnswer(target, text) {
  if (text && !target.answer.textContent.trim()) {
    target.answer.textContent = text;
  }
}

function updateTool(target, event) {
  const id = event.itemId ?? event.payload?.callId ?? `tool-${target.toolItems.size}`;
  let item = target.toolItems.get(id);
  if (!item) {
    item = document.createElement("li");
    item.className = "tool-item";
    item.innerHTML = `
      <div class="tool-head">
        <span class="tool-name"></span>
        <small></small>
      </div>
      <pre></pre>
    `;
    target.toolItems.set(id, item);
    target.tools.appendChild(item);
  }

  target.toolsPanel.classList.remove("is-empty");
  target.toolsPanel.querySelector("small").textContent = "active";

  const name = event.payload?.name ?? "tool";
  const status = event.status ?? event.type.replace("tool.call.", "");
  const pre = item.querySelector("pre");
  item.querySelector(".tool-name").textContent = name;
  item.querySelector("small").textContent = status;
  item.dataset.status = status;

  if (event.type === "tool.call.started") {
    pre.textContent = formatPayload(event.payload?.args ?? {});
  } else if (event.type === "tool.call.args.delta") {
    pre.textContent += event.payload?.delta ?? "";
  } else if (event.type === "tool.call.completed") {
    pre.textContent = formatPayload(event.payload?.output ?? {});
  } else if (event.type === "tool.call.failed") {
    pre.textContent = event.payload?.error ?? "tool failed";
  } else if (event.type === "tool.call.approval_required") {
    pre.textContent = formatPayload(event.payload ?? {});
  }
}

function appendMeta(target, text) {
  target.meta.textContent = text;
}

function appendError(target, text) {
  if (!target) {
    return;
  }
  target.root.classList.add("has-error");
  target.answer.textContent = text;
}

function markSectionDone(panel) {
  panel.querySelector("small").textContent = "done";
}

function setRunning(isRunning, label) {
  running = isRunning;
  runButton.disabled = isRunning;
  runStatus.textContent = label;
  renderConversationList();
}

function resizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function syncStatusFromControls() {
  if (!running) {
    runStatus.textContent = runtimeLabel(runtimeSettings());
  }
}

function runtimeSettings() {
  return {
    model: modelInput.value.trim() || "gpt-5.4",
    reasoningEffort: reasoningEffortSelect.value,
    speedMode: selectedSpeedMode(),
  };
}

function eventSettings(payload = {}) {
  return {
    model: payload?.model ?? runtimeSettings().model,
    reasoningEffort: payload?.reasoningEffort ?? payload?.reasoning_effort ?? runtimeSettings().reasoningEffort,
    speedMode: payload?.speedMode ?? payload?.speed_mode ?? runtimeSettings().speedMode,
  };
}

function selectedSpeedMode() {
  return speedModeInputs.find((input) => input.checked)?.value ?? "fast";
}

function runtimeLabel(settings) {
  const speed = settings.speedMode === "fast" ? "fast" : "standard";
  return `${settings.model || "gpt-5.4"} · ${settings.reasoningEffort || "xhigh"} · ${speed}`;
}

function conversationTitle(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 36) : "WebCodex Chat";
}

function displayConversationTitle(conversation) {
  if (conversation.title && conversation.title !== "WebCodex Chat") {
    return conversation.title;
  }
  return conversation.last_message_content || "新对话";
}

function formatConversationMeta(conversation) {
  const count = Number(conversation.message_count ?? 0);
  const suffix = count > 0 ? `${count} 条` : "空";
  const updated = shortTime(conversation.updated_at ?? conversation.created_at);
  return updated ? `${updated} · ${suffix}` : suffix;
}

function shortTime(value) {
  if (!value) {
    return "";
  }
  const normalized = String(value).replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatPayload(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
