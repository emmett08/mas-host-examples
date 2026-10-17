"""Check incident candidate constraints using only the invocation's supplied evidence."""

import hashlib
import json


def reference(record: dict) -> dict:
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {"id": record["id"], "sha256": hashlib.sha256(encoded.encode()).hexdigest()}


def assess(_ctx, invocation: dict) -> dict:
    candidate = invocation["candidate"]
    output = candidate["output"]
    incident = invocation["sources"]["incident"]
    records = invocation["evidence"]
    # The host supplied exact Evidence records. Do not invent evidence or infer
    # real-world diagnosis accuracy from these output/evidence constraints.
    evidence = [reference(record) for record in records]
    items = incident.get("evidence", {}).get("items", [])
    collected = {item["id"]: item for item in items if item.get("status") == "collected"}
    remedy = output.get("remediation", {})
    citations = output.get("evidence_ids", []) + remedy.get("evidence_ids", [])
    known = isinstance(citations, list) and all(isinstance(key, str) and key in collected for key in citations)
    abstains = remedy.get("action") == "none"
    target = remedy.get("target", {})
    deployment = collected.get("workload-deployment", {}).get("data", {})
    metadata = deployment.get("metadata", {})
    constrained = abstains or (
        remedy.get("action") == "replace_readiness_probe_path"
        and target.get("kind") == "Deployment"
        and target.get("namespace") == "mas-demo"
        and target.get("name") == "mas-demo-checkout"
        and target.get("container") == "checkout"
        and isinstance(metadata.get("uid"), str) and bool(metadata.get("uid"))
        and isinstance(metadata.get("resourceVersion"), str) and bool(metadata.get("resourceVersion"))
        and target.get("uid") == metadata["uid"]
        and target.get("resource_version") == metadata["resourceVersion"]
        and remedy.get("current_path") == "/readyz" and remedy.get("proposed_path") == "/healthz"
        and {"pod", "workload-deployment", "logs-checkout-current"}.issubset(remedy.get("evidence_ids", []))
        and {"pod", "workload-deployment", "logs-checkout-current"}.issubset(collected)
        and bool(remedy.get("verification")) and bool(remedy.get("rollback"))
    )
    uncertainty = (not abstains or output.get("requires_human") is True) and bool(output.get("next_checks"))
    findings = []
    for criterion, passed, explanation in (
        ("evidence-references", known, "Every cited evidence ID must identify a collected item in the supplied incident; remove unsupported references."),
        ("bounded-proposal", constrained, "A proposal must either abstain or preserve the exact allowlisted target identity, readiness paths, supporting items, verification and rollback. This check does not establish diagnosis correctness or authorise an effect."),
        ("uncertainty", uncertainty, "Abstention requires human review, and every candidate must retain discriminating next checks. This checks consistency, not whether abstention is appropriate for the true incident."),
    ):
        findings.append({"criterion_id": criterion, "verdict": "pass" if passed else "fail",
                         "score": 1 if passed else 0, "evidence": evidence, "explanation": explanation})
    return {"status": "completed", "findings": findings}
