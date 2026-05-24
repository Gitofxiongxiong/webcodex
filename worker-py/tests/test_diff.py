from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from webcodex_worker.diff import WorkspaceDiff, commit_workspace_changes, create_diff


class FakeClient:
    def __init__(self) -> None:
        self.writes = []

    async def write_workspace_file_bytes(self, **kwargs):
        self.writes.append(kwargs)
        return {
            "file": {
                "path": kwargs["path"],
                "content_type": kwargs["content_type"],
                "size": len(kwargs["content_base64"]),
                "blob_sha256": f"sha-{kwargs['path']}",
            }
        }


class WorkspaceDiffTest(unittest.TestCase):
    def test_classifies_workspace_changes(self) -> None:
        baseline = {
            "a.txt": {"sha256": "1"},
            "b.txt": {"sha256": "2"},
            "attachments/att_1/file.txt": {"sha256": "3"},
        }
        current = {
            "a.txt": {"sha256": "1"},
            "b.txt": {"sha256": "changed"},
            "c.txt": {"sha256": "4"},
            "outputs/report.txt": {"sha256": "5"},
            "attachments/att_1/file.txt": {"sha256": "changed"},
        }

        diff = create_diff(baseline, current)

        self.assertEqual(diff.added, ["c.txt"])
        self.assertEqual(diff.modified, ["b.txt"])
        self.assertEqual(diff.deleted, [])
        self.assertEqual(diff.unchanged, ["a.txt"])
        self.assertEqual(diff.artifacts, ["outputs/report.txt"])

    def test_commit_includes_artifacts(self) -> None:
        async def run_case() -> None:
            with TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "outputs").mkdir()
                (root / "outputs" / "report.txt").write_text("report", encoding="utf-8")
                client = FakeClient()

                result = await commit_workspace_changes(
                    client=client,
                    workspace_id="workspace_1",
                    workspace_root=root,
                    diff=WorkspaceDiff(
                        added=[],
                        modified=[],
                        deleted=[],
                        unchanged=[],
                        artifacts=["outputs/report.txt"],
                    ),
                    run_id="run_1",
                )

                self.assertEqual(client.writes[0]["path"], "outputs/report.txt")
                self.assertEqual(result["artifacts"][0]["path"], "outputs/report.txt")

        import asyncio

        asyncio.run(run_case())


if __name__ == "__main__":
    unittest.main()
