# WebCodex Demo PRD

## 1. 背景

我们要做一个 Web 版 Codex 应用。用户通过浏览器发起任务，系统在隔离环境中运行 Codex/Agent，Codex/Agent 通过受控工具访问用户工作空间文件，并将过程和结果流式展示给前端。

这一版 demo 需要先把两个核心边界搭清楚：

1. **SQLite 是业务元数据库**  
   用来存用户、工作空间、文件索引、文件版本、文件操作历史、对话历史、run 记录、run event 记录。

2. **阿里云 OSS 是文件内容存储**  
   文件内容不直接塞进 SQLite，而是按 SHA-256 写入阿里云 OSS 的固定前缀下，例如 `beta/objects/`。SQLite 只保存 blob key、sha、size、content type 等元数据。

这和未来真实架构保持一致：

```text
SQLite demo       -> future Postgres
Aliyun OSS        -> production object storage
Node worker       -> OpenAI Agents SDK / future Codex SDK runtime
```

## 2. 产品目标

### 2.1 Demo 阶段目标

demo 需要支持：

- 创建用户。
- 创建用户工作空间。
- 向工作空间写入文件。
- 从工作空间读取文件。
- 查询工作空间当前文件列表。
- 查询文件操作历史。
- 创建 conversation。
- 创建 run。
- 将用户消息写入历史记录。
- 启动 Node worker。
- 接收 Node worker 流式事件。
- 将 run event 存入 SQLite。
- 通过 SSE 向前端实时展示 run event。
- 支持基于 `seq` 的事件重放。

### 2.2 中长期目标

后续版本需要支持：

- 多用户、多 workspace。
- workspace 文件树、版本管理、重命名、删除、回滚。
- OSS 导入和导出。
- Codex/Agent 工具调用 workspace 文件 API。
- Codex/Agent 在沙箱中执行命令。
- 文件 diff、patch、提交。
- 高危操作审批。
- 前端展示工具调用、命令输出、文件变更和最终 diff。
- SQLite 替换为 Postgres。
- 阿里云 OSS 增加分片上传、生命周期策略和临时凭证。
- SSE 事件分发替换为 Redis Stream、NATS 或 Kafka。

## 3. 当前非目标

demo 暂不做：

- 登录鉴权系统。
- 企业级 RBAC。
- 大文件分片上传。

## 4. 核心架构

```text
Browser
  -> FastAPI Backend
    -> SQLite business metadata database
    -> Aliyun OSS object store
    -> Node worker process
      -> normalized event protocol
    -> SSE stream
  -> Browser
```

### 4.1 SQLite 负责什么

SQLite 是 demo 的业务数据库，负责保存可查询、可关联、可审计的元数据：

```text
users
workspaces
workspace_versions
workspace_files
file_ops
conversations
messages
runs
run_events
```

SQLite 不保存大文件内容。即使 demo 阶段文件很小，也不要为了方便把文件内容直接放进 SQLite，因为这会和未来 OSS 架构不一致。

### 4.2 阿里云 OSS 负责什么

阿里云 OSS 保存所有 workspace 文件内容。对象 key 必须使用固定前缀，当前配置为：

```text
OSS_ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com
OSS_BUCKET_NAME=your-oss-bucket
OSS_KEY_PREFIX=your-fixed-prefix
```

对象 key 结构：

```text
beta/
  objects/
    ab/
      abcd...sha256
```

写入文件时：

1. 后端对文件内容计算 SHA-256。
2. 文件内容写入 `{OSS_KEY_PREFIX}/objects/{sha前两位}/{sha}`。
3. SQLite 的 `workspace_files` 只保存 blob key 和元数据。

这种设计让不同环境或租户可以通过固定前缀隔离对象：

```text
beta/objects/{sha-prefix}/{sha}
  ~= oss://your-oss-bucket/{fixed_prefix}/objects/{sha-prefix}/{sha}
```

### 4.3 Node Worker 负责什么

Node worker 是 Codex SDK / OpenAI Agents SDK 的承接层。

当前阶段它已经负责真实 SDK run：

- `run.started`
- `assistant.message.delta`
- `tool.call.started`
- `tool.call.completed`
- `assistant.message.done`
- `run.completed`

worker 的边界：

- 调用 OpenAI Agents SDK / Codex SDK。
- 将 SDK 原始事件映射为内部稳定事件协议。
- 将所有过程事件回传给后端。
- 后续通过工具调用后端 workspace API 读取/写入文件。
- 后续通过沙箱能力执行命令、生成 diff 和 artifact。

## 5. 数据模型

### 5.1 users

保存用户。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 用户 ID |
| `name` | TEXT | 用户显示名 |
| `created_at` | TEXT | 创建时间 |

demo 默认用户：

```text
demo-user
```

### 5.2 workspaces

保存用户工作空间。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | workspace ID |
| `user_id` | TEXT FK | 所属用户 |
| `name` | TEXT | workspace 名称 |
| `current_version_id` | TEXT | 当前版本 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 更新时间 |

demo 默认工作空间：

```text
demo-workspace
```

### 5.3 workspace_versions

保存 workspace 的版本历史。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 版本 ID |
| `workspace_id` | TEXT FK | workspace ID |
| `parent_version_id` | TEXT | 父版本 |
| `message` | TEXT | 版本说明 |
| `created_at` | TEXT | 创建时间 |

每次写文件都会创建一个新版本。

demo 版本策略：

- 新建 workspace 时创建 initial version。
- 写文件时从当前版本复制文件快照。
- 写入目标文件的新 blob 元数据。
- 更新 workspace 的 `current_version_id`。

### 5.4 workspace_files

保存某个版本下的文件索引。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_id` | TEXT PK | workspace ID |
| `version_id` | TEXT PK | version ID |
| `path` | TEXT PK | workspace 内路径 |
| `blob_key` | TEXT | 阿里云 OSS 对象 key，必须带固定前缀 |
| `blob_sha256` | TEXT | 内容 SHA-256 |
| `size` | INTEGER | 文件大小 |
| `content_type` | TEXT | 内容类型 |
| `deleted` | INTEGER | 是否删除 |
| `updated_at` | TEXT | 更新时间 |

注意：`workspace_files` 只存索引，不存文件内容。

### 5.5 file_ops

保存文件操作历史。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 操作 ID |
| `workspace_id` | TEXT FK | workspace ID |
| `version_id` | TEXT FK | version ID |
| `op` | TEXT | `created` / `modified` / future `renamed` / `deleted` |
| `path` | TEXT | 文件路径 |
| `old_path` | TEXT | rename 前路径 |
| `blob_sha256` | TEXT | 操作后的 blob sha |
| `created_at` | TEXT | 创建时间 |

demo 当前只实现：

```text
created
modified
```

### 5.6 conversations

保存对话。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | conversation ID |
| `user_id` | TEXT FK | 用户 ID |
| `workspace_id` | TEXT FK | workspace ID |
| `title` | TEXT | 标题 |
| `created_at` | TEXT | 创建时间 |

conversation 必须绑定 workspace。这样后续 Agent 工具调用时能知道当前操作哪个工作空间。

### 5.7 messages

保存对话历史。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | message ID |
| `conversation_id` | TEXT FK | conversation ID |
| `run_id` | TEXT | 关联 run |
| `role` | TEXT | `user` / `assistant` |
| `content` | TEXT | 消息内容 |
| `created_at` | TEXT | 创建时间 |

demo 当前在创建 run 时写入用户消息。assistant 消息后续可以从 run events 聚合，也可以在 `assistant.message.done` 时落表。

### 5.8 runs

保存一次任务运行。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | run ID |
| `conversation_id` | TEXT FK | conversation ID |
| `status` | TEXT | 状态 |
| `user_message` | TEXT | 本次用户输入 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 更新时间 |

状态：

```text
queued
running
completed
failed
cancelled
```

### 5.9 run_events

保存 run 过程事件。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | TEXT PK | run ID |
| `seq` | INTEGER PK | run 内递增序号 |
| `type` | TEXT | 事件类型 |
| `visibility` | TEXT | `user` / `debug` / `hidden` |
| `item_id` | TEXT | message/tool/command item ID |
| `parent_id` | TEXT | 父 item ID |
| `status` | TEXT | item 状态 |
| `payload_json` | TEXT | 事件 payload JSON |
| `created_at` | TEXT | 创建时间 |

`seq` 由后端写入事件时生成，用于：

- 前端排序。
- SSE 断线重连。
- 历史回放。
- 调试定位。

## 6. 阿里云 OSS 设计

### 6.1 写入

写入 workspace 文件时：

```text
PUT /api/workspaces/{workspace_id}/files/{path}
```

请求体：

```json
{
  "content": "hello workspace",
  "message": "seed README",
  "content_type": "text/plain; charset=utf-8"
}
```

后端处理：

1. 校验 workspace 是否存在。
2. 校验 path，禁止绝对路径和 `..`。
3. 对 `content` 计算 SHA-256。
4. 写入阿里云 OSS 固定前缀。
5. 创建 workspace 新版本。
6. 写入 `workspace_files`。
7. 写入 `file_ops`。
8. 返回文件元数据和 blob 元数据。

响应：

```json
{
  "file": {
    "path": "README.md",
    "blob_key": "beta/objects/12/12abcd...",
    "blob_sha256": "12abcd...",
    "size": 15,
    "content_type": "text/plain; charset=utf-8",
    "version_id": "ver_xxx",
    "op": "created"
  },
  "blob": {
    "key": "beta/objects/12/12abcd...",
    "sha256": "12abcd...",
    "size": 15
  }
}
```

### 6.2 读取

读取 workspace 文件时：

```text
GET /api/workspaces/{workspace_id}/files/{path}
```

后端处理：

1. 从 SQLite 找到当前版本下的文件记录。
2. 读取 `blob_key` 指向的阿里云 OSS 对象。
3. 返回文件元数据和内容。

响应：

```json
{
  "file": {
    "path": "README.md",
    "blob_key": "beta/objects/12/12abcd...",
    "blob_sha256": "12abcd...",
    "size": 15,
    "version_id": "ver_xxx"
  },
  "content": "hello workspace"
}
```

### 6.3 列表

```text
GET /api/workspaces/{workspace_id}/files
```

返回当前版本的文件列表。

后续可以支持：

```text
GET /api/workspaces/{workspace_id}/files?version_id=ver_xxx
```

### 6.4 文件操作历史

```text
GET /api/workspaces/{workspace_id}/file-ops
```

返回当前版本对应的文件操作。

后续可以增加：

```text
GET /api/workspaces/{workspace_id}/history
GET /api/workspaces/{workspace_id}/versions
GET /api/workspaces/{workspace_id}/versions/{version_id}/diff
```

## 7. Conversation 和 Run 流程

### 7.1 创建 Conversation

```text
POST /api/conversations
```

请求：

```json
{
  "user_id": "demo-user",
  "workspace_id": "demo-workspace",
  "title": "Demo Conversation"
}
```

demo 行为：

- 如果 user 不存在，自动创建。
- 如果 workspace 不存在，自动创建 initial workspace。
- 如果 workspace 存在但属于其他用户，返回错误。

### 7.2 创建 Run

```text
POST /api/conversations/{conversation_id}/runs
```

请求：

```json
{
  "message": "帮我检查工作区"
}
```

后端处理：

1. 查询 conversation。
2. 创建 run。
3. 将用户消息写入 `messages`。
4. 写入 `run.queued` event。
5. 启动 Node worker。
6. 将 `RUN_ID`、`WORKSPACE_ID`、`USER_MESSAGE` 传给 worker。

### 7.3 Worker 回传事件

worker 调用：

```text
POST /internal/runs/{run_id}/events
Authorization: Bearer dev-worker-token
```

后端处理：

1. 校验 worker token。
2. 校验 run 存在。
3. 为事件分配 seq。
4. 写入 `run_events`。
5. 如果是 `run.started`，更新 run 状态为 `running`。
6. 如果是 `run.completed`，更新 run 状态为 `completed`。
7. 如果是 `run.failed`，更新 run 状态为 `failed`。

### 7.4 前端 SSE

前端连接：

```text
GET /api/runs/{run_id}/events?after=0
```

SSE 输出：

```text
id: 1
event: run.queued
data: {"runId":"run_xxx","seq":1,"type":"run.queued","payload":{}}
```

断线重连：

```text
GET /api/runs/{run_id}/events?after=123
```

## 8. Run Event Protocol

### 8.1 事件结构

```ts
type RunEvent = {
  runId: string;
  seq: number;
  type: string;
  visibility: "user" | "debug" | "hidden";
  itemId?: string | null;
  parentId?: string | null;
  status?: "queued" | "running" | "completed" | "failed" | "blocked" | null;
  payload: Record<string, unknown>;
};
```

### 8.2 当前事件类型

```text
run.queued
run.started
run.completed
run.failed
assistant.message.created
assistant.message.delta
assistant.message.done
tool.call.started
tool.call.completed
codex.command.started
codex.command.output.delta
codex.command.completed
codex.file.changed
```

### 8.3 未来事件类型

```text
assistant.reasoning_summary.delta
assistant.reasoning_summary.done
agent.changed
tool.call.args.delta
tool.call.args.done
tool.call.output.delta
tool.call.failed
tool.call.approval_required
codex.patch.created
workspace.version.created
artifact.created
run.cancelled
run.heartbeat
```

### 8.4 不透传 SDK 原始事件

不允许前端直接绑定 OpenAI SDK / Codex SDK 原始事件。

原因：

- SDK 原始事件可能变化。
- 原始事件不一定适合 UI。
- 工具调用、模型输出、命令输出可能并发到达。
- 前端需要稳定的排序和重放机制。
- 后续可能替换 SDK。

## 9. API 清单

### 9.1 用户

```text
POST /api/users
GET  /api/users/{user_id}
```

### 9.2 工作空间

```text
POST /api/workspaces
GET  /api/workspaces/{workspace_id}
GET  /api/workspaces/{workspace_id}/files
PUT  /api/workspaces/{workspace_id}/files/{file_path}
GET  /api/workspaces/{workspace_id}/files/{file_path}
GET  /api/workspaces/{workspace_id}/file-ops
```

### 9.3 对话

```text
POST /api/conversations
GET  /api/conversations/{conversation_id}/messages
```

### 9.4 Run

```text
POST /api/conversations/{conversation_id}/runs
GET  /api/runs/{run_id}
GET  /api/runs/{run_id}/events
```

### 9.5 Worker 内部接口

```text
POST /internal/runs/{run_id}/events
```

## 10. 安全约束

demo 已有：

- worker 内部接口使用 `WORKER_TOKEN`。
- workspace file path 禁止绝对路径和 `..`。
- OSS key 解析时必须限制在固定 `OSS_KEY_PREFIX` 下。
- Node worker 不直接访问 SQLite。
- Node worker 不直接持有 OSS 凭证。

生产需要增加：

- 登录鉴权。
- tenant/workspace RBAC。
- worker 短期 job token。
- shell 命令审批。
- 沙箱无 root。
- 沙箱无长期密钥。
- 默认关闭公网。
- 工具输入输出审计。
- 敏感信息脱敏。

## 11. 验收标准

### 11.1 SQLite 业务表

- 能创建用户。
- 能创建 workspace。
- workspace 创建后有 initial version。
- 写文件会创建新 version。
- 写文件会记录 workspace_files。
- 写文件会记录 file_ops。
- 创建 run 会记录 user message。
- worker event 会记录 run_events。

### 11.2 阿里云 OSS

- 写文件后阿里云 OSS bucket 的 `OSS_KEY_PREFIX/objects/` 下存在对应 SHA 对象。
- 相同内容只写一份对象。
- SQLite 中只保存 blob key，不保存完整文件内容。
- 读取文件时能通过 blob key 返回原内容。

### 11.3 流式事件

- 创建 run 后能收到 `run.queued`。
- worker 开始后能收到 `run.started`。
- assistant 文本能逐步输出。
- 工具调用能展示。
- 命令输出能展示。
- 文件变更能展示。
- 完成后能收到 `run.completed`。
- `after` 参数能读取指定 seq 之后的事件。

## 12. 迭代计划

### Phase 1：真实 SDK worker 最小闭环

已具备：

- Node worker 使用 `@openai/agents` 启动真实 SDK run。
- 后端通过 `OPENAI_API_KEY`、`OPENAI_MODEL` 把模型配置传给 worker。
- worker 将 SDK stream 中的 assistant 文本增量回传为 `assistant.message.delta`。
- worker 完成后回传 `assistant.message.done` 和 `run.completed`。

### Phase 2：SDK streaming event 映射为 Run Event Protocol

已具备：

- `worker-node/src/sdk-events.mjs` 负责归一化 SDK 事件。
- `raw_model_stream_event` 中的 `response.output_text.delta` 映射为 `assistant.message.delta`。
- `run_item_stream_event` 中的 `tool_called` 映射为 `tool.call.started`。
- `run_item_stream_event` 中的 `tool_output` 映射为 `tool.call.completed`。
- agent 切换、reasoning、approval 等事件先以 debug/future protocol 事件保留。

### Phase 3：Workspace 工具暴露给 Node worker

已具备：

- `worker-node/src/tools/workspace.mjs`
- `workspace_list`
- `workspace_read`
- `workspace_write`
- `workspace_grep`
- `workspace_search`
- 后端提供带 `WORKER_TOKEN` 校验的 `/internal/workspaces/{workspace_id}/...` 接口。
- worker 工具只通过 Python API 访问 workspace，不持有 OSS 凭证。

Node worker 不直接读本地文件，不直接读 OSS，只通过 Python API 操作 workspace。

### Phase 4：本地沙箱

要做：

- 每个 run 创建临时 workspace 目录。
- 从 workspace API 导入文件。
- 在临时目录执行命令。
- 生成 diff。
- 导出修改到 workspace。

### Phase 5：前端体验完善

已具备：

- 展示真实 SDK 文本增量。
- 以 AI 对话形式展示用户消息和 assistant 消息。
- 展示 reasoning summary、工具调用、工具结果和最终输出。
- 前端可以按 run 选择模型、推理深度和速度模式；快速模式映射为 `service_tier=priority`，普通模式映射为 `service_tier=default`。

要做：

- 展示命令输出和文件变更。
- 展示 run 状态、错误和重放。

### Phase 6：生产数据库和 OSS 能力完善

要做：

- SQLite 替换为 Postgres。
- 阿里云 OSS 增加 STS 临时凭证、分片上传、生命周期策略和跨环境前缀规划。
- SSE 事件分发替换为 Redis Stream。
- 增加 worker pool。
- 增加权限和审计。

## 13. 当前项目结构

```text
webcodex/
  README.md
  .env.example
  backend/
    requirements.txt
    app/
      __init__.py
      config.py
      db.py
      oss_store.py
      main.py
  worker-node/
    package.json
    package-lock.json
    src/
      protocol.mjs
      sdk-events.mjs
      worker.mjs
  frontend/
    index.html
    main.js
    styles.css
  data/
    .gitkeep
  docs/
    PRD.md
    oss配置.txt
```

## 14. 关键决策

### 14.1 SQLite 存元数据，不存文件内容

这让 demo 和生产架构一致。未来完善 OSS 能力或迁移对象存储实现时，不需要重写 workspace 版本模型。

### 14.2 阿里云 OSS 使用固定前缀和 SHA-256 内容寻址

好处：

- 同内容自动去重。
- blob 不可变。
- 文件版本只需要引用 blob。
- 固定前缀让 demo、测试、生产环境的对象命名边界清晰。

### 14.3 Node worker 不直接访问 OSS

worker 只拿任务上下文和 worker token，不拿 OSS AK。未来真实生产中也应保持这个边界。

### 14.4 前端只消费规范化事件

前端不绑定 SDK 原始事件。这样 SDK 变化、worker 替换、工具扩展都不会直接冲击 UI。
