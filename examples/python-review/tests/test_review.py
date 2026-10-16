import json
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace

from review import Capacity, Decision, Evidence, Proposal, Security, accept, capacity, publish_receipt, security, validate


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.proposal = Proposal("service-42", 240, 3, 100, 0)

    def test_inclusive_capacity_and_refusal(self):
        for demand, approved in ((300, True), (301, False)):
            proposal = replace(self.proposal, required_capacity=demand)
            evidence = Evidence(proposal, capacity(None, proposal), security(None, proposal))
            self.assertEqual(accept(None, evidence), Decision("service-42", approved, 300, 0))

    def test_critical_findings_refuse_adequate_capacity(self):
        proposal = replace(self.proposal, critical_findings=1)
        evidence = Evidence(proposal, Capacity(300, True), Security(1, False))
        self.assertFalse(accept(None, evidence).approved)

    def test_independent_acceptance_rejects_corrupt_reports(self):
        good = Evidence(self.proposal, Capacity(300, True), Security(0, True))
        for evidence in (replace(good, capacity=Capacity(299, True)),
                         replace(good, capacity=Capacity(300, False)),
                         replace(good, security=Security(1, True))):
            with self.subTest(evidence=evidence), self.assertRaisesRegex(ValueError, "disagree"):
                accept(None, evidence)

    def test_invalid_counts_and_boolean_are_rejected(self):
        for field, value in (("replicas", 0), ("capacity_per_replica", 1_000_001),
                             ("required_capacity", True), ("critical_findings", -1),
                             ("release", "")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate(replace(self.proposal, **{field: value}))

    def test_receipt_identifies_effect_and_prevents_overwrite(self):
        decision = Decision("service-42", True, 300, 0)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "receipt.json")
            result = publish_receipt(path, decision, "admitted-effect")
            self.assertEqual(result.output, decision)
            receipt = json.loads(Path(path).read_text())
            self.assertEqual(receipt["invocation_id"], "admitted-effect")
            self.assertEqual(receipt["output"]["available_capacity"], 300)
            with self.assertRaises(FileExistsError):
                publish_receipt(path, decision, "different-effect")


if __name__ == "__main__":
    unittest.main()
