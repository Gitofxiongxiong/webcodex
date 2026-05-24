import React, { useEffect, useMemo, useRef, useState } from "./vendor/react.bundle.mjs";
import { createRoot } from "./vendor/react-dom-client.bundle.mjs";
import "./vendor/dotlottie-wc/dotlottie-wc.js";

const apiBaseUrlStorageKey = "webcodex.apiBaseUrl";
const apiBaseUrl = resolveApiBaseUrl();
const authStorageKey = "webcodex.auth";
const h = React.createElement;

const supportedModels = [
  { value: "gpt-5.5", label: "GPT-5.5" },
];
const supportedModelValues = new Set(supportedModels.map((item) => item.value));
const defaultModel = supportedModels[0]?.value ?? "gpt-5.5";
const reasoningOptions = ["low", "medium", "high", "xhigh"];
const speedOptions = [
  { value: "fast", label: "Fast" },
  { value: "standard", label: "Standard" },
];

const eventTypes = [
  "run.queued",
  "run.started",
  "assistant.message.created",
  "assistant.message.delta",
  "assistant.message.done",
  "assistant.reasoning_summary.delta",
  "assistant.reasoning_summary.done",
  "context.estimated",
  "model.usage",
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
  "codex.patch.started",
  "codex.patch.completed",
  "codex.file.changed",
  "workspace.version.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
];

function App() {
  const [auth, setAuth] = useState(readStoredAuth);
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [model, setModel] = useState(defaultModel);
  const [reasoningEffort, setReasoningEffort] = useState("xhigh");
  const [speedMode, setSpeedMode] = useState("fast");
  const [usagePanel, setUsagePanel] = useState(null);
  const [modelCatalog, setModelCatalog] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState("chat");
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [workspaceFiles, setWorkspaceFiles] = useState([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const sourceRef = useRef(null);
  const activeAssistantIdRef = useRef(null);
  const currentRunIdRef = useRef(null);
  const cancelRequestedRef = useRef(false);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const token = auth?.token ?? "";
  const workspaceId = auth?.workspace?.id ?? "";

  const settings = useMemo(
    () => ({ model, reasoningEffort, speedMode }),
    [model, reasoningEffort, speedMode]
  );

  useEffect(() => {
    if (!token) {
      return undefined;
    }
    refreshCurrentUser()
      .then(() => Promise.all([refreshConversations(), refreshWorkspaces()]))
      .catch((error) => pushNotice(error.message));
    loadModelCatalog().catch((error) => pushNotice(error.message));
    return () => sourceRef.current?.close();
  }, [token]);

  useEffect(() => {
    if (!token) {
      sourceRef.current?.close();
      activeAssistantIdRef.current = null;
      currentRunIdRef.current = null;
      cancelRequestedRef.current = false;
      setConversationId(null);
      setConversations([]);
      setMessages([]);
      setRunning(false);
      setUsagePanel(null);
      setModelCatalog(null);
      setView("chat");
      setWorkspaces([]);
      setSelectedWorkspaceId("");
      setWorkspaceFiles([]);
      setWorkspaceLoading(false);
      setWorkspaceFilesLoading(false);
      setWorkspaceError("");
      setAttachments([]);
      setDragActive(false);
      setStatus("就绪");
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    refreshConversations().catch((error) => pushNotice(error.message));
    refreshWorkspaces().catch((error) => setWorkspaceError(error.message));
  }, [workspaceId]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (view === "workspaces") {
      refreshWorkspaces().catch((error) => setWorkspaceError(error.message));
    }
  }, [view, token]);

  useEffect(() => {
    if (!selectedWorkspaceId && workspaceId) {
      setSelectedWorkspaceId(workspaceId);
      return;
    }
    if (selectedWorkspaceId) {
      refreshWorkspaceFiles(selectedWorkspaceId).catch((error) => setWorkspaceError(error.message));
    }
  }, [selectedWorkspaceId, workspaceId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  if (!token) {
    return h(AuthGate, { onAuthenticated: handleAuthenticated });
  }

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
    if (response.status === 401) {
      clearStoredAuth();
      setAuth(null);
      throw new Error("登录已过期，请重新登录");
    }
    return response;
  }

  function handleAuthenticated(nextAuth) {
    saveStoredAuth(nextAuth);
    setAuth(nextAuth);
    setConversationId(null);
    setConversations([]);
    setMessages([]);
    setView("chat");
    setSelectedWorkspaceId(nextAuth?.workspace?.id ?? "");
  }

  async function refreshCurrentUser() {
    const response = await apiFetch("/api/auth/me");
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "加载用户失败");
    }
    const nextAuth = { ...auth, ...body, token };
    saveStoredAuth(nextAuth);
    setAuth(nextAuth);
  }

  async function loadModelCatalog() {
    const response = await apiFetch("/api/models/catalog");
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "Failed to load model catalog");
    }
    setModelCatalog(body);
  }

  async function logout() {
    sourceRef.current?.close();
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Local logout should continue even if the server session was already gone.
    }
    clearStoredAuth();
    setAuth(null);
  }

  async function refreshConversations(activeId = conversationId) {
    const params = new URLSearchParams({ limit: "80" });
    if (workspaceId) {
      params.set("workspace_id", workspaceId);
    }
    const response = await apiFetch(`/api/conversations?${params}`);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "加载历史会话失败");
    }
    setConversations(body.conversations ?? []);
    if (activeId) {
      setConversationId(activeId);
    }
  }

  async function refreshWorkspaces() {
    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const response = await apiFetch("/api/workspaces");
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "加载工作空间失败");
      }
      const items = body.workspaces ?? [];
      setWorkspaces(items);
      setSelectedWorkspaceId((current) => current || workspaceId || items[0]?.id || "");
      return items;
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function refreshWorkspaceFiles(targetWorkspaceId = selectedWorkspaceId) {
    if (!targetWorkspaceId) {
      setWorkspaceFiles([]);
      return [];
    }
    setWorkspaceFilesLoading(true);
    setWorkspaceError("");
    try {
      const response = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/files`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "加载工作空间文件失败");
      }
      const files = body.files ?? [];
      setWorkspaceFiles(files);
      return files;
    } finally {
      setWorkspaceFilesLoading(false);
    }
  }

  async function createWorkspace(name) {
    const response = await apiFetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "创建工作空间失败");
    }
    await refreshWorkspaces();
    setSelectedWorkspaceId(body.id);
    setWorkspaceFiles([]);
    return body;
  }

  async function switchWorkspace(workspace) {
    if (!workspace?.id || running) {
      return;
    }
    const nextAuth = { ...auth, workspace };
    saveStoredAuth(nextAuth);
    setAuth(nextAuth);
    setSelectedWorkspaceId(workspace.id);
    sourceRef.current?.close();
    activeAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    cancelRequestedRef.current = false;
    setConversationId(null);
    setMessages([]);
    clearComposerAttachments();
    setDragActive(false);
    setUsagePanel(null);
    setStatus("就绪");
    setView("chat");
  }

  async function createConversation(initialMessage) {
    const response = await apiFetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        title: conversationTitle(initialMessage),
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "创建会话失败");
    }
    await refreshConversations(body.conversation_id);
    return body.conversation_id;
  }

  async function createRun(targetConversationId, message, attachmentIds = []) {
    const response = await apiFetch(`/api/conversations/${targetConversationId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        attachment_ids: attachmentIds,
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

  async function uploadFiles(fileList) {
    const files = Array.from(fileList ?? []).filter(Boolean);
    if (!files.length || running) {
      return;
    }
    const staged = files.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      name: file.name || "attachment",
      size: file.size,
      content_type: file.type || "application/octet-stream",
      previewUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : "",
      status: "uploading",
      error: "",
    }));
    setAttachments((items) => [...items, ...staged]);

    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.name || "attachment");
    }
    const query = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
    try {
      const response = await apiFetch(`/api/attachments${query}`, {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "附件上传失败");
      }
      const uploaded = body.attachments ?? [];
      setAttachments((items) => replaceUploadedAttachments(items, staged, uploaded));
    } catch (error) {
      setAttachments((items) => items.map((item) => (
        staged.some((stagedItem) => stagedItem.localId === item.localId)
          ? { ...item, status: "failed", error: error.message }
          : item
      )));
    }
  }

  function removeAttachment(localId) {
    setAttachments((items) => {
      const target = items.find((item) => item.localId === localId);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return items.filter((item) => item.localId !== localId);
    });
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    if (running) {
      return;
    }
    uploadFiles(event.dataTransfer?.files);
  }

  function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      uploadFiles(files);
    }
  }

  async function submitMessage(event) {
    event.preventDefault();
    const text = input.trim();
    const readyAttachments = attachments.filter((item) => item.status === "uploaded" && item.id);
    const busyAttachments = attachments.some((item) => item.status === "uploading");
    const failedAttachments = attachments.some((item) => item.status === "failed");
    if (running || busyAttachments || failedAttachments || (!text && readyAttachments.length === 0)) {
      return;
    }

    const assistantId = crypto.randomUUID();
    const messageAttachments = readyAttachments.map((item) => item.attachment);
    activeAssistantIdRef.current = assistantId;
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", content: text, attachments: messageAttachments },
      assistantMessage(assistantId, settings),
    ]);
    setInput("");
    for (const item of readyAttachments) {
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
    setAttachments([]);
    setRunning(true);
    setUsagePanel(null);
    cancelRequestedRef.current = false;
    setStatus("排队中");

    try {
      const targetConversationId = conversationId ?? (await createConversation(text || attachmentConversationTitle(messageAttachments)));
      setConversationId(targetConversationId);
      const run = await createRun(targetConversationId, text, readyAttachments.map((item) => item.id));
      setUsagePanel(initialUsagePanel(run.run_id, run.settings ?? settings));
      connectEvents(run.run_id);
      await refreshConversations(targetConversationId);
    } catch (error) {
      setAttachments(readyAttachments);
      updateAssistant(assistantId, { content: displayErrorMessage(error, "运行失败"), failed: true, streaming: false });
      setRunning(false);
      setStatus("失败");
    }
  }

  async function stopRun() {
    const runId = currentRunIdRef.current;
    const assistantId = activeAssistantIdRef.current;
    if (!running || !runId || cancelRequestedRef.current) {
      return;
    }

    cancelRequestedRef.current = true;
    setStatus("正在停止");
    if (assistantId) {
      updateAssistant(assistantId, { cancelled: true });
    }

    try {
      const response = await apiFetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "停止运行失败");
      }
      if (assistantId) {
        updateAssistant(assistantId, { streaming: false, cancelled: true });
      }
      setRunning(false);
      cancelRequestedRef.current = false;
      setStatus(body.status === "cancelled" ? "已停止" : "已结束");
      sourceRef.current?.close();
      refreshConversations().catch((error) => pushNotice(error.message));
    } catch (error) {
      cancelRequestedRef.current = false;
      setStatus("停止失败");
      pushNotice(error.message);
    }
  }

  function connectEvents(runId) {
    sourceRef.current?.close();
    currentRunIdRef.current = runId;
    const source = new EventSource(`${apiBaseUrl}/api/runs/${runId}/events?access_token=${encodeURIComponent(token)}`);
    sourceRef.current = source;
    source.onerror = () => {
      if (cancelRequestedRef.current) {
        source.close();
        return;
      }
      const assistantId = activeAssistantIdRef.current;
      if (assistantId) {
        updateAssistant(assistantId, { content: "事件流连接中断", failed: true, streaming: false });
      }
      setRunning(false);
      setStatus("连接中断");
      source.close();
    };
    for (const type of eventTypes) {
      source.addEventListener(type, (message) => handleRunEvent(JSON.parse(message.data)));
    }
  }

  function handleRunEvent(event) {
    const assistantId = activeAssistantIdRef.current;
    if (!assistantId) {
      return;
    }

    if (event.type === "run.queued") {
      setStatus("排队中");
    } else if (event.type === "run.started") {
      setStatus("运行中");
      updateAssistant(assistantId, { settings: eventSettings(event.payload, settings) });
    } else if (event.type === "assistant.reasoning_summary.delta") {
      appendReasoningBlock(assistantId, event);
    } else if (event.type === "assistant.reasoning_summary.done") {
      completeReasoningBlock(assistantId, event);
    } else if (event.type === "assistant.message.delta") {
      appendTextBlock(assistantId, event.payload?.text ?? "", event);
    } else if (event.type === "assistant.message.done") {
      completeTextBlock(assistantId, event.payload?.text ?? "", event);
    } else if (event.type === "context.estimated") {
      setUsagePanel((current) => usagePanelFromEstimate(event.payload, current));
    } else if (event.type === "model.usage") {
      setUsagePanel((current) => usagePanelFromModelUsage(event.payload, current));
    } else if (event.type.startsWith("tool.call.") || event.type.startsWith("codex.") || event.type === "workspace.version.created") {
      updateTool(assistantId, event);
    } else if (event.type === "run.completed") {
      updateAssistant(assistantId, { streaming: false });
      setRunning(false);
      cancelRequestedRef.current = false;
      setStatus("已完成");
      sourceRef.current?.close();
      loadRunUsage(event.runId ?? currentRunIdRef.current).catch((error) => pushNotice(error.message));
      refreshConversations().catch((error) => pushNotice(error.message));
    } else if (event.type === "run.failed") {
      const errorText = displayErrorMessage(event.payload?.error, "运行失败");
      appendTextBlock(assistantId, errorText, event, { forceNew: true, status: "failed" });
      updateAssistant(assistantId, { content: errorText, failed: true, streaming: false });
      setRunning(false);
      cancelRequestedRef.current = false;
      setStatus("失败");
      sourceRef.current?.close();
      refreshConversations().catch((error) => pushNotice(error.message));
    } else if (event.type === "run.cancelled") {
      updateAssistant(assistantId, { streaming: false, cancelled: true });
      setRunning(false);
      cancelRequestedRef.current = false;
      setStatus("已停止");
      sourceRef.current?.close();
      refreshConversations().catch((error) => pushNotice(error.message));
    }
  }

  async function selectConversation(targetConversationId) {
    if (running || targetConversationId === conversationId) {
      return;
    }
    sourceRef.current?.close();
    activeAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    cancelRequestedRef.current = false;
    clearComposerAttachments();
    setView("chat");
    setConversationId(targetConversationId);
    setMessages([]);
    setUsagePanel(null);
    setStatus("加载中");

    try {
      const response = await apiFetch(`/api/conversations/${targetConversationId}/messages`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "加载消息失败");
      }
      setMessages((body.messages ?? []).map(storedMessage));
      setStatus("就绪");
      await refreshConversations(targetConversationId);
    } catch (error) {
      pushNotice(error.message);
      setStatus("加载失败");
    }
  }

  function startNewChat() {
    if (running) {
      return;
    }
    sourceRef.current?.close();
    activeAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    cancelRequestedRef.current = false;
    setView("chat");
    setConversationId(null);
    setMessages([]);
    clearComposerAttachments();
    setUsagePanel(null);
    setStatus("就绪");
    inputRef.current?.focus();
  }

  function pushNotice(text) {
    if (isHiddenNotice(text)) {
      return;
    }
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "notice", content: text }]);
  }

  function clearComposerAttachments() {
    setAttachments((items) => {
      for (const item of items) {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return [];
    });
    setDragActive(false);
  }

  async function loadRunUsage(runId) {
    if (!runId) {
      return;
    }
    const response = await apiFetch(`/api/runs/${runId}/usage`);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "加载用量失败");
    }
    setUsagePanel((current) => usagePanelFromSummary(body, current));
  }

  const activeTitle = view === "workspaces" ? "工作空间管理" : displayActiveTitle(conversations, conversationId);
  const hasMessages = messages.length > 0;

  return h("div", { className: `app-frame${sidebarOpen ? "" : " sidebar-collapsed"}` },
    h(Sidebar, {
      user: auth?.user,
      workspace: auth?.workspace,
      conversations,
      activeId: conversationId,
      running,
      isOpen: sidebarOpen,
      activeView: view,
      onToggle: () => setSidebarOpen((value) => !value),
      onNewChat: startNewChat,
      onSelect: selectConversation,
      onWorkspaceManage: () => setView("workspaces"),
      onLogout: logout,
    }),
    h("main", { className: `chat-shell${view === "workspaces" ? " workspace-shell" : ""}` },
      !sidebarOpen ? h("button", {
        className: "sidebar-restore",
        type: "button",
        title: "打开侧边栏",
        onClick: () => setSidebarOpen(true),
      }, h(Icon, { name: "panel-left-open" })) : null,
      h(Header, {
        title: activeTitle,
        status: view === "workspaces" ? workspaceStatus(workspaces, workspaceId) : status,
        usage: view === "workspaces" ? null : usagePanel,
        modelCatalog,
        showWorkspaceAction: view !== "workspaces",
        onWorkspaceManage: () => setView("workspaces"),
      }),
      view === "workspaces"
        ? h(WorkspaceManager, {
          workspaces,
          files: workspaceFiles,
          currentWorkspaceId: workspaceId,
          selectedWorkspaceId,
          loading: workspaceLoading,
          filesLoading: workspaceFilesLoading,
          error: workspaceError,
          running,
          onBack: () => setView("chat"),
          onCreate: createWorkspace,
          onSelect: setSelectedWorkspaceId,
          onUse: switchWorkspace,
          onRefresh: refreshWorkspaces,
          onRefreshFiles: () => refreshWorkspaceFiles(selectedWorkspaceId),
        })
        : [
          h("section", { key: "messages", className: `message-scroll${hasMessages ? "" : " empty"}`, ref: messagesRef, "aria-live": "polite" },
            h("div", { className: "message-column" },
              !hasMessages
                ? h(EmptyState, {
                  workspace: auth?.workspace,
                  onWorkspaceManage: () => setView("workspaces"),
                })
                : messages.map((message) => h(MessageView, { key: message.id, message }))
            )
          ),
          h("form", { key: "composer", className: `composer-wrap${hasMessages ? "" : " is-empty-chat"}`, onSubmit: submitMessage },
            h("div", {
              className: `composer${dragActive ? " is-dragging" : ""}`,
              onDragEnter: (event) => {
                event.preventDefault();
                if (!running) {
                  setDragActive(true);
                }
              },
              onDragOver: (event) => event.preventDefault(),
              onDragLeave: (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setDragActive(false);
                }
              },
              onDrop: handleDrop,
            },
              h("input", {
                ref: fileInputRef,
                className: "composer-file-input",
                type: "file",
                multiple: true,
                disabled: running,
                onChange: (event) => {
                  uploadFiles(event.target.files);
                  event.target.value = "";
                },
              }),
              attachments.length ? h(AttachmentTray, { attachments, onRemove: removeAttachment }) : null,
              h("textarea", {
                ref: inputRef,
                value: input,
                rows: 1,
                placeholder: "输入消息，按 Enter 发送",
                disabled: running,
                onChange: (event) => setInput(event.target.value),
                onPaste: handlePaste,
                onKeyDown: (event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                },
              }),
              h("div", { className: "composer-footer" },
                h("button", {
                  className: "icon-button add-button",
                  type: "button",
                  disabled: running,
                  title: "添加文件",
                  onClick: () => fileInputRef.current?.click(),
                }, h(Icon, { name: "paperclip" })),
                h(RuntimeControls, {
                  model,
                  reasoningEffort,
                  speedMode,
                  onModel: setModel,
                  onReasoning: setReasoningEffort,
                  onSpeed: setSpeedMode,
                }),
                h("button", {
                  className: `send-button${running ? " stop-button" : ""}`,
                  type: running ? "button" : "submit",
                  disabled: running ? cancelRequestedRef.current : !canSubmit(input, attachments),
                  title: running ? "停止" : "发送",
                  onClick: running ? stopRun : undefined,
                },
                  h(Icon, { name: running ? "stop" : "arrow-up", className: "send-icon" })
                )
              )
            )
          )
        ]
    )
  );

  function updateAssistant(id, patch) {
    setMessages((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function updateTool(id, event) {
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const callId = event.itemId ?? event.payload?.callId ?? `tool-${assistantBlocks(item).length}`;
      const blocks = assistantBlocks(item);
      const existingIndex = blocks.findIndex((block) => block.type === "tool" && block.id === callId);
      const current = existingIndex >= 0 ? blocks[existingIndex] : {
        id: callId,
        type: "tool",
        name: "工具调用",
        status: "started",
        detail: "",
      };
      const next = {
        ...current,
        name: event.payload?.displayName ?? event.payload?.name ?? displayEventName(event.type, current.name),
        status: event.status ?? statusFromEventType(event.type),
        detail: toolDetail(current.detail, event),
      };
      if (existingIndex >= 0) {
        blocks[existingIndex] = next;
      } else {
        blocks.push(next);
      }
      return { ...item, tools: toolBlocks(blocks), blocks };
    }));
  }

  function appendReasoningBlock(id, event) {
    const text = event.payload?.text ?? "";
    if (!text) {
      return;
    }
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const blockId = reasoningBlockId(event, assistantBlocks(item));
      const blocks = upsertBlock(assistantBlocks(item), blockId, () => ({
        id: blockId,
        type: "reasoning",
        text: "",
        status: event.status ?? "running",
      }), (block) => ({
        ...block,
        text: `${block.text ?? ""}${text}`,
        status: event.status ?? block.status ?? "running",
      }));
      return { ...item, reasoning: reasoningText(blocks), blocks };
    }));
  }

  function completeReasoningBlock(id, event) {
    const text = event.payload?.text ?? "";
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const blockId = reasoningBlockId(event, assistantBlocks(item));
      const blocks = upsertBlock(assistantBlocks(item), blockId, () => ({
        id: blockId,
        type: "reasoning",
        text,
        status: event.status ?? "completed",
      }), (block) => ({
        ...block,
        text: text && !String(block.text ?? "").trim() ? text : block.text,
        status: event.status ?? "completed",
      }));
      return { ...item, reasoning: reasoningText(blocks), blocks };
    }));
  }

  function appendTextBlock(id, text, event, options = {}) {
    if (!text) {
      return;
    }
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const blocks = assistantBlocks(item);
      const last = blocks[blocks.length - 1];
      if (!options.forceNew && last?.type === "text") {
        const nextBlocks = [...blocks];
        nextBlocks[nextBlocks.length - 1] = {
          ...last,
          text: `${last.text ?? ""}${text}`,
          status: options.status ?? event.status ?? last.status ?? "running",
        };
        return { ...item, content: textContent(nextBlocks), blocks: nextBlocks };
      }
      const nextBlocks = [
        ...blocks,
        {
          id: event.itemId ? `${event.itemId}-text-${blocks.length}` : `text-${blocks.length}`,
          type: "text",
          text,
          status: options.status ?? event.status ?? "running",
        },
      ];
      return { ...item, content: textContent(nextBlocks), blocks: nextBlocks };
    }));
  }

  function completeTextBlock(id, text, event) {
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      let blocks = assistantBlocks(item);
      const existingText = textContent(blocks);
      if (text && !existingText.trim()) {
        blocks = [
          ...blocks,
          {
            id: event.itemId ? `${event.itemId}-text-${blocks.length}` : `text-${blocks.length}`,
            type: "text",
            text,
            status: event.status ?? "completed",
          },
        ];
      } else if (blocks.length && blocks[blocks.length - 1]?.type === "text") {
        blocks = [...blocks];
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], status: event.status ?? "completed" };
      }
      return { ...item, content: textContent(blocks), blocks };
    }));
  }
}

function AuthGate({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitAuth(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: account.trim(),
          password,
          ...(mode === "register" ? { name: name.trim() || account.trim() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "认证失败");
      }
      onAuthenticated(body);
    } catch (authError) {
      setError(authError.message);
    } finally {
      setBusy(false);
    }
  }

  return h("main", { className: "auth-shell" },
    h("form", { className: "auth-panel", onSubmit: submitAuth },
      h("div", { className: "auth-brand" },
        h("div", { className: "brand-mark" }, "K"),
        h("h1", null, "WebCodex")
      ),
      h("div", { className: "auth-tabs" },
        h("button", {
          type: "button",
          "aria-current": mode === "login" ? "true" : "false",
          onClick: () => setMode("login"),
        }, "登录"),
        h("button", {
          type: "button",
          "aria-current": mode === "register" ? "true" : "false",
          onClick: () => setMode("register"),
        }, "注册")
      ),
      h("label", { className: "auth-field" },
        h("span", null, "账号"),
        h("input", {
          value: account,
          minLength: 3,
          maxLength: 64,
          autoComplete: "username",
          placeholder: "demo@example.com",
          required: true,
          onChange: (event) => setAccount(event.target.value),
        })
      ),
      mode === "register" ? h("label", { className: "auth-field" },
        h("span", null, "昵称"),
        h("input", {
          value: name,
          maxLength: 80,
          autoComplete: "name",
          placeholder: "你的名字",
          onChange: (event) => setName(event.target.value),
        })
      ) : null,
      h("label", { className: "auth-field" },
        h("span", null, "密码"),
        h("input", {
          value: password,
          minLength: 4,
          maxLength: 128,
          type: "password",
          autoComplete: mode === "login" ? "current-password" : "new-password",
          required: true,
          onChange: (event) => setPassword(event.target.value),
        })
      ),
      error ? h("div", { className: "auth-error" }, error) : null,
      h("button", {
        className: "auth-submit",
        type: "submit",
        disabled: busy || !account.trim() || password.length < 4,
      }, busy ? "处理中..." : mode === "login" ? "登录" : "创建账号")
    )
  );
}

function Sidebar({
  user,
  workspace,
  conversations,
  activeId,
  running,
  isOpen,
  activeView,
  onToggle,
  onNewChat,
  onSelect,
  onWorkspaceManage,
  onLogout,
}) {
  return h("aside", { className: `sidebar${isOpen ? "" : " is-closed"}` },
    h("div", { className: "brand-row" },
      h(WcxLogo),
      h("button", { className: "sidebar-toggle", type: "button", title: "收起侧边栏", onClick: onToggle },
        h(Icon, { name: "panel-left-close" })
      )
    ),
    h("button", { className: "new-chat", type: "button", disabled: running, onClick: onNewChat },
      h(Icon, { name: "circle-plus", className: "new-chat-icon" }),
      "新建会话"
    ),
    h("button", {
      className: "workspace-nav-button",
      type: "button",
      "aria-current": activeView === "workspaces" ? "true" : "false",
      onClick: onWorkspaceManage,
    },
      h(Icon, { name: "folder", className: "workspace-nav-icon" }),
      h("span", { className: "workspace-nav-copy" },
        h("strong", null, workspace?.name ?? "Default Workspace"),
        h("span", null, "工作空间管理")
      )
    ),
    h("div", { className: "history-title" }, "历史会话"),
    h("nav", { className: "history-list" },
      conversations.length === 0
        ? h("p", { className: "history-empty" }, "暂无会话")
        : conversations.map((conversation) => h("button", {
          key: conversation.id,
          type: "button",
          className: "history-item",
          "aria-current": conversation.id === activeId ? "true" : "false",
          disabled: running,
          onClick: () => onSelect(conversation.id),
        },
          h("span", { className: "history-name" }, displayConversationTitle(conversation)),
          h("span", { className: "history-meta" }, formatConversationMeta(conversation))
        ))
    ),
    h("div", { className: "account-box" },
      h("div", { className: "account-avatar" }, userInitial(user)),
      h("div", { className: "account-copy" },
        h("strong", null, user?.name ?? "用户"),
        h("span", null, user?.account ?? "")
      ),
      h("button", { className: "logout-button", type: "button", onClick: onLogout, title: "退出登录" }, "退出")
    )
  );
}

function WorkspaceManager({
  workspaces,
  files,
  currentWorkspaceId,
  selectedWorkspaceId,
  loading,
  filesLoading,
  error,
  running,
  onBack,
  onCreate,
  onSelect,
  onUse,
  onRefresh,
  onRefreshFiles,
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null;
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const totalSize = files.reduce((sum, file) => sum + numeric(file.size), 0);
  const folderCount = countFolders(fileTree);

  async function submit(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      await onCreate(trimmed);
      setName("");
    } catch (createError) {
      setLocalError(createError.message);
    } finally {
      setBusy(false);
    }
  }

  return h("section", { className: "workspace-manager" },
    h("div", { className: "workspace-manager-head" },
      h("button", { className: "workspace-back-button", type: "button", onClick: onBack },
        h(Icon, { name: "arrow-left" }),
        "返回聊天"
      ),
      h("div", { className: "workspace-manager-title" },
        h("h2", null, "用户工作空间"),
        h("p", null, "当前文件夹能力来自 workspace 内文件路径，例如 src/main.js 会显示为 src 文件夹。空文件夹还没有独立持久化模型。")
      ),
      h("button", { className: "workspace-refresh-button", type: "button", disabled: loading, onClick: onRefresh, title: "刷新工作空间" },
        h(Icon, { name: "refresh" }),
        loading ? "刷新中" : "刷新"
      )
    ),
    error || localError ? h("div", { className: "workspace-error" }, localError || error) : null,
    h("div", { className: "workspace-grid" },
      h("section", { className: "workspace-list-panel" },
        h("div", { className: "workspace-section-head" },
          h("h3", null, "工作空间"),
          h("span", null, `${workspaces.length} 个`)
        ),
        h("form", { className: "workspace-create-form", onSubmit: submit },
          h("input", {
            value: name,
            maxLength: 80,
            placeholder: "新工作空间名称",
            disabled: busy,
            onChange: (event) => setName(event.target.value),
          }),
          h("button", { type: "submit", disabled: busy || !name.trim() },
            busy ? "创建中" : "创建"
          )
        ),
        h("div", { className: "workspace-list" },
          loading && workspaces.length === 0
            ? h("p", { className: "workspace-muted" }, "正在加载工作空间")
            : workspaces.map((workspace) => h("button", {
              key: workspace.id,
              className: "workspace-list-item",
              type: "button",
              "aria-current": workspace.id === selectedWorkspace?.id ? "true" : "false",
              onClick: () => onSelect(workspace.id),
            },
              h("span", { className: "workspace-list-name" }, workspace.name),
              h("span", { className: "workspace-list-meta" },
                `${formatNumber(workspace.file_count)} 个文件 · ${formatNumber(workspace.conversation_count)} 个会话`
              ),
              workspace.id === currentWorkspaceId ? h("span", { className: "workspace-current-mark" },
                h(Icon, { name: "check" }),
                "当前"
              ) : null
            ))
        )
      ),
      h("section", { className: "workspace-detail-panel" },
        selectedWorkspace ? h("div", { className: "workspace-detail-head" },
          h("div", null,
            h("h3", null, selectedWorkspace.name),
            h("p", null, selectedWorkspace.id)
          ),
          h("div", { className: "workspace-actions" },
            h("button", { className: "workspace-refresh-button", type: "button", disabled: filesLoading, onClick: onRefreshFiles },
              h(Icon, { name: "refresh" }),
              filesLoading ? "加载中" : "刷新文件"
            ),
            h("button", {
              className: "workspace-use-button",
              type: "button",
              disabled: running || selectedWorkspace.id === currentWorkspaceId,
              onClick: () => onUse(selectedWorkspace),
            }, selectedWorkspace.id === currentWorkspaceId ? "正在使用" : "切换到此工作空间")
          )
        ) : null,
        selectedWorkspace ? h("div", { className: "workspace-stats" },
          h("div", null, h("strong", null, formatNumber(files.length)), h("span", null, "文件")),
          h("div", null, h("strong", null, formatNumber(folderCount)), h("span", null, "文件夹")),
          h("div", null, h("strong", null, formatBytes(totalSize)), h("span", null, "总大小")),
          h("div", null, h("strong", null, shortTime(selectedWorkspace.updated_at) || "-"), h("span", null, "更新时间"))
        ) : null,
        h("div", { className: "workspace-tree-head" },
          h("h3", null, "文件树"),
          h("span", null, filesLoading ? "加载中" : `${files.length} 个文件`)
        ),
        filesLoading && files.length === 0
          ? h("p", { className: "workspace-muted" }, "正在加载文件")
          : files.length === 0
            ? h("div", { className: "workspace-empty-files" },
              h(Icon, { name: "folder" }),
              h("strong", null, "暂无文件"),
              h("span", null, "Agent 写入文件后，这里会按路径显示目录结构。")
            )
            : h(FileTree, { nodes: fileTree })
      )
    )
  );
}

function FileTree({ nodes, depth = 0 }) {
  return h("div", { className: "file-tree", style: { "--tree-depth": depth } },
    nodes.map((node) => h("div", { key: node.path, className: "file-tree-node" },
      h("div", { className: `file-tree-row ${node.type}` },
        h(Icon, { name: node.type === "folder" ? "folder" : "file" }),
        h("span", { className: "file-tree-name", title: node.path }, node.name),
        node.type === "file" ? h("span", { className: "file-tree-size" }, formatBytes(node.size)) : null
      ),
      node.children?.length ? h(FileTree, { nodes: node.children, depth: depth + 1 }) : null
    ))
  );
}

function WcxLogo() {
  return h("img", {
    className: "brand-logo-image",
    src: "./assets/wcx-logo-transparent.png",
    alt: "WebCodex",
  });
}

function WBrandMark({ className = "" } = {}) {
  return h("div", { className: `w-brand-mark ${className}`.trim(), "aria-label": "WebCodex" },
    h("svg", { className: "w-brand-svg", viewBox: "0 0 200 200", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
      h("defs", null,
        h("filter", { id: "w-brand-shadow", x: "-20%", y: "-20%", width: "140%", height: "140%" },
          h("feDropShadow", { dx: "0", dy: "5", stdDeviation: "5", floodColor: "#000", floodOpacity: "0.2" })
        ),
        h("path", {
          id: "w-brand-shape",
          d: "M 40 50 C 50 135, 60 155, 75 155 C 95 155, 95 75, 100 65 C 105 75, 105 155, 125 155 C 140 155, 150 135, 160 50",
          fill: "none",
          strokeWidth: "36",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        h("clipPath", { id: "w-brand-yellow-cap" },
          h("polygon", { points: "0,0 70,0 70,68 0,83" })
        )
      ),
      h("rect", { x: "10", y: "10", width: "180", height: "180", rx: "42", fill: "#2C2C2E" }),
      h("g", { className: "w-character", filter: "url(#w-brand-shadow)" },
        h("use", { href: "#w-brand-shape", stroke: "#F5F4EF" }),
        h("use", { href: "#w-brand-shape", stroke: "#F8B63F", clipPath: "url(#w-brand-yellow-cap)" }),
        h("ellipse", { cx: "48", cy: "115", rx: "6", ry: "3.5", fill: "#F8B63F", opacity: "0.5" }),
        h("ellipse", { cx: "152", cy: "115", rx: "6", ry: "3.5", fill: "#F8B63F", opacity: "0.5" }),
        h("g", { className: "eye-left" },
          h("circle", { cx: "60", cy: "105", r: "14", fill: "#F5F4EF", stroke: "#2C2C2E", strokeWidth: "3" }),
          h("g", { className: "pupil-group" },
            h("circle", { cx: "60", cy: "105", r: "7", fill: "#2C2C2E" }),
            h("circle", { cx: "57.5", cy: "102", r: "2.5", fill: "#F5F4EF" })
          )
        ),
        h("g", { className: "eye-right" },
          h("circle", { cx: "140", cy: "105", r: "14", fill: "#F5F4EF", stroke: "#2C2C2E", strokeWidth: "3" }),
          h("g", { className: "pupil-group" },
            h("circle", { cx: "140", cy: "105", r: "7", fill: "#2C2C2E" }),
            h("circle", { cx: "137.5", cy: "102", r: "2.5", fill: "#F5F4EF" })
          )
        )
      )
    )
  );
}

function Icon({ name, className = "" }) {
  const common = {
    className: `ui-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  if (name === "circle-plus") {
    return h("svg", common,
      h("circle", { cx: "12", cy: "12", r: "10" }),
      h("path", { d: "M8 12h8" }),
      h("path", { d: "M12 8v8" })
    );
  }
  if (name === "panel-left-close") {
    return h("svg", common,
      h("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }),
      h("path", { d: "M9 3v18" }),
      h("path", { d: "M15 9l-3 3 3 3" })
    );
  }
  if (name === "panel-left-open") {
    return h("svg", common,
      h("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }),
      h("path", { d: "M9 3v18" }),
      h("path", { d: "M12 9l3 3-3 3" })
    );
  }
  if (name === "chevron-down") {
    return h("svg", common,
      h("path", { d: "M6 9l6 6 6-6" })
    );
  }
  if (name === "folder") {
    return h("svg", common,
      h("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" })
    );
  }
  if (name === "file") {
    return h("svg", common,
      h("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }),
      h("path", { d: "M14 2v6h6" })
    );
  }
  if (name === "paperclip") {
    return h("svg", common,
      h("path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" })
    );
  }
  if (name === "x") {
    return h("svg", common,
      h("path", { d: "M18 6 6 18" }),
      h("path", { d: "m6 6 12 12" })
    );
  }
  if (name === "refresh") {
    return h("svg", common,
      h("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
      h("path", { d: "M3 21v-5h5" }),
      h("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
      h("path", { d: "M16 8h5V3" })
    );
  }
  if (name === "arrow-left") {
    return h("svg", common,
      h("path", { d: "M19 12H5" }),
      h("path", { d: "M12 19l-7-7 7-7" })
    );
  }
  if (name === "check") {
    return h("svg", common,
      h("path", { d: "M20 6 9 17l-5-5" })
    );
  }
  if (name === "stop") {
    return h("svg", common,
      h("rect", { width: "10", height: "10", x: "7", y: "7", rx: "1", fill: "currentColor", stroke: "none" })
    );
  }
  return h("svg", common,
    h("path", { d: "M12 19V5" }),
    h("path", { d: "M5 12l7-7 7 7" })
  );
}

function Header({ title, status, usage, modelCatalog, showWorkspaceAction = false, onWorkspaceManage }) {
  return h("header", { className: "topbar" },
    h("div", { className: "title-block" },
      h("h1", null, title),
      usage ? h(UsageMeterStable, { usage, modelCatalog }) : null
    ),
    h("div", { className: "runtime-strip" },
      showWorkspaceAction ? h("button", {
        className: "topbar-workspace-button",
        type: "button",
        onClick: onWorkspaceManage,
        title: "打开工作空间管理",
      },
        h(Icon, { name: "folder" }),
        "工作空间"
      ) : null,
      h("span", { className: "status-pill" }, status)
    )
  );
}

function RuntimeControls({ model, reasoningEffort, speedMode, onModel, onReasoning, onSpeed }) {
  const normalizedModel = supportedModelValues.has(model) ? model : defaultModel;
  useEffect(() => {
    if (normalizedModel !== model) {
      onModel(normalizedModel);
    }
  }, [model, normalizedModel, onModel]);

  return h("div", { className: "runtime-controls" },
    h(SelectMenu, {
      label: "模型",
      value: normalizedModel,
      options: supportedModels,
      onChange: onModel,
    }),
    h(SelectMenu, {
      label: "推理强度",
      value: reasoningEffort,
      options: reasoningOptions.map((item) => ({ value: item, label: item })),
      onChange: onReasoning,
    }),
    h(SelectMenu, {
      label: "速度",
      value: speedMode,
      options: speedOptions,
      onChange: onSpeed,
    })
  );
}

function SelectMenu({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((item) => item.value === value) ?? options[0];

  return h("div", { className: "select-menu" },
    h("button", {
      className: "select-trigger",
      type: "button",
      title: label,
      "aria-expanded": open ? "true" : "false",
      onClick: () => setOpen((current) => !current),
      onBlur: () => window.setTimeout(() => setOpen(false), 120),
    },
      h("span", { className: "select-trigger-label" }, selected?.label ?? value),
      h(Icon, { name: "chevron-down", className: "select-chevron" })
    ),
    open ? h("div", { className: "select-menu-list", role: "listbox", "aria-label": label },
      options.map((item) => h("button", {
        key: item.value,
        className: "select-menu-item",
        type: "button",
        role: "option",
        "aria-selected": item.value === value ? "true" : "false",
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => {
          onChange(item.value);
          setOpen(false);
        },
      }, item.label))
    ) : null
  );
}

function Dropdown({ className = "", panelClassName = "", label, renderTrigger, children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const triggerProps = {
    type: "button",
    "aria-expanded": open ? "true" : "false",
    "aria-haspopup": "dialog",
    "aria-label": label,
    onClick: () => setOpen((current) => !current),
  };

  return h("div", {
    className: `ui-dropdown ${open ? "is-open" : ""} ${className}`.trim(),
    ref: rootRef,
  },
    renderTrigger({ open, triggerProps }),
    open ? h("div", {
      className: `ui-dropdown-panel ${panelClassName}`.trim(),
      role: "dialog",
      "aria-label": label,
    }, children) : null
  );
}

function CircularProgress({ value, label, className = "" }) {
  const progress = clampPercent(value);
  return h("svg", {
    className: `ui-progress-ring ${className}`.trim(),
    viewBox: "0 0 100 100",
    role: "img",
    "aria-label": `${label} ${formatPercent(progress)}%`,
  },
    h("circle", { className: "ui-progress-ring-inner", cx: "50", cy: "50", r: "30" }),
    h("circle", {
      className: "ui-progress-ring-outer",
      cx: "50",
      cy: "50",
      r: "23",
      pathLength: "100",
      style: { "--progress-value": `${progress}` },
    })
  );
}

function UsageMeterStable({ usage, modelCatalog }) {
  const context = usage.context ?? {};
  const totals = usage.totals ?? {};
  const remainingTokens = numeric(context.remainingTokens);
  const usableTokens = numeric(context.usableContextTokens);
  const derivedUsedPercent = usableTokens > 0 ? clampPercent(((usableTokens - remainingTokens) / usableTokens) * 100) : 0;
  const usedPercent = context.usedPercent == null ? derivedUsedPercent : clampPercent(context.usedPercent);
  const remainingPercent = usableTokens > 0 ? clampPercent((remainingTokens / usableTokens) * 100) : clampPercent(100 - usedPercent);
  const breakdown = normalizeBreakdown(context.breakdown, usableTokens);

  return h(Dropdown, {
    className: "usage-meter",
    panelClassName: "usage-popover",
    label: "Context usage and token usage",
    renderTrigger: ({ triggerProps }) => h("button", {
      ...triggerProps,
      className: "usage-trigger",
      title: "Context used",
    },
      h(CircularProgress, { value: usedPercent, label: "Context used" })
    ),
  },
    h("div", { className: "usage-head" },
      h("span", null, "Context used"),
      h("strong", null, `${formatPercent(usedPercent)}%`)
    ),
    h("div", { className: "usage-token-row" },
      h("span", null, "Tokens available"),
      h("strong", null, `${formatNumber(remainingTokens)} / ${formatNumber(usableTokens)}`)
    ),
    h("div", { className: "usage-stats" },
      h("span", null, `Input ${formatNumber(actualOrEstimateInputTokens(totals, context))} tokens`),
      h("span", null, `Output ${formatNumber(totals.outputTokens)} tokens`),
      h("span", null, formatCostStable(totals, context, modelCatalog))
    ),
    breakdown.length ? h("div", { className: "usage-legend" },
      breakdown.map((part, index) => h("span", {
        key: part.key,
        className: "usage-legend-item",
        style: { "--part-color": part.color ?? partColor(index) },
        title: `${part.label}: ${formatNumber(part.tokens)} tokens`,
      }, `${part.label} ${formatPercent(part.percent)}%`))
    ) : h("div", { className: "usage-legend muted" }, "Waiting for context estimate")
  );
}

function formatCostStable(totals = {}, context = {}, modelCatalog = null) {
  if (totals.costUsd != null) {
    return `Cost $${formatDecimal(totals.costUsd)}`;
  }
  const estimatedCost = estimatePromptCostUsd(context, modelCatalog);
  if (estimatedCost != null) {
    return `Est. $${formatDecimal(estimatedCost)}`;
  }
  if (actualOrEstimateInputTokens(totals, context) > 0 || numeric(totals.outputTokens) > 0) {
    return "Cost pending";
  }
  return "Waiting for usage";
}

function actualOrEstimateInputTokens(totals = {}, context = {}) {
  return totals.inputTokens == null ? context.inputTokensEstimate : totals.inputTokens;
}

function estimatePromptCostUsd(context = {}, modelCatalog = null) {
  const model = normalizeModelName(context.model);
  const rates = modelCatalog?.pricing?.usdPrices?.[model];
  const inputTokens = numeric(context.inputTokensEstimate);
  if (!rates || inputTokens <= 0) {
    return null;
  }
  return inputTokens * numeric(rates.input);
}

function EmptyState({ workspace, onWorkspaceManage }) {
  return h("div", { className: "empty-state" },
    h(EmptyBlinkingSquare),
    h("button", {
      className: "empty-workspace-button",
      type: "button",
      onClick: onWorkspaceManage,
    },
      h(Icon, { name: "folder" }),
      h("span", null, "工作空间管理"),
      h("small", null, workspace?.name ?? "Default Workspace")
    )
  );
}

function EmptyBlinkingSquare() {
  return h("div", { className: "empty-blinking-square", role: "status", "aria-label": "等待输入" },
    h("dotlottie-wc", {
      className: "empty-blinking-lottie",
      src: "./assets/Blinking%20Square.lottie",
      autoplay: true,
      loop: true,
    })
  );
}

function MessageView({ message }) {
  if (message.role === "notice") {
    return h("article", { className: "notice-message" }, message.content);
  }
  if (message.role === "user") {
    return h("article", { className: "user-row" },
      h("div", { className: "user-bubble" },
        message.content ? h("div", { className: "user-text" }, message.content) : null,
        message.attachments?.length ? h(MessageAttachments, { attachments: message.attachments }) : null
      )
    );
  }
  return h("article", { className: `assistant-row${message.failed ? " failed" : ""}${message.streaming ? " streaming" : ""}` },
    h("div", { className: "assistant-avatar" },
      message.streaming ? h(ThinkingIndicator) : h("span", { className: "assistant-dot" })
    ),
    h("div", { className: "assistant-body" },
      h("div", { className: "assistant-blocks" },
        assistantBlocks(message).length
          ? assistantBlocks(message).map((block) => h(AssistantBlock, { key: block.id, block }))
          : (message.failed ? "" : h("span", { className: "assistant-placeholder" })),
        message.cancelled ? h("div", { className: "assistant-stop-note" }, "已停止") : null
      )
    )
  );
}

function AttachmentTray({ attachments, onRemove }) {
  return h("div", { className: "attachment-tray" },
    attachments.map((attachment) => h(AttachmentPreview, {
      key: attachment.localId,
      item: attachment,
      onRemove: () => onRemove(attachment.localId),
    }))
  );
}

function AttachmentPreview({ item, onRemove }) {
  const attachment = item.attachment ?? {};
  const name = attachment.filename || item.name;
  const contentType = attachment.content_type || item.content_type;
  const previewUrl = item.previewUrl || attachmentPreviewUrl(attachment);
  const image = isImageAttachment({ content_type: contentType }) && previewUrl;
  return h("div", { className: `attachment-preview ${item.status}` },
    image ? h("img", { src: previewUrl, alt: name }) : h("div", { className: "attachment-file-icon" }, h(Icon, { name: "file" })),
    h("div", { className: "attachment-preview-main" },
      h("span", { className: "attachment-name", title: name }, name),
      h("span", { className: "attachment-meta" },
        item.status === "uploading" ? "上传中" : item.status === "failed" ? item.error || "上传失败" : `${formatBytes(attachment.size ?? item.size)} · ${contentType || "file"}`
      )
    ),
    h("button", { className: "attachment-remove", type: "button", title: "移除", onClick: onRemove },
      h(Icon, { name: "x" })
    )
  );
}

function MessageAttachments({ attachments }) {
  return h("div", { className: "message-attachments" },
    attachments.map((attachment) => h("a", {
      key: attachment.id ?? attachment.workspace_path,
      className: `message-attachment ${isImageAttachment(attachment) ? "image" : "file"}`,
      href: attachment.id ? `${apiBaseUrl}/api/attachments/${encodeURIComponent(attachment.id)}/content?access_token=${encodeURIComponent(readStoredAuth()?.token ?? "")}` : undefined,
      target: "_blank",
      rel: "noreferrer",
    },
      isImageAttachment(attachment)
        ? h("img", { src: attachmentPreviewUrl(attachment), alt: attachment.filename || attachment.safe_name || "image" })
        : h(Icon, { name: "file" }),
      h("span", null, attachment.filename || attachment.safe_name || attachment.workspace_path),
      h("small", null, formatBytes(attachment.size))
    ))
  );
}

function AssistantBlock({ block }) {
  if (block.type === "reasoning") {
    return h(ReasoningDisclosure, { block });
  }
  if (block.type === "tool") {
    return h(ToolDisclosure, { block });
  }
  return h(AssistantTextBlock, { block });
}

function AssistantTextBlock({ block }) {
  return h("div", { className: "assistant-text assistant-text-block" },
    block.text ? h(MarkdownView, { content: block.text }) : null
  );
}

function ReasoningDisclosure({ block }) {
  const [open, setOpen] = useState(false);
  const running = block.status === "running";
  return h("section", { className: `reasoning-disclosure${open ? " is-open" : ""}${running ? " is-running" : ""}` },
    h("button", {
      className: "reasoning-trigger",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      onClick: () => setOpen((value) => !value),
    },
      h("span", { className: "reasoning-title" }, "思考过程"),
      h("span", { className: "reasoning-meta" }, running ? "进行中" : "已完成"),
      h(Icon, { name: "chevron-down", className: "disclosure-chevron" })
    ),
    open ? h("div", { className: "reasoning-panel" }, block.text) : null
  );
}

function ToolDisclosure({ block }) {
  const [open, setOpen] = useState(block.status === "running" || block.status === "blocked");
  return h("section", { className: `tool-disclosure${open ? " is-open" : ""}` },
    h("button", {
      className: "tool-trigger",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      onClick: () => setOpen((value) => !value),
    },
      h("span", { className: "tool-title" }, block.name || "工具调用"),
      h("span", { className: `tool-status ${toolStatusClass(block.status)}` }, toolStatusLabel(block.status)),
      h(Icon, { name: "chevron-down", className: "disclosure-chevron" })
    ),
    open ? h("pre", { className: "tool-panel" }, block.detail || "等待工具输出") : null
  );
}

function MarkdownView({ content }) {
  return h("div", {
    className: "markdown-body",
    dangerouslySetInnerHTML: { __html: renderMarkdown(content) },
  });
}

function ThinkingIndicator({ className = "" } = {}) {
  return h("div", { className: `thinking-indicator ${className}`.trim(), role: "status", "aria-label": "正在思考" },
    h("dotlottie-wc", {
      className: "thinking-lottie",
      src: "./assets/thinking-blue.lottie",
      autoplay: true,
      loop: true,
    })
  );
}

function assistantMessage(id, settings) {
  return {
    id,
    role: "assistant",
    content: "",
    reasoning: "",
    tools: [],
    blocks: [],
    settings,
    failed: false,
    cancelled: false,
    streaming: true,
  };
}

function storedMessage(message) {
  if (message.role === "assistant") {
    return {
      id: message.id ?? crypto.randomUUID(),
      role: "assistant",
      content: message.content,
      reasoning: "",
      tools: [],
      blocks: message.content ? [{
        id: `${message.id ?? crypto.randomUUID()}-text`,
        type: "text",
        text: message.content,
        status: "completed",
      }] : [],
      failed: false,
      cancelled: false,
      streaming: false,
    };
  }
  return {
    id: message.id ?? crypto.randomUUID(),
    role: "user",
    content: message.payload?.text ?? message.content,
    attachments: message.attachments ?? message.payload?.attachments ?? [],
  };
}

function replaceUploadedAttachments(items, staged, uploaded) {
  let uploadIndex = 0;
  const stagedIds = new Set(staged.map((item) => item.localId));
  return items.map((item) => {
    if (!stagedIds.has(item.localId)) {
      return item;
    }
    const attachment = uploaded[uploadIndex++];
    if (!attachment) {
      return { ...item, status: "failed", error: "附件上传响应缺失" };
    }
    return {
      ...item,
      id: attachment.id,
      attachment,
      name: attachment.filename,
      size: attachment.size,
      content_type: attachment.content_type,
      status: "uploaded",
      error: "",
    };
  });
}

function canSubmit(input, attachments) {
  const hasText = Boolean(input.trim());
  const hasReadyAttachment = attachments.some((item) => item.status === "uploaded" && item.id);
  const blocked = attachments.some((item) => item.status === "uploading" || item.status === "failed");
  return !blocked && (hasText || hasReadyAttachment);
}

function isImageAttachment(attachment = {}) {
  return String(attachment.content_type ?? "").startsWith("image/");
}

function attachmentPreviewUrl(attachment = {}) {
  if (!attachment.id) {
    return "";
  }
  const auth = readStoredAuth();
  const token = auth?.token ?? "";
  const query = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return `${apiBaseUrl}/api/attachments/${encodeURIComponent(attachment.id)}/content${query}`;
}

function attachmentConversationTitle(attachments = []) {
  if (!attachments.length) {
    return "附件对话";
  }
  if (attachments.length === 1) {
    return attachments[0]?.filename || attachments[0]?.safe_name || "附件对话";
  }
  return `${attachments.length} 个附件`;
}

function isHiddenNotice(text) {
  return /not found|404/i.test(String(text?.message ?? text ?? ""));
}

function displayErrorMessage(error, fallback) {
  const text = String(error?.message ?? error ?? "").trim();
  return !text || isHiddenNotice(text) ? fallback : text;
}

function renderMarkdown(source) {
  const blocks = extractMathAndCode(String(source ?? ""));
  const escaped = escapeHtml(blocks.text).replace(/\r\n?/g, "\n");
  return restoreMathAndCode(renderMarkdownBlocks(escaped, blocks.tokens), blocks.tokens);
}

function extractMathAndCode(source) {
  const tokens = [];
  const addToken = (html, block = false) => {
    const token = `@@TOKEN_${tokens.length}@@`;
    tokens.push({ html, block });
    return token;
  };
  let text = source.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_match, language, code) => {
    return addToken(
      `<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ""}>${escapeHtml(code.trim())}</code></pre>`,
      true
    );
  });
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return addToken(`<code>${escapeHtml(code)}</code>`);
  });
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
    return addToken(renderKatex(expr, true), true);
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (_match, expr) => {
    return addToken(renderKatex(expr, false));
  });
  return { text, tokens };
}

function restoreMathAndCode(text, tokens) {
  return tokens.reduce((current, token, index) => current.replaceAll(`@@TOKEN_${index}@@`, token.html), text);
}

function renderKatex(expr, displayMode) {
  const raw = String(expr ?? "").trim();
  const katex = window.katex;
  if (!katex?.renderToString) {
    return displayMode ? `<div class="math-fallback">$$${escapeHtml(raw)}$$</div>` : `<span class="math-fallback">$${escapeHtml(raw)}$</span>`;
  }
  try {
    return katex.renderToString(raw, { displayMode, throwOnError: false, strict: "ignore" });
  } catch {
    return displayMode ? `<div class="math-fallback">$$${escapeHtml(raw)}$$</div>` : `<span class="math-fallback">$${escapeHtml(raw)}$</span>`;
  }
}

function renderMarkdownBlocks(text, tokens) {
  const lines = text.split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isBlockTokenLine(line, tokens)) {
      html.push(line.trim());
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTableBlock(tableLines));
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^&gt;\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^&gt;\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${quoteLines.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items = [];
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(lines[index].replace(pattern, ""));
        index += 1;
      }
      html.push(renderListBlock(items, ordered));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index, tokens)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${renderInline(paragraphLines.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return html.join("\n");
}

function startsMarkdownBlock(lines, index, tokens) {
  const line = lines[index] ?? "";
  return isBlockTokenLine(line, tokens)
    || /^(#{1,6})\s+/.test(line)
    || /^&gt;\s?/.test(line)
    || /^\s*[-*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || isTableStart(lines, index);
}

function isBlockTokenLine(line, tokens) {
  const tokenIndex = tokenIndexFromLine(line);
  return tokenIndex >= 0 && Boolean(tokens[tokenIndex]?.block);
}

function tokenIndexFromLine(line) {
  const match = line.trim().match(/^@@TOKEN_(\d+)@@$/);
  return match ? Number(match[1]) : -1;
}

function isTableStart(lines, index) {
  const current = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  return current.includes("|")
    && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function renderTableBlock(lines) {
  const headers = splitTableRow(lines[0]).map(renderInline);
  const rows = lines.slice(2).map((row) => splitTableRow(row).map(renderInline));
  const thead = `<thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function renderListBlock(items, ordered) {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`;
}

function renderInline(text) {
  return String(text ?? "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, href) => (
      `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${label}</a>`
    ))
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>");
}

function splitTableRow(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function eventSettings(payload = {}, fallback) {
  return {
    model: payload?.model ?? fallback.model,
    reasoningEffort: payload?.reasoningEffort ?? payload?.reasoning_effort ?? fallback.reasoningEffort,
    speedMode: payload?.speedMode ?? payload?.speed_mode ?? fallback.speedMode,
  };
}

function initialUsagePanel(runId, settings = {}) {
  return {
    runId,
    context: {
      model: settings.model,
      usedPercent: 0,
      remainingTokens: 0,
      usableContextTokens: 0,
      breakdown: [],
    },
    totals: {
      inputTokens: null,
      outputTokens: 0,
      totalTokens: 0,
      pricingConfigured: false,
    },
    usageEvents: [],
  };
}

function usagePanelFromEstimate(payload = {}, current = null) {
  return {
    ...(current ?? initialUsagePanel(null)),
    context: {
      ...(current?.context ?? {}),
      callId: payload.callId,
      callIndex: payload.callIndex,
      model: payload.model,
      serviceTier: payload.serviceTier,
      tokenizer: payload.tokenizer,
      contextWindow: numeric(payload.contextWindow),
      reservedOutputTokens: numeric(payload.reservedOutputTokens),
      usableContextTokens: numeric(payload.usableContextTokens),
      inputTokensEstimate: numeric(payload.inputTokensEstimate),
      remainingTokens: numeric(payload.remainingTokens),
      usedPercent: clampPercent(payload.usedPercent),
      breakdown: normalizeBreakdown(payload.breakdown, numeric(payload.usableContextTokens)),
    },
  };
}

function usagePanelFromModelUsage(payload = {}, current = null) {
  if (payload.source === "response.completed" && hasProviderUsage(current)) {
    return current;
  }
  const usage = payload.usage ?? {};
  const context = contextFromUsagePayload(payload, current);
  return {
    ...(current ?? initialUsagePanel(null)),
    context,
    totals: {
      ...(current?.totals ?? {}),
      inputTokens: numeric(usage.inputTokens),
      cachedTokens: numeric(usage.cachedTokens),
      outputTokens: numeric(usage.outputTokens),
      reasoningTokens: numeric(usage.reasoningTokens),
      totalTokens: numeric(usage.totalTokens),
      costMicroUsd: payload.costMicroUsd,
      costUsd: payload.costMicroUsd == null ? null : payload.costMicroUsd / 1000000,
      pricingConfigured: payload.costMicroUsd != null,
    },
    usageEvents: [...(current?.usageEvents ?? []), payload],
  };
}

function hasProviderUsage(panel) {
  return Array.isArray(panel?.usageEvents) && panel.usageEvents.some((event) => event?.source === "provider-usage");
}

function contextFromUsagePayload(payload = {}, current = null) {
  const hasContext = payload.usableContextTokens != null || payload.breakdown != null || payload.inputTokensEstimate != null;
  if (!hasContext) {
    return current?.context ?? {};
  }
  return usagePanelFromEstimate(payload, current).context;
}

function usagePanelFromSummary(summary = {}, current = null) {
  return {
    ...(current ?? initialUsagePanel(summary.runId)),
    runId: summary.runId ?? current?.runId ?? null,
    context: summary.context ? {
      ...(current?.context ?? {}),
      ...summary.context,
      usedPercent: clampPercent(summary.context.usedPercent),
      breakdown: normalizeBreakdown(summary.context.breakdown, numeric(summary.context.usableContextTokens)),
    } : current?.context ?? {},
    totals: {
      ...(current?.totals ?? {}),
      ...(summary.totals ?? {}),
    },
    usageEvents: summary.usageEvents ?? current?.usageEvents ?? [],
  };
}

function normalizeBreakdown(parts, usableTokens = 0) {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .map((part, index) => {
      const tokens = numeric(part.tokens);
      const denominator = usableTokens || numeric(part.denominator);
      return {
        key: part.key ?? `part_${index}`,
        label: promptPartLabel(part.key, part.label),
        tokens,
        percent: clampPercent(part.percent ?? (denominator ? (tokens / denominator) * 100 : 0)),
        color: partColor(index),
      };
    })
    .filter((part) => part.tokens > 0 || part.percent > 0);
}

function promptPartLabel(key, fallback) {
  const stableLabels = {
    system: "System",
    prompt: "Prompt",
    tools: "Tools",
    history: "History",
    current_user: "Current",
    tool_results: "Tool results",
    workspace: "Workspace",
    protocol: "Protocol",
  };
  if (stableLabels[key]) {
    return stableLabels[key];
  }
  const labels = {
    system: "系统提示",
    prompt: "Prompt",
    tools: "工具定义",
    history: "历史对话",
    current_user: "当前输入",
    tool_results: "工具结果",
    workspace: "工作区",
    protocol: "协议开销",
  };
  return labels[key] ?? fallback ?? key ?? "其他";
}

function partColor(index) {
  return ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#4b5563", "#a16207"][index % 8];
}

function runtimeLabel(settings) {
  return `${settings.model} · ${settings.reasoningEffort} · ${settings.speedMode}`;
}

function conversationTitle(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 36) : "新会话";
}

function displayConversationTitle(conversation) {
  if (conversation.title && conversation.title !== "WebCodex Chat") {
    return conversation.title;
  }
  return conversation.last_message_content || "新会话";
}

function displayActiveTitle(conversations, activeId) {
  const active = conversations.find((conversation) => conversation.id === activeId);
  return active ? displayConversationTitle(active) : "WebCodex";
}

function workspaceStatus(workspaces, currentWorkspaceId) {
  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  return current ? `当前：${current.name}` : "工作空间";
}

function formatConversationMeta(conversation) {
  const count = Number(conversation.message_count ?? 0);
  const updated = shortTime(conversation.updated_at ?? conversation.created_at);
  return updated ? `${updated} · ${count} 条` : `${count} 条`;
}

function formatCost(totals = {}) {
  if (totals.costUsd != null) {
    return `Cost $${formatDecimal(totals.costUsd)}`;
  }
  return "Cost pending";
}

function formatCostLegacy(totals = {}) {
  if (totals.costCredits != null) {
    return `额度 ${formatDecimal(totals.costCredits)} credits`;
  }
  if (totals.costUsd != null) {
    return `费用 $${formatDecimal(totals.costUsd)}`;
  }
  return "Cost pending";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(numeric(value));
}

function formatBytes(value) {
  const bytes = numeric(value);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2).replace(/0$/, "").replace(/\.$/, "")} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const number = clampPercent(value);
  return number >= 10 ? number.toFixed(1).replace(/\.0$/, "") : number.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
}

function formatDecimal(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return "0";
  }
  if (number === 0) {
    return "0";
  }
  return number < 0.01 ? number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeModelName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^openai\//, "");
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function clampPercent(value) {
  const number = numeric(value);
  return Math.max(0, Math.min(100, number));
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

function buildFileTree(files) {
  const root = new Map();
  for (const file of files) {
    const parts = String(file.path ?? "").split("/").filter(Boolean);
    let children = root;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      if (!children.has(part)) {
        children.set(part, {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
          size: 0,
          children: new Map(),
        });
      }
      const node = children.get(part);
      if (isFile) {
        node.type = "file";
        node.size = numeric(file.size);
        node.updated_at = file.updated_at;
        node.content_type = file.content_type;
      }
      children = node.children;
    });
  }
  return sortTreeNodes(root);
}

function sortTreeNodes(nodes) {
  return [...nodes.values()]
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "folder" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    })
    .map((node) => ({
      ...node,
      children: sortTreeNodes(node.children),
    }));
}

function countFolders(nodes) {
  return nodes.reduce((count, node) => (
    count + (node.type === "folder" ? 1 : 0) + countFolders(node.children ?? [])
  ), 0);
}

function assistantBlocks(message) {
  if (Array.isArray(message?.blocks) && message.blocks.length) {
    return message.blocks;
  }
  const blocks = [];
  if (message?.reasoning) {
    blocks.push({
      id: `${message.id ?? "assistant"}-reasoning`,
      type: "reasoning",
      text: message.reasoning,
      status: "completed",
    });
  }
  for (const tool of message?.tools ?? []) {
    blocks.push({ ...tool, type: "tool" });
  }
  if (message?.content) {
    blocks.push({
      id: `${message.id ?? "assistant"}-text`,
      type: "text",
      text: message.content,
      status: message.failed ? "failed" : "completed",
    });
  }
  return blocks;
}

function upsertBlock(blocks, id, createBlock, updateBlock) {
  const next = [...blocks];
  const existingIndex = next.findIndex((block) => block.id === id);
  if (existingIndex >= 0) {
    next[existingIndex] = updateBlock(next[existingIndex]);
  } else {
    next.push(updateBlock(createBlock()));
  }
  return next;
}

function reasoningBlockId(event, blocks) {
  return event.itemId ?? `reasoning-${blocks.filter((block) => block.type === "reasoning").length}`;
}

function reasoningText(blocks) {
  return blocks.filter((block) => block.type === "reasoning").map((block) => block.text ?? "").join("\n\n");
}

function textContent(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

function toolBlocks(blocks) {
  return blocks.filter((block) => block.type === "tool");
}

function displayEventName(type, fallback) {
  const labels = {
    "codex.command.started": "bash (/sandbox)",
    "codex.command.completed": "bash (/sandbox)",
    "codex.patch.started": "apply_patch",
    "codex.patch.completed": "apply_patch",
    "workspace.version.created": "workspace_export",
  };
  return labels[type] ?? fallback ?? "工具调用";
}

function statusFromEventType(type) {
  if (type.endsWith(".completed") || type === "workspace.version.created") {
    return "completed";
  }
  if (type.endsWith(".failed")) {
    return "failed";
  }
  if (type.endsWith(".started") || type.endsWith(".delta")) {
    return "running";
  }
  return type.replace("tool.call.", "");
}

function toolStatusLabel(status) {
  const labels = {
    running: "执行中",
    started: "执行中",
    completed: "已完成",
    failed: "失败",
    blocked: "待确认",
    approval_required: "待确认",
  };
  return labels[status] ?? status ?? "未知";
}

function toolStatusClass(status) {
  if (status === "completed") {
    return "is-completed";
  }
  if (status === "failed") {
    return "is-failed";
  }
  if (status === "blocked" || status === "approval_required") {
    return "is-blocked";
  }
  return "is-running";
}

function toolDetail(previous, event) {
  if (event.type === "tool.call.args.delta") {
    return `${previous}${event.payload?.delta ?? ""}`;
  }
  if (event.type === "tool.call.started") {
    return formatPayload(event.payload?.args ?? {});
  }
  if (event.type === "tool.call.completed") {
    return formatPayload(event.payload?.output ?? {});
  }
  if (event.type === "tool.call.failed") {
    return event.payload?.error ?? "工具执行失败";
  }
  if (event.type === "codex.command.started") {
    return formatPayload({
      command: event.payload?.command,
      cwd: event.payload?.cwd,
    });
  }
  if (event.type === "codex.command.completed") {
    return formatPayload({
      exitCode: event.payload?.exitCode,
      timedOut: event.payload?.timedOut,
      durationMs: event.payload?.durationMs,
      stdout: event.payload?.stdout,
      stderr: event.payload?.stderr,
    });
  }
  if (event.type === "codex.patch.started") {
    return formatPayload(event.payload?.operation ?? event.payload ?? {});
  }
  if (event.type === "codex.patch.completed") {
    return formatPayload({
      status: event.payload?.status,
      output: event.payload?.output,
    });
  }
  if (event.type === "workspace.version.created") {
    return formatPayload({
      versionId: event.payload?.versionId,
      exported: event.payload?.exported,
    });
  }
  return formatPayload(event.payload ?? {});
}

function formatPayload(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function userInitial(user) {
  const source = user?.name || user?.account || "U";
  return source.trim().slice(0, 1).toUpperCase();
}

function readStoredAuth() {
  try {
    const raw = localStorage.getItem(authStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredAuth(auth) {
  localStorage.setItem(authStorageKey, JSON.stringify(auth));
}

function clearStoredAuth() {
  localStorage.removeItem(authStorageKey);
}

function resolveApiBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("api");
  if (explicit) {
    const normalized = explicit.replace(/\/$/, "");
    localStorage.setItem(apiBaseUrlStorageKey, normalized);
    return normalized;
  }
  return localStorage.getItem(apiBaseUrlStorageKey) || "http://127.0.0.1:8000";
}

createRoot(document.querySelector("#root")).render(h(App));
