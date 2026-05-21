import React, { useEffect, useMemo, useRef, useState } from "./vendor/react.bundle.mjs";
import { createRoot } from "./vendor/react-dom-client.bundle.mjs";

const apiBaseUrlStorageKey = "webcodex.apiBaseUrl";
const apiBaseUrl = resolveApiBaseUrl();
const authStorageKey = "webcodex.auth";
const h = React.createElement;

const eventTypes = [
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

function App() {
  const [auth, setAuth] = useState(readStoredAuth);
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [model, setModel] = useState("gpt-5.4");
  const [reasoningEffort, setReasoningEffort] = useState("xhigh");
  const [speedMode, setSpeedMode] = useState("fast");
  const sourceRef = useRef(null);
  const activeAssistantIdRef = useRef(null);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
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
      .then(() => refreshConversations())
      .catch((error) => pushNotice(error.message));
    return () => sourceRef.current?.close();
  }, [token]);

  useEffect(() => {
    if (!token) {
      sourceRef.current?.close();
      activeAssistantIdRef.current = null;
      setConversationId(null);
      setConversations([]);
      setMessages([]);
      setRunning(false);
      setStatus("就绪");
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    refreshConversations().catch((error) => pushNotice(error.message));
  }, [workspaceId]);

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

  async function createRun(targetConversationId, message) {
    const response = await apiFetch(`/api/conversations/${targetConversationId}/runs`, {
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

  async function submitMessage(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || running) {
      return;
    }

    const assistantId = crypto.randomUUID();
    activeAssistantIdRef.current = assistantId;
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", content: text },
      assistantMessage(assistantId, settings),
    ]);
    setInput("");
    setRunning(true);
    setStatus("排队中");

    try {
      const targetConversationId = conversationId ?? (await createConversation(text));
      setConversationId(targetConversationId);
      const run = await createRun(targetConversationId, text);
      connectEvents(run.run_id);
      await refreshConversations(targetConversationId);
    } catch (error) {
      updateAssistant(assistantId, { content: error.message, failed: true });
      setRunning(false);
      setStatus("失败");
    }
  }

  function connectEvents(runId) {
    sourceRef.current?.close();
    const source = new EventSource(`${apiBaseUrl}/api/runs/${runId}/events?access_token=${encodeURIComponent(token)}`);
    sourceRef.current = source;
    source.onerror = () => {
      const assistantId = activeAssistantIdRef.current;
      if (assistantId) {
        updateAssistant(assistantId, { content: "事件流连接中断", failed: true });
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
      appendAssistantField(assistantId, "reasoning", event.payload?.text ?? "");
    } else if (event.type === "assistant.reasoning_summary.done") {
      ensureAssistantField(assistantId, "reasoning", event.payload?.text ?? "");
    } else if (event.type === "assistant.message.delta") {
      appendAssistantField(assistantId, "content", event.payload?.text ?? "");
    } else if (event.type === "assistant.message.done") {
      ensureAssistantField(assistantId, "content", event.payload?.text ?? "");
    } else if (event.type.startsWith("tool.call.")) {
      updateTool(assistantId, event);
    } else if (event.type === "run.completed") {
      setRunning(false);
      setStatus("已完成");
      sourceRef.current?.close();
      refreshConversations().catch((error) => pushNotice(error.message));
    } else if (event.type === "run.failed") {
      updateAssistant(assistantId, { content: event.payload?.error ?? "运行失败", failed: true });
      setRunning(false);
      setStatus("失败");
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
    setConversationId(targetConversationId);
    setMessages([]);
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
    setConversationId(null);
    setMessages([]);
    setStatus("就绪");
    inputRef.current?.focus();
  }

  function pushNotice(text) {
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "notice", content: text }]);
  }

  const activeTitle = displayActiveTitle(conversations, conversationId);

  return h("div", { className: "app-frame" },
    h(Sidebar, {
      user: auth?.user,
      conversations,
      activeId: conversationId,
      running,
      onNewChat: startNewChat,
      onSelect: selectConversation,
      onLogout: logout,
    }),
    h("main", { className: "chat-shell" },
      h(Header, {
        title: activeTitle,
        status,
        model,
        reasoningEffort,
        speedMode,
        onModel: setModel,
        onReasoning: setReasoningEffort,
        onSpeed: setSpeedMode,
      }),
      h("section", { className: "message-scroll", ref: messagesRef, "aria-live": "polite" },
        h("div", { className: "message-column" },
          messages.length === 0
            ? h(EmptyState)
            : messages.map((message) => h(MessageView, { key: message.id, message }))
        )
      ),
      h("form", { className: "composer-wrap", onSubmit: submitMessage },
        h("div", { className: "composer" },
          h("textarea", {
            ref: inputRef,
            value: input,
            rows: 1,
            placeholder: "输入消息，按 Enter 发送",
            disabled: running,
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            },
          }),
          h("div", { className: "composer-footer" },
            h("button", { className: "icon-button add-button", type: "button", disabled: running, title: "添加" }, "+"),
            h("div", { className: "composer-mode" }, "Agent"),
            h("button", { className: "send-button", type: "submit", disabled: running || !input.trim(), title: "发送" }, "↑")
          )
        )
      )
    )
  );

  function updateAssistant(id, patch) {
    setMessages((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function appendAssistantField(id, field, value) {
    if (!value) {
      return;
    }
    setMessages((items) => items.map((item) => (
      item.id === id ? { ...item, [field]: `${item[field] ?? ""}${value}` } : item
    )));
  }

  function ensureAssistantField(id, field, value) {
    if (!value) {
      return;
    }
    setMessages((items) => items.map((item) => (
      item.id === id && !String(item[field] ?? "").trim() ? { ...item, [field]: value } : item
    )));
  }

  function updateTool(id, event) {
    setMessages((items) => items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const callId = event.itemId ?? event.payload?.callId ?? `tool-${item.tools.length}`;
      const tools = [...item.tools];
      const existingIndex = tools.findIndex((tool) => tool.id === callId);
      const current = existingIndex >= 0 ? tools[existingIndex] : { id: callId, name: "工具调用", status: "started", detail: "" };
      const next = {
        ...current,
        name: event.payload?.name ?? current.name,
        status: event.status ?? event.type.replace("tool.call.", ""),
        detail: toolDetail(current.detail, event),
      };
      if (existingIndex >= 0) {
        tools[existingIndex] = next;
      } else {
        tools.push(next);
      }
      return { ...item, tools };
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

function Sidebar({ user, conversations, activeId, running, onNewChat, onSelect, onLogout }) {
  return h("aside", { className: "sidebar" },
    h("div", { className: "brand-row" },
      h("div", { className: "brand-mark" }, "K"),
      h("button", { className: "sidebar-toggle", type: "button", title: "侧栏" }, "◧")
    ),
    h("button", { className: "new-chat", type: "button", disabled: running, onClick: onNewChat },
      h("span", { className: "new-chat-icon" }, "+"),
      "新建会话",
      h("kbd", null, "Ctrl K")
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

function Header({ title, status, model, reasoningEffort, speedMode, onModel, onReasoning, onSpeed }) {
  return h("header", { className: "topbar" },
    h("div", { className: "title-block" },
      h("h1", null, title),
      h("span", { className: "chevron" }, "⌄")
    ),
    h("div", { className: "runtime-strip" },
      h("span", { className: "status-pill" }, status),
      h("select", { value: model, onChange: (event) => onModel(event.target.value), title: "模型" },
        h("option", { value: "gpt-5.4" }, "gpt-5.4"),
        h("option", { value: "gpt-5.3-codex" }, "gpt-5.3-codex"),
        h("option", { value: "gpt-5.2" }, "gpt-5.2")
      ),
      h("select", { value: reasoningEffort, onChange: (event) => onReasoning(event.target.value), title: "推理强度" },
        h("option", { value: "low" }, "low"),
        h("option", { value: "medium" }, "medium"),
        h("option", { value: "high" }, "high"),
        h("option", { value: "xhigh" }, "xhigh")
      ),
      h("select", { value: speedMode, onChange: (event) => onSpeed(event.target.value), title: "速度" },
        h("option", { value: "fast" }, "fast"),
        h("option", { value: "standard" }, "standard")
      )
    ),
    h("button", { className: "share-button", type: "button", title: "分享" }, "↗")
  );
}

function EmptyState() {
  return h("div", { className: "empty-state" },
    h("h2", null, "开始一个 WebCodex 会话"),
    h("p", null, "描述你要检查、修改或生成的内容，结果会在这里持续流式显示。")
  );
}

function MessageView({ message }) {
  if (message.role === "notice") {
    return h("article", { className: "notice-message" }, message.content);
  }
  if (message.role === "user") {
    return h("article", { className: "user-row" },
      h("div", { className: "user-bubble" }, message.content)
    );
  }
  return h("article", { className: `assistant-row${message.failed ? " failed" : ""}` },
    h("div", { className: "assistant-avatar" }, "●"),
    h("div", { className: "assistant-body" },
      message.settings ? h("div", { className: "assistant-runtime" }, runtimeLabel(message.settings)) : null,
      message.reasoning ? h("details", { className: "reasoning-box" },
        h("summary", null, "思考过程"),
        h("p", null, message.reasoning)
      ) : null,
      message.tools?.length ? h("div", { className: "tool-list" },
        message.tools.map((tool) => h("details", { className: "tool-card", key: tool.id },
          h("summary", null,
            h("span", null, tool.name || "工具调用"),
            h("small", null, tool.status)
          ),
          h("pre", null, tool.detail)
        ))
      ) : null,
      h("div", { className: "assistant-text" }, message.content || (message.failed ? "" : "正在思考..."))
    )
  );
}

function assistantMessage(id, settings) {
  return {
    id,
    role: "assistant",
    content: "",
    reasoning: "",
    tools: [],
    settings,
    failed: false,
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
      failed: false,
    };
  }
  return {
    id: message.id ?? crypto.randomUUID(),
    role: "user",
    content: message.content,
  };
}

function eventSettings(payload = {}, fallback) {
  return {
    model: payload?.model ?? fallback.model,
    reasoningEffort: payload?.reasoningEffort ?? payload?.reasoning_effort ?? fallback.reasoningEffort,
    speedMode: payload?.speedMode ?? payload?.speed_mode ?? fallback.speedMode,
  };
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

function formatConversationMeta(conversation) {
  const count = Number(conversation.message_count ?? 0);
  const updated = shortTime(conversation.updated_at ?? conversation.created_at);
  return updated ? `${updated} · ${count} 条` : `${count} 条`;
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
