"""A Python entry agent delegates a typed JSON object to the Go reviewer."""

from mas_host import Context


def review(ctx: Context, proposal: dict) -> dict:
    # Go requests Rust and C++ specialists, then independently checks their
    # reports. Each language boundary remains an admitted MAS Request/Result.
    return ctx.request("native_review", "reviewer", proposal)
