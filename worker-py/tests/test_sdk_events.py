from __future__ import annotations

import unittest
from types import SimpleNamespace

from webcodex_worker.events import event
from webcodex_worker.sdk_events import SdkEventAdapter


class SdkEventAdapterTest(unittest.TestCase):
    def test_event_uses_backend_field_names(self) -> None:
        body = event("tool.call.started", item_id="call_1", parent_id="parent_1")

        self.assertEqual(body["itemId"], "call_1")
        self.assertEqual(body["parentId"], "parent_1")
        self.assertNotIn("item_id", body)

    def test_text_delta_is_normalized(self) -> None:
        adapter = SdkEventAdapter(assistant_item_id="assistant_42")
        sdk_event = SimpleNamespace(
            type="raw_response_event",
            data=SimpleNamespace(type="response.output_text.delta", delta="hello"),
        )

        normalized = adapter.normalize(sdk_event)

        self.assertEqual(normalized[0]["type"], "assistant.message.delta")
        self.assertEqual(normalized[0]["itemId"], "assistant_42")
        self.assertEqual(normalized[0]["payload"]["text"], "hello")

    def test_shell_tool_events_are_normalized(self) -> None:
        adapter = SdkEventAdapter()
        call_item = SimpleNamespace(
            type="tool_call_item",
            raw_item={
                "type": "shell_call",
                "call_id": "call-1",
                "action": {"commands": ["pwd", "ls"]},
            },
        )
        output_item = SimpleNamespace(
            type="tool_call_output_item",
            output=[
                {
                    "stdout": "/workspace",
                    "stderr": "",
                    "duration_ms": 12,
                    "outcome": {"type": "exit", "exitCode": 0},
                }
            ],
            raw_item={"type": "shell_call_output", "call_id": "call-1"},
        )

        started = adapter.normalize(SimpleNamespace(type="run_item_stream_event", name="tool_called", item=call_item))
        completed = adapter.normalize(SimpleNamespace(type="run_item_stream_event", name="tool_output", item=output_item))

        self.assertEqual(started[0]["type"], "codex.command.started")
        self.assertEqual(started[0]["payload"]["command"], "pwd\nls")
        self.assertEqual(completed[0]["type"], "codex.command.completed")
        self.assertEqual(completed[0]["status"], "completed")
        self.assertEqual(completed[0]["payload"]["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
