import assert from "node:assert/strict";

import { SdkEventNormalizer } from "./sdk-events.mjs";

const normalizer = new SdkEventNormalizer({ assistantItemId: "assistant_test" });

const textEvents = normalizer.normalize({
  type: "raw_model_stream_event",
  data: { type: "output_text_delta", delta: "ok" },
});
assert.equal(textEvents[0]?.type, "assistant.message.delta");
assert.equal(textEvents[0]?.payload?.text, "ok");

const reasoningEvents = normalizer.normalize({
  type: "raw_model_stream_event",
  data: {
    type: "model",
    event: {
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning_test",
      delta: "thinking",
    },
  },
});
assert.equal(reasoningEvents[0]?.type, "assistant.reasoning_summary.delta");
assert.equal(reasoningEvents[0]?.payload?.text, "thinking");

const emptyReasoningDoneEvents = normalizer.normalize({
  type: "raw_model_stream_event",
  data: {
    type: "model",
    event: {
      type: "response.reasoning_summary_text.done",
      item_id: "reasoning_empty",
      text: "",
    },
  },
});
assert.deepEqual(emptyReasoningDoneEvents, []);

const emptyReasoningItemEvents = normalizer.normalize({
  type: "run_item_stream_event",
  name: "reasoning_item_created",
  item: {
    type: "reasoning",
    rawItem: {
      id: "reasoning_empty_item",
      summary: [],
    },
  },
});
assert.deepEqual(emptyReasoningItemEvents, []);

const wrappedShellOutput = {
  output: [
    {
      stdout: "from sandbox\n",
      stderr: "",
      outcome: { type: "exit", exitCode: 0 },
      duration_ms: 12,
    },
  ],
  maxOutputLength: 24000,
};
const shellEvents = normalizer.normalize({
  type: "run_item_stream_event",
  name: "tool_output",
  item: {
    type: "shell_call_output",
    callId: "call_shell_ok",
    rawItem: { type: "shell_call_output", callId: "call_shell_ok" },
    output: wrappedShellOutput,
  },
});
assert.equal(shellEvents[0]?.type, "codex.command.completed");
assert.equal(shellEvents[0]?.status, "completed");
assert.equal(shellEvents[0]?.payload?.exitCode, 0);
assert.match(shellEvents[0]?.payload?.stdout, /from sandbox/);

const failedShellEvents = normalizer.normalize({
  type: "run_item_stream_event",
  name: "tool_output",
  item: {
    type: "shell_call_output",
    callId: "call_shell_failed",
    rawItem: { type: "shell_call_output", callId: "call_shell_failed" },
    output: JSON.stringify({ ok: false, error: "Invalid JSON input for tool" }),
  },
});
assert.equal(failedShellEvents[0]?.type, "codex.command.completed");
assert.equal(failedShellEvents[0]?.status, "failed");
assert.match(failedShellEvents[0]?.payload?.stderr, /Invalid JSON input/);

console.log("sdk event mapper ok");
