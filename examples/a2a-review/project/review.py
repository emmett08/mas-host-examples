"""Release advice combines an exact local rule with a separately admitted reviewer."""
from dataclasses import dataclass

from mas_host import Context


@dataclass(frozen=True)
class Proposal:
    release: str
    has_rollback: bool
    critical_findings: bool


@dataclass(frozen=True)
class Policy:
    accepted: bool
    criterion: str


@dataclass(frozen=True)
class Evidence:
    proposal: Proposal
    policy: Policy


@dataclass(frozen=True)
class Review:
    approved: bool
    reason: str


@dataclass(frozen=True)
class Decision:
    release: str
    approved: bool
    policy_accepted: bool
    reviewer_approved: bool
    reason: str


def policy(_ctx: Context, proposal: Proposal) -> Policy:
    if not proposal.release or len(proposal.release.encode()) > 64:
        raise ValueError("release must contain 1..64 UTF-8 bytes")
    if type(proposal.has_rollback) is not bool or type(proposal.critical_findings) is not bool:
        raise ValueError("policy flags must be booleans")
    return Policy(proposal.has_rollback and not proposal.critical_findings,
                  "Rollback exists and no critical finding was reported.")


def review(ctx: Context, proposal: Proposal) -> Decision:
    checked = ctx.request("policy_check", "policy", proposal, output_type=Policy)
    advice = ctx.request("model_review", "reviewer", Evidence(proposal, checked), output_type=Review)
    # The reviewer cannot override a failed deterministic policy check.
    return Decision(proposal.release, checked.accepted and advice.approved,
                    checked.accepted, advice.approved, advice.reason)
