import { tool } from "@openai/agents";
import { z } from "zod";

export function makeWorkspaceTools({ apiBaseUrl, workerToken, workspaceId }) {
  const client = new WorkspaceApiClient({ apiBaseUrl, workerToken, workspaceId });

  return [
    tool({
      name: "workspace_list",
      description: "List files in the current WebCodex workspace. Use this before reading or changing files.",
      parameters: z.object({
        version_id: z.string().optional(),
      }),
      execute: async ({ version_id }) => client.listFiles({ versionId: version_id }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "workspace_read",
      description: "Read a UTF-8 text file directly from the current WebCodex workspace by workspace-relative path.",
      parameters: z.object({
        path: z.string().min(1),
        version_id: z.string().optional(),
      }),
      execute: async ({ path, version_id }) => client.readFile({ path, versionId: version_id }),
      errorFunction: formatToolError,
      timeoutMs: 20_000,
    }),
    tool({
      name: "workspace_write",
      description: "Create or modify a UTF-8 text file directly in the current WebCodex workspace. Prefer sandbox_write for draft work and workspace_export for publishing sandbox files.",
      parameters: z.object({
        path: z.string().min(1),
        content: z.string(),
        message: z.string().min(1).optional(),
        content_type: z.string().min(1).optional(),
      }),
      execute: async ({ path, content, message, content_type }) =>
        client.writeFile({
          path,
          content,
          message: message ?? `agent write ${path}`,
          contentType: content_type ?? "text/plain; charset=utf-8",
        }),
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
    tool({
      name: "workspace_grep",
      description: "Search workspace UTF-8 text files with a regular expression and return path, line, and matching text.",
      parameters: z.object({
        pattern: z.string().min(1),
        path_glob: z.string().optional(),
        case_sensitive: z.boolean().optional(),
        max_matches: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ pattern, path_glob, case_sensitive, max_matches }) =>
        client.grep({
          pattern,
          pathGlob: path_glob,
          caseSensitive: case_sensitive ?? true,
          maxMatches: max_matches ?? 50,
        }),
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
    tool({
      name: "workspace_search",
      description: "Find workspace files by case-insensitive path or content substring and return short snippets.",
      parameters: z.object({
        query: z.string().min(1),
        path_glob: z.string().optional(),
        max_results: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ query, path_glob, max_results }) =>
        client.search({
          query,
          pathGlob: path_glob,
          maxResults: max_results ?? 50,
        }),
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
  ];
}

export class WorkspaceApiClient {
  constructor({ apiBaseUrl, workerToken, workspaceId }) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.workerToken = workerToken;
    this.workspaceId = workspaceId;
  }

  async listFiles({ versionId } = {}) {
    const query = new URLSearchParams();
    if (versionId) {
      query.set("version_id", versionId);
    }
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/files`, {
      query,
    });
  }

  async readFile({ path, versionId }) {
    const query = new URLSearchParams();
    if (versionId) {
      query.set("version_id", versionId);
    }
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/files/${encodePath(path)}`, {
      query,
    });
  }

  async readFileBytes({ path, versionId }) {
    const query = new URLSearchParams();
    if (versionId) {
      query.set("version_id", versionId);
    }
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/file-bytes/${encodePath(path)}`, {
      query,
    });
  }

  async writeFile({ path, content, message, contentType }) {
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/files/${encodePath(path)}`, {
      method: "PUT",
      body: {
        content,
        message,
        content_type: contentType,
      },
    });
  }

  async writeFileBytes({ path, contentBase64, message, contentType }) {
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/file-bytes/${encodePath(path)}`, {
      method: "PUT",
      body: {
        content_base64: contentBase64,
        message,
        content_type: contentType,
      },
    });
  }

  async grep({ pattern, pathGlob, caseSensitive, maxMatches }) {
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/grep`, {
      method: "POST",
      body: {
        pattern,
        path_glob: pathGlob,
        case_sensitive: caseSensitive,
        max_matches: maxMatches,
      },
    });
  }

  async rg({ pattern, pathGlob, caseSensitive, contextBefore, contextAfter, maxMatches, maxLineChars, cursor }) {
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/rg`, {
      method: "POST",
      body: {
        pattern,
        path_glob: pathGlob,
        case_sensitive: caseSensitive,
        context_before: contextBefore,
        context_after: contextAfter,
        max_matches: maxMatches,
        max_line_chars: maxLineChars,
        cursor,
      },
    });
  }

  async search({ query, pathGlob, maxResults }) {
    return this.request(`/internal/workspaces/${encodeURIComponent(this.workspaceId)}/search`, {
      method: "POST",
      body: {
        query,
        path_glob: pathGlob,
        max_results: maxResults,
      },
    });
  }

  async request(path, { method = "GET", query, body } = {}) {
    const url = new URL(path, `${this.apiBaseUrl}/`);
    if (query) {
      for (const [key, value] of query.entries()) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.workerToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(dropUndefined(body)) : undefined,
    });

    const text = await response.text();
    const payload = parseJsonMaybe(text);
    if (!response.ok) {
      const detail = payload?.detail ?? text;
      throw new Error(`Workspace API ${method} ${url.pathname} failed: ${response.status} ${stringify(detail)}`);
    }
    return payload;
  }
}

function encodePath(path) {
  return String(path)
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function parseJsonMaybe(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatToolError(_context, error) {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
