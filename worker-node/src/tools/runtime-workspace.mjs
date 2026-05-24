import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import { normalizeSandboxPath } from "../runtime/docker-runtime.mjs";
import { WorkspaceApiClient } from "./workspace.mjs";

const DEFAULT_EXCLUDES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const MAX_TREE_LIMIT = 300;
const MAX_IMPORT_FILES = 50;
const MAX_EXPORT_FILES = 50;
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export function makeRuntimeWorkspaceTools({ runtime, apiBaseUrl, workerToken, workspaceId }) {
  const client = new WorkspaceApiClient({ apiBaseUrl, workerToken, workspaceId });
  const bridge = new WorkspaceBridge({ runtime, client });

  const tools = [
    tool({
      name: "workspace_tree",
      description: "List a bounded metadata-only tree from the current WebCodex workspace. Does not return file contents.",
      parameters: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(0).max(8).optional(),
        limit: z.number().int().min(1).max(MAX_TREE_LIMIT).optional(),
        cursor: z.string().optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      }),
      execute: async (args) => bridge.tree(args),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "workspace_rg",
      description: "Search current workspace text files with bounded ripgrep-style results and line truncation.",
      parameters: z.object({
        pattern: z.string().min(1),
        path_glob: z.string().optional(),
        case_sensitive: z.boolean().optional(),
        context_before: z.number().int().min(0).max(3).optional(),
        context_after: z.number().int().min(0).max(3).optional(),
        max_matches: z.number().int().min(1).max(200).optional(),
        max_line_chars: z.number().int().min(40).max(1000).optional(),
        cursor: z.string().optional(),
      }),
      execute: async (args) => bridge.rg(args),
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
    tool({
      name: "workspace_import",
      description: "Import one or more current WebCodex workspace files into Docker /sandbox before using shell or apply_patch.",
      parameters: z.object({
        files: z.array(z.object({
          workspace_path: z.string().min(1),
          sandbox_path: z.string().min(1).describe("Destination path relative to Docker /sandbox, or an absolute path under /sandbox.").optional(),
          version_id: z.string().optional(),
        })).min(1).max(MAX_IMPORT_FILES),
      }),
      execute: async (args) => bridge.importFiles(args),
      errorFunction: formatToolError,
      timeoutMs: 60_000,
    }),
  ];
  if (process.env.WORKER_ENABLE_WORKSPACE_EXPORT === "true") {
    tools.push(
      tool({
        name: "workspace_export",
        description: "Export one or more Docker /sandbox files back to the WebCodex workspace, creating workspace versions.",
        parameters: z.object({
          files: z.array(z.object({
            sandbox_path: z.string().min(1).describe("Source path relative to Docker /sandbox, or an absolute path under /sandbox."),
            workspace_path: z.string().min(1).optional(),
            content_type: z.string().min(1).optional(),
          })).min(1).max(MAX_EXPORT_FILES),
          message: z.string().min(1).optional(),
        }),
        execute: async (args) => bridge.exportFiles(args),
        errorFunction: formatToolError,
        timeoutMs: 60_000,
      })
    );
  }
  return tools;
}

class WorkspaceBridge {
  constructor({ runtime, client }) {
    this.runtime = runtime;
    this.client = client;
  }

  async tree({ path: targetPath = "", depth = 2, limit = 100, cursor, include, exclude } = {}) {
    const files = await this.client.listFiles();
    const prefix = normalizeWorkspacePrefix(targetPath);
    const max = Math.min(limit ?? 100, MAX_TREE_LIMIT);
    const start = decodeCursor(cursor);
    const excludes = new Set([...DEFAULT_EXCLUDES, ...(exclude ?? [])]);
    const includeMatchers = include?.length ? include : null;
    const rows = [];
    const seenDirs = new Set();
    const filtered = files.files
      .filter((file) => file.path.startsWith(prefix))
      .filter((file) => !isExcluded(file.path, excludes))
      .filter((file) => !includeMatchers || includeMatchers.some((glob) => matchGlob(file.path, glob)));

    for (const file of filtered) {
      const relative = prefix ? file.path.slice(prefix.length).replace(/^\/+/, "") : file.path;
      const parts = relative.split("/").filter(Boolean);
      const maxParts = Math.min(parts.length, Math.max(1, depth + 1));
      for (let i = 1; i < maxParts; i += 1) {
        const dirPath = joinWorkspacePath(prefix, parts.slice(0, i).join("/"));
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          rows.push({ path: dirPath, type: "directory" });
        }
      }
      if (parts.length <= depth + 1) {
        rows.push({
          path: file.path,
          type: "file",
          size: file.size,
          content_type: file.content_type,
          updated_at: file.updated_at,
        });
      }
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    const entries = rows.slice(start, start + max);
    const nextIndex = start + entries.length;
    return {
      ok: true,
      path: prefix || ".",
      entries,
      next_cursor: nextIndex < rows.length ? encodeCursor(nextIndex) : undefined,
      truncated: nextIndex < rows.length,
    };
  }

  async rg({
    pattern,
    path_glob,
    case_sensitive = true,
    context_before = 0,
    context_after = 0,
    max_matches = 50,
    max_line_chars = 240,
    cursor,
  }) {
    const result = await this.client.rg({
      pattern,
      pathGlob: path_glob,
      caseSensitive: case_sensitive,
      contextBefore: Math.min(context_before ?? 0, 3),
      contextAfter: Math.min(context_after ?? 0, 3),
      maxMatches: Math.min(max_matches ?? 50, 200),
      maxLineChars: Math.min(max_line_chars ?? 240, 1000),
      cursor,
    });
    return result;
  }

  async importFiles({ files }) {
    let totalBytes = 0;
    const imported = [];
    const skipped = [];
    for (const item of files) {
      try {
        const response = await this.client.readFileBytes({
          path: item.workspace_path,
          versionId: item.version_id,
        });
        const bytes = Buffer.from(response.content_base64, "base64");
        validateSize(bytes.length, totalBytes);
        const sandboxPath = normalizeSandboxPath(item.sandbox_path ?? item.workspace_path);
        const fullPath = this.runtime.resolveWorkspacePath(sandboxPath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, bytes);
        totalBytes += bytes.length;
        imported.push({
          workspace_path: response.file?.path ?? item.workspace_path,
          sandbox_path: sandboxPath,
          size: bytes.length,
          blob_sha256: response.file?.blob_sha256 ?? sha256(bytes),
          content_type: response.file?.content_type,
        });
      } catch (error) {
        skipped.push({
          workspace_path: item.workspace_path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ok: skipped.length === 0, imported, skipped: skipped.length ? skipped : undefined };
  }

  async exportFiles({ files, message }) {
    let totalBytes = 0;
    const exported = [];
    let versionId = null;
    for (const item of files) {
      const sandboxPath = normalizeSandboxPath(item.sandbox_path);
      const fullPath = this.runtime.resolveWorkspacePath(sandboxPath);
      const info = await stat(fullPath);
      if (!info.isFile()) {
        throw new Error(`Export path is not a file: ${sandboxPath}`);
      }
      validateSize(info.size, totalBytes);
      const bytes = await readFile(fullPath);
      totalBytes += bytes.length;
      const workspacePath = normalizeWorkspacePath(item.workspace_path ?? sandboxPath);
      const response = await this.client.writeFileBytes({
        path: workspacePath,
        contentBase64: bytes.toString("base64"),
        message: message ?? `export sandbox ${sandboxPath}`,
        contentType: item.content_type ?? detectContentType(workspacePath),
      });
      versionId = response.file?.version_id ?? versionId;
      exported.push({
        sandbox_path: sandboxPath,
        workspace_path: workspacePath,
        size: bytes.length,
        blob_sha256: response.blob?.sha256 ?? sha256(bytes),
        content_type: response.file?.content_type,
      });
    }
    return { ok: true, version_id: versionId, exported };
  }
}

function validateSize(size, currentTotal) {
  if (size > MAX_SINGLE_FILE_BYTES) {
    throw new Error(`File is too large: ${size} bytes`);
  }
  if (currentTotal + size > MAX_TOTAL_BYTES) {
    throw new Error(`Import/export total is too large: ${currentTotal + size} bytes`);
  }
}

function normalizeWorkspacePrefix(value) {
  const normalized = normalizeWorkspacePath(value || "");
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

function normalizeWorkspacePath(value) {
  const raw = String(value ?? "").replaceAll("\\", "/").trim().replace(/^\/+/, "");
  if (!raw) {
    return ".";
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Workspace path escapes root: ${value}`);
  }
  return normalized;
}

function joinWorkspacePath(prefix, child) {
  return [prefix, child].filter(Boolean).join("/");
}

function isExcluded(filePath, excludes) {
  return filePath.split("/").some((part) => excludes.has(part));
}

function matchGlob(value, glob) {
  const pattern = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${pattern}$`).test(value);
}

function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }
  const value = Number.parseInt(Buffer.from(String(cursor), "base64url").toString("utf8"), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function encodeCursor(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectContentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function formatToolError(_context, error) {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
