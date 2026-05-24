import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { shellTool, tool } from "@openai/agents";
import { z } from "zod";

import { WorkspaceApiClient } from "./workspace.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_READ_BYTES = 512_000;
const MAX_CURL_BODY_CHARS = 128_000;

export function makeSandboxTools({ sandboxDir, apiBaseUrl, workerToken, workspaceId }) {
  const sandbox = new Sandbox({ sandboxDir });
  const workspace = new WorkspaceApiClient({ apiBaseUrl, workerToken, workspaceId });

  return [
    tool({
      name: "sandbox_list",
      description: "List files inside the active sandbox. Paths are relative to the sandbox root.",
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
      description: "Read a UTF-8 text file from the active sandbox by sandbox-relative path.",
      parameters: z.object({
        path: z.string().min(1),
      }),
      execute: async ({ path }) => sandbox.readText({ path }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "sandbox_write",
      description: "Create or overwrite a UTF-8 text file inside the active sandbox. Use this for drafts, generated files, scripts, and tests before exporting to the workspace.",
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
      description: "Run a bash command in the active sandbox directory and return stdout, stderr, and exit code. Use this for shell-based file operations and tests.",
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
      description: "Run Python code in the active sandbox directory and return stdout, stderr, and exit code. Use this for scripts, generation, parsing, and verification.",
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
    shellTool({
      name: "curl",
      shell: new CurlOnlyShell({ cwd: sandbox.root }),
      needsApproval: false,
    }),
    tool({
      name: "sandbox_curl",
      description: "Fetch or inspect a URL with curl from the active sandbox. Use this for HTTP APIs, exact URLs, headers, status codes, and response bodies.",
      parameters: z.object({
        url: z.url().refine((value) => isHttpUrl(value), "URL must use http or https"),
        method: z.string().min(1).max(16).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(MAX_CURL_BODY_CHARS).optional(),
        follow_redirects: z.boolean().optional(),
        include_headers: z.boolean().optional(),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      }),
      execute: async ({ url, method, headers, body, follow_redirects, include_headers, timeout_ms }) =>
        runCurl({
          url,
          method,
          headers,
          body,
          followRedirects: follow_redirects ?? true,
          includeHeaders: include_headers ?? true,
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

class CurlOnlyShell {
  constructor({ cwd }) {
    this.cwd = cwd;
  }

  async run(action) {
    const timeoutMs = normalizeTimeoutMs(action?.timeoutMs);
    const maxOutputLength = normalizeOutputLimit(action?.maxOutputLength);
    const commands = Array.isArray(action?.commands) ? action.commands : [];
    const output = [];
    for (const command of commands) {
      output.push(await runCurlShellCommand({ command, cwd: this.cwd, timeoutMs, maxOutputLength }));
    }
    return { output, maxOutputLength };
  }
}

async function runCurlShellCommand({ command, cwd, timeoutMs, maxOutputLength }) {
  let argv;
  try {
    argv = parseShellWords(command);
    validateCurlCommand(argv);
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      outcome: { type: "exit", exitCode: null },
    };
  }

  const result = await runCommand({
    command: "curl",
    args: argv.slice(1),
    cwd,
    timeoutMs,
    maxOutputChars: maxOutputLength,
  });
  return {
    stdout: limitText(result.stdout, maxOutputLength),
    stderr: limitText(result.stderr, maxOutputLength),
    outcome: result.timed_out ? { type: "timeout" } : { type: "exit", exitCode: result.exit_code },
  };
}

function runCurl({ url, method, headers, body, followRedirects, includeHeaders, cwd, timeoutMs }) {
  const args = ["--silent", "--show-error", "--fail-with-body", "--max-time", String(Math.ceil(timeoutMs / 1000))];
  if (followRedirects) {
    args.push("--location");
  }
  if (includeHeaders) {
    args.push("--include");
  }
  if (method) {
    args.push("--request", method.toUpperCase());
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    args.push("--header", `${name}: ${value}`);
  }
  if (body !== undefined) {
    args.push("--data-raw", body);
  }
  args.push(url);
  return runCommand({
    command: "curl",
    args,
    cwd,
    timeoutMs,
  });
}

function validateCurlCommand(argv) {
  if (argv.length === 0) {
    throw new Error("curl shell tool requires a curl command");
  }
  if (path.basename(argv[0]).toLowerCase() !== "curl") {
    throw new Error("curl shell tool only allows commands that start with curl");
  }
  if (!argv.some((arg) => isHttpUrl(arg))) {
    throw new Error("curl shell tool requires at least one http or https URL");
  }
}

function parseShellWords(command) {
  const input = String(command ?? "");
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("curl command has an unterminated quote");
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function normalizeTimeoutMs(value) {
  const number = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(number) || number < 1_000 || number > MAX_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS;
  }
  return number;
}

function normalizeOutputLimit(value) {
  const number = Number(value ?? MAX_OUTPUT_CHARS);
  if (!Number.isInteger(number) || number < 1 || number > MAX_OUTPUT_CHARS) {
    return MAX_OUTPUT_CHARS;
  }
  return number;
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
      throw new Error(`Sandbox path escapes the active sandbox: ${targetPath}`);
    }
    return fullPath;
  }

  relative(fullPath) {
    return normalizeSlash(path.relative(this.root, fullPath));
  }
}

function runCommand({ command, args, cwd, timeoutMs, maxOutputChars = MAX_OUTPUT_CHARS }) {
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
      stdout = appendLimited(stdout, chunk.toString(), maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), maxOutputChars);
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
        stderr: appendLimited(stderr, error.message, maxOutputChars),
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

function appendLimited(current, next, maxOutputChars = MAX_OUTPUT_CHARS) {
  const value = current + next;
  if (value.length <= maxOutputChars) {
    return value;
  }
  return value.slice(0, maxOutputChars) + "\n[output truncated]";
}

function limitText(value, maxOutputChars) {
  return appendLimited("", String(value ?? ""), maxOutputChars);
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
