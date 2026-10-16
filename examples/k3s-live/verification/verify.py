#!/usr/bin/env python3
"""Check the finite demo choreography with SPIN; keep raw, inspectable evidence."""
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
    spin = shutil.which("spin")
    compiler = shutil.which(os.environ.get("CC", "cc"))
    source = ROOT / "hybrid.pml"
    summary = {
        "schema": "mas-k3s-choreography-verification/1",
        "model_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "reviewed_application_files": {
            name: hashlib.sha256((ROOT.parent / name).read_bytes()).hexdigest()
            for name in ("project/topology.yaml", "project/workflows/coordinator.yaml",
                         "project/workflows/platform.yaml", "project/workflows/security.yaml")
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
    for name, macro, liveness, no_reduction, violation in CASES:
        commands = []
        check = {"name": name, "macro": macro, "mode": "ltl" if liveness else "safety",
                 "partial_order_reduction": not no_reduction,
                 "expected": "counterexample" if violation else "zero_errors"}
        try:
            with tempfile.TemporaryDirectory(prefix="mas-spin-") as temporary:
                build = Path(temporary)
                shutil.copyfile(source, build / "hybrid.pml")
                definitions = [f"-D{macro}"] if macro else []
                if name == "safety":
                    for seed in (17, 29):
                        run([spin, f"-n{seed}", "-u1000", "-p", *definitions, "hybrid.pml"], build, commands)
                run([spin, *definitions, "-a", "hybrid.pml"], build, commands)
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
                    replay = run([spin, *definitions, "-t", "-p", "-g", "-l", "hybrid.pml"], build, commands)
                    if liveness:
                        if "acceptance cycle" not in output or "START OF CYCLE" not in replay or "choreography_settles" not in output:
                            raise RuntimeError("counterexample did not replay the selected LTL cycle")
                    else:
                        failed = re.search(r"text of failed assertion: (.+)", replay)
                        if not failed or re.sub(r"\s+", "", violation) not in re.sub(r"\s+", "", failed[1]):
                            raise RuntimeError(f"counterexample missed target assertion {violation}")
                    trail = build / "hybrid.pml.trail"
                    if not trail.is_file():
                        raise RuntimeError("missing counterexample trail")
                    shutil.copyfile(trail, out / f"{name}.trail")
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
    summary["status"] = "PASS" if all(c["result"] != "FAILED_OR_INCOMPLETE" for c in summary["checks"]) else "FAIL"
    (out / "commands.json").write_text(json.dumps(raw_commands, indent=2) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
