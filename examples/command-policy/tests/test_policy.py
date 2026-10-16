"""Test the ordinary CLI independently of MAS."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "policy-check"


class PolicyTests(unittest.TestCase):
    def run_tool(self, task):
        return subprocess.run([str(TOOL), "--service", task["service"], "--max-critical", "0",
                               "--invocation-id", "standalone-test"], input=json.dumps(task),
                              text=True, capture_output=True, timeout=5)

    def test_approval_and_refusal_are_successful_operation_results(self):
        for findings in (0, 1):
            result = self.run_tool({"service": "billing", "critical_findings": findings})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["approved"], findings == 0)

    def test_invalid_count_is_rejected(self):
        for value in (True, -1, 1.5):
            self.assertEqual(self.run_tool({"service": "billing", "critical_findings": value}).returncode, 2)

    def test_receipt_survives_failure_and_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / "receipt.json"
            task = {"service": "billing", "critical_findings": 0,
                    "receipt_path": str(receipt), "crash_after_receipt": True}
            self.assertEqual(self.run_tool(task).returncode, 7)
            original = receipt.read_bytes()
            self.assertEqual(json.loads(original)["invocation_id"], "standalone-test")
            self.assertEqual(self.run_tool(task).returncode, 2)
            self.assertEqual(receipt.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
