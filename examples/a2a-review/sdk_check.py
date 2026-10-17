#!/usr/bin/env python3
"""Exercise the Rust gateway with the independently maintained official A2A SDK."""
import asyncio
from importlib.metadata import version
import time

import httpx
from google.protobuf.json_format import MessageToDict, ParseDict
from a2a.client import A2ACardResolver
from a2a.client.transports.jsonrpc import JsonRpcTransport
from a2a.types import GetExtendedAgentCardRequest, GetTaskRequest, SendMessageRequest

from demo import PROFILE, TERMINAL, arguments, descriptor, gateway, output, save_report, submission


async def check(alice):
    assert version("a2a-sdk") == "1.0.3", "install the pinned requirements-sdk.txt"
    async with httpx.AsyncClient(timeout=5, trust_env=False, headers={
        "Authorization": "Bearer " + alice.token, "A2A-Version": "1.0", "A2A-Extensions": PROFILE,
    }) as http:
        # Card parsing, protobuf JSON encoding, RPC construction and response
        # decoding below all use the official SDK, not demo.Client.rpc.
        resolver = A2ACardResolver(http, alice.endpoint.removesuffix("/a2a"))
        public = await resolver.get_agent_card()
        transport = JsonRpcTransport(http, public, alice.endpoint)
        card = await transport.get_extended_agent_card(GetExtendedAgentCardRequest())
        digest = descriptor(MessageToDict(card))["bundle_digest"]
        request = ParseDict(submission(digest, "official-sdk-1"), SendMessageRequest())
        sent = await transport.send_message(request)
        task_id = sent.task.id
        assert task_id
        repeated = await transport.send_message(request)
        assert repeated.task.id == task_id
        deadline = time.monotonic() + 65
        while time.monotonic() < deadline:
            task = await transport.get_task(GetTaskRequest(id=task_id))
            value = MessageToDict(task)
            if value["status"]["state"] in TERMINAL:
                assert value["status"]["state"] == "TASK_STATE_COMPLETED", value
                decision = output(value)
                assert decision["policy_accepted"] is True and decision["approved"] is True
                return {"status": "passed", "mode": "deterministic-provider-fixture",
                    "client": "official a2a-sdk", "client_version": version("a2a-sdk"),
                    "protocol": "A2A/1.0", "profile": PROFILE, "task_id": task_id,
                    "same_task_on_retry": True, "decision": decision}
            await asyncio.sleep(0.05)
        raise AssertionError("official SDK polling deadline exceeded")


if __name__ == "__main__":
    options = arguments()
    if options.live:
        raise SystemExit("SDK conformance check is fixture-only; use demo.py --live for provider calls")
    with gateway(options) as (alice, _bob, _public, _local):
        save_report(options, asyncio.run(check(alice)))
