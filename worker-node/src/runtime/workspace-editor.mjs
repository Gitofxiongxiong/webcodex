import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyDiff } from "@openai/agents/utils";

import { normalizeSandboxPath } from "./docker-runtime.mjs";

export class RuntimeWorkspaceEditor {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async createFile(operation) {
    const relativePath = normalizeSandboxPath(operation.path);
    const fullPath = this.runtime.resolveWorkspacePath(relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    const content = applyDiff("", operation.diff, "create");
    await writeFile(fullPath, content, "utf8");
    return {
      status: "completed",
      output: `created ${relativePath}`,
    };
  }

  async updateFile(operation) {
    const relativePath = normalizeSandboxPath(operation.path);
    const fullPath = this.runtime.resolveWorkspacePath(relativePath);
    const input = await readFile(fullPath, "utf8");
    const output = applyDiff(input, operation.diff);
    if (operation.moveTo) {
      const targetRelativePath = normalizeSandboxPath(operation.moveTo);
      const targetFullPath = this.runtime.resolveWorkspacePath(targetRelativePath);
      await mkdir(path.dirname(targetFullPath), { recursive: true });
      await writeFile(targetFullPath, output, "utf8");
      await rm(fullPath, { force: true });
      return {
        status: "completed",
        output: `updated ${relativePath} and moved to ${targetRelativePath}`,
      };
    }
    await writeFile(fullPath, output, "utf8");
    return {
      status: "completed",
      output: `updated ${relativePath}`,
    };
  }

  async deleteFile(operation) {
    const relativePath = normalizeSandboxPath(operation.path);
    const fullPath = this.runtime.resolveWorkspacePath(relativePath);
    const info = await stat(fullPath);
    if (!info.isFile()) {
      throw new Error(`apply_patch delete only supports files: ${relativePath}`);
    }
    await rm(fullPath, { force: true });
    return {
      status: "completed",
      output: `deleted ${relativePath}`,
    };
  }
}
