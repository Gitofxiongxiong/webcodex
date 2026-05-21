import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import OpenAI, { toFile } from "openai";

const IMAGE_KINDS = new Set(["image"]);

export class AttachmentClient {
  constructor({ apiBaseUrl, workerToken, sandboxDir, openaiClient }) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.workerToken = workerToken;
    this.sandboxDir = path.resolve(sandboxDir);
    this.openai = openaiClient;
  }

  async getRunInput(runId) {
    return this.requestJson(`/internal/runs/${encodeURIComponent(runId)}/input`);
  }

  async buildRunInput({ runId, input, attachments }) {
    const text = String(input?.text ?? "");
    const prepared = [];
    for (const attachment of attachments ?? []) {
      prepared.push(await this.prepareAttachment({ runId, attachment }));
    }

    const content = [{ type: "input_text", text: this.userTextWithAttachmentIndex(text, prepared) }];
    for (const item of prepared) {
      if (item.modelPart) {
        content.push(item.modelPart);
      }
    }

    return [{
      type: "message",
      role: "user",
      content,
    }];
  }

  sessionInputCallback(historyItems, newItems) {
    return [...historyItems, ...newItems.map(redactLargeInlineData)];
  }

  async prepareAttachment({ runId, attachment }) {
    const data = await this.downloadAttachment(attachment.id);
    const bytes = Buffer.from(data.content_base64, "base64");
    await this.writeSandboxAttachment(attachment, bytes);

    try {
      const preparedAttachment = {
        ...attachment,
        openai_file_id: await this.ensureOpenAIFile(attachment, bytes),
      };
      const modelPart = this.modelPartForAttachment(preparedAttachment);
      const includedAs = modelPart?.type ?? "tool_only";
      await this.updateRunAttachment(runId, attachment.id, { included_as: includedAs });
      return { attachment: preparedAttachment, modelPart, includedAs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateAttachmentOpenAIFile(attachment.id, {
        openai_status: "failed",
        openai_error: message,
        openai_purpose: attachment.openai_purpose ?? purposeForAttachment(attachment),
      }).catch(() => {});
      const fallbackModelPart = this.openai
        ? (IMAGE_KINDS.has(attachment.model_kind)
          ? this.modelPartForAttachment({
            ...attachment,
            openai_file_id: "inline_image",
            image_data_url: `data:${attachment.content_type || "image/png"};base64,${bytes.toString("base64")}`,
          })
          : this.modelPartForAttachment({
            ...attachment,
            openai_file_id: "inline_file",
            file_data: bytes.toString("base64"),
          }))
        : null;
      await this.updateRunAttachment(runId, attachment.id, {
        included_as: fallbackModelPart?.type ?? "tool_only",
        error: message,
      }).catch(() => {});
      return { attachment, modelPart: fallbackModelPart, includedAs: fallbackModelPart?.type ?? "tool_only", error: message };
    }
  }

  async downloadAttachment(attachmentId) {
    return this.requestJson(`/internal/attachments/${encodeURIComponent(attachmentId)}/bytes`);
  }

  async writeSandboxAttachment(attachment, bytes) {
    const relative = normalizeSandboxRelativePath(attachment.workspace_path || attachment.safe_name || attachment.id);
    const fullPath = path.resolve(this.sandboxDir, relative);
    const rel = path.relative(this.sandboxDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Attachment path escapes sandbox: ${relative}`);
    }
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
  }

  async ensureOpenAIFile(attachment, bytes) {
    if (attachment.openai_file_id && attachment.openai_status === "uploaded") {
      return attachment.openai_file_id;
    }
    if (!this.openai) {
      throw new Error("OpenAI client is not configured for file uploads");
    }

    const purpose = purposeForAttachment(attachment);
    const file = await toFile(bytes, attachment.safe_name || attachment.filename || `${attachment.id}.bin`, {
      type: attachment.content_type || "application/octet-stream",
    });
    const uploaded = await this.openai.files.create({ file, purpose });
    await this.updateAttachmentOpenAIFile(attachment.id, {
      openai_file_id: uploaded.id,
      openai_status: "uploaded",
      openai_purpose: purpose,
      openai_error: null,
    });
    return uploaded.id;
  }

  modelPartForAttachment(attachment) {
    if (!attachment.openai_file_id) {
      return null;
    }
    if (IMAGE_KINDS.has(attachment.model_kind)) {
      return {
        type: "input_image",
        image: attachment.image_data_url || { id: attachment.openai_file_id },
        detail: attachment.image_detail || "auto",
        providerData: {
          attachment_id: attachment.id,
          workspace_path: attachment.workspace_path,
        },
      };
    }
    return {
      type: "input_file",
      file: attachment.file_data || { id: attachment.openai_file_id },
      filename: attachment.safe_name || attachment.filename,
      providerData: {
        attachment_id: attachment.id,
        workspace_path: attachment.workspace_path,
      },
    };
  }

  userTextWithAttachmentIndex(text, prepared) {
    const lines = [text.trim() || "Please analyze the attached files."];
    if (prepared.length) {
      lines.push("", "Uploaded attachments are available both as model inputs and Docker /sandbox files; listed paths are /sandbox-relative:");
      for (const item of prepared) {
        const attachment = item.attachment;
        const status = item.error ? `tool_only: ${item.error}` : item.includedAs;
        lines.push(`- ${attachment.workspace_path} (${attachment.content_type}, ${attachment.size} bytes, ${status})`);
      }
    }
    return lines.join("\n");
  }

  async updateAttachmentOpenAIFile(attachmentId, body) {
    return this.requestJson(`/internal/attachments/${encodeURIComponent(attachmentId)}/openai-file`, {
      method: "PATCH",
      body,
    });
  }

  async updateRunAttachment(runId, attachmentId, body) {
    return this.requestJson(
      `/internal/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "PATCH", body }
    );
  }

  async requestJson(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
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
      throw new Error(`Attachment API ${method} ${path} failed: ${response.status} ${stringify(detail)}`);
    }
    return payload;
  }
}

export function createOpenAIUploadClient() {
  if (process.env.OPENAI_MODEL_PROVIDER === "codex-relay") {
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return null;
  }
  const baseURL = process.env.OPENAI_BASE_URL || "";
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

function purposeForAttachment(attachment) {
  return attachment.model_kind === "image" ? "vision" : "user_data";
}

function normalizeSandboxRelativePath(value) {
  return String(value || "attachment.bin").replaceAll("\\", "/").replace(/^\/+/, "");
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

function redactLargeInlineData(item) {
  if (!item || item.role !== "user" || !Array.isArray(item.content)) {
    return item;
  }
  return {
    ...item,
    content: item.content.map((part) => {
      if (part?.type === "input_image" && typeof part.image === "string" && part.image.startsWith("data:")) {
        return {
          ...part,
          image: "[image data omitted; see attachment workspace_path]",
        };
      }
      if (part?.type === "input_file" && typeof part.file === "string" && /^[A-Za-z0-9+/=]+$/.test(part.file)) {
        return {
          ...part,
          file: "[file data omitted; see attachment workspace_path]",
        };
      }
      return part;
    }),
  };
}
