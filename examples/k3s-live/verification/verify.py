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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "evidence")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text('{"status":"RUNNING_OR_INTERRUPTED"}\n')
    spin = shutil.which("spin")
    compiler = shutil.which(os.environ.get("CC", "cc"))
    source = ROOT / "hybrid.pml"
    summary = {
        "schema": "mas-k3s-application-verification/4",
        "model_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "models": {
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
                         "shared/resolution.ts", "remediator/outcomes.test.ts",
                         "server/http.ts", "server/runs.ts", "server/runs.test.ts",
                         "remediator/controller.ts", "remediator/controller.test.ts", "remediator/index.ts", "remediator/transport.ts",
                         "remediator/transport.test.ts", "operator/client.ts", "deploy/rbac.yaml",
                         "deploy/remediation-crd.yaml", "deploy/remediator.yaml")
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
    counterexamples.unlink(missing_ok=True)
    for name, macro, liveness, no_reduction, violation in CASES:
        model = "controller" if name.startswith("controller-") else "remediation" if name.startswith("remediation-") else "hybrid"
        source = ROOT / f"{model}.pml"
        claim = {"controller": "controller_settles", "remediation": "remediation_settles", "hybrid": "choreography_settles"}[model]
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
                if name in ("safety", "remediation-safety", "controller-safety"):
                    for seed in (17, 29):
                        run([spin, f"-n{seed}", "-u1000", "-p", *definitions, source.name], build, commands)
                run([spin, *definitions, "-a", source.name], build, commands)
                flags = ["-O2", "-DMEMLIM=512"]
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
                    with zipfile.ZipFile(counterexamples, "a", zipfile.ZIP_DEFLATED) as archive:
                        for generated in [build / source.name, trail, *sorted(build.glob("pan.*"))]:
                            archive.write(generated, f"{name}/{generated.name}")
                        archive.writestr(f"{name}/configuration.json", json.dumps({
                            "spin_definitions": definitions, "compiler_flags": flags,
                            "verifier_options": [*options, "-b", f"-m{DEPTH}", "-w20"],
                            "model_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        }, indent=2) + "\n")
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
    # A long run must not certify source hashes captured before concurrent edits.
    changed = [name for name, digest in summary["reviewed_application_files"].items()
               if not (ROOT.parent / name).is_file() or hashlib.sha256((ROOT.parent / name).read_bytes()).hexdigest() != digest]
    changed += [name for name, model in summary["models"].items()
                if not (ROOT / name).is_file() or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != model["sha256"]]
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != summary["runner_sha256"]:
        changed.append("verification/verify.py")
    summary["source_changed_during_verification"] = changed
    summary["status"] = "PASS" if not changed and all(c["result"] != "FAILED_OR_INCOMPLETE" for c in summary["checks"]) else "FAIL"
    (out / "commands.json").write_text(json.dumps(raw_commands, indent=2) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
