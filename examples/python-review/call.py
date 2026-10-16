"""Call a MAS agent with a dataclass; no input file is required."""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path

from mas_host import Client
from review import Decision, Proposal


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("MAS_HOST_BIN", "mas-host"))
    parser.add_argument("--sdk-root", default=os.environ.get("MAS_HOST_SDK_ROOT"))
    parser.add_argument("--state", default=".state")
    parser.add_argument("--run", default="python-typed")
    parser.add_argument("--receipt", default="")
    parser.add_argument("--native-config", action="store_true",
                        help="explicitly export the equivalent typed Python configuration")
    args = parser.parse_args()
    project = Path(__file__).resolve().parent
    options = {}
    if args.native_config:
        from configure import configuration
        exported = configuration().export(project / ".mas" / "authored")
        options = {"agents": exported.agents, "topology": exported.topology}
    client = Client(project=project, state=args.state, run_id=args.run,
                    host=args.host, sdk_root=args.sdk_root, **options)
    proposal = Proposal(release="service-42", required_capacity=240, replicas=3,
                        capacity_per_replica=100, critical_findings=0, receipt_path=args.receipt)
    decision = client.run("reviewer", proposal, output_type=Decision)
    assert isinstance(decision, Decision)
    print(json.dumps(asdict(decision), sort_keys=True))


if __name__ == "__main__":
    main()
