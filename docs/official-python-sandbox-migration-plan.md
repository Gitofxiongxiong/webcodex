# WebCodex Official Python Sandbox Migration Plan

## 1. 决策摘要

WebCodex 的 agent runtime 迁移到 OpenAI Agents Python SDK 的官方 Sandbox Agent 架构。

核心决策：

- 放弃当前 Node worker 中自定义 Docker runtime + 自定义 shell/apply_patch/workspace bridge 的方向。
- 不再把用户上传文件包装成 Responses API 的 `input_image` / `input_file` 模型附件。
- 用户上传文件、图片、PDF 统一物化到 sandbox workspace 中，用户消息只告诉 agent 文件路径。
- agent 使用官方 `SandboxAgent`、`SandboxRunConfig`、`DockerSandboxClient`、`Manifest`、`Capabilities.default()`。
- `exec_command`、`write_stdin`、`apply_patch`、`view_image` 等能力来自官方 sandbox capabilities，而不是 WebCodex 自己定义同名或相似工具。
- WebCodex 自己只负责产品边界：用户消息、文件存储、run 生命周期、事件流、最终产物记录、workspace 持久化。

本项目还没有上线，不需要兼容旧 worker、旧工具名、旧附件投递方案和旧 run history。本次迁移优先目标是彻底修正 runtime 架构，避免继续在非官方接口上堆兼容逻辑。

## 2. 迁移原因

### 2.1 当前问题不是单点 bug

最初的报错是：

```text
400 Unknown parameter: 'input[4].content[1].attachment_id'
```

直接原因是当前 worker 把附件信息通过 `providerData` 叠加到了 Responses API content part 上，最后 relay / upstream 收到了不支持的 `attachment_id` 字段。

但这只是表层问题。更根本的问题是：当前 runtime 没有使用 OpenAI Agents SDK 官方的 sandbox 接口，而是在普通 `Agent` 外面自己拼了一套类似 sandbox 的工具系统。

当前实现的特征：

- 使用 `new Agent(...)`，不是 `SandboxAgent`。
- 自己启动 Docker container。
- 自己实现 `RuntimeShellExecutor`。
- 自己实现 `RuntimeWorkspaceEditor`。
- 自己实现 `workspace_import` / `workspace_export`。
- 自己把附件转成模型输入或文本索引。
- 没有绑定官方 `Filesystem()` capability。
- 因此官方 `view_image` 不会出现。

这会导致每遇到一个官方 sandbox 已经定义好的能力，就要在 WebCodex 里重新发明一遍，并承担协议漂移风险。

### 2.2 官方能力已经覆盖我们要的核心路径

OpenAI Agents Python SDK 的 sandbox 体系已经提供了我们需要的基础能力：

- `SandboxAgent`：在普通 agent 之上增加 sandbox workspace、manifest、capabilities、run identity。
- `SandboxRunConfig`：决定本次 run 使用哪个 sandbox session、client、snapshot 或 session state。
- `DockerSandboxClient`：官方 Docker 后端。
- `Manifest`：声明 sandbox 初始 workspace。
- `LocalDir` / `LocalFile` / `Dir`：把宿主机文件或目录物化到 sandbox。
- `Capabilities.default()`：默认包含 `Filesystem()`、`Shell()`、`Compaction()`。
- `Filesystem()`：提供官方 `apply_patch` 和 `view_image`。
- `Shell()`：提供官方 shell execution 能力。

官方中文文档也明确写到：`Filesystem` 用于编辑文件或检查本地图像，会添加 `apply_patch` 和 `view_image`；`Capabilities.default()` 默认包含 `Filesystem()`、`Shell()` 和 `Compaction()`。

参考资料：

- OpenAI Agents Python Sandbox Agents: `https://openai.github.io/openai-agents-python/sandbox/guide/`
- OpenAI Agents Python Sandbox Clients: `https://openai.github.io/openai-agents-python/sandbox/clients/`
- Python SDK source: `https://github.com/openai/openai-agents-python`
- JS SDK source for cross-check: `https://github.com/openai/openai-agents-js`

### 2.3 Python SDK 更适合作为本项目主 runtime

当前后端已经是 FastAPI / Python，继续保留 Node worker 会让系统长期处在双 runtime 状态：

```text
FastAPI backend
  -> Node worker
    -> JS Agents SDK
      -> custom Docker runtime
```

迁移后可以收敛为：

```text
FastAPI backend
  -> Python worker
    -> OpenAI Agents Python SDK
      -> official DockerSandboxClient
```

收益：

- 同语言栈，调试、类型、依赖和部署更简单。
- 可以直接复用 Python SDK 官方 sandbox 示例和接口。
- 不需要在 JS worker 里维护一套和 Python 后端重复的 HTTP client、session client、event client。
- 后续如果需要接入数据库、对象存储、权限、文件 diff，更容易和后端共享代码。

## 3. 迁移目的

本次迁移的目的不是“让旧方案继续能跑”，而是重建 agent runtime 的正确边界。

目标状态：

1. agent 面对的是一个真实 sandbox workspace，而不是模型附件列表。
2. 图片查看走官方 `view_image`。
3. 文件编辑走官方 `apply_patch`。
4. 命令执行走官方 shell capability。
5. Docker 生命周期走官方 `DockerSandboxClient`。
6. workspace 初始文件走官方 `Manifest` 物化。
7. run 完成后由 WebCodex 对 sandbox workspace 做持久化、diff 和产物登记。
8. WebCodex 不再维护和官方工具重叠的自定义工具协议。
9. provider / relay 兼容性问题被收敛在 model provider 层，而不是渗透到附件和工具层。

## 4. 非目标

本次迁移不做这些兼容：

- 不兼容旧 Node worker 的工具名和内部行为。
- 不兼容旧 `workspace_import` / `workspace_export` 工作流。
- 不兼容旧的 OpenAI file upload / `attachment_id` / `input_image` 附件方案。
- 不保证旧 run history 可继续作为新 SDK session replay。
- 不保证旧 SSE event schema 完全不变。
- 不继续维护 `viewTool2` 或自定义 `view_image`。
- 不把官方 SDK 源码 vendoring 为运行依赖。

可以保留的只是产品概念：

- 用户创建 conversation。
- 用户上传文件。
- 用户发起 run。
- 前端能看到 agent 过程。
- 最终文件能回到 workspace 或 outputs。

## 5. 目标架构

### 5.1 总体架构

```text
Browser
  -> FastAPI Backend
    -> SQLite metadata
    -> OSS object store
    -> Python worker process
      -> OpenAI Agents Python SDK
        -> SandboxAgent
        -> SandboxRunConfig
        -> DockerSandboxClient
        -> Docker container
          -> /workspace
          -> /workspace/attachments
          -> /workspace/outputs
```

### 5.2 运行时边界

FastAPI backend 负责：

- 用户、workspace、conversation、run 的业务元数据。
- 文件内容的 OSS 存储。
- run input 和 attachments 的查询接口。
- worker 进程启动和取消。
- 接收 worker events。
- SSE 转发给前端。
- run 完成后的 workspace commit 和 artifact 记录。

Python worker 负责：

- 从 backend 获取 run input。
- 把 workspace 文件和 attachments 物化到 host-side run workspace。
- 创建 `SandboxAgent`。
- 创建或恢复 official sandbox session。
- 调用 `Runner.run_streamed(...)`。
- 把 SDK stream event 转成 WebCodex run events。
- run 结束后把 sandbox workspace 同步回 host-side workspace。

OpenAI Agents Python SDK 负责：

- agent loop。
- model 调用。
- tool 调用协议。
- sandbox capability binding。
- Docker sandbox session 生命周期。
- 官方 `exec_command` / `write_stdin` / `apply_patch` / `view_image`。

Docker container 负责：

- 真正执行 shell 命令。
- 保存本次 run 的 workspace 文件。
- 运行测试、构建、解析图片、读取 PDF、生成 artifacts。

### 5.3 Workspace root 选择

推荐使用官方默认语义：`/workspace`。

原因：

- 官方文档和示例默认围绕 `/workspace`。
- `Manifest.root` 默认是 `/workspace`。
- `Filesystem()` 的 `apply_patch` 路径相对于 workspace root。
- 既然本项目不需要兼容旧方案，就不必继续坚持 `/sandbox`。

新约定：

```text
/workspace
  project files and generated working files

/workspace/attachments
  uploaded user attachments

/workspace/outputs
  files intended for user download or product artifact display
```

如果后续发现某些前端或导出逻辑仍依赖 `sandbox://`，应一起迁移为结构化 artifact event，而不是继续把 `/sandbox` 字符串暴露给模型。

## 6. 文件和附件策略

### 6.1 上传文件不再作为模型附件发送

用户上传任何文件后，backend 仍然可以保存 metadata 和 OSS blob，但 worker 启动时必须把文件下载或复制到 host-side run workspace：

```text
{run_workspace}/attachments/{attachment_id}/{safe_original_name}
```

agent 收到的用户消息只包含路径：

```text
Uploaded files are available in the sandbox workspace:
- attachments/att_123/image.png
- attachments/att_124/report.pdf
```

模型需要看图片时调用：

```text
view_image({"path": "attachments/att_123/image.png"})
```

模型需要处理 PDF、CSV、zip、源码等文件时，用 shell 或 Python 脚本读取。

### 6.2 Workspace 文件直接物化到 sandbox

旧方案让 agent 先通过 `workspace_tree` / `workspace_rg` 发现 workspace，再用 `workspace_import` 复制文件到 `/sandbox`。新方案不保留这个边界。

新方案：

1. run 开始前，backend / worker 根据 workspace metadata 从 OSS 还原当前 workspace 文件。
2. 文件写入 host-side run workspace。
3. `Manifest(entries={".": LocalDir(src=run_workspace)})` 将目录物化进 Docker sandbox。
4. agent 直接用官方 shell、apply_patch、view_image 在 workspace 内工作。
5. run 完成后 worker 计算 sandbox workspace 与 baseline 的差异。
6. backend 把新增、修改、删除写回 workspace 版本。

这样可以去掉一整类自定义工具和人为路径同步问题。

### 6.3 Baseline 和 diff

run 开始前生成 baseline manifest：

```json
{
  "files": {
    "src/app.py": {
      "sha256": "...",
      "size": 1234,
      "content_type": "text/x-python"
    }
  }
}
```

run 结束后重新扫描 `/workspace`，对比：

- added
- modified
- deleted
- unchanged

写回策略：

- `attachments/**` 默认不写回 workspace。
- `outputs/**` 作为 artifacts 记录。
- 其他路径作为 workspace 文件变更。
- 二进制文件用 bytes API 写回。
- 文本文件不用强制转 UTF-8，避免破坏 binary。

## 7. Python Worker 设计

### 7.1 目录结构

新增：

```text
worker-py/
  pyproject.toml
  webcodex_worker/
    __init__.py
    main.py
    config.py
    backend_client.py
    attachments.py
    workspace_materializer.py
    sandbox_runner.py
    session.py
    events.py
    diff.py
    artifacts.py
  tests/
    test_attachments.py
    test_diff.py
    test_session.py
    test_event_mapping.py
```

### 7.2 依赖

推荐依赖：

```toml
dependencies = [
  "openai-agents[docker]==0.17.3",
  "openai>=2",
  "docker>=7",
  "httpx>=0.28",
  "pydantic>=2",
  "python-dotenv>=1",
]
```

版本策略：

- 先 pin `openai-agents[docker]==0.17.3`。
- 官方 SDK 升级通过单独 PR 做。
- 不从本地 clone import SDK。
- 可以在 `external/openai-agents-python/` 保留源码 clone 作为分析资料，但必须加入 `.gitignore`，不作为运行依赖。

### 7.3 Worker env

保留必要 env，删除 Node 专属 env。

建议：

```text
API_BASE_URL
WORKER_TOKEN
RUN_ID
CONVERSATION_ID
WORKSPACE_ID

WORKER_RUNTIME=official_docker
WORKER_DOCKER_IMAGE=webcodex-agent-runtime:latest
WORKER_RUN_ROOT=...
WORKER_KEEP_CONTAINER=false

OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_API_PROTOCOL=responses
OPENAI_PROVIDER_PROFILE=official | relay
OPENAI_REASONING_EFFORT
OPENAI_REASONING_SUMMARY
OPENAI_TEXT_VERBOSITY
OPENAI_AGENTS_DISABLE_TRACING=1
```

不再需要：

```text
WORKER_RUNTIME_TOOL_MODE
OPENAI_RESPONSES_RELAY_MODE
OPENAI_SEND_SERVICE_TIER
SANDBOX_DIR
RUN_WORKSPACE_DIR
RUN_ARTIFACTS_DIR
```

如果某些 provider profile 仍需要 relay 特殊处理，应放在 Python `provider.py` 里集中处理。

### 7.4 Agent 构造

概念代码：

```python
from pathlib import Path

from docker import from_env as docker_from_env
from agents import ModelSettings, Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Capabilities
from agents.sandbox.entries import Dir, LocalDir
from agents.sandbox.sandboxes.docker import (
    DockerSandboxClient,
    DockerSandboxClientOptions,
)


def build_agent(model: str, workspace_root: Path) -> SandboxAgent[None]:
    manifest = Manifest(
        root="/workspace",
        entries={
            ".": LocalDir(src=workspace_root),
            "outputs": Dir(),
        },
    )
    return SandboxAgent(
        name="WebCodex Coding Agent",
        model=model,
        instructions=build_instructions(),
        default_manifest=manifest,
        capabilities=Capabilities.default(),
        model_settings=ModelSettings(
            parallel_tool_calls=True,
        ),
    )


async def run_agent(agent: SandboxAgent[None], input_items: list[dict], image: str):
    client = DockerSandboxClient(docker_from_env())
    run_config = RunConfig(
        sandbox=SandboxRunConfig(
            client=client,
            options=DockerSandboxClientOptions(image=image),
        ),
    )
    return Runner.run_streamed(agent, input_items, run_config=run_config)
```

注意：

- 上面是方向代码，不是最终代码。
- `LocalDir(src=workspace_root)` 的源路径边界要按官方规则处理。若源目录不在 worker cwd 下，需要配置 `Manifest.extra_path_grants` 或让 worker cwd 设为可信 workspace root 的父目录。
- 不要额外注册自定义 `shell`、`apply_patch`、`view_image`。

### 7.5 Instructions

新 instructions 应围绕官方 sandbox 工具，而不是 WebCodex 自定义工具。

要求：

- 明确当前工作区 root 是 `/workspace`。
- 上传文件在 `attachments/...`。
- 图片用 `view_image`。
- 文件编辑用 `apply_patch`。
- 命令执行用 shell capability。
- 输出给用户的文件写到 `outputs/`。
- 不声称能访问宿主机文件系统。
- 不再提 `workspace_import`。

示例要点：

```text
You work inside an official OpenAI Agents SDK sandbox workspace.
The workspace root is /workspace.
Uploaded files are under attachments/.
Use view_image for local image files.
Use apply_patch for file edits.
Use shell commands for inspection, tests, builds, conversion, and verification.
Write user-facing generated artifacts under outputs/.
```

## 8. Event 设计

不兼容旧 event schema，但需要保持前端可展示。

建议新 event schema 分三层：

### 8.1 Run lifecycle

```text
run.started
run.failed
run.completed
run.cancelled
```

### 8.2 Agent stream

```text
assistant.text.delta
assistant.text.completed
tool.call.started
tool.call.delta
tool.call.completed
tool.output
```

### 8.3 Product artifacts

```text
workspace.diff.created
workspace.commit.created
artifact.created
usage.recorded
```

事件原则：

- SDK 原始事件不要直接存成产品协议。
- worker 负责 adapter。
- backend 只接受稳定的 WebCodex event。
- 前端只依赖 WebCodex event。

### 8.4 Tool event 映射

需要覆盖官方 sandbox tools：

- `exec_command`
- `write_stdin`
- `apply_patch`
- `view_image`

`view_image` 的 tool output 可能是结构化 image output 或 data URL。前端展示不应依赖模型最后转述，而应从 tool event 中识别并显示。

## 9. Session 和上下文策略

### 9.1 不迁移旧 history

旧 session items 里可能包含旧工具、旧附件 part、旧 providerData。新 worker 不要 replay 旧格式。

迁移时可以清空开发环境旧 conversation 的 agent session，或在新 worker 中只消费迁移后的 messages。

### 9.2 新 session 存储

实现 Python `SessionABC`：

```python
class BackendConversationSession(SessionABC):
    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        ...

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        ...

    async def pop_item(self) -> TResponseInputItem | None:
        ...
```

这层继续走 backend internal API，但只保存新 SDK 可 replay 的 input/output items。

### 9.3 上下文压缩

先使用 `Capabilities.default()` 中的 `Compaction()`，不要自己实现旧 compaction。

验收项：

- 多轮对话不会因为旧工具输出格式导致 replay 失败。
- 图片路径在多轮对话里仍然可用。
- 历史中不出现 `attachment_id`、`input_image`、`openai_file_id` 这类旧附件字段。

## 10. Backend 改造

### 10.1 Worker 启动

把当前 `start_node_worker` 替换为通用 `start_worker`：

```text
start_worker
  -> if settings.worker_impl == "python":
       start_python_worker
     else:
       fail fast during migration
```

由于本项目不需要兼容旧方案，最终可以直接删除 Node worker 分支。

### 10.2 配置

新增：

```text
WORKER_IMPL=python
WORKER_PY_ENTRY=worker-py/webcodex_worker/main.py
WORKER_DOCKER_IMAGE=webcodex-agent-runtime:latest
WORKER_RUN_ROOT=...
```

删除或废弃：

```text
WORKER_ENTRY_PATH
WORKER_RUNTIME_TOOL_MODE
WORKER_RUNTIME
OPENAI_RESPONSES_RELAY_MODE
OPENAI_SEND_SERVICE_TIER
```

### 10.3 Attachment API

保留 backend attachment metadata 和 bytes API，但字段语义调整：

删除运行时依赖：

- `openai_file_id`
- `openai_purpose`
- `openai_status`
- `openai_error`

保留或新增：

- `sandbox_path`
- `content_type`
- `size`
- `sha256`
- `original_name`

### 10.4 Workspace commit

run 完成后，backend 接收 worker 生成的 diff summary：

```json
{
  "added": ["src/new.py"],
  "modified": ["src/app.py"],
  "deleted": ["old.txt"],
  "artifacts": ["outputs/report.html"]
}
```

backend 负责：

- 写 OSS objects。
- 更新 `workspace_files`。
- 创建 workspace version。
- 记录 run 与 version 的关系。
- 记录 artifacts。

## 11. Docker Image 策略

当前 `worker-node/Dockerfile.agent-runtime` 里已经有：

- Node
- Python
- curl
- git
- ripgrep
- poppler-utils
- Pillow
- Chromium
- CJK fonts

迁移后应把 Dockerfile 移到更中性的路径：

```text
docker/agent-runtime/Dockerfile
```

镜像名仍可先用：

```text
webcodex-agent-runtime:latest
```

镜像内约定：

- 默认用户非 root。
- 必须有 shell、python、node、rg、curl、git。
- 必须有常见图片/PDF 工具。
- 不内置长期密钥。
- 不挂载 Docker socket。
- 工作区由官方 Docker sandbox 创建和管理，不再由 WebCodex 手写 `docker run` 参数。

## 12. 源码分析策略

为了方便分析官方 SDK，可以把官方仓库 clone 到本地，但不能作为运行依赖。

推荐目录：

```text
external/openai-agents-python/
external/openai-agents-js/
```

规则：

- `external/` 加入 `.gitignore`。
- 不修改官方源码。
- 不从 `external/` import。
- 运行依赖来自 PyPI / npm package。
- 如果发现 SDK bug，记录 issue 或 fork patch，不在产品代码里 monkey patch。

当前已分析的官方源码点：

- Python SDK `ViewImageTool`：读取 workspace 图片，10 MB 限制，返回 `ToolOutputImage`。
- Python SDK `Capabilities.default()`：默认 `Filesystem()`、`Shell()`、`Compaction()`。
- Python SDK `DockerSandboxClient`：官方 Docker session backend。
- JS SDK `FilesystemCapability`：同样提供 `view_image`，用于确认 JS/Python 能力一致。

## 13. 分阶段迁移计划

### Phase 0: 架构冻结

目标：停止继续扩展旧 Node runtime。

任务：

- 本文档合并到 `docs/`。
- 旧 `agent-runtime-tooling-plan.md` 标记为废弃。
- 确认目标 SDK：`openai-agents[docker]==0.17.3`。
- 确认 workspace root：`/workspace`。
- 确认不再使用模型附件。
- 确认不保留旧工具兼容。

验收：

- 团队只按本文档推进 runtime。
- 新功能不再加到 Node worker。

### Phase 1: Python worker skeleton

目标：Python worker 能被 backend 启动，能拉取 run input，能回传最小事件。

任务：

- 新增 `worker-py/`。
- 新增 Python package 配置。
- 实现 `config.py` 读取 env。
- 实现 `backend_client.py`。
- 实现 `events.py`。
- 后端启动 worker 改为 Python entry。
- run started / failed / completed 打通。

验收：

- 创建 run 后 Python worker 进程启动。
- worker 能调用 backend internal API。
- 前端能看到 `run.started` 和 `run.completed`。
- 不调用 OpenAI，不启动 Docker。

### Phase 2: 官方 Docker Sandbox smoke test

目标：用官方 SDK 跑通最小 `SandboxAgent`。

任务：

- 集成 `openai-agents[docker]`。
- 构造 `SandboxAgent`。
- 使用 `DockerSandboxClient`。
- 使用项目 runtime image。
- 跑一个固定 prompt，让 agent 执行 shell。
- 验证 `exec_command` 出现在 tool event。
- 验证 `apply_patch` 能编辑文件。
- 验证 `view_image` 能读取本地测试 PNG。

验收：

- 不使用任何 WebCodex 自定义 shell/apply_patch/view 工具。
- Docker container 由 official client 创建。
- `view_image` 能返回图片输出。
- OpenAI 官方 endpoint 跑通。

### Phase 3: Workspace 和附件物化

目标：用户 workspace 和 attachments 都通过 official manifest 进入 sandbox。

任务：

- 实现 `workspace_materializer.py`。
- 从 OSS 还原 workspace 当前文件到 host-side run workspace。
- 从 attachment bytes API 下载附件到 `attachments/{id}/...`。
- 生成 baseline manifest。
- 构造 `Manifest(root="/workspace", entries={".": LocalDir(...)})`。
- 用户 input 中只包含文本和路径列表。

验收：

- 用户上传图片后，agent 能通过 `view_image("attachments/...")` 看图。
- 用户上传普通文件后，agent 能通过 shell 读取。
- Responses request 中不出现 `attachment_id`。
- Responses request 中不出现 `input_image` 或 `input_file`。

### Phase 4: Streaming event adapter

目标：官方 SDK stream events 能稳定显示在前端。

任务：

- 映射 assistant text delta。
- 映射 tool call started/completed。
- 映射 tool output。
- 对 shell output 做截断和折叠。
- 对 `view_image` output 做图片展示事件。
- 记录 usage。
- 失败时保留 SDK error type 和 message。

验收：

- 前端能看到模型文本流。
- 前端能看到 shell 命令和输出。
- 前端能看到 apply_patch 变更。
- 前端能看到 view_image 调用结果。
- SDK 异常不会吞掉，run 会进入 failed。

### Phase 5: Session persistence

目标：多轮 conversation 使用 Python SDK session replay，不混入旧格式。

任务：

- 实现 `BackendConversationSession(SessionABC)`。
- 保存新 SDK output items。
- 清理旧附件 replay 逻辑。
- 禁止写入旧 `providerData.attachment_id`。
- 验证 compaction。

验收：

- 多轮对话能继续引用之前 sandbox workspace 里的文件。
- session 中没有旧 attachment part。
- replay 不触发 Responses schema 错误。

### Phase 6: Workspace diff 和 commit

目标：run 结束后把 sandbox 结果写回 WebCodex workspace。

任务：

- 实现 `diff.py` 扫描 workspace。
- 忽略 `attachments/**`。
- 把 `outputs/**` 记录为 artifacts。
- 新增/修改/删除 workspace 文件写回 OSS。
- 创建 workspace version。
- 生成 `workspace.diff.created` 和 `workspace.commit.created` events。

验收：

- agent 修改源文件后，WebCodex workspace 看到新版本。
- agent 删除文件后，workspace 反映删除。
- agent 生成 `outputs/report.html` 后，前端看到 artifact。
- 二进制文件不被 UTF-8 解码破坏。

### Phase 7: 删除旧 Node runtime

目标：彻底移除旧方案，降低维护面。

任务：

- 删除 `worker-node/src/runtime/*`。
- 删除 `worker-node/src/tools/runtime-*`。
- 删除旧 `attachments.mjs` 的模型附件逻辑。
- 删除 Node worker 启动配置。
- 删除旧 runtime tests。
- 删除旧 docs 中与 JS 自定义 runtime 冲突的内容，或保留废弃说明。

验收：

- 项目启动不依赖 Node worker。
- 没有 `WORKER_RUNTIME_TOOL_MODE`。
- 没有自定义 `viewTool2`。
- 没有自定义 `shell` / `apply_patch` 与官方能力重名。

### Phase 8: Provider 和 relay 验收

目标：确认 official endpoint 和 relay endpoint 的真实能力差异。

任务：

- 在官方 OpenAI endpoint 上跑完整验收。
- 在当前 relay endpoint 上跑完整验收。
- 如果 relay 不支持结构化 `view_image` output，记录为 provider limitation。
- 不为 relay 重建旧附件方案。
- 需要时给 relay profile 降级为 text/data-url output，但仍保持 sandbox 文件路径策略。

验收：

- official profile 全功能通过。
- relay profile 明确通过或明确标记限制。
- 限制集中在 provider 层，不污染 attachment/materializer/session 设计。

## 14. 验收用例

### 14.1 图片附件

输入：

```text
看一下这张图片里的报错：attachments/att_x/image.png
```

期望：

- agent 调用 `view_image`。
- agent 能描述截图中的错误。
- model request 不包含 `attachment_id`。
- 不需要前端把图片作为特殊附件塞给模型。

### 14.2 普通文件附件

输入：

```text
分析 attachments/att_y/data.csv
```

期望：

- agent 用 shell/Python 读取 CSV。
- 输出分析结果。
- 不使用 OpenAI file upload。

### 14.3 代码修改

输入：

```text
修复项目测试失败
```

期望：

- worker 物化 workspace。
- agent 用 shell 跑测试。
- agent 用 apply_patch 改文件。
- worker diff 发现修改。
- backend 写回 workspace version。

### 14.4 生成产物

输入：

```text
生成一份 HTML 报告
```

期望：

- agent 写 `outputs/report.html`。
- run 完成后 backend 记录 artifact。
- 前端展示可打开的 artifact。

### 14.5 多轮对话

第一轮：

```text
看这张图，指出错误
```

第二轮：

```text
根据刚才的错误修复项目
```

期望：

- session replay 正常。
- 第二轮能引用之前结论。
- sandbox workspace 或重新物化的 workspace 文件可用。
- 不出现旧 attachment replay 错误。

## 15. 风险和处理

### 15.1 `LocalDir` 大 workspace 性能

风险：workspace 很大时，完整物化成本高。

处理：

- 当前 demo 阶段先完整物化，保证简单正确。
- 后续加 workspace size 上限。
- 后续支持 sparse materialization，但仍通过 `Manifest` 和官方 sandbox session，不恢复旧 `workspace_import` 工具。

### 15.2 Relay 不支持结构化图片 tool output

风险：非官方 relay 可能不接受 SDK 的结构化 `ToolOutputImage`。

处理：

- 先以官方 endpoint 作为正确性基准。
- relay profile 如果失败，只在 provider 层降级。
- 降级仍然基于 sandbox 文件路径，不回到 `input_image` 附件方案。

### 15.3 官方 SDK sandbox 仍在演进

风险：sandbox API 在后续版本有 breaking changes。

处理：

- pin 版本。
- 升级单独做。
- 保留官方源码 clone 只用于分析。
- 核心代码只依赖公开 API。

### 15.4 Docker 权限和路径边界

风险：官方 `LocalDir` 对宿主机路径有安全限制，绝对路径需要额外 grant。

处理：

- worker 进程 cwd 设为可信 run root 的父目录。
- 必要时使用 `Manifest.extra_path_grants`。
- 不把用户可控路径直接传给 `LocalDir(src=...)`。
- 所有文件名做 safe name 处理。

### 15.5 删除旧兼容导致开发数据不可 replay

风险：旧 conversation run history 不能继续 replay。

处理：

- 接受该风险。
- 开发环境清空旧 agent session。
- 保留 messages 文本用于 UI 展示，但不作为新 SDK session 输入。

## 16. 最终完成标准

迁移完成需要满足：

- 默认 worker 是 Python worker。
- 项目不再启动 Node worker。
- agent 是 `SandboxAgent`。
- run 使用 `SandboxRunConfig`。
- Docker 由 `DockerSandboxClient` 管理。
- 默认 capabilities 来自 `Capabilities.default()`。
- 图片查看通过官方 `view_image`。
- 文件编辑通过官方 `apply_patch`。
- 命令执行通过官方 shell capability。
- 用户上传文件只作为 workspace 文件路径出现。
- Responses payload 中不再出现 `attachment_id`、`openai_file_id`、旧 `providerData`。
- workspace 变更由 run 结束 diff 写回。
- artifacts 通过结构化事件记录，不依赖模型最终答案里的特殊 markdown。
- 旧 Node runtime 和重复工具代码被删除。

## 17. 推荐执行顺序

实际开发时按下面顺序开 PR：

1. `docs`: 合并本文档，废弃旧 JS runtime plan。
2. `worker-py`: Python worker skeleton。
3. `sandbox`: 官方 Docker SandboxAgent smoke test。
4. `attachments`: 附件物化到 workspace。
5. `workspace`: workspace materialize + baseline。
6. `events`: SDK stream event adapter。
7. `session`: Python SDK session persistence。
8. `commit`: workspace diff + artifact commit。
9. `backend`: 删除 Node worker 启动路径。
10. `cleanup`: 删除旧 Node runtime 和过时配置。
