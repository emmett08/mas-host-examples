#!/usr/bin/env python3
"""Check finite demo choreography and remediation with SPIN; retain evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
TIMEOUT_SECONDS = 30
MEMORY_BYTES = 512 * 1024 * 1024
DEPTH = 100_000
CASES = [
    ("dual-repair-safety", None, False, False, None),
    ("dual-repair-safety-no-reduction", None, False, True, None),
    ("dual-repair-settlement", None, True, False, None),
    ("dual-repair-settlement-no-reduction", None, True, True, None),
    ("dual-repair-source", "BUG_DUAL_SOURCE", False, False, "snapshot_run==source_run"),
    ("dual-repair-seed", "BUG_DUAL_SEED", False, False, "snapshot_seed==source_seed"),
    ("dual-repair-approach", "BUG_DUAL_APPROACH", False, False, "snapshot_approach==id"),
    ("dual-repair-before-freeze", "BUG_DUAL_FREEZE", False, False, "frozen_trusted"),
    ("dual-repair-target", "BUG_DUAL_TARGET", False, False, "evidence_target==source_run"),
    ("dual-repair-shared-journal", "BUG_DUAL_JOURNAL", False, False, "journal_key==(evidence_target-1)"),
    ("dual-repair-success-witness", "WITNESS_DUAL_REPAIR", False, False, "phase[0]==Verified"),
    ("investigation-safety", None, False, False, None),
    ("investigation-safety-no-reduction", None, False, True, None),
    ("investigation-settlement", None, True, False, None),
    ("investigation-settlement-no-reduction", None, True, True, None),
    ("investigation-early-assessment", "BUG_MCP_EARLY_ASSESSMENT", False, False, "frozen_version==1"),
    ("investigation-recorded-replay", "BUG_MCP_REPLAY", False, False, "calls[slot]<=1"),
    ("investigation-unknown-effect", "BUG_MCP_UNKNOWN", False, False, "!(has_unknown)"),
    ("investigation-subject-mismatch", "BUG_MCP_SUBJECT", False, False, "all_trusted"),
    ("investigation-partial-coverage", "BUG_MCP_PARTIAL_COVERAGE", False, False, "covered==15"),
    ("investigation-duplicate-coverage", "BUG_MCP_DUPLICATE_COVERAGE", False, False, "covered==15"),
    ("investigation-cancelled-launch", "BUG_MCP_CANCEL", False, False, "!(cancelled)"),
    ("investigation-refreeze", "BUG_MCP_REFREEZE", False, False, "frozen_version<=1"),
    ("investigation-stall", "BUG_MCP_STALL", True, False, "acceptance cycle"),
    ("investigation-success-witness", "WITNESS_MCP_SUCCESS", False, False, "results==4"),
    ("investigation-reverse-order-witness", "WITNESS_MCP_REVERSE_ORDER", False, False, "order_code==228"),
    ("investigation-unavailable-witness", "WITNESS_MCP_UNAVAILABLE", False, False, "unavailable_observation"),
    ("investigation-partial-blocked-witness", "WITNESS_MCP_PARTIAL_BLOCKED", False, False, "results==1"),
    ("investigation-duplicate-blocked-witness", "WITNESS_MCP_DUPLICATE_BLOCKED", False, False, "covered!=15"),
    ("investigation-restart-witness", "WITNESS_MCP_RESTART", False, False, "recorded_restart"),
    ("investigation-uncertain-witness", "WITNESS_MCP_UNCERTAIN", False, False, "has_unknown"),
    ("revision-safety", None, False, False, None),
    ("revision-safety-no-reduction", None, False, True, None),
    ("revision-settlement", None, True, False, None),
    ("revision-settlement-no-reduction", None, True, True, None),
    ("revision-wrong-selection", "BUG_SELECTION", False, False, "exact_selected"),
    ("revision-exhausted-authority", "BUG_AUTHORITY", False, False, "admission"),
    ("revision-success-witness", "WITNESS_REVISION", False, False, "mutation"),
    ("safety", None, False, False, None),
    ("safety-no-reduction", None, False, True, None),
    ("settlement", None, True, False, None),
    ("settlement-no-reduction", None, True, True, None),
    ("forbidden-route", "BUG_ROUTE", False, False, "(sender[4]==2)&&(recipient[4]==4)"),
    ("wrong-correlation", "BUG_CORRELATION", False, False, "(reply_to[5]==5)"),
    ("early-decision", "BUG_EARLY_DECISION", False, False, "state[1]==Succeeded"),
    ("observer-dispatch", "BUG_OBSERVER_DISPATCH", False, False, "(observed_dispatches==dispatches)"),
    ("provider-stall", "BUG_STALL", True, False, "acceptance cycle"),
    ("success-witness", "WITNESS_SUCCESS", False, False, "(state[0]!=Succeeded)"),
    ("remediation-safety", None, False, False, None),
    ("remediation-safety-no-reduction", None, False, True, None),
    ("remediation-settlement", None, True, False, None),
    ("remediation-settlement-no-reduction", None, True, True, None),
    ("remediation-missing-uid-guard", "BUG_UID_GUARD", False, False, "patch_uid_matches"),
    ("remediation-early-verified", "BUG_EARLY_VERIFIED", False, False, "fresh_metrics"),
    ("remediation-stale-resource-version", "BUG_STALE_RV", False, False, "resource_version_matches"),
    ("remediation-report-auth", "BUG_REPORT_AUTH", False, False, "(!(report_published)||report_authenticated)"),
    ("remediation-api-stall", "BUG_REMEDIATION_STALL", True, False, "acceptance cycle"),
    ("remediation-success-witness", "WITNESS_REMEDIATION_SUCCESS", False, False, "(outcome!=Verified)"),
    ("remediation-effect-attribution", "BUG_EFFECT_ATTRIBUTION", False, False, "patch_acknowledged"),
    ("remediation-uncertain-effect-witness", "WITNESS_EFFECT_UNCERTAINTY", False, False, "EffectUnknown"),
    ("controller-safety", None, False, False, None),
    ("controller-safety-no-reduction", None, False, True, None),
    ("controller-settlement", None, True, False, None),
    ("controller-settlement-no-reduction", None, True, True, None),
    ("controller-lost-create-ack", "BUG_LOST_CREATE_ACK", False, False, "!(lost_create_ack[id])"),
    ("controller-cas-bypass", "BUG_CAS_BYPASS", False, False, "(effects<=1)"),
    ("controller-retry-applying", "BUG_RETRY_APPLYING", False, False, "original_claim_ack[id]"),
    ("controller-early-publication", "BUG_EARLY_PUBLISH", False, False, "(phase==Finished)"),
    ("controller-source-binding", "BUG_SOURCE_BINDING", False, False, "source_bound"),
    ("controller-stale-evidence", "BUG_STALE_EVIDENCE", False, False, "evidence_fresh"),
    ("controller-owner-stall", "BUG_CONTROLLER_STALL", True, False, "acceptance cycle"),
    ("controller-success-witness", "WITNESS_CONTROLLER_SUCCESS", False, False, "(durable_report!=Verified)"),
    ("controller-uncertainty-witness", "WITNESS_CONTROLLER_UNCERTAINTY", False, False, "Uncertain"),
]


def limit_child() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))


def run(command: list[str], cwd: Path, log: list[dict]) -> str:
    try:
        result = subprocess.run(command, cwd=cwd, text=True, capture_output=True,
                                timeout=TIMEOUT_SECONDS, preexec_fn=limit_child)
    except subprocess.TimeoutExpired as error:
        log.append({"command": command, "status": "timeout"})
        raise RuntimeError(f"command exceeded {TIMEOUT_SECONDS}s: {command[0]}") from error
    output = result.stdout + result.stderr
    log.append({"command": command, "exit_code": result.returncode, "output": output})
    if result.returncode:
        raise RuntimeError(f"command exited {result.returncode}: {command[0]}")
    return output



def validate_archive(path: Path, expected: dict[str, str]) -> dict:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise RuntimeError("counterexample archive member coverage changed")
        for name, digest in expected.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != digest:
                raise RuntimeError(f"counterexample archive content changed: {name}")
    return {"path": path.name, "entries": len(expected),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "verified": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "evidence")
    parser.add_argument("--compile-optimisation", choices=("0", "2"), default="0",
                        help="C optimisation level. The finite suite compiles fastest with 0.")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text('{"status":"RUNNING_OR_INTERRUPTED"}\n')
    spin = shutil.which("spin")
    compiler = shutil.which(os.environ.get("CC", "cc"))
    source = ROOT / "hybrid.pml"
    summary = {
        "schema": "mas-k3s-application-verification/7",
        "compiler_optimisation": f"-O{args.compile_optimisation}",
        "model_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "models": {
            "dual-repair.pml": {
                "sha256": hashlib.sha256((ROOT / "dual-repair.pml").read_bytes()).hexdigest(),
                "bounds": {"runs": 2, "approaches": 2, "workload_identities": 2,
                           "retained_fault_journals": 2, "maximum_patch_effects_per_target": 1},
                "assumptions": [
                    "Each immutable source Run binds its Event, original seed Pod, approach and fixed workload policy",
                    "Only a complete trusted frozen MCP bundle supplies evidence for MCP controller admission",
                    "Single-failed-guard classes cover mismatched source, seed, approach, freeze and target predicates",
                    "Distinct Deployment UID/original-template keys reserve distinct journals; one process per incident",
                    "Existing investigation, revision, controller and remediation models separately check their local lifecycles",
                    "Accepted execution abstracts unchanged guarded live UID/RV/template checks and an acknowledged API effect",
                    "Recovery completion abstracts the conjunction of the executor's independent verification checks",
                    "No elapsed-time guarantee, hash-collision argument or implementation refinement proof",
                ],
            },
            "investigation.pml": {
                "sha256": hashlib.sha256((ROOT / "investigation.pml").read_bytes()).hexdigest(),
                "bounds": {"runs": 1, "delegate_invocation_identities": 4, "required_actor_identities": 4, "server_restarts": 2,
                           "cancellations": 1, "frozen_bundles": 1, "assessment_starts": 1},
                "assumptions": [
                    "Single orchestrator owner; durable admission, tool ledger, source input and frozen bytes survive restart",
                    "Cancellation check and new child dispatch share a synchronous admission boundary",
                    "Tool reservation, external call, retained result, evidence freeze and assessed launch are separate transitions",
                    "Any reserved but unrecorded operation becomes uncertain on restart and cannot automatically retry",
                    "Subject UID, known tool, valid result and evidence consistency are conjunctive trusted-code predicates",
                    "Freezing requires completed calls covering all four distinct required tool actors, regardless of their order",
                    "Valid unavailable observations count as completed acquisition attempts, not usable remediation evidence",
                    "Finite host/tool outcomes and at most two restarts; no process fairness or elapsed-time guarantee",
                    "Host deadline and per-call identity are preserved by recovery; timing and MCP transport are not modelled",
                    "The later candidate/assessment revision loop is checked separately in revision.pml",
                    "No storage loss, overlapping orchestrators, cryptographic adversary or implementation refinement proof",
                ],
            },
            "revision.pml": {
                "sha256": hashlib.sha256((ROOT / "revision.pml").read_bytes()).hexdigest(),
                "bounds": {"candidates": 2, "assessments": 2, "revisions": 1, "controller_effects": 1},
                "assumptions": ["Exact hashes are equality predicates, not cryptographic proofs",
                                "Completed means the frozen internal checks passed, not independent diagnosis correctness",
                                "Existing independent remediation admission is separately required",
                                "Cancellation and unknown effects terminate without controller authority",
                                "The host preserves immutable candidates and supplied feedback; no storage-loss model"],
            },
            "hybrid.pml": {"sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
            "remediation.pml": {
                "sha256": hashlib.sha256((ROOT / "remediation.pml").read_bytes()).hexdigest(),
                "bounds": {"bundles": 1, "proposals": 1, "targets": 1, "tool_invocations": 1,
                           "maximum_patch_effects": 1, "report_publications": 1},
                "assumptions": [
                    "Every API call and bounded recovery poll returns or reaches a finite failure deadline",
                    "Exact comparisons and Kubernetes atomic JSON Patch tests are abstract Boolean predicates",
                    "No crash, restart, retry, storage loss, cryptographic adversary or unrestricted exactly-once claim",
                    "Recovery predicates represent actual checks, not the truth of LLM diagnosis",
                    "No fairness option; positive transitions consume finite remaining work",
                ],
            },
            "controller.pml": {
                "sha256": hashlib.sha256((ROOT / "controller.pml").read_bytes()).hexdigest(),
                "bounds": {"concurrent_workers": 2, "source_run_uids": 2,
                           "retained_fault_journals": 1, "maximum_patch_effects": 1,
                           "publication_attempts": 2},
                "assumptions": [
                    "One retained journal key covers namespace UID, Deployment UID, original template hash and fixed policy version",
                    "No journal deletion, durable storage loss, hash collisions, credential adversary or arbitrary workload mutation",
                    "Kubernetes create, status resourceVersion CAS and guarded workload PATCH are separately atomic",
                    "Create and claim responses may be lost; their originating worker grants no effect authority",
                    "A retained Pending journal may await a later poll after the two bounded worker attempts; settlement excludes retained Applying",
                    "A boot can crash before or after its one effect, patch ACK, recovery or durable Finished write",
                    "A finite owner deadline may store an uncertain terminal before a delayed owner finishes its already-reserved effect",
                    "Each API attempt returns or reaches a finite failure deadline; no fairness option or elapsed-time guarantee",
                    "Publication retry may fail or duplicate delivery but uses only the immutable durable report and original source Run UID",
                    "Recovery conjunction abstracts predicates independently enumerated in remediation.pml",
                    "Freshness abstracts the admission comparison, not wall-clock passage before the patch",
                    "Finish/POST acknowledgement choices share one durable-reread abstraction; no transport retry timing proof",
                    "No implementation refinement proof or unrestricted exactly-once claim",
                ],
            },
        },
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "reviewed_application_files": {
            name: hashlib.sha256((ROOT.parent / name).read_bytes()).hexdigest()
            for name in ("project/topology.yaml", "project/workflows/coordinator.yaml",
                         "project/workflows/platform.yaml", "project/workflows/security.yaml",
                         "deploy/remediation.mjs", "deploy/remediation.test.mjs",
                         "deploy/guarded-operation.mjs", "deploy/guarded-operation.test.mjs",
                         "shared/resolution.ts", "shared/workloads.mjs", "remediator/outcomes.test.ts",
                         "server/http.ts", "server/runs.ts", "server/runs.test.ts",
                         "remediator/controller.ts", "remediator/controller.test.ts", "remediator/index.ts", "remediator/transport.ts",
                         "remediator/transport.test.ts", "operator/client.ts", "operator/controller.ts", "operator/controller.test.ts", "deploy/rbac.yaml",
                         "deploy/crd.yaml", "deploy/remediation-crd.yaml", "deploy/remediator.yaml", "project/revision.json",
                         "project/assessment.py", "shared/revision.mjs", "ui/revision.test.ts", "server/host.integration.ts",
                         "server/host.ts", "server/investigation.ts", "server/investigation.test.ts", "server/investigation.integration.ts", "mcp/server.ts", "mcp/tools.ts",
                         "mcp/client.test.ts", "mcp/tools.test.ts", "project/mcp-client.mjs",
                         "project/fixture-provider.mjs", "shared/evidence.ts", "operator/evidence.ts", "package-lock.json",
                         "project/agents.mcp.toml", "project/topology.mcp.yaml", "project/prompts/investigator.md",
                         "project/connections.mcp-fixture.toml", "project/schemas/investigation.json",
                         "project/schemas/mcp-input.json", "project/schemas/mcp-logs-input.json", "project/schemas/mcp-result.json")
        },
        "bounds": {"actors": 7, "request_identities": 8, "runs": 1, "observer_reads": 2},
        "limits": {"seconds_per_command": TIMEOUT_SECONDS, "address_space_bytes": MEMORY_BYTES,
                   "search_depth": DEPTH},
        "assumptions": ["Every admitted leaf has a finite known success or failure response",
                        "No provider stall, crash, cancellation, expiry, storage loss or actor change in positive checks",
                        "Atomic abstract transport transitions; no implementation refinement proof",
                        "No fairness option; positive transitions consume finite remaining work"],
        "checks": [],
    }
    if not spin or not compiler:
        summary["status"] = "NOT_EXECUTED"
        summary["reason"] = "SPIN and a C compiler must be installed"
        (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(summary["reason"])
        return 1
    versions = []
    summary["spin"] = run([spin, "-V"], ROOT, versions).strip()
    summary["compiler"] = run([compiler, "--version"], ROOT, versions).splitlines()[0]
    raw_commands = {"tool_versions": versions}
    counterexamples = out / "counterexamples.zip"
    archive_members = {}
    archive = zipfile.ZipFile(counterexamples, "w", zipfile.ZIP_DEFLATED)
    for name, macro, liveness, no_reduction, violation in CASES:
        model = "dual-repair" if name.startswith("dual-repair-") else "investigation" if name.startswith("investigation-") else "revision" if name.startswith("revision-") else "controller" if name.startswith("controller-") else "remediation" if name.startswith("remediation-") else "hybrid"
        source = ROOT / f"{model}.pml"
        claim = {"dual-repair": "dual_repair_settles", "investigation": "investigation_settles", "revision": "revision_settles", "controller": "controller_settles", "remediation": "remediation_settles", "hybrid": "choreography_settles"}[model]
        commands = []
        check = {"name": name, "model": source.name, "claim": claim if liveness else None,
                 "macro": macro, "mode": "ltl" if liveness else "safety",
                 "partial_order_reduction": not no_reduction,
                 "expected": "counterexample" if violation else "zero_errors"}
        try:
            with tempfile.TemporaryDirectory(prefix="mas-spin-") as temporary:
                build = Path(temporary)
                shutil.copyfile(source, build / source.name)
                definitions = [f"-D{macro}"] if macro else []
                if name in ("safety", "remediation-safety", "controller-safety", "investigation-safety", "dual-repair-safety"):
                    for seed in (17, 29):
                        run([spin, f"-n{seed}", "-u1000", "-p", *definitions, source.name], build, commands)
                run([spin, *definitions, "-a", source.name], build, commands)
                # These bounded models spend most of their time compiling.
                # Keep every search option and resource limit unchanged.
                flags = [f"-O{args.compile_optimisation}", "-DMEMLIM=512"]
                if not liveness:
                    flags += ["-DSAFETY", "-DNOCLAIM"]
                if no_reduction:
                    flags += ["-DNOREDUCE"]
                run([compiler, *flags, "-o", "pan", "pan.c"], build, commands)
                options = ["-a"] if liveness else []
                output = run([str(build / "pan"), *options, "-b", f"-m{DEPTH}", "-w20"], build, commands)
                errors = re.search(r"errors:\s*(\d+)", output)
                if not errors:
                    raise RuntimeError("verifier did not report an error count")
                if any(marker in output for marker in ("max search depth too small", "out of memory", "Search not completed")):
                    # Expected counterexamples stop search intentionally.
                    if not violation or "Search not completed" not in output or any(
                            marker in output for marker in ("max search depth too small", "out of memory")):
                        raise RuntimeError("incomplete search")
                if violation:
                    if int(errors[1]) == 0:
                        raise RuntimeError("expected counterexample was not found")
                    replay = run([spin, *definitions, "-t", "-p", "-g", "-l", source.name], build, commands)
                    if liveness:
                        if "acceptance cycle" not in output or "START OF CYCLE" not in replay or claim not in output:
                            raise RuntimeError("counterexample did not replay the selected LTL cycle")
                    else:
                        failed = re.search(r"text of failed assertion: (.+)", replay)
                        if not failed or re.sub(r"\s+", "", violation) not in re.sub(r"\s+", "", failed[1]):
                            raise RuntimeError(f"counterexample missed target assertion {violation}")
                    trail = build / f"{source.name}.trail"
                    if not trail.is_file():
                        raise RuntimeError("missing counterexample trail")
                    shutil.copyfile(trail, out / f"{name}.trail")
                    # Preserve the exact generated verifier before deleting its
                    # temporary build directory; one archive avoids many C files.
                    for generated in [build / source.name, trail, *sorted(build.glob("pan.*"))]:
                        member = f"{name}/{generated.name}"
                        content = generated.read_bytes()
                        archive.writestr(member, content)
                        archive_members[member] = hashlib.sha256(content).hexdigest()
                    member = f"{name}/configuration.json"
                    content = (json.dumps({
                        "spin_definitions": definitions, "compiler_flags": flags,
                        "verifier_options": [*options, "-b", f"-m{DEPTH}", "-w20"],
                        "model_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    }, indent=2) + "\n").encode()
                    archive.writestr(member, content)
                    archive_members[member] = hashlib.sha256(content).hexdigest()
                    check["counterexample_sources"] = f"counterexamples.zip/{name}/"
                    check["result"] = "EXPECTED_COUNTEREXAMPLE"
                else:
                    if int(errors[1]) != 0:
                        raise RuntimeError("positive check found a counterexample")
                    check["result"] = "COMPLETE_ZERO_ERRORS"
                check["stored_states"] = (re.search(r"([\d.e+]+) states, stored", output) or [None, None])[1]
                check["errors"] = int(errors[1])
        except (RuntimeError, OSError) as error:
            check["result"] = "FAILED_OR_INCOMPLETE"
            check["reason"] = str(error)
        raw_commands[name] = commands
        check["raw_commands_key"] = name
        summary["checks"].append(check)
        print(f"{name}: {check['result']}")
    archive.close()
    try:
        summary["counterexample_archive"] = validate_archive(counterexamples, archive_members)
    except (RuntimeError, OSError, zipfile.BadZipFile) as error:
        summary["counterexample_archive_error"] = str(error)
    # A long run must not certify source hashes captured before concurrent edits.
    changed = [name for name, digest in summary["reviewed_application_files"].items()
               if not (ROOT.parent / name).is_file() or hashlib.sha256((ROOT.parent / name).read_bytes()).hexdigest() != digest]
    changed += [name for name, model in summary["models"].items()
                if not (ROOT / name).is_file() or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != model["sha256"]]
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != summary["runner_sha256"]:
        changed.append("verification/verify.py")
    summary["source_changed_during_verification"] = changed
    summary["status"] = "PASS" if not changed and "counterexample_archive_error" not in summary and all(c["result"] != "FAILED_OR_INCOMPLETE" for c in summary["checks"]) else "FAIL"
    (out / "commands.json").write_text(json.dumps(raw_commands, indent=2) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
