#!/usr/bin/env python3
"""Exhaust finite controller models and require guard-removal counterexamples."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
CASES = [
    ("eligibility", None, None),
    ("effects", None, None),
    ("promotion", None, None),
    ("eligibility", "BUG_TREE", "receipt_tree==current_tree"),
    ("eligibility", "BUG_REQUIREMENTS", "receipt_requirements==current_requirements"),
    ("eligibility", "BUG_TESTS", "receipt_tests==current_tests"),
    ("eligibility", "BUG_ENVIRONMENT", "receipt_environment==current_environment"),
    ("eligibility", "BUG_IMAGE", "receipt_image==current_image"),
    ("eligibility", "BUG_VERIFIER", "authorised_verifier"),
    ("eligibility", "BUG_MANDATORY", "mandatory_pass"),
    ("effects", "BUG_UNKNOWN_PHASE", "(effect!=1)&&(effect!=3)"),
    ("effects", "BUG_UNKNOWN_REPEAT", "(effect!=1)&&(effect!=3)"),
    ("effects", "BUG_RESERVED_PHASE", "(effect!=1)&&(effect!=3)"),
    ("effects", "BUG_RESERVED_REPEAT", "(effect!=1)&&(effect!=3)"),
    ("effects", "BUG_BUDGET_RESET", "charged<=budget"),
    ("effects", "BUG_CANCEL", "!(cancelled)"),
    ("effects", "BUG_CANCEL_RESET", "!(ever_cancelled)"),
    ("promotion", "BUG_OWNER", "effects<=1"),
    ("promotion", "BUG_CLAIM_ACK", "ack"),
    ("promotion", "BUG_STALE_TARGET", "target==observed_target"),
    ("promotion", "BUG_PROMOTION_IDENTITY", "current_generation==verified_generation"),
    ("promotion", "BUG_UNVERIFIED_PROMOTION", "verification_passed"),
    ("promotion", "BUG_PROMOTION_CANCEL", "!(cancelled)"),
    ("eligibility", "WITNESS_RECOVERY", "!(promoted)"),
    ("effects", "WITNESS_FAILED_REVISION", "first_failed"),
    ("effects", "WITNESS_UNKNOWN_RESTART", "unresolved_dispatches==1"),
    ("effects", "WITNESS_RESERVED_RESTART", "effect==3"),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(case: tuple, spin: str, compiler: str, no_reduce: bool = False) -> dict:
    model, macro, expected = case
    name = f"{model}-{macro or 'safety'}{'-no-reduction' if no_reduce else ''}"
    commands = []
    with tempfile.TemporaryDirectory(prefix="self-remediation-spin-") as directory:
        cwd = Path(directory)
        source = ROOT / f"{model}.pml"
        shutil.copyfile(source, cwd / source.name)

        def run(args: list[str]) -> str:
            result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=30)
            output = result.stdout + result.stderr
            commands.append({"argv": args, "exit_code": result.returncode, "output": output})
            if result.returncode:
                raise RuntimeError(f"{name}: command failed: {args[0]}\n{output}")
            return output

        run([spin, *( [f"-D{macro}"] if macro else [] ), "-a", source.name])
        run([compiler, "-O0", "-DSAFETY", "-DNOCLAIM", *( ["-DNOREDUCE"] if no_reduce else [] ), "-o", "pan", "pan.c"])
        output = run([str(cwd / "pan"), "-m10000", "-w18"])
        match = re.search(r"errors:\s*(\d+)", output)
        if not match or "max search depth too small" in output or "Search not completed" in output and not expected:
            raise RuntimeError(f"{name}: incomplete verification\n{output}")
        errors = int(match.group(1))
        trace = None
        if expected:
            if errors < 1 or "assertion violated" not in output or expected not in output.replace(" ", ""):
                raise RuntimeError(f"{name}: expected assertion {expected!r} was not reached\n{output}")
            trace = run([spin, *( [f"-D{macro}"] if macro else [] ), "-t", "-p", "-g", source.name])
        elif errors:
            raise RuntimeError(f"{name}: unexpected model violation\n{output}")
        return {"name": name, "model_sha256": sha(source), "guard_control": macro,
                "expected_assertion": expected, "errors": errors, "passed": True,
                "commands": commands, "counterexample": trace}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT.parent / ".state" / "formal")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    spin = shutil.which(os.environ.get("SPIN", "spin"))
    compiler = shutil.which(os.environ.get("CC", "cc"))
    if not spin or not compiler:
        raise SystemExit("SPIN and a C compiler are required; no verification was performed")
    report = {"schema": "self-remediation-formal/1", "status": "RUNNING_OR_INTERRUPTED", "cases": []}
    output = args.out / "summary.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    jobs = [(case, False) for case in CASES] + [(case, True) for case in CASES if case[1] is None]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(verify, case, spin, compiler, no_reduce) for case, no_reduce in jobs]
        for (case, no_reduce), future in zip(jobs, futures):
            try:
                report["cases"].append(future.result())
            except Exception as error:
                report["cases"].append({"name": f"{case[0]}-{case[1] or 'safety'}", "no_reduction": no_reduce,
                                        "passed": False, "error": str(error)})
            output.write_text(json.dumps(report, indent=2) + "\n")
    report.update({
        "status": "PASSED" if all(case["passed"] for case in report["cases"]) else "FAILED",
        "spin_version": subprocess.check_output([spin, "-V"], text=True).strip(),
        "runner_sha256": sha(Path(__file__)),
        "implementation_sha256": {str(path.relative_to(ROOT.parent)): sha(path)
                                  for folder in ("controller", "tools", "deploy", "host", "contracts")
                                  for path in sorted((ROOT.parent / folder).glob("*.ts"))},
        "scope": {"controller_processes": 2, "process_incarnations": 2,
                  "budget_units": [1, 2], "identity_values": 2,
                  "claim": "Finite control safety, guard sensitivity and selected reachability only",
                  "excludes": ["arbitrary generated-code correctness", "test completeness", "cryptographic collision resistance",
                               "unbounded liveness", "storage destruction", "provider truthfulness", "full implementation refinement proof"]},
    })
    output.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(case["passed"] for case in report["cases"])
    print(f"{passed}/{len(report['cases'])} SPIN checks passed; report: {output}")
    return 0 if report["status"] == "PASSED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
