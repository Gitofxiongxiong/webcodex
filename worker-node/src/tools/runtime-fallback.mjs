import { tool } from "@openai/agents";
import { z } from "zod";

import { RuntimeShellExecutor } from "../runtime/docker-runtime.mjs";
import { RuntimeWorkspaceEditor } from "../runtime/workspace-editor.mjs";

export function makeRuntimeFunctionTools({ runtime }) {
  const shell = new RuntimeShellExecutor({ runtime });
  const editor = new RuntimeWorkspaceEditor({ runtime });

  return [
    tool({
      name: "shell",
      description: "Run one or more bash commands inside Docker /sandbox. Use this for Python, curl, rg, npm, tests, builds, and HTML generation.",
      parameters: z.object({
        commands: z.array(z.string().min(1)).min(1),
        timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
        max_output_length: z.number().int().min(1).max(120_000).optional(),
      }),
      execute: async ({ commands, timeout_ms, max_output_length }) =>
        shell.run({
          commands,
          timeoutMs: timeout_ms,
          maxOutputLength: max_output_length,
        }),
      errorFunction: formatToolError,
      timeoutMs: 130_000,
    }),
    tool({
      name: "apply_patch",
      description: "Apply a V4A patch operation to files inside Docker /sandbox. Use create_file, update_file, or delete_file.",
      parameters: z.object({
        type: z.enum(["create_file", "update_file", "delete_file"]),
        path: z.string().min(1).describe("Path relative to Docker /sandbox, or an absolute path under /sandbox."),
        diff: z.string().optional(),
        move_to: z.string().min(1).describe("Destination path relative to Docker /sandbox, or an absolute path under /sandbox.").optional(),
      }),
      execute: async ({ type, path, diff, move_to }) => {
        if (type === "create_file") {
          return editor.createFile({ type, path, diff: diff ?? "" });
        }
        if (type === "update_file") {
          return editor.updateFile({ type, path, diff: diff ?? "", moveTo: move_to });
        }
        return editor.deleteFile({ type, path });
      },
      errorFunction: formatToolError,
      timeoutMs: 30_000,
    }),
  ];
}

function formatToolError(_context, error) {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
