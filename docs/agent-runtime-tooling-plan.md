# WebCodex Agent Runtime Tooling Plan

> Status: superseded. This JS custom-runtime plan has been replaced by
> `docs/official-python-sandbox-migration-plan.md`, which moves WebCodex to the
> official OpenAI Agents Python SDK `SandboxAgent` / `DockerSandboxClient`
> architecture. Keep this file only as historical context.

## 1. 目标

当前目标是把 WebCodex 的 agent 工具层从大量自定义 sandbox 工具，收敛为更接近 OpenAI Agents SDK 原生工具语义的运行时。

核心方向：

- 用 Docker 作为每个 run 的真实隔离执行环境。
- 用 Agents SDK 原生 `webSearchTool()` 提供 Web Search。
- 用 Agents SDK 原生 `shellTool()` 提供 bash、python、curl、rg、测试命令等能力。
- 用 Agents SDK 原生 `applyPatchTool()` 提供文件编辑能力。
- 只保留少量 WebCodex 自定义桥接工具，用于 workspace 边界、检索分页、文件导入导出和可视化查看。

这份方案只描述目标架构和迁移路径，不要求本次直接改代码。

## 2. 当前 SDK 结论

基于当前项目本地依赖 `worker-node/package.json`：

```json
"@openai/agents": "^0.11.4"
```

本地类型导出确认：

- `@openai/agents` 导出 `webSearchTool`
- `@openai/agents` 导出 `shellTool`
- `@openai/agents` 导出 `applyPatchTool`
- 当前版本未发现公开导出的 `viewTool` 或 `viewTool()`

官方文档结论：

- Web Search 是 OpenAI 平台内置工具，可在 Responses API / Agents SDK 工具列表中启用。
- Shell 工具支持 hosted shell，也支持 local shell mode。
- local shell mode 下，SDK 负责建模工具调用，实际命令执行由我们自己的 runtime 完成。
- 官方文档明确建议 shell、apply patch、computer-use 这类 harness 仍由应用 runtime 托管。

因此，本方案中：

- `webSearchTool()` 是 SDK 原生工具。
- `shellTool()` 是 SDK 原生工具，但执行器由 WebCodex 用 Docker 承接。
- `applyPatchTool()` 是 SDK 原生工具，但 editor 由 WebCodex 限制在 Docker 工作目录内。
- `viewTool2` 是 WebCodex 自定义工具，不是当前 SDK 原生工具。

## 3. 目标工具面

最终给 agent 暴露的工具建议分为两类。

SDK 原生工具：

```text
webSearchTool
shellTool
applyPatchTool
```

WebCodex 自定义桥接工具：

```text
workspace_tree
workspace_rg
workspace_import
workspace_export
viewTool2
```

不建议继续暴露这些宽泛或重复工具：

```text
sandbox_list
sandbox_read
sandbox_write
sandbox_bash
sandbox_python
sandbox_curl
workspace_list
workspace_read
workspace_write
workspace_grep
workspace_search
```

原因：

- sandbox 文件读写和命令执行应统一走 `shellTool` / `applyPatchTool` / `viewTool2`。
- workspace 不是 agent 可随意读写的本地目录，应保持清晰边界。
- `workspace_list` 容易一次性返回整个 workspace，引发上下文爆炸。
- `workspace_grep` / `workspace_search` 如果不强制分页和截断，也会引发上下文爆炸。

## 4. Docker Sandbox 设计

每个 run 创建一个独立 Docker container。

推荐目录约定：

```text
/sandbox
  agent-visible working directory

/tmp
  transient runtime files

/artifacts
  optional large generated artifacts
```

宿主机上为每个 run 创建一个 run directory：

```text
data/runs/{run_id}/workspace
data/runs/{run_id}/artifacts
```

Docker 启动时挂载：

```text
host data/runs/{run_id}/workspace  -> container /sandbox
host data/runs/{run_id}/artifacts  -> container /artifacts
```

安全默认值：

- container 使用非 root 用户。
- 默认工作目录为 `/sandbox`。
- 默认关闭特权模式。
- 默认不挂载 Docker socket。
- 默认不挂载宿主项目根目录。
- 默认不注入长期密钥。
- 每个 run 有 CPU、内存、磁盘、进程数和超时限制。
- run 完成、取消或失败后清理 container。
- 是否保留 run directory 由调试配置控制。

网络策略：

- Web Search 使用 `webSearchTool()`，不依赖 sandbox 公网。
- `curl`、`npm install`、`pip install` 等命令通过 `shellTool()` 在 Docker 内执行。
- Docker 网络默认可以先允许公网，生产环境应逐步收敛为 allowlist。
- 对于敏感 workspace，建议默认禁网，只在任务需要时按 run 打开。

## 5. Local Shell Mode

`shellTool()` 使用 SDK 原生工具定义，但传入 WebCodex 自己实现的 local shell executor。

概念代码：

```ts
import { shellTool } from "@openai/agents";

const shell = shellTool({
  name: "shell",
  shell: new DockerShellExecutor({ containerId, cwd: "/sandbox" }),
  needsApproval: false,
});
```

`DockerShellExecutor.run(action)` 负责：

- 解析 SDK 下发的 shell action。
- 在目标 container 内执行命令。
- 工作目录固定为 `/sandbox` 或其子目录。
- 捕获 stdout、stderr、exit code、signal、duration。
- 按 `max_output_length` 和 WebCodex 自己的上限截断输出。
- 超时后先 `SIGTERM`，再强制 kill。
- 返回 SDK 期望的 `shell_call_output` 形态。

命令能力：

```text
bash
python
node
npm
pnpm
rg
curl
git diff
test commands
build commands
format commands
```

`curl` 不需要单独的自定义 `sandbox_curl`。agent 直接通过 `shellTool()` 执行：

```bash
curl -iL https://example.com
```

这样 curl、rg、python、bash 都统一走一个稳定工具协议。

## 6. Apply Patch

`applyPatchTool()` 使用 SDK 原生工具定义，但传入 WebCodex 自己实现的 Docker editor。

概念代码：

```ts
import { applyPatchTool } from "@openai/agents";

const applyPatch = applyPatchTool({
  editor: new DockerWorkspaceEditor({ containerId, root: "/sandbox" }),
  needsApproval: false,
});
```

editor 规则：

- 只允许修改 `/sandbox` 内文件。
- 禁止绝对路径逃逸。
- 禁止 `..` 逃逸。
- create、update、delete 都在 container workspace 内完成。
- 变更不会自动写回 WebCodex workspace。
- 写回必须显式调用 `workspace_export`。

这个边界很重要：Docker sandbox 是草稿区，WebCodex workspace 是版本化持久区。

## 7. Workspace 桥接工具

Workspace 桥接工具只负责 workspace 和 Docker sandbox 之间的边界操作，不再承担通用文件系统能力。

### 7.1 workspace_tree

替代当前宽泛的 `workspace_list`。

用途：

- 列出 workspace 中某个路径下的文件树摘要。
- 给 agent 做低成本导航。
- 避免一次性把全量文件树塞进上下文。

建议参数：

```ts
{
  path?: string;
  depth?: number;
  limit?: number;
  cursor?: string;
  include?: string[];
  exclude?: string[];
}
```

返回：

```ts
{
  ok: true;
  path: string;
  entries: Array<{
    path: string;
    type: "file" | "directory";
    size?: number;
    content_type?: string;
    updated_at?: string;
  }>;
  next_cursor?: string;
  truncated: boolean;
}
```

强制限制：

- 默认 `depth = 2`。
- 默认 `limit = 100`。
- 最大 `limit = 300`。
- 默认排除 `node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`。
- 返回 path/type/size 等元数据，不返回文件内容。

### 7.2 workspace_rg

替代当前 `workspace_grep` / `workspace_search`。

用途：

- 在 workspace 的持久文件中做 ripgrep 风格搜索。
- 返回有限匹配行，而不是完整文件。
- 支持分页，避免 rg 命中大范围内容时上下文爆炸。

建议参数：

```ts
{
  pattern: string;
  path_glob?: string;
  case_sensitive?: boolean;
  context_before?: number;
  context_after?: number;
  max_matches?: number;
  max_line_chars?: number;
  cursor?: string;
}
```

返回：

```ts
{
  ok: true;
  matches: Array<{
    path: string;
    line: number;
    text: string;
    before?: string[];
    after?: string[];
  }>;
  next_cursor?: string;
  truncated: boolean;
}
```

强制限制：

- 默认 `max_matches = 50`。
- 最大 `max_matches = 200`。
- 默认 `max_line_chars = 240`。
- 最大 `context_before/context_after = 3`。
- 单次响应总字符数建议不超过 32 KB。
- 返回时明确标记 `truncated` 和 `next_cursor`。

实现建议：

- 后端可以基于 workspace 当前版本的文件索引临时 materialize 到只读目录后运行 `rg`。
- 也可以直接从 OSS/DB 流式读取文本文件做搜索。
- 无论实现方式如何，对 agent 暴露的结果必须分页、截断、可继续。

### 7.3 workspace_import

用途：

- 把 workspace 当前版本中的指定文件复制到 Docker `/sandbox`。
- agent 只有导入后，才能用 `shellTool()`、`applyPatchTool()`、`viewTool2` 对它做本地操作。

建议参数：

```ts
{
  files: Array<{
    workspace_path: string;
    sandbox_path?: string;
    version_id?: string;
  }>;
}
```

返回：

```ts
{
  ok: true;
  imported: Array<{
    workspace_path: string;
    sandbox_path: string;
    size: number;
    blob_sha256: string;
  }>;
  skipped?: Array<{
    workspace_path: string;
    reason: string;
  }>;
}
```

强制限制：

- 单文件大小上限。
- 单次导入文件数上限。
- 单次导入总字节上限。
- 默认只允许导入当前 workspace 当前版本。
- 大二进制文件允许导入，但不允许直接作为文本返回给模型。

### 7.4 workspace_export

用途：

- 把 Docker `/sandbox` 中的结果文件写回 WebCodex workspace。
- 每次 export 创建新的 workspace version。

建议参数：

```ts
{
  files: Array<{
    sandbox_path: string;
    workspace_path?: string;
    content_type?: string;
  }>;
  message?: string;
}
```

返回：

```ts
{
  ok: true;
  version_id: string;
  exported: Array<{
    sandbox_path: string;
    workspace_path: string;
    size: number;
    blob_sha256: string;
  }>;
}
```

强制限制：

- 只允许从 `/sandbox` 导出。
- 禁止导出 Docker 系统路径。
- 单文件和总大小有上限。
- 导出前计算 sha256。
- 写入 workspace 后由后端记录 file ops 和 version。

## 8. viewTool2

`viewTool2` 是 WebCodex 自定义工具，用于查看 Docker sandbox 内的文件、图片和 PDF。

命名固定为：

```text
viewTool2
```

不使用 `sandbox_view`。

原因：

- 当前 `@openai/agents@0.11.4` 未发现 SDK 原生 `viewTool` 导出。
- 但 agent 需要稳定的查看体验，尤其是图片、PDF、长文本、二进制文件。
- `shellTool("cat file")` 适合快速文本检查，不适合图片/PDF，也容易输出过大。

建议参数：

```ts
{
  path: string;
  mode?: "auto" | "text" | "image" | "pdf" | "metadata";
  start_line?: number;
  max_lines?: number;
  page?: number;
  detail?: "low" | "high";
}
```

文本模式：

- 只读取 `/sandbox` 内文件。
- 默认返回带行号的有限行数。
- 默认 `max_lines = 200`。
- 最大 `max_lines = 1000`。
- 单行默认截断到 500 字符。
- 如果文件过大，返回 `truncated` 和建议下一次 `start_line`。

图片模式：

- 支持 png、jpg、jpeg、webp、gif 等常见格式。
- 返回结构化 image output，不把 base64 作为长文本塞进模型上下文。
- 返回 width、height、mime、size 等元数据。
- `detail` 控制低清/高清查看。

PDF 模式：

- 默认只渲染指定页。
- `page` 从 1 开始。
- 返回页面图片和页数元数据。
- 不一次性把整份 PDF 文本或所有页面塞进上下文。

metadata 模式：

- 返回文件类型、大小、修改时间、hash、可预览能力。
- 对未知二进制文件默认走 metadata。

安全规则：

- 只能访问 Docker `/sandbox`。
- 禁止访问宿主文件系统。
- 禁止路径逃逸。
- 输出必须有大小限制。

未来如果 SDK 提供原生 `viewTool()`，可以用 adapter 保留 `viewTool2` 的外部名字，内部替换实现。

## 9. Agent 工作流

推荐 agent instructions 引导以下流程：

```text
1. 用 workspace_tree 或 workspace_rg 发现相关文件。
2. 用 workspace_import 把需要修改或深入检查的文件导入 /sandbox。
3. 用 shellTool 执行 rg、cat、python、curl、测试、构建等命令。
4. 用 viewTool2 查看长文本、图片、PDF 或二进制元数据。
5. 用 applyPatchTool 修改 /sandbox 内文件。
6. 用 shellTool 运行验证命令。
7. 用 workspace_export 把最终结果写回 WebCodex workspace。
```

禁止让 agent 误以为它可以直接访问宿主项目根目录。它只能看到：

```text
Docker /sandbox
web_search
workspace bridge tools
viewTool2
```

## 10. 上下文爆炸控制

这是本方案的关键约束。

### 10.1 workspace_tree

不允许无界递归列出整个 workspace。

必须具备：

- `depth`
- `limit`
- `cursor`
- 默认 exclude
- `truncated`
- `next_cursor`

默认返回目录摘要，而不是内容。

### 10.2 workspace_rg

不允许把所有命中一次性返回。

必须具备：

- `max_matches`
- `max_line_chars`
- `cursor`
- `context_before/context_after` 上限
- 单次响应总字符数上限
- `truncated`
- `next_cursor`

### 10.3 shellTool 输出

`shellTool()` 也必须限制输出。

建议：

- 默认最大 stdout+stderr 24 KB。
- 允许 SDK action 中的 `max_output_length`，但不能超过 WebCodex 上限。
- 超限时保留头部或尾部，并明确 `[output truncated]`。
- 对 `rg` 命令建议在 instructions 中要求 agent 使用 `-n`、`--max-count`、`--glob` 等限制。

### 10.4 viewTool2 输出

`viewTool2` 不允许把大文件完整读入上下文。

必须：

- 文本按行分页。
- 图片以结构化 image output 返回。
- PDF 按页渲染。
- 二进制默认只返回 metadata。

## 11. 事件与前端展示

当前 WebCodex 已经有 normalized run event protocol。迁移后仍不应让前端直接绑定 SDK 原始事件。

需要新增或确认的事件映射：

```text
shell_call              -> codex.command.started
shell_call_output       -> codex.command.completed / codex.command.output.delta
apply_patch_call        -> codex.patch.started
apply_patch_call_output -> codex.patch.completed / codex.file.changed
web_search_call         -> tool.call.started / tool.call.completed
viewTool2 call          -> tool.call.started / tool.call.completed / artifact.preview
workspace_export        -> workspace.version.created / codex.file.changed
```

前端展示建议：

- shell 命令块显示 command、cwd、exit code、duration、stdout/stderr。
- rg 输出按文件和行号折叠。
- patch 输出显示 changed files 和 diff 摘要。
- Web Search 显示可点击引用。
- `viewTool2` 图片/PDF 输出显示预览。
- workspace export 显示新 version 和导出文件列表。

## 12. 安全与审计

必须记录：

- 每次 tool call 的 tool name。
- shell command。
- cwd。
- exit code。
- duration。
- stdout/stderr 截断后内容。
- workspace import/export 文件路径、大小、sha256。
- web search 是否发生。
- viewTool2 查看路径和 mode。

敏感信息处理：

- 不把长期密钥注入 Docker。
- 必要的临时 token 只放入指定环境变量，并做日志脱敏。
- 对 shell 输出做 secret redaction。
- 对 workspace export 做审计记录。

高风险命令：

- demo 阶段可先不做人工审批，但要完整记录。
- 生产阶段建议对网络、包安装、删除大量文件、生成大文件、访问外部域名等动作引入 approval policy。

## 13. 迁移计划

### Phase 1: 引入 Docker run lifecycle

- 为每个 run 创建 container。
- 挂载 run workspace 到 `/sandbox`。
- 实现创建、状态检查、超时、清理。
- 保留当前旧 sandbox 工具作为 fallback。

### Phase 2: 接入 SDK shellTool local executor

- 实现 `DockerShellExecutor`。
- 用 `shellTool({ shell: dockerShell })` 替代 `sandbox_bash`、`sandbox_python`、`sandbox_curl`。
- 确认 `curl`、`rg`、`python`、测试命令可用。
- 更新 event normalizer 支持 shell call。

### Phase 3: 接入 SDK applyPatchTool

- 实现 `DockerWorkspaceEditor`。
- 所有 patch 限制在 `/sandbox`。
- 替代 `sandbox_write` 这类直接写文件工具。
- 前端展示 patch 和 changed files。

### Phase 4: 收敛 workspace 工具

- 新增 `workspace_tree`。
- 新增 `workspace_rg`。
- 保留或改造 `workspace_import` / `workspace_export` 支持多文件、大小限制、版本信息。
- 废弃 `workspace_list`、`workspace_grep`、`workspace_search`、`workspace_read`、`workspace_write` 的 agent 暴露。

### Phase 5: 新增 viewTool2

- 支持 text/image/pdf/metadata。
- 文本按行分页。
- 图片返回结构化 image output。
- PDF 按页渲染。
- 前端支持预览事件展示。

### Phase 6: 删除旧 sandbox 工具

- 移除 `sandbox_list`、`sandbox_read`、`sandbox_write`、`sandbox_bash`、`sandbox_python`、`sandbox_curl`。
- 更新 agent instructions。
- 更新测试。
- 更新 PRD 或架构文档。

## 14. 验收标准

工具能力：

- agent 可以用 `webSearchTool()` 搜索最新公开信息。
- agent 可以用 `shellTool()` 在 Docker `/sandbox` 中执行 bash。
- agent 可以通过 shell 执行 `curl`。
- agent 可以通过 shell 执行 `rg`，并且输出被截断保护。
- agent 可以用 `applyPatchTool()` 修改 `/sandbox` 内文件。
- agent 可以用 `viewTool2` 查看文本、图片和 PDF。
- agent 可以用 `workspace_import` 从 workspace 导入文件。
- agent 可以用 `workspace_export` 把结果写回 workspace。

隔离能力：

- shell 不能访问宿主项目根目录。
- apply patch 不能写出 `/sandbox`。
- viewTool2 不能读出 `/sandbox`。
- workspace bridge 不能读写非当前 workspace。

上下文控制：

- `workspace_tree` 不会返回无界文件树。
- `workspace_rg` 不会返回无界搜索结果。
- shell stdout/stderr 有最大输出限制。
- viewTool2 文本/PDF 有分页限制。

可观测性：

- 前端能看到 shell 命令和输出。
- 前端能看到 web search 调用。
- 前端能看到 patch / changed files。
- 前端能看到 workspace export 产生的新 version。
- run events 可以断线重放。

## 15. 推荐最终形态

最终 agent 工具声明大致应收敛为：

```ts
const agent = new Agent({
  name: "WebCodex Coding Agent",
  tools: [
    webSearchTool({ searchContextSize: "medium" }),
    shellTool({
      name: "shell",
      shell: new DockerShellExecutor({ containerId, cwd: "/sandbox" }),
      needsApproval: false,
    }),
    applyPatchTool({
      editor: new DockerWorkspaceEditor({ containerId, root: "/sandbox" }),
      needsApproval: false,
    }),
    workspaceTreeTool,
    workspaceRgTool,
    workspaceImportTool,
    workspaceExportTool,
    viewTool2,
  ],
});
```

这比继续维护一组自定义 `sandbox_*` 工具更稳：

- 工具语义更接近 SDK 原生能力。
- bash、curl、rg、python 统一在 shell 模型下运行。
- 文件编辑统一在 apply patch 模型下运行。
- workspace 持久区和 Docker 草稿区边界清晰。
- 上下文爆炸风险集中在 `workspace_tree`、`workspace_rg`、`shellTool`、`viewTool2` 四个点控制。

## 16. 参考

官方文档：

- OpenAI Tools overview: `https://developers.openai.com/api/docs/guides/tools`
- OpenAI Web Search tool: `https://developers.openai.com/api/docs/guides/tools-web-search`
- OpenAI Shell tool: `https://developers.openai.com/api/docs/guides/tools-shell`

本地确认文件：

- `worker-node/package.json`
- `worker-node/node_modules/@openai/agents/dist/index.d.ts`
- `worker-node/node_modules/@openai/agents-openai/dist/tools.d.ts`
- `worker-node/node_modules/@openai/agents-core/dist/tool.d.ts`
- `worker-node/node_modules/@openai/agents-core/dist/shell.d.ts`
- `worker-node/node_modules/@openai/agents-core/dist/editor.d.ts`
