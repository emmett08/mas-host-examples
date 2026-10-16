"""Explicit alternative to TOML/YAML authoring using typed Python builders."""

from mas_host import Agent, Configuration, Native


def configuration() -> Configuration:
    bindings = (
        ("reviewer", "review", "review_release/1"),
        ("capacity", "capacity", "assess_capacity/1"),
        ("security", "security", "assess_security/1"),
        ("acceptance", "accept", "accept_release/1"),
    )
    pairs = (("client", "reviewer"), ("reviewer", "capacity"),
             ("reviewer", "security"), ("reviewer", "acceptance"))
    return Configuration(
        agents=[Agent(name, Native("python", "review.py", handler), operation)
                for name, handler, operation in bindings],
        edges=[edge for source, target in pairs for edge in ((source, target), (target, source))],
        limits={"wall_seconds": 60, "max_calls": 1, "max_messages": 32,
                "max_bytes": 262144, "mailbox_capacity": 8},
    )
