"""Typed Python agents for a synthetic service-capacity review."""

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path

from mas_host import Context, EffectResult, Request


@dataclass(frozen=True)
class Proposal:
    release: str
    required_capacity: int
    replicas: int
    capacity_per_replica: int
    critical_findings: int
    receipt_path: str = ""


@dataclass(frozen=True)
class Capacity:
    available: int
    sufficient: bool


@dataclass(frozen=True)
class Security:
    critical_findings: int
    accepted: bool


@dataclass(frozen=True)
class Evidence:
    proposal: Proposal
    capacity: Capacity
    security: Security


@dataclass(frozen=True)
class Decision:
    release: str
    approved: bool
    available_capacity: int
    critical_findings: int


def validate(proposal: Proposal) -> None:
    if not proposal.release or len(proposal.release.encode()) > 64:
        raise ValueError("release must contain 1..64 bytes")
    for name in ("required_capacity", "replicas", "capacity_per_replica"):
        value = getattr(proposal, name)
        if type(value) is not int or not 1 <= value <= 1_000_000:
            raise ValueError(f"{name} must be an integer in 1..1000000")
    if type(proposal.critical_findings) is not int or not 0 <= proposal.critical_findings <= 1_000_000:
        raise ValueError("critical_findings must be an integer in 0..1000000")


def capacity(_ctx: Context, proposal: Proposal) -> Capacity:
    validate(proposal)
    available = proposal.replicas * proposal.capacity_per_replica
    return Capacity(available, available >= proposal.required_capacity)


def security(_ctx: Context, proposal: Proposal) -> Security:
    validate(proposal)
    return Security(proposal.critical_findings, proposal.critical_findings == 0)


def accept(_ctx: Context, evidence: Evidence) -> Decision:
    """Recompute the decision from the input and reject inconsistent reports."""
    proposal = evidence.proposal
    validate(proposal)
    available = proposal.replicas * proposal.capacity_per_replica
    expected_capacity = Capacity(available, available >= proposal.required_capacity)
    expected_security = Security(proposal.critical_findings, proposal.critical_findings == 0)
    if evidence.capacity != expected_capacity or evidence.security != expected_security:
        raise ValueError("peer reports disagree with independent acceptance")
    return Decision(proposal.release, evidence.capacity.sufficient and evidence.security.accepted,
                    available, proposal.critical_findings)


def publish_receipt(path: str, decision: Decision, invocation_id: str) -> EffectResult:
    """Write a durable local receipt within the admitted effect boundary."""
    receipt = {"version": "python-review-receipt/1", "invocation_id": invocation_id,
               "output": asdict(decision)}
    destination = Path(path)
    # Exclusive creation makes an accidental second publication visible. An
    # uncertain effect requires reconciliation, never an automatic second write.
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(receipt, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return EffectResult(output=decision, evidence={"receipt_path": str(destination),
                                                  "invocation_id": invocation_id})


def review(ctx: Context, proposal: Proposal) -> Decision:
    validate(proposal)
    reports = ctx.parallel([
        Request("capacity_check", "capacity", proposal),
        Request("security_check", "security", proposal),
    ])
    evidence = Evidence(proposal, Capacity(**reports[0]), Security(**reports[1]))
    decision = ctx.request("independent_acceptance", "acceptance", evidence, output_type=Decision)
    if proposal.receipt_path:
        output = ctx.effect("publish_receipt", {"path": proposal.receipt_path, "decision": asdict(decision)},
                            lambda invocation_id: publish_receipt(proposal.receipt_path, decision, invocation_id))
        return Decision(**output)
    return decision
