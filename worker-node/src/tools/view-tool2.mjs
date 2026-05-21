import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import { DOCKER_ARTIFACTS_ROOT, DOCKER_SANDBOX_ROOT, normalizeSandboxPath, shellQuote } from "../runtime/docker-runtime.mjs";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".csv", ".tsv", ".xml", ".svg", ".py", ".sh", ".ps1", ".yml", ".yaml"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DEFAULT_MAX_LINES = 200;
const MAX_LINES = 1000;
const MAX_LINE_CHARS = 500;

export function makeViewTool2({ runtime }) {
  const viewer = new RuntimeViewer({ runtime });
  return tool({
    name: "viewTool2",
    description: [
      `Inspect files that already exist inside the current run's Docker ${DOCKER_SANDBOX_ROOT} only.`,
      `Use workspace_import first for WebCodex workspace files or uploaded attachments that are not yet in Docker ${DOCKER_SANDBOX_ROOT}.`,
      `This tool cannot read host filesystem paths, ${DOCKER_ARTIFACTS_ROOT} paths, or persistent WebCodex workspace paths directly.`,
      "Returns bounded text, image metadata, PDF page metadata, or generic file metadata.",
    ].join(" "),
    parameters: z.object({
      path: z.string().min(1).describe(`Path relative to Docker ${DOCKER_SANDBOX_ROOT}, or an absolute path under ${DOCKER_SANDBOX_ROOT}.`),
      mode: z.enum(["auto", "text", "image", "pdf", "metadata"]).optional(),
      start_line: z.number().int().min(1).optional(),
      max_lines: z.number().int().min(1).max(MAX_LINES).optional(),
      page: z.number().int().min(1).optional(),
      detail: z.enum(["low", "high"]).optional(),
    }),
    execute: async (args) => viewer.view(args),
    errorFunction: formatToolError,
    timeoutMs: 30_000,
  });
}

class RuntimeViewer {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async view({ path: targetPath, mode = "auto", start_line = 1, max_lines = DEFAULT_MAX_LINES, page = 1, detail = "low" }) {
    const sandboxPath = normalizeSandboxPath(targetPath);
    const fullPath = this.runtime.resolveWorkspacePath(sandboxPath);
    const info = await stat(fullPath);
    if (!info.isFile()) {
      throw new Error(`viewTool2 only inspects files inside Docker ${DOCKER_SANDBOX_ROOT}; path is not a file: ${sandboxPath}`);
    }
    const actualMode = mode === "auto" ? modeForPath(sandboxPath) : mode;
    if (actualMode === "text") {
      return this.viewText({ fullPath, sandboxPath, startLine: start_line, maxLines: max_lines });
    }
    if (actualMode === "image") {
      return this.viewImage({ fullPath, sandboxPath, size: info.size, detail });
    }
    if (actualMode === "pdf") {
      return this.viewPdf({ fullPath, sandboxPath, size: info.size, page, detail });
    }
    return this.metadata({ fullPath, sandboxPath, size: info.size });
  }

  async viewText({ fullPath, sandboxPath, startLine, maxLines }) {
    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, startLine - 1);
    const count = Math.min(maxLines ?? DEFAULT_MAX_LINES, MAX_LINES);
    const rows = lines.slice(startIndex, startIndex + count).map((text, index) => ({
      line: startIndex + index + 1,
      text: truncateLine(text),
    }));
    return {
      ok: true,
      path: sandboxPath,
      mode: "text",
      start_line: startIndex + 1,
      max_lines: count,
      total_lines: lines.length,
      lines: rows,
      next_start_line: startIndex + count < lines.length ? startIndex + count + 1 : undefined,
      truncated: startIndex + count < lines.length || rows.some((row) => row.text.endsWith("[line truncated]")),
    };
  }

  async viewImage({ fullPath, sandboxPath, size, detail }) {
    const metadata = await imageMetadata(this.runtime, sandboxPath);
    return {
      ok: true,
      path: sandboxPath,
      mode: "image",
      detail,
      size,
      ...metadata,
      note: `Image bytes remain in Docker ${DOCKER_SANDBOX_ROOT}; use browser workspace attachment/content APIs after export for preview.`,
    };
  }

  async viewPdf({ sandboxPath, size, page, detail }) {
    const metadata = await pdfMetadata(this.runtime, sandboxPath);
    return {
      ok: true,
      path: sandboxPath,
      mode: "pdf",
      detail,
      page,
      size,
      ...metadata,
      note: "PDF pages are inspected one page at a time; render/export a preview image if browser preview is needed.",
    };
  }

  async metadata({ fullPath, sandboxPath, size }) {
    const bytes = await readFile(fullPath);
    return {
      ok: true,
      path: sandboxPath,
      mode: "metadata",
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      inferred_type: modeForPath(sandboxPath),
    };
  }
}

async function imageMetadata(runtime, sandboxPath) {
  const commandPath = runtime.commandWorkspacePath(sandboxPath);
  const result = await runtime.exec(`python3 - <<'PY'\nfrom pathlib import Path\nfrom PIL import Image\np=Path(${pythonStringLiteral(commandPath)})\nwith Image.open(p) as im:\n    print(f\"width={im.width}\")\n    print(f\"height={im.height}\")\n    print(f\"format={im.format}\")\nPY`, { timeoutMs: 10_000, maxOutputChars: 4_000 }).catch(() => null);
  if (!result || result.exit_code !== 0) {
    const fileResult = await runtime.exec(`file --brief --mime-type ${shellQuote(commandPath)}`, { timeoutMs: 10_000, maxOutputChars: 1_000 }).catch(() => null);
    return { mime: fileResult?.stdout?.trim() || undefined };
  }
  return Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => {
    const [key, value] = line.split("=");
    return [key, /^\d+$/.test(value) ? Number(value) : value];
  }));
}

async function pdfMetadata(runtime, sandboxPath) {
  const result = await runtime.exec(`pdfinfo ${shellQuote(runtime.commandWorkspacePath(sandboxPath))} | sed -n 's/^Pages:[[:space:]]*//p'`, {
    timeoutMs: 10_000,
    maxOutputChars: 1_000,
  }).catch(() => null);
  const pages = Number.parseInt(result?.stdout?.trim() || "0", 10);
  return Number.isFinite(pages) && pages > 0 ? { pages } : {};
}

function modeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "metadata";
}

function truncateLine(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_LINE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_LINE_CHARS)}[line truncated]`;
}

function pythonStringLiteral(value) {
  return JSON.stringify(String(value));
}

function formatToolError(_context, error) {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
