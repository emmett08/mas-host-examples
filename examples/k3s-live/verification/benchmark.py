#!/usr/bin/env python3
"""Compare complete finite verification runs with C optimisation levels 2 and 0."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    original = verifier.run
    rows = []
    reference = None
    reference_trails = None
    for index, level in enumerate(("2", "0", "0", "2"), 1):
        elapsed = {"compile": 0.0, "other": 0.0}

        def measured(command, cwd, log):
            phase = "compile" if "pan.c" in command and "-o" in command else "other"
            start = time.monotonic()
            try:
                return original(command, cwd, log)
            finally:
                elapsed[phase] += time.monotonic() - start

        verifier.run = measured
        destination = out / f"run-{index}-O{level}"
        sys.argv = ["verify.py", "--out", str(destination), "--compile-optimisation", level]
        start = time.monotonic()
        code = verifier.main()
        rows.append({"index": index, "optimisation": f"-O{level}",
                     "seconds": time.monotonic() - start, "exit_code": code, **elapsed})
        (out / "benchmark.json").write_text(json.dumps(rows, indent=2) + "\n")
        if code:
            return code
        summary = json.loads((destination / "summary.json").read_text())
        comparison = {key: summary[key] for key in
                      ("models", "runner_sha256", "limits", "checks")}
        trails = {path.name: path.read_bytes() for path in destination.glob("*.trail")}
        if reference is None:
            reference, reference_trails = comparison, trails
        elif comparison != reference or trails != reference_trails:
            raise RuntimeError("Verification outcomes, source, bounds or counterexample trails changed")
        print(json.dumps(rows[-1]), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
