import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@lottiefiles/dotlottie-wc";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { MarkdownRenderer } from "./components/markdown/MarkdownRenderer.jsx";
import "./styles/app.css";

const apiBaseUrlStorageKey = "webcodex.apiBaseUrl";
const apiBaseUrl = resolveApiBaseUrl();
const authStorageKey = "webcodex.auth";
const h = React.createElement;
const sidebarHistoryLimit = 5;
const folderMarkerFile = ".webcodex-folder";

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
  "sandbox.exports.created",
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
  const [billingUsage, setBillingUsage] = useState(null);
  const [modelCatalog, setModelCatalog] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState("chat");
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceFiles, setWorkspaceFiles] = useState([]);
  const [workspaceFolders, setWorkspaceFolders] = useState([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceTreeOpen, setWorkspaceTreeOpen] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const sourceRef = useRef(null);
  const activeAssistantIdRef = useRef(null);
  const currentRunIdRef = useRef(null);
  const eventSeqRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const composerFileInputRef = useRef(null);
  const composerDragDepthRef = useRef(0);
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
      .then(() => Promise.all([refreshConversations(), refreshWorkspaces(), loadBillingUsage()]))
      .catch((error) => pushNotice(error.message));
    loadModelCatalog().catch((error) => pushNotice(error.message));
    return () => sourceRef.current?.close();
  }, [token]);

  useEffect(() => {
    if (!token) {
      sourceRef.current?.close();
      activeAssistantIdRef.current = null;
      currentRunIdRef.current = null;
      eventSeqRef.current = 0;
      cancelRequestedRef.current = false;
      setConversationId(null);
      setConversations([]);
      setMessages([]);
      setAttachments([]);
      setRunning(false);
      setUsagePanel(null);
      setBillingUsage(null);
      setModelCatalog(null);
      setView("chat");
      setWorkspaces([]);
      setWorkspaceFiles([]);
      setWorkspaceFolders([]);
      setWorkspaceLoading(false);
      setWorkspaceFilesLoading(false);
      setWorkspaceError("");
      setWorkspaceTreeOpen(false);
      setAttachments([]);
      setAttachmentUploading(false);
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
    if (workspaceId) {
      refreshWorkspaceFiles(workspaceId).catch((error) => setWorkspaceError(error.message));
    }
  }, [workspaceId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    function handleWindowPaste(event) {
      if (!token || view !== "chat" || running) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const files = filesFromClipboard(event.clipboardData);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      handleComposerFiles(files);
    }
    window.addEventListener("paste", handleWindowPaste);
    return () => window.removeEventListener("paste", handleWindowPaste);
  }, [token, view, running, workspaceId, attachments.length]);

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
    eventSeqRef.current = 0;
    setView("chat");
    setAttachments([]);
    setAttachmentUploading(false);
    setDragActive(false);
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

  async function loadBillingUsage() {
    const response = await apiFetch("/api/billing/usage");
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "Failed to load billing usage");
    }
    setBillingUsage(body);
    return body;
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
    const params = new URLSearchParams({ limit: "200" });
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
      return items;
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function refreshWorkspaceFiles(targetWorkspaceId = workspaceId) {
    if (!targetWorkspaceId) {
      setWorkspaceFiles([]);
      setWorkspaceFolders([]);
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
      const normalized = normalizeWorkspaceEntries(body.files ?? [], body.folders ?? []);
      const files = normalized.files;
      const folders = normalized.folders;
      setWorkspaceFiles(files);
      setWorkspaceFolders(folders);
      return { files, folders };
    } finally {
      setWorkspaceFilesLoading(false);
    }
  }

  async function createWorkspaceFolder(path) {
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) {
      throw new Error("工作空间不可用");
    }
    const response = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = await response.json();
    if (response.status === 404) {
      const fallback = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/files/${encodeWorkspacePath(joinPath(path, folderMarkerFile))}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "",
          content_type: "text/plain; charset=utf-8",
          message: `create folder ${path}`,
        }),
      });
      const fallbackBody = await fallback.json();
      if (!fallback.ok) {
        throw new Error(fallbackBody.detail ?? "创建文件夹失败");
      }
      await Promise.all([refreshWorkspaceFiles(targetWorkspaceId), refreshWorkspaces()]);
      return fallbackBody;
    }
    if (!response.ok) {
      throw new Error(body.detail ?? "创建文件夹失败");
    }
    await Promise.all([refreshWorkspaceFiles(targetWorkspaceId), refreshWorkspaces()]);
    return body;
  }

  async function uploadWorkspaceFiles(fileList, targetPath = "") {
    const files = Array.from(fileList ?? []);
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId || files.length === 0) {
      return null;
    }
    const formData = new FormData();
    formData.set("target_path", targetPath);
    for (const file of files) {
      formData.append("files", file);
    }
    const response = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/upload`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "上传文件失败");
    }
    await Promise.all([refreshWorkspaceFiles(targetWorkspaceId), refreshWorkspaces()]);
    return body;
  }

  async function uploadChatAttachments(fileList) {
    const files = Array.from(fileList ?? []).filter(Boolean);
    if (!workspaceId || files.length === 0) {
      return [];
    }
    const remaining = Math.max(0, 20 - attachments.length);
    const selected = files.slice(0, remaining);
    if (!selected.length) {
      pushNotice("每条消息最多上传 20 个文件");
      return [];
    }
    const formData = new FormData();
    for (const file of selected) {
      formData.append("files", file);
    }
    setAttachmentUploading(true);
    try {
      const params = new URLSearchParams({ workspace_id: workspaceId });
      const response = await apiFetch(`/api/attachments?${params}`, {
        method: "POST",
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "上传附件失败");
      }
      const uploaded = body.attachments ?? [];
      setAttachments((items) => [...items, ...uploaded].slice(0, 20));
      await Promise.all([refreshWorkspaceFiles(workspaceId), refreshWorkspaces()]);
      return uploaded;
    } finally {
      setAttachmentUploading(false);
    }
  }

  async function handleComposerFiles(fileList) {
    try {
      await uploadChatAttachments(fileList);
    } catch (error) {
      pushNotice(error.message);
    }
  }

  function removeAttachment(attachmentId) {
    setAttachments((items) => items.filter((item) => item.id !== attachmentId));
  }

  function handleComposerDragEnter(event) {
    if (running) {
      return;
    }
    event.preventDefault();
    composerDragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleComposerDragOver(event) {
    if (running) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleComposerDragLeave(event) {
    if (running) {
      return;
    }
    event.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) {
      setDragActive(false);
    }
  }

  function handleComposerDrop(event) {
    if (running) {
      return;
    }
    event.preventDefault();
    composerDragDepthRef.current = 0;
    setDragActive(false);
    handleComposerFiles(event.dataTransfer.files);
  }

  function handleComposerPaste(event) {
    if (running) {
      return;
    }
    const files = filesFromClipboard(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    handleComposerFiles(files);
  }

  async function copyWorkspaceEntry(sourcePath, targetPath) {
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) {
      throw new Error("工作空间不可用");
    }
    const response = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_path: sourcePath, target_path: targetPath }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "复制失败");
    }
    await Promise.all([refreshWorkspaceFiles(targetWorkspaceId), refreshWorkspaces()]);
    return body;
  }

  async function moveWorkspaceEntry(sourcePath, targetPath) {
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) {
      throw new Error("工作空间不可用");
    }
    const response = await apiFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_path: sourcePath, target_path: targetPath }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "剪切失败");
    }
    await Promise.all([refreshWorkspaceFiles(targetWorkspaceId), refreshWorkspaces()]);
    return body;
  }

  function openWorkspaceTree() {
    setWorkspaceTreeOpen(true);
    if (workspaceId) {
      refreshWorkspaceFiles(workspaceId).catch((error) => setWorkspaceError(error.message));
    }
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

  async function submitMessage(event) {
    event.preventDefault();
    const text = input.trim();
    const selectedAttachments = attachments;
    if ((!text && selectedAttachments.length === 0) || running || attachmentUploading) {
      return;
    }

    const assistantId = crypto.randomUUID();
    activeAssistantIdRef.current = assistantId;
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", content: text, attachments: selectedAttachments },
      assistantMessage(assistantId, settings),
    ]);
    setInput("");
    setAttachments([]);
    setRunning(true);
    setUsagePanel(null);
    cancelRequestedRef.current = false;
    setStatus("排队中");

    try {
      const titleText = text || selectedAttachments.map((item) => item.safe_name || item.filename).join(", ") || "附件";
      const targetConversationId = conversationId ?? (await createConversation(titleText));
      setConversationId(targetConversationId);
      const run = await createRun(targetConversationId, text, selectedAttachments.map((item) => item.id));
      eventSeqRef.current = 0;
      setUsagePanel(initialUsagePanel(run.run_id, run.settings ?? settings));
      connectEvents(run.run_id);
      await refreshConversations(targetConversationId);
    } catch (error) {
      setAttachments(selectedAttachments);
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
    const params = new URLSearchParams({ access_token: token });
    if (eventSeqRef.current > 0) {
      params.set("after", String(eventSeqRef.current));
    }
    const source = new EventSource(`${apiBaseUrl}/api/runs/${runId}/events?${params}`);
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
    if (event?.seq != null) {
      eventSeqRef.current = Math.max(eventSeqRef.current, numeric(event.seq));
    }
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
      updateAssistant(assistantId, { payload: event.payload });
    } else if (event.type === "sandbox.exports.created") {
      updateAssistantPayload(assistantId, { sandbox_exports: event.payload?.exports ?? [] });
    } else if (event.type === "context.estimated") {
      setUsagePanel((current) => usagePanelFromEstimate(event.payload, current));
    } else if (event.type === "model.usage") {
      setUsagePanel((current) => usagePanelFromModelUsage(event.payload, current));
    } else if (shouldShowToolEvent(event)) {
      updateTool(assistantId, event);
    } else if (event.type === "run.completed") {
      updateAssistant(assistantId, { streaming: false });
      setRunning(false);
      cancelRequestedRef.current = false;
      setStatus("已完成");
      sourceRef.current?.close();
      loadRunUsage(event.runId ?? currentRunIdRef.current).catch((error) => pushNotice(error.message));
      loadBillingUsage().catch((error) => pushNotice(error.message));
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
    if (targetConversationId === conversationId) {
      return;
    }
    sourceRef.current?.close();
    activeAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    eventSeqRef.current = 0;
    cancelRequestedRef.current = false;
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
      const activeRun = body.activeRun;
      const storedMessages = (body.messages ?? []).map(storedMessage);
      const historicalMessages = await hydrateHistoricalMessages(storedMessages, activeRun?.id);
      if (activeRun && !isTerminalRunStatus(activeRun.status)) {
        const assistantId = crypto.randomUUID();
        activeAssistantIdRef.current = assistantId;
        currentRunIdRef.current = activeRun.id;
        setMessages([
          ...historicalMessages,
          assistantMessage(assistantId, eventSettings(activeRun.settings, settings)),
        ]);
        setUsagePanel(initialUsagePanel(activeRun.id, activeRun.settings ?? settings));
        setRunning(true);
        setStatus(runStatusLabel(activeRun.status));
        await replayRunEvents(activeRun.id, assistantId);
        connectEvents(activeRun.id);
      } else {
        setMessages(historicalMessages);
        setRunning(false);
        setUsagePanel(null);
        setStatus("就绪");
      }
      await refreshConversations(targetConversationId);
    } catch (error) {
      pushNotice(error.message);
      setStatus("加载失败");
    }
  }

  function startNewChat() {
    sourceRef.current?.close();
    activeAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    eventSeqRef.current = 0;
    cancelRequestedRef.current = false;
    setRunning(false);
    setView("chat");
    setConversationId(null);
    setMessages([]);
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

  async function replayRunEvents(runId, assistantId) {
    const response = await apiFetch(`/api/runs/${runId}/events/history?limit=5000`);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail ?? "加载运行事件失败");
    }
    eventSeqRef.current = 0;
    activeAssistantIdRef.current = assistantId;
    for (const event of body.events ?? []) {
      handleRunEvent(event);
    }
    eventSeqRef.current = numeric(body.lastSeq ?? eventSeqRef.current);
  }

  async function hydrateHistoricalMessages(items, activeRunId = null) {
    const runIds = [...new Set(items.map((item) => item.runId).filter((runId) => runId && runId !== activeRunId))];
    if (!runIds.length) {
      return items;
    }
    const eventEntries = await Promise.all(runIds.map(async (runId) => {
      try {
        const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/events/history?limit=5000`);
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.detail ?? "加载运行事件失败");
        }
        return [runId, body.events ?? []];
      } catch (error) {
        pushNotice(error.message);
        return [runId, []];
      }
    }));
    const eventsByRun = new Map(eventEntries);
    const assistantRunIds = new Set(items.filter((item) => item.role === "assistant" && item.runId).map((item) => item.runId));
    const hydrated = [];
    for (const item of items) {
      const events = item.runId ? eventsByRun.get(item.runId) : null;
      if (item.role === "assistant" && events?.length) {
        hydrated.push(historicalAssistantFromRunEvents(item.runId, events, item, settings));
      } else {
        hydrated.push(item);
      }
      if (item.role === "user" && item.runId && events?.length && !assistantRunIds.has(item.runId) && runEventsHaveAssistantTimeline(events)) {
        hydrated.push(historicalAssistantFromRunEvents(item.runId, events, null, settings));
      }
    }
    return hydrated;
  }

  const activeTitle = view === "workspaces"
    ? "工作空间"
    : view === "history"
      ? "聊天记录"
      : displayActiveTitle(conversations, conversationId);
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
      onShowAllHistory: () => setView("history"),
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
        status: view === "workspaces"
          ? workspaceStatus(workspaces, workspaceId)
          : view === "history"
            ? `${formatNumber(conversations.length)} 个会话`
            : status,
        usage: view === "chat" ? usagePanel : null,
        billingUsage,
        modelCatalog,
        showWorkspaceAction: view !== "workspaces",
        onWorkspaceManage: () => setView("workspaces"),
        showWorkspaceTreeAction: view === "chat",
        onWorkspaceTree: openWorkspaceTree,
      }),
      view === "workspaces"
        ? h(WorkspaceManager, {
          files: workspaceFiles,
          folders: workspaceFolders,
          workspaceId,
          loading: workspaceLoading,
          filesLoading: workspaceFilesLoading,
          error: workspaceError,
          onBack: () => setView("chat"),
          onRefresh: refreshWorkspaces,
          onRefreshFiles: () => refreshWorkspaceFiles(workspaceId),
          onCreateFolder: createWorkspaceFolder,
          onUploadFiles: uploadWorkspaceFiles,
          onCopyEntry: copyWorkspaceEntry,
          onMoveEntry: moveWorkspaceEntry,
        })
        : view === "history"
          ? h(ConversationHistoryPage, {
            conversations,
            activeId: conversationId,
            running,
            onBack: () => setView("chat"),
            onSelect: selectConversation,
          })
        : [
          h("section", {
            key: "messages",
            className: `message-scroll${hasMessages ? "" : " empty"}${dragActive ? " is-dragging" : ""}`,
            ref: messagesRef,
            "aria-live": "polite",
            onDragEnter: handleComposerDragEnter,
            onDragOver: handleComposerDragOver,
            onDragLeave: handleComposerDragLeave,
            onDrop: handleComposerDrop,
          },
            h("div", { className: "message-column" },
              !hasMessages
                ? h(EmptyState, {
                  workspace: auth?.workspace,
                  onWorkspaceManage: () => setView("workspaces"),
                })
                : messages.map((message) => h(MessageView, {
                  key: message.id,
                  message,
                  workspaceId,
                  apiFetch,
                  onNotice: pushNotice,
                }))
            )
          ),
          h("form", { key: "composer", className: `composer-wrap${hasMessages ? "" : " is-empty-chat"}`, onSubmit: submitMessage },
            h("input", {
              ref: composerFileInputRef,
              className: "composer-file-input",
              type: "file",
              multiple: true,
              onChange: (event) => {
                handleComposerFiles(event.target.files);
                event.target.value = "";
              },
            }),
            h("div", {
              className: `composer${dragActive ? " is-dragging" : ""}`,
              onDragEnter: handleComposerDragEnter,
              onDragOver: handleComposerDragOver,
              onDragLeave: handleComposerDragLeave,
              onDrop: handleComposerDrop,
            },
              attachments.length || attachmentUploading
                ? h("div", { className: "composer-attachments" },
                  attachments.map((attachment) => h(AttachmentChip, {
                    key: attachment.id,
                    attachment,
                    disabled: running,
                    onRemove: () => removeAttachment(attachment.id),
                  })),
                  attachmentUploading ? h("span", { className: "attachment-chip is-uploading" }, "上传中") : null
                )
                : null,
              h("textarea", {
                ref: inputRef,
                value: input,
                rows: 1,
                placeholder: "输入消息，按 Enter 发送",
                disabled: running,
                onChange: (event) => setInput(event.target.value),
                onPaste: handleComposerPaste,
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
                  disabled: running || attachmentUploading,
                  title: "上传文件",
                  onClick: () => composerFileInputRef.current?.click(),
                }, "+"),
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
                  disabled: running ? cancelRequestedRef.current : ((!input.trim() && attachments.length === 0) || attachmentUploading),
                  title: running ? "停止" : "发送",
                  onClick: running ? stopRun : undefined,
                },
                  h(Icon, { name: running ? "stop" : "arrow-up", className: "send-icon" })
                )
              )
            )
          )
        ]
      ,
      workspaceTreeOpen ? h(WorkspaceTreeDrawer, {
        files: workspaceFiles,
        folders: workspaceFolders,
        loading: workspaceFilesLoading,
        error: workspaceError,
        onRefresh: () => refreshWorkspaceFiles(workspaceId),
        onClose: () => setWorkspaceTreeOpen(false),
      }) : null
    )
  );

  function updateAssistant(id, patch) {
    setMessages((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function updateAssistantPayload(id, patch) {
    setMessages((items) => items.map((item) => item.id === id
      ? { ...item, payload: { ...(item.payload ?? {}), ...patch } }
      : item));
  }

  function updateTool(id, event) {
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const blocks = applyToolEventToBlocks(assistantBlocks(item), event);
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
  onShowAllHistory,
  onWorkspaceManage,
  onLogout,
}) {
  const visibleConversations = conversations.slice(0, sidebarHistoryLimit);
  const hasMoreConversations = conversations.length > sidebarHistoryLimit;

  return h("aside", { className: `sidebar${isOpen ? "" : " is-closed"}` },
    h("div", { className: "brand-row" },
      h(WcxLogo),
      h("button", { className: "sidebar-toggle", type: "button", title: "收起侧边栏", onClick: onToggle },
        h(Icon, { name: "panel-left-close" })
      )
    ),
    h("button", { className: "new-chat", type: "button", onClick: onNewChat },
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
        h("strong", null, "工作空间"),
        h("span", null, "文件管理")
      )
    ),
    h("div", { className: "history-title" }, "历史会话"),
    h("nav", { className: "history-list" },
      conversations.length === 0
        ? h("p", { className: "history-empty" }, "暂无会话")
        : visibleConversations.map((conversation) => h("button", {
          key: conversation.id,
          type: "button",
          className: "history-item",
          "aria-current": conversation.id === activeId ? "true" : "false",
          onClick: () => onSelect(conversation.id),
        },
          h("span", { className: "history-name" }, displayConversationTitle(conversation)),
          h("span", { className: "history-meta" }, formatConversationMeta(conversation))
        )),
      hasMoreConversations ? h("button", {
        className: "history-more-button",
        type: "button",
        onClick: onShowAllHistory,
      },
        h("span", null, "查看更多"),
        h("span", null, `${formatNumber(conversations.length)} 条`)
      ) : null
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

function ConversationHistoryPage({
  conversations,
  activeId,
  running,
  onBack,
  onSelect,
}) {
  return h("section", { className: "conversation-history-page" },
    h("div", { className: "conversation-history-head" },
      h("button", { className: "workspace-back-button", type: "button", onClick: onBack },
        h(Icon, { name: "arrow-left" }),
        "返回聊天"
      ),
      h("div", { className: "conversation-history-title" },
        h("h2", null, "聊天记录"),
        h("p", null, `${formatNumber(conversations.length)} 个历史会话`)
      )
    ),
    conversations.length === 0
      ? h("div", { className: "conversation-history-empty" }, "暂无会话")
      : h("div", { className: "conversation-history-list" },
        conversations.map((conversation) => h("button", {
          key: conversation.id,
          type: "button",
          className: "conversation-history-item",
          "aria-current": conversation.id === activeId ? "true" : "false",
          onClick: () => onSelect(conversation.id),
        },
          h("span", { className: "conversation-history-name" }, displayConversationTitle(conversation)),
          h("span", { className: "conversation-history-meta" }, formatConversationMeta(conversation))
        ))
      )
  );
}

function WorkspaceManager({
  files,
  folders,
  workspaceId,
  loading,
  filesLoading,
  error,
  onBack,
  onRefresh,
  onRefreshFiles,
  onCreateFolder,
  onUploadFiles,
  onCopyEntry,
  onMoveEntry,
}) {
  const uploadInputRef = useRef(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [clipboard, setClipboard] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const fileTree = useMemo(() => buildFileTree(files, folders), [files, folders]);
  const selectedEntry = selectedPath ? findTreeNode(fileTree, selectedPath) : null;
  const targetFolder = selectedEntry?.type === "folder" ? selectedEntry.path : selectedEntry ? parentPath(selectedEntry.path) : "";
  const totalSize = files.reduce((sum, file) => sum + numeric(file.size), 0);
  const folderCount = countFolders(fileTree);

  async function refreshAll() {
    setLocalError("");
    try {
      await Promise.all([onRefresh?.(), onRefreshFiles?.()]);
    } catch (refreshError) {
      setLocalError(refreshError.message);
    }
  }

  async function createFolderIn(targetPath) {
    const name = window.prompt("文件夹名称");
    const trimmed = name?.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      const path = joinPath(targetPath, trimmed);
      await onCreateFolder(path);
      setSelectedPath(path);
    } catch (folderError) {
      setLocalError(folderError.message);
    } finally {
      setContextMenu(null);
      setBusy(false);
    }
  }

  async function uploadSelectedFiles(event) {
    const selectedFiles = event.target.files;
    if (!selectedFiles?.length || busy) {
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      await onUploadFiles(selectedFiles, targetFolder);
    } catch (uploadError) {
      setLocalError(uploadError.message);
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }

  function chooseClipboard(mode) {
    const node = contextMenu?.node ?? selectedEntry;
    if (node) {
      setClipboard({ mode, path: node.path, type: node.type });
      setSelectedPath(node.path);
    }
    setContextMenu(null);
  }

  async function pasteClipboard(targetPath = targetFolder) {
    if (!clipboard || busy) {
      return;
    }
    const nextPath = joinPath(targetPath, baseName(clipboard.path));
    setBusy(true);
    setLocalError("");
    try {
      if (clipboard.mode === "cut") {
        await onMoveEntry(clipboard.path, nextPath);
        setClipboard(null);
      } else {
        await onCopyEntry(clipboard.path, nextPath);
      }
      setSelectedPath(nextPath);
    } catch (pasteError) {
      setLocalError(pasteError.message);
    } finally {
      setContextMenu(null);
      setBusy(false);
    }
  }

  async function copySelectedPath(node = selectedEntry) {
    if (!node) {
      return;
    }
    try {
      await copyText(node.path);
    } catch (copyError) {
      setLocalError(copyError.message);
    } finally {
      setContextMenu(null);
    }
  }

  function openContextMenu(event, node = null) {
    event.preventDefault();
    setSelectedPath(node?.path ?? "");
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      node,
    });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  const empty = files.length === 0 && folders.length === 0;
  const targetLabel = targetFolder || "工作空间";
  const contextTargetFolder = contextMenu?.node?.type === "folder"
    ? contextMenu.node.path
    : contextMenu?.node
      ? parentPath(contextMenu.node.path)
      : "";

  return h("section", { className: "workspace-manager" },
    h("div", { className: "workspace-manager-head" },
      h("button", { className: "workspace-back-button", type: "button", onClick: onBack },
        h(Icon, { name: "arrow-left" }),
        "返回聊天"
      ),
      h("div", { className: "workspace-manager-title" },
        h("h2", null, "工作空间")
      ),
      h("button", { className: "workspace-refresh-button", type: "button", disabled: loading || filesLoading || busy, onClick: refreshAll, title: "刷新" },
        h(Icon, { name: "refresh" }),
        loading || filesLoading ? "刷新中" : "刷新"
      )
    ),
    error || localError ? h("div", { className: "workspace-error" }, localError || error) : null,
    h("div", { className: "workspace-file-manager", onClick: closeContextMenu, onContextMenu: (event) => openContextMenu(event, null) },
      h("div", { className: "workspace-toolbar" },
        h("input", {
          ref: uploadInputRef,
          className: "workspace-hidden-input",
          type: "file",
          multiple: true,
          onChange: uploadSelectedFiles,
        }),
        h("button", { className: "workspace-refresh-button", type: "button", disabled: busy || !workspaceId, onClick: () => uploadInputRef.current?.click() },
          h(Icon, { name: "upload" }),
          "上传文件"
        )
      ),
      h("div", { className: "workspace-file-meta" },
        h("span", null, `位置：${targetLabel}`),
        selectedEntry ? h("span", null, `已选择：${selectedEntry.path}`) : h("span", null, "未选择文件或文件夹"),
        clipboard ? h("span", null, `${clipboard.mode === "cut" ? "剪切" : "复制"}：${clipboard.path}`) : null
      ),
      h("div", { className: "workspace-stats" },
        h("div", null, h("strong", null, formatNumber(files.length)), h("span", null, "文件")),
        h("div", null, h("strong", null, formatNumber(folderCount)), h("span", null, "文件夹")),
        h("div", null, h("strong", null, formatBytes(totalSize)), h("span", null, "总大小"))
      ),
      h("section", { className: "workspace-detail-panel" },
        h("div", { className: "workspace-tree-head" },
          h("h3", null, "文件和文件夹"),
          h("span", null, filesLoading ? "加载中" : `${formatNumber(files.length)} 个文件`)
        ),
        filesLoading && empty
          ? h("p", { className: "workspace-muted" }, "正在加载文件")
          : empty
            ? h("div", { className: "workspace-empty-files" },
              h(Icon, { name: "folder" }),
              h("strong", null, "暂无文件"),
              h("span", null, "可以新建文件夹或上传文件。")
            )
            : h(FileTree, {
              nodes: fileTree,
              selectedPath,
              onSelect: (node) => setSelectedPath(node.path),
              onContextMenu: openContextMenu,
            })
      ),
      contextMenu ? h(WorkspaceContextMenu, {
        x: contextMenu.x,
        y: contextMenu.y,
        node: contextMenu.node,
        clipboard,
        busy,
        onCreateFolder: () => createFolderIn(contextTargetFolder),
        onUpload: () => {
          closeContextMenu();
          uploadInputRef.current?.click();
        },
        onCopy: () => chooseClipboard("copy"),
        onCut: () => chooseClipboard("cut"),
        onPaste: () => pasteClipboard(contextTargetFolder),
        onCopyPath: () => copySelectedPath(contextMenu.node),
      }) : null
    )
  );
}

function WorkspaceContextMenu({
  x,
  y,
  node,
  clipboard,
  busy,
  onCreateFolder,
  onUpload,
  onCopy,
  onCut,
  onPaste,
  onCopyPath,
}) {
  return h("div", {
    className: "workspace-context-menu",
    style: { left: x, top: y },
    onClick: (event) => event.stopPropagation(),
    onContextMenu: (event) => event.preventDefault(),
  },
    h("button", { type: "button", disabled: busy, onClick: onCreateFolder },
      h(Icon, { name: "folder-plus" }),
      "新建文件夹"
    ),
    h("button", { type: "button", disabled: busy, onClick: onUpload },
      h(Icon, { name: "upload" }),
      "上传文件"
    ),
    node ? h("button", { type: "button", disabled: busy, onClick: onCopy },
      h(Icon, { name: "copy" }),
      "复制"
    ) : null,
    node ? h("button", { type: "button", disabled: busy, onClick: onCut },
      h(Icon, { name: "scissors" }),
      "剪切"
    ) : null,
    h("button", { type: "button", disabled: busy || !clipboard, onClick: onPaste },
      h(Icon, { name: "clipboard" }),
      "粘贴"
    ),
    node ? h("button", { type: "button", disabled: busy, onClick: onCopyPath },
      h(Icon, { name: "link" }),
      "复制路径"
    ) : null
  );
}

function WorkspaceTreeDrawer({ files, folders, loading, error, onRefresh, onClose }) {
  const [localError, setLocalError] = useState("");
  const fileTree = useMemo(() => buildFileTree(files, folders), [files, folders]);
  const empty = files.length === 0 && folders.length === 0;

  function copyPath(path) {
    setLocalError("");
    copyText(path).catch((copyError) => setLocalError(copyError.message));
  }

  return h("aside", { className: "workspace-tree-drawer" },
    h("div", { className: "workspace-tree-drawer-head" },
      h("h2", null, "工作空间"),
      h("div", { className: "workspace-tree-drawer-actions" },
        h("button", { className: "workspace-refresh-button", type: "button", disabled: loading, onClick: onRefresh, title: "刷新" },
          h(Icon, { name: "refresh" })
        ),
        h("button", { className: "workspace-refresh-button", type: "button", onClick: onClose, title: "关闭" },
          h(Icon, { name: "x" })
        )
      )
    ),
    error || localError ? h("div", { className: "workspace-error" }, localError || error) : null,
    loading && empty
      ? h("p", { className: "workspace-muted" }, "正在加载文件")
      : empty
        ? h("div", { className: "workspace-empty-files compact" },
          h(Icon, { name: "folder" }),
          h("strong", null, "暂无文件")
        )
        : h(FileTree, {
          nodes: fileTree,
          renderActions: (node) => h("button", {
            className: "file-tree-action",
            type: "button",
            title: "复制路径",
            onClick: () => copyPath(node.path),
          }, h(Icon, { name: "link" })),
        })
  );
}

function FileTree({ nodes, depth = 0, selectedPath = "", onSelect, onContextMenu, renderActions }) {
  return h("div", { className: "file-tree", style: { "--tree-depth": depth } },
    nodes.map((node) => h("div", { key: node.path, className: "file-tree-node" },
      h("div", {
        className: `file-tree-row ${node.type}${node.path === selectedPath ? " is-selected" : ""}`,
        role: onSelect ? "button" : undefined,
        tabIndex: onSelect ? 0 : undefined,
        onClick: onSelect ? () => onSelect(node) : undefined,
        onContextMenu: onContextMenu ? (event) => {
          event.stopPropagation();
          onContextMenu(event, node);
        } : undefined,
        onKeyDown: onSelect ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node);
          }
        } : undefined,
      },
        h(Icon, { name: node.type === "folder" ? "folder" : "file" }),
        h("span", { className: "file-tree-name", title: node.path }, node.name),
        node.type === "file" ? h("span", { className: "file-tree-size" }, formatBytes(node.size)) : null,
        renderActions ? h("div", {
          className: "file-tree-actions",
          onClick: (event) => event.stopPropagation(),
        }, renderActions(node)) : null
      ),
      node.children?.length ? h(FileTree, { nodes: node.children, depth: depth + 1, selectedPath, onSelect, onContextMenu, renderActions }) : null
    ))
  );
}

function WcxLogo() {
  return h("img", {
    className: "brand-logo-image",
    src: "/assets/wcx-logo-transparent.png",
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
  if (name === "folder-plus") {
    return h("svg", common,
      h("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" }),
      h("path", { d: "M12 11v6" }),
      h("path", { d: "M9 14h6" })
    );
  }
  if (name === "file") {
    return h("svg", common,
      h("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }),
      h("path", { d: "M14 2v6h6" })
    );
  }
  if (name === "image") {
    return h("svg", common,
      h("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }),
      h("circle", { cx: "9", cy: "9", r: "2" }),
      h("path", { d: "M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21" })
    );
  }
  if (name === "download") {
    return h("svg", common,
      h("path", { d: "M12 3v12" }),
      h("path", { d: "M7 10l5 5 5-5" }),
      h("path", { d: "M5 21h14" })
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
  if (name === "upload") {
    return h("svg", common,
      h("path", { d: "M12 3v12" }),
      h("path", { d: "M7 8l5-5 5 5" }),
      h("path", { d: "M5 21h14" })
    );
  }
  if (name === "copy") {
    return h("svg", common,
      h("rect", { width: "14", height: "14", x: "8", y: "8", rx: "2" }),
      h("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" })
    );
  }
  if (name === "scissors") {
    return h("svg", common,
      h("circle", { cx: "6", cy: "7", r: "3" }),
      h("circle", { cx: "6", cy: "17", r: "3" }),
      h("path", { d: "M8.6 8.6 19 19" }),
      h("path", { d: "M8.6 15.4 19 5" })
    );
  }
  if (name === "clipboard") {
    return h("svg", common,
      h("rect", { width: "14", height: "18", x: "5", y: "4", rx: "2" }),
      h("path", { d: "M9 4a3 3 0 0 1 6 0" }),
      h("path", { d: "M9 4h6" })
    );
  }
  if (name === "link") {
    return h("svg", common,
      h("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
      h("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" })
    );
  }
  if (name === "file-tree") {
    return h("svg", common,
      h("path", { d: "M4 4h6v6H4z" }),
      h("path", { d: "M14 14h6v6h-6z" }),
      h("path", { d: "M4 14h6v6H4z" }),
      h("path", { d: "M10 7h2a2 2 0 0 1 2 2v8" }),
      h("path", { d: "M10 17h4" })
    );
  }
  if (name === "x") {
    return h("svg", common,
      h("path", { d: "M18 6 6 18" }),
      h("path", { d: "m6 6 12 12" })
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

function Header({
  title,
  status,
  usage,
  billingUsage,
  modelCatalog,
  showWorkspaceAction = false,
  onWorkspaceManage,
  showWorkspaceTreeAction = false,
  onWorkspaceTree,
}) {
  return h("header", { className: "topbar" },
    h("div", { className: "title-block" },
      h("h1", null, title),
      usage ? h(UsageMeterStable, { usage, modelCatalog }) : null,
      billingUsage ? h("span", { className: "billing-total-pill", title: "用户累计消费金币" },
        `${formatCreditsFixed(billingUsage?.totals?.costCredits)} 金币`
      ) : null
    ),
    h("div", { className: "runtime-strip" },
      showWorkspaceTreeAction ? h("button", {
        className: "topbar-workspace-button",
        type: "button",
        onClick: onWorkspaceTree,
        title: "展开工作空间文件树",
      },
        h(Icon, { name: "file-tree" }),
        "文件树"
      ) : null,
      showWorkspaceAction ? h("button", {
        className: "topbar-workspace-button",
        type: "button",
        onClick: onWorkspaceManage,
        title: "打开工作空间",
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
    return `Cost $${formatDecimal(totals.costUsd)} / ${formatCredits(totals.costCredits)} 金币`;
  }
  const estimatedCost = estimatePromptCostUsd(context, modelCatalog);
  if (estimatedCost != null) {
    return `Est. $${formatDecimal(estimatedCost)} / ${formatCredits(estimateCredits(estimatedCost, modelCatalog))} 金币`;
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

function estimateCredits(usd, modelCatalog = null) {
  const rate = numeric(modelCatalog?.pricing?.usdToCreditsRate ?? 7);
  return numeric(usd) * rate;
}

function EmptyState() {
  return h("div", { className: "empty-state" },
    h(EmptyMascot)
  );
}

function EmptyMascot() {
  const rootRef = useRef(null);

  useEffect(() => {
    const node = rootRef.current;
    const supportsFinePointer = window.matchMedia?.("(pointer: fine)").matches ?? true;
    if (!node || !supportsFinePointer) {
      return undefined;
    }

    let frameId = 0;
    let pointer = null;

    function setGaze(prefix, x, y) {
      node.style.setProperty(`--${prefix}-gaze-x`, `${x}px`);
      node.style.setProperty(`--${prefix}-gaze-y`, `${y}px`);
    }

    function gazeFor(target) {
      const rect = target.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = pointer.x - centerX;
      const dy = pointer.y - centerY;
      const distance = Math.hypot(dx, dy);
      const maxOffset = 7;
      const offset = Math.min(maxOffset, distance / 22);
      return {
        x: distance ? (dx / distance) * offset : 0,
        y: distance ? (dy / distance) * offset : 0,
      };
    }

    function updateGaze() {
      frameId = 0;
      if (!pointer) {
        return;
      }
      const face = node.querySelector(".empty-mascot-face") ?? node;
      const side = node.querySelector(".empty-mascot-side") ?? node;
      const faceGaze = gazeFor(face);
      const sideGaze = gazeFor(side);
      setGaze("face", faceGaze.x, faceGaze.y);
      setGaze("side", sideGaze.x, sideGaze.y);
    }

    function handlePointerMove(event) {
      pointer = { x: event.clientX, y: event.clientY };
      if (!frameId) {
        frameId = window.requestAnimationFrame(updateGaze);
      }
    }

    function resetGaze() {
      pointer = null;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      setGaze("face", 0, 0);
      setGaze("side", 0, 0);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("blur", resetGaze);
    document.addEventListener("mouseleave", resetGaze);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("blur", resetGaze);
      document.removeEventListener("mouseleave", resetGaze);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return h("div", { className: "empty-mascot", ref: rootRef, role: "img", "aria-label": "等待输入" },
    h("div", { className: "empty-mascot-face" },
      h(MascotEye, { className: "face left" }),
      h(MascotEye, { className: "face right" })
    ),
    h("div", { className: "empty-mascot-side" },
      h(MascotEye, { className: "side left" }),
      h(MascotEye, { className: "side right" })
    )
  );
}

function MascotEye({ className }) {
  return h("span", { className: `empty-mascot-eye ${className}` },
    h("span", { className: "empty-mascot-pupil" })
  );
}

function MessageView({ message, workspaceId, apiFetch, onNotice }) {
  if (message.role === "notice") {
    return h("article", { className: "notice-message" }, message.content);
  }
  if (message.role === "user") {
    return h("article", { className: "user-row" },
      h("div", { className: "user-bubble" },
        message.content ? h("div", null, message.content) : null,
        message.attachments?.length ? h("div", { className: "user-attachments" },
          message.attachments.map((attachment) => h("span", { key: attachment.id, className: "user-attachment" },
            h(Icon, { name: attachment.model_kind === "image" ? "image" : "file" }),
            h("span", null, attachment.safe_name || attachment.filename || attachment.original_name || "file")
          ))
        ) : null
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
          ? assistantBlocks(message).map((block, index, blocks) => h(AssistantBlock, {
            key: block.id,
            block,
            showExports: index === blocks.findLastIndex((item) => item.type === "text"),
            streaming: message.streaming,
            message,
            workspaceId,
            apiFetch,
            onNotice,
          }))
          : (message.failed ? "" : h("span", { className: "assistant-placeholder" })),
        message.cancelled ? h("div", { className: "assistant-stop-note" }, "已停止") : null
      )
    )
  );
}

function AssistantBlock({ block, showExports = false, streaming = false, message, workspaceId, apiFetch, onNotice }) {
  if (block.type === "reasoning") {
    return h(ReasoningDisclosure, { block });
  }
  if (block.type === "tool") {
    return h(ToolDisclosure, { block });
  }
  return h(AssistantTextBlock, { block, showExports, streaming, message, workspaceId, apiFetch, onNotice });
}

function AssistantTextBlock({ block, showExports = false, streaming = false, message, workspaceId, apiFetch, onNotice }) {
  const exports = showExports ? (message?.payload?.sandbox_exports ?? []) : [];
  return h("div", { className: "assistant-text assistant-text-block" },
    block.text ? h(MarkdownView, { content: stripSandboxLinks(block.text), streaming: streaming && block.status !== "completed" }) : null,
    exports.length ? h(SandboxExportList, { exports, workspaceId, apiFetch, onNotice }) : null
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

function MarkdownView({ content, streaming = false }) {
  return h(MarkdownRenderer, { content, streaming });
}

function AttachmentChip({ attachment, disabled, onRemove }) {
  const name = attachment.safe_name || attachment.filename || attachment.original_name || "file";
  return h("span", { className: "attachment-chip", title: name },
    h(Icon, { name: attachment.model_kind === "image" ? "image" : "file" }),
    h("span", { className: "attachment-chip-name" }, name),
    h("span", { className: "attachment-chip-size" }, formatBytes(attachment.size)),
    h("button", { type: "button", disabled, onClick: onRemove, title: "移除" },
      h(Icon, { name: "x" })
    )
  );
}

function SandboxExportList({ exports: exportedFiles, workspaceId, apiFetch, onNotice }) {
  return h("div", { className: "sandbox-export-list" },
    exportedFiles.map((item, index) => h("div", {
      key: `${item.sandbox_path}-${index}`,
      className: `sandbox-export-card${item.ok ? "" : " is-failed"}`,
    },
      h("div", { className: "sandbox-export-main" },
        h(Icon, { name: item.ok ? "download" : "file" }),
        h("div", null,
          h("strong", null, item.description || baseName(item.workspace_path || item.sandbox_path) || "导出文件"),
          h("span", null, item.ok ? `${baseName(item.workspace_path)} · ${formatBytes(item.size)}` : item.error)
        )
      ),
      item.ok ? h("button", {
        type: "button",
        className: "sandbox-download-button",
        onClick: () => downloadWorkspaceFile({ workspaceId, path: item.workspace_path, apiFetch, onNotice }),
      }, "下载") : null
    ))
  );
}

async function downloadWorkspaceFile({ workspaceId, path, apiFetch, onNotice }) {
  try {
    if (!workspaceId || !path) {
      throw new Error("文件不可下载");
    }
    const response = await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/file-bytes/${encodeWorkspacePath(path)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail ?? "下载失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = baseName(path) || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    onNotice?.(error.message);
  }
}

function ThinkingIndicator({ className = "" } = {}) {
  return h("div", { className: `thinking-indicator ${className}`.trim(), role: "status", "aria-label": "正在思考" },
    h("dotlottie-wc", {
      className: "thinking-lottie",
      src: "/assets/thinking-blue.lottie",
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
      runId: message.run_id ?? message.runId ?? null,
      content: message.content,
      payload: message.payload,
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
    runId: message.run_id ?? message.runId ?? null,
    content: message.content,
    attachments: message.attachments ?? [],
    payload: message.payload,
  };
}

function runEventsHaveAssistantTimeline(events) {
  return events.some((event) => (
    event.type?.startsWith("assistant.") ||
    shouldShowToolEvent(event) ||
    event.type === "sandbox.exports.created" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ));
}

function historicalAssistantFromRunEvents(runId, events, baseMessage = null, fallbackSettings = {}) {
  let blocks = [];
  let payload = { ...(baseMessage?.payload ?? {}) };
  let failed = Boolean(baseMessage?.failed);
  let cancelled = Boolean(baseMessage?.cancelled);
  let settings = fallbackSettings;
  for (const event of events) {
    if (event.type === "run.started") {
      settings = eventSettings(event.payload, fallbackSettings);
    } else if (event.type === "assistant.reasoning_summary.delta") {
      blocks = applyReasoningDeltaToBlocks(blocks, event);
    } else if (event.type === "assistant.reasoning_summary.done") {
      blocks = applyReasoningDoneToBlocks(blocks, event);
    } else if (event.type === "assistant.message.delta") {
      blocks = applyTextDeltaToBlocks(blocks, event.payload?.text ?? "", event);
    } else if (event.type === "assistant.message.done") {
      blocks = applyTextDoneToBlocks(blocks, event.payload?.text ?? baseMessage?.content ?? "", event);
      payload = { ...payload, ...(event.payload ?? {}) };
    } else if (event.type === "sandbox.exports.created") {
      payload = { ...payload, sandbox_exports: event.payload?.exports ?? [] };
    } else if (shouldShowToolEvent(event)) {
      blocks = applyToolEventToBlocks(blocks, event);
    } else if (event.type === "run.failed") {
      failed = true;
      blocks = applyTextDoneToBlocks(blocks, displayErrorMessage(event.payload?.error, "运行失败"), event);
    } else if (event.type === "run.cancelled") {
      cancelled = true;
    }
  }
  if (baseMessage?.content && !textContent(blocks).trim()) {
    blocks = applyTextDoneToBlocks(blocks, baseMessage.content, { itemId: baseMessage.id, status: "completed" });
  }
  return {
    id: baseMessage?.id ?? `${runId}-assistant-history`,
    role: "assistant",
    runId,
    content: textContent(blocks),
    payload,
    reasoning: reasoningText(blocks),
    tools: toolBlocks(blocks),
    blocks,
    settings,
    failed,
    cancelled,
    streaming: false,
  };
}

function isHiddenNotice(text) {
  return /not found|404/i.test(String(text?.message ?? text ?? ""));
}

function displayErrorMessage(error, fallback) {
  const text = String(error?.message ?? error ?? "").trim();
  return !text || isHiddenNotice(text) ? fallback : text;
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
      costMicroCredits: payload.costMicroCredits,
      costCredits: payload.costMicroCredits == null ? null : payload.costMicroCredits / 1000000,
      pricingConfigured: payload.costMicroUsd != null,
    },
    usageEvents: [...(current?.usageEvents ?? []), payload],
  };
}

function hasProviderUsage(panel) {
  return Array.isArray(panel?.usageEvents) && panel.usageEvents.some((event) => event?.source === "provider-usage");
}

function isTerminalRunStatus(status) {
  return ["completed", "failed", "cancelled"].includes(String(status ?? ""));
}

function runStatusLabel(status) {
  const value = String(status ?? "");
  if (value === "queued") {
    return "排队中";
  }
  if (value === "starting") {
    return "启动中";
  }
  if (value === "running") {
    return "运行中";
  }
  return "运行中";
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
  return "工作空间";
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
    return `${formatCredits(totals.costCredits)} 金币`;
  }
  if (totals.costUsd != null) {
    return `Cost $${formatDecimal(totals.costUsd)}`;
  }
  return "Cost pending";
}

function formatCredits(value) {
  const number = numeric(value);
  if (number === 0) {
    return "0";
  }
  if (number < 0.000001) {
    return "<0.000001";
  }
  if (number < 0.01) {
    return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  return formatDecimal(number);
}

function formatCreditsFixed(value) {
  return numeric(value).toFixed(2);
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

function buildFileTree(files, folders = []) {
  const root = new Map();
  for (const folder of folders) {
    const parts = String(folder.path ?? "").split("/").filter(Boolean);
    let children = root;
    let currentPath = "";
    parts.forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!children.has(part)) {
        children.set(part, {
          name: part,
          path: currentPath,
          type: "folder",
          size: 0,
          children: new Map(),
        });
      }
      const node = children.get(part);
      node.type = "folder";
      children = node.children;
    });
  }
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
      }
      children = node.children;
    });
  }
  return sortTreeNodes(root);
}

function normalizeWorkspaceEntries(files, folders) {
  const folderPaths = new Set((folders ?? []).map((folder) => folder.path).filter(Boolean));
  const visibleFiles = [];
  for (const file of files ?? []) {
    const path = String(file.path ?? "");
    if (baseName(path) === folderMarkerFile) {
      const folderPath = parentPath(path);
      if (folderPath) {
        folderPaths.add(folderPath);
      }
      continue;
    }
    visibleFiles.push(file);
  }
  return {
    files: visibleFiles,
    folders: [...folderPaths].sort((left, right) => left.localeCompare(right, "zh-CN")).map((path) => ({ path })),
  };
}

function findTreeNode(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    const child = findTreeNode(node.children ?? [], path);
    if (child) {
      return child;
    }
  }
  return null;
}

function parentPath(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function baseName(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function joinPath(folder, name) {
  const left = String(folder ?? "").replace(/^\/+|\/+$/g, "");
  const right = String(name ?? "").replace(/^\/+|\/+$/g, "");
  return left ? `${left}/${right}` : right;
}

function encodeWorkspacePath(path) {
  return String(path ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function filesFromClipboard(clipboardData) {
  const items = Array.from(clipboardData?.items ?? []);
  const files = [];
  for (const item of items) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    if (file.type.startsWith("image/")) {
      const extension = extensionForContentType(file.type);
      files.push(new File([file], `screenshot-${timestampForFilename()}.${extension}`, { type: file.type }));
    } else {
      files.push(file);
    }
  }
  return files;
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "textarea" || tagName === "input" || tagName === "select";
}

function extensionForContentType(contentType) {
  if (contentType === "image/jpeg") {
    return "jpg";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  return "png";
}

function timestampForFilename() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function stripSandboxLinks(text) {
  return String(text ?? "").replace(/!\[[^\]]*\]\(sandbox:\/\/[^)]+\)/g, "").trim();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("复制失败");
  }
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

function shouldShowToolEvent(event) {
  if (event?.visibility === "debug" || event?.visibility === "hidden") {
    return false;
  }
  return event?.type?.startsWith("tool.call.") ||
    event?.type?.startsWith("codex.") ||
    event?.type === "workspace.version.created";
}

function applyReasoningDeltaToBlocks(blocks, event) {
  const text = event.payload?.text ?? "";
  if (!text) {
    return blocks;
  }
  const blockId = reasoningBlockId(event, blocks);
  return upsertBlock(blocks, blockId, () => ({
    id: blockId,
    type: "reasoning",
    text: "",
    status: event.status ?? "running",
  }), (block) => ({
    ...block,
    text: `${block.text ?? ""}${text}`,
    status: event.status ?? block.status ?? "running",
  }));
}

function applyReasoningDoneToBlocks(blocks, event) {
  const text = event.payload?.text ?? "";
  if (!String(text).trim()) {
    return blocks;
  }
  const blockId = reasoningBlockId(event, blocks);
  return upsertBlock(blocks, blockId, () => ({
    id: blockId,
    type: "reasoning",
    text,
    status: event.status ?? "completed",
  }), (block) => ({
    ...block,
    text: text && !String(block.text ?? "").trim() ? text : block.text,
    status: event.status ?? "completed",
  }));
}

function applyTextDeltaToBlocks(blocks, text, event, options = {}) {
  if (!text) {
    return blocks;
  }
  const last = blocks[blocks.length - 1];
  if (!options.forceNew && last?.type === "text") {
    const next = [...blocks];
    next[next.length - 1] = {
      ...last,
      text: `${last.text ?? ""}${text}`,
      status: options.status ?? event.status ?? last.status ?? "running",
    };
    return next;
  }
  return [
    ...blocks,
    {
      id: event.itemId ? `${event.itemId}-text-${blocks.length}` : `text-${blocks.length}`,
      type: "text",
      text,
      status: options.status ?? event.status ?? "running",
    },
  ];
}

function applyTextDoneToBlocks(blocks, text, event) {
  const existingText = textContent(blocks);
  if (text && !existingText.trim()) {
    return [
      ...blocks,
      {
        id: event.itemId ? `${event.itemId}-text-${blocks.length}` : `text-${blocks.length}`,
        type: "text",
        text,
        status: event.status ?? "completed",
      },
    ];
  }
  if (blocks.length && blocks[blocks.length - 1]?.type === "text") {
    const next = [...blocks];
    next[next.length - 1] = { ...next[next.length - 1], status: event.status ?? "completed" };
    return next;
  }
  return blocks;
}

function applyToolEventToBlocks(blocks, event) {
  const callId = event.itemId ?? event.payload?.callId ?? `tool-${blocks.length}`;
  const nextBlocks = [...blocks];
  const existingIndex = nextBlocks.findIndex((block) => block.type === "tool" && block.id === callId);
  const current = existingIndex >= 0 ? nextBlocks[existingIndex] : {
    id: callId,
    type: "tool",
    name: "工具调用",
    status: "started",
    detail: "",
  };
  const next = {
    ...current,
    name: event.payload?.displayName ?? event.payload?.name ?? displayEventName(event.type, current.name),
    status: toolEventStatus(event),
    detail: toolDetail(current.detail, event),
  };
  if (existingIndex >= 0) {
    nextBlocks[existingIndex] = next;
  } else {
    nextBlocks.push(next);
  }
  return nextBlocks;
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

function toolEventStatus(event) {
  if (event.type !== "codex.command.completed") {
    return event.status ?? statusFromEventType(event.type);
  }
  const summary = shellSummaryFromPayload(event.payload ?? {});
  if (
    event.payload?.ok === false ||
    summary.timedOut ||
    (summary.exitCode != null && summary.exitCode !== 0)
  ) {
    return "failed";
  }
  return event.status ?? statusFromEventType(event.type);
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
    return formatPayload(shellSummaryFromPayload(event.payload ?? {}));
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

function shellSummaryFromPayload(payload) {
  const summary = normalizeShellOutput(payload.output);
  return {
    exitCode: payload.exitCode ?? summary.exitCode,
    timedOut: payload.timedOut ?? summary.timedOut,
    durationMs: payload.durationMs ?? summary.durationMs,
    stdout: payload.stdout || summary.stdout,
    stderr: payload.stderr || summary.stderr,
  };
}

function normalizeShellOutput(output) {
  const parsed = parseJsonMaybe(output);
  if (Array.isArray(parsed)) {
    return shellSummaryFromRows(parsed, null);
  }
  if (Array.isArray(parsed?.output)) {
    return shellSummaryFromRows(parsed.output, parsed.ok === false ? parsed.error ?? "Tool execution failed" : null);
  }
  if (parsed?.output) {
    return normalizeShellOutput(parsed.output);
  }
  if (parsed && typeof parsed === "object") {
    if ("stdout" in parsed || "stderr" in parsed || "outcome" in parsed) {
      return shellSummaryFromRows([parsed], null);
    }
    if (parsed.ok === false || parsed.error) {
      return shellSummaryFromRows([], parsed.error ?? "Tool execution failed");
    }
  }
  if (typeof parsed === "string" && parsed.trim()) {
    return shellSummaryFromRows([], parsed);
  }
  return shellSummaryFromRows([], null);
}

function shellSummaryFromRows(rows, error) {
  const last = rows.at(-1) ?? {};
  return {
    exitCode: last.outcome?.type === "exit" ? last.outcome.exitCode : null,
    timedOut: rows.some((row) => row?.outcome?.type === "timeout"),
    durationMs: numeric(last.duration_ms),
    stdout: rows.map((row) => row?.stdout ?? "").filter(Boolean).join("\n"),
    stderr: [
      rows.map((row) => row?.stderr ?? "").filter(Boolean).join("\n"),
      error,
    ].filter(Boolean).join("\n"),
  };
}

function formatPayload(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonMaybe(value) {
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

const rootElement = document.querySelector("#root");
window.__webcodexRoot = window.__webcodexRoot ?? createRoot(rootElement);
window.__webcodexRoot.render(h(App));
