import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import { WorkspaceApiClient } from "./workspace.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_READ_BYTES = 512_000;

export function makeSandboxTools({ sandboxDir, apiBaseUrl, workerToken, workspaceId }) {
  const sandbox = new Sandbox({ sandboxDir });
  const workspace = new WorkspaceApiClient({ apiBaseUrl, workerToken, workspaceId });

  return [
    tool({
      name: "sandbox_list",
      description: "List files inside the current run sandbox. Paths are relative to the sandbox root.",
      parameters: z.object({
        path: z.string().optional(),
        recursive: z.boolean().optional(),
      }),
      execute: async ({ path: targetPath, recursive }) => sandbox.list({ path: targetPath, recursive }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "sandbox_read",
      description: "Read a UTF-8 text file from the current run sandbox by sandbox-relative path.",
      parameters: z.object({
        path: z.string().min(1),
      }),
      execute: async ({ path }) => sandbox.readText({ path }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "sandbox_write",
      description: "Create or overwrite a UTF-8 text file inside the current run sandbox. Use this for drafts, generated files, scripts, and tests before exporting to the workspace.",
      parameters: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      execute: async ({ path, content }) => sandbox.writeText({ path, content }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "sandbox_bash",
      description: "Run a bash command in the current run sandbox directory and return stdout, stderr, and exit code. Use this for shell-based file operations and tests.",
      parameters: z.object({
        command: z.string().min(1),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      }),
      execute: async ({ command, timeout_ms }) =>
        runCommand({
          command: "bash",
          args: ["-lc", command],
          cwd: sandbox.root,
          timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        }),
      errorFunction: formatToolError,
      timeoutMs: MAX_TIMEOUT_MS + 5_000,
    }),
    tool({
      name: "sandbox_python",
      description: "Run Python code in the current run sandbox directory and return stdout, stderr, and exit code. Use this for scripts, generation, parsing, and verification.",
      parameters: z.object({
        code: z.string().min(1),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      }),
      execute: async ({ code, timeout_ms }) =>
        runCommand({
          command: "python",
          args: ["-c", code],
          cwd: sandbox.root,
          timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        }),
      errorFunction: formatToolError,
      timeoutMs: MAX_TIMEOUT_MS + 5_000,
    }),
    tool({
      name: "workspace_import",
      description: "Import a UTF-8 file from the current WebCodex workspace into the sandbox. This copies workspace content into a sandbox-relative path.",
      parameters: z.object({
        workspace_path: z.string().min(1),
        sandbox_path: z.string().min(1).optional(),
        version_id: z.string().optional(),
      }),
      execute: async ({ workspace_path, sandbox_path, version_id }) => {
        const result = await workspace.readFile({ path: workspace_path, versionId: version_id });
        const content = String(result?.content ?? "");
        const writeResult = await sandbox.writeText({ path: sandbox_path ?? workspace_path, content });
        return {
          ok: true,
          workspace_path,
          sandbox_path: writeResult.path,
          bytes: writeResult.bytes,
          workspace_file: result?.file,
        };
      },
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
    tool({
      name: "workspace_export",
      description: "Export a UTF-8 file from the sandbox to the current WebCodex workspace. This creates or modifies a workspace file and creates a new workspace version.",
      parameters: z.object({
        sandbox_path: z.string().min(1),
        workspace_path: z.string().min(1).optional(),
        message: z.string().min(1).optional(),
        content_type: z.string().min(1).optional(),
      }),
      execute: async ({ sandbox_path, workspace_path, message, content_type }) => {
        const readResult = await sandbox.readText({ path: sandbox_path });
        const targetPath = workspace_path ?? sandbox_path;
        const writeResult = await workspace.writeFile({
          path: targetPath,
          content: readResult.content,
          message: message ?? `export sandbox ${sandbox_path}`,
          contentType: content_type ?? "text/plain; charset=utf-8",
        });
        return {
          ok: true,
          sandbox_path,
          workspace_path: targetPath,
          bytes: readResult.bytes,
          result: writeResult,
        };
      },
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
  ];
}

class Sandbox {
  constructor({ sandboxDir }) {
    if (!sandboxDir) {
      throw new Error("Missing SANDBOX_DIR");
    }
    this.root = path.resolve(sandboxDir);
  }

  async list({ path: targetPath = ".", recursive = false } = {}) {
    const root = this.resolve(targetPath);
    const entries = await this.listEntries(root, { recursive, base: root });
    return {
      ok: true,
      root: this.root,
      path: this.relative(root) || ".",
      entries,
    };
  }

  async listEntries(root, { recursive, base }) {
    const rows = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const fullPath = path.join(root, entry.name);
      const info = await stat(fullPath);
      const row = {
        path: normalizeSlash(path.relative(base, fullPath)),
        type: entry.isDirectory() ? "directory" : "file",
        size: info.size,
      };
      rows.push(row);
      if (recursive && entry.isDirectory()) {
        for (const child of await this.listEntries(fullPath, { recursive, base })) {
          rows.push(child);
        }
      }
    }
    return rows;
  }

  async readText({ path: targetPath }) {
    const fullPath = this.resolve(targetPath);
    const info = await stat(fullPath);
    if (!info.isFile()) {
      throw new Error(`Sandbox path is not a file: ${targetPath}`);
    }
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`Sandbox file is too large to read as text: ${targetPath}`);
    }
    const content = await readFile(fullPath, "utf8");
    return {
      ok: true,
      path: this.relative(fullPath),
      bytes: Buffer.byteLength(content, "utf8"),
      content,
    };
  }

  async writeText({ path: targetPath, content }) {
    const fullPath = this.resolve(targetPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return {
      ok: true,
      path: this.relative(fullPath),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  resolve(targetPath) {
    const raw = String(targetPath ?? ".").replaceAll("\\", "/");
    const fullPath = path.resolve(this.root, raw);
    const relative = path.relative(this.root, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Sandbox path escapes the run sandbox: ${targetPath}`);
    }
    return fullPath;
  }

  relative(fullPath) {
    return normalizeSlash(path.relative(this.root, fullPath));
  }
}

function runCommand({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: sandboxProcessEnv(cwd),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command: [command, ...args].join(" "),
        cwd,
        exit_code: null,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr: appendLimited(stderr, error.message),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command: [command, ...args].join(" "),
        cwd,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

function appendLimited(current, next) {
  const value = current + next;
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return value.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated]";
}

function normalizeSlash(value) {
  return String(value).replaceAll("\\", "/");
}

function sandboxProcessEnv(cwd) {
  const source = process.env;
  const env = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "PYTHONPATH",
    "PYTHONHOME",
  ]) {
    if (source[name]) {
      env[name] = source[name];
    }
  }
  env.HOME = cwd;
  env.USERPROFILE = cwd;
  env.WEB_CODEX_SANDBOX = cwd;
  env.PYTHONIOENCODING = "utf-8";
  env.NO_COLOR = "1";
  return env;
}

function formatToolError(_context, error) {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
