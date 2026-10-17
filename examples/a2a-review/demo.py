#!/usr/bin/env python3
"""Bounded, credential-free integration exercise using the real Rust host gateway."""
import argparse
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import tomllib
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
PROFILE = "urn:mas:host-task-service:1"
INPUT = {"release": "release-42", "has_rollback": True, "critical_findings": False}
TERMINAL = {"TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"}


class Client:
    """Small JSON-RPC demonstration client; this is not the official A2A SDK."""
    def __init__(self, endpoint, token):
        parsed = urlsplit(endpoint)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("this test client accepts literal loopback HTTP only")
        self.endpoint, self.token, self.port = endpoint, token, parsed.port

    def request(self, method=None, params=None, *, discard_body=False, extension=PROFILE):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            if method is None:
                connection.request("GET", "/.well-known/agent-card.json")
            else:
                body = json.dumps({"jsonrpc": "2.0", "id": "demo-rpc", "method": method,
                                   "params": params or {}}, separators=(",", ":"))
                headers = {
                    "Content-Type": "application/json", "Authorization": "Bearer " + self.token,
                    "A2A-Version": "1.0",
                }
                if extension:
                    headers["A2A-Extensions"] = extension
                connection.request("POST", "/a2a", body, headers)
            response = connection.getresponse()
            if discard_body:
                # Observe acceptance headers, then lose the response body: no task
                # identifier is decoded or retained by this client.
                if response.status != 200:
                    raise AssertionError(f"submission HTTP status {response.status}")
                return None
            raw = response.read(131073)
            if len(raw) > 131072:
                raise AssertionError("response exceeded demonstration limit")
            return response.status, json.loads(raw)
        finally:
            connection.close()

    def rpc(self, method, params=None):
        status, body = self.request(method, params)
        if status != 200 or "error" in body:
            raise AssertionError(f"{method}: HTTP {status}: {body}")
        return body["result"]

    def rejected(self, method, params, expected_codes=None, *, expected_status=200, extension=PROFILE):
        status, body = self.request(method, params, extension=extension)
        assert status == expected_status, (method, status, body)
        error = body.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        if expected_codes:
            assert code in expected_codes, (method, body)
        return {"http_status": status, "code": code}


def descriptor(card):
    extensions = [item for item in card["capabilities"]["extensions"] if item["uri"] == PROFILE]
    assert len(extensions) == 1, "missing or duplicate MAS task-service profile"
    return extensions[0]["params"]["descriptor"]


def submission(digest, identity="review-message-1", value=None, agent="review"):
    return {"message": {"messageId": identity, "role": "ROLE_USER", "parts": [{
        "mediaType": "application/json", "data": {"agent": agent,
        "input": deepcopy(INPUT if value is None else value), "descriptorDigest": digest}}]},
        "configuration": {"returnImmediately": True}}


def poll(client, task_id, seconds=65):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        task = client.rpc("GetTask", {"id": task_id})
        if task["status"]["state"] in TERMINAL:
            if task["status"]["state"] != "TASK_STATE_COMPLETED":
                raise AssertionError(f"task did not complete: {task}")
            return task
        time.sleep(0.05)
    raise AssertionError("task exceeded demonstration polling deadline")


def output(task):
    artifacts = task.get("artifacts", [])
    assert len(artifacts) == 1 and len(artifacts[0]["parts"]) == 1, task
    return artifacts[0]["parts"][0]["data"]


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", type=Path, default=Path(os.getenv("MAS_HOST_BIN", ROOT / ".tools/mas-host/target/debug/mas-host")))
    parser.add_argument("--sdk-root", type=Path, default=Path(os.getenv("MAS_HOST_SDK_ROOT", ROOT / ".tools/mas-host")))
    parser.add_argument("--live", action="store_true", help="make bounded, billed OpenAI requests instead of using the deterministic provider fixture")
    parser.add_argument("--model", default="gpt-5.4-2026-03-05")
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


@contextmanager
def gateway(args):
    if args.live and not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("--live requires OPENAI_API_KEY; no fixture fallback occurs")
    host, sdk = args.host.resolve(), args.sdk_root.resolve()
    if not host.is_file():
        raise SystemExit("Build the pinned host with make setup, or supply --host and --sdk-root")
    with tempfile.TemporaryDirectory(prefix="nehemiah-a2a-") as temporary:
        work = Path(temporary)
        # Keep executable bytes stable while another developer rebuilds the
        # source checkout. The host includes these bytes in execution identity.
        retained_host = work / "mas-host"
        shutil.copy2(host, retained_host)
        host = retained_host
        project = work / "project"
        shutil.copytree(Path(__file__).parent / "project", project)
        build = [str(host), "build", "--project", str(project), "--sdk-root", str(sdk)]
        if args.live:
            settings = tomllib.loads((project / "agents.toml").read_text())
            settings["connections"]["reviewer_provider"] = {
                "kind": "openai", "endpoint": "https://api.openai.com/v1/responses",
                "api_key_env": "OPENAI_API_KEY"}
            settings["agents"][2]["implementation"]["model"] = args.model
            live = work / "live-agents.json"
            live.write_text(json.dumps(settings))
            build += ["--agents", str(live)]
        bundle = json.loads(subprocess.check_output(build, text=True, timeout=120))["bundle"]
        local_descriptor = json.loads(subprocess.check_output(
            [str(host), "describe", "--bundle", bundle], text=True, timeout=10))
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}/a2a"
        tokens = {name: secrets.token_urlsafe(32) for name in ("alice", "bob")}
        config = {"version": "mas-host-a2a/1", "listen": f"127.0.0.1:{port}",
            "public_url": endpoint, "name": "Nehemiah release review",
            "exports": [
                {"agent": "review", "name": "Release review", "description": "Deterministic release policy followed by reviewer advice.", "public": True},
                {"agent": "policy", "name": "Release policy", "description": "Checks rollback and critical-finding flags.", "public": False}],
            "principals": [{"name": name, "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                            "agents": ["review", "policy"] if name == "alice" else ["review"]}
                           for name, token in tokens.items()], "max_active": 2, "max_tasks": 8}
        config_file = work / "gateway.json"
        config_file.write_text(json.dumps(config))
        config_file.chmod(0o600)
        with (work / "gateway.log").open("w+") as log:
            process = subprocess.Popen([str(host), "serve-a2a", "--bundle", bundle,
                "--state", str(work / "state"), "--config", str(config_file)], stdout=log, stderr=log)
            try:
                alice, bob = Client(endpoint, tokens["alice"]), Client(endpoint, tokens["bob"])
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        raise AssertionError("gateway stopped: " + log.read(8192))
                    try:
                        status, card = alice.request()
                        if status == 200:
                            break
                    except (OSError, http.client.HTTPException):
                        pass
                    time.sleep(0.05)
                else:
                    raise AssertionError("gateway startup exceeded 10 seconds")
                yield alice, bob, card, local_descriptor
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def exercise(args):
    with gateway(args) as (alice, bob, public, local):
        authorised = alice.rpc("GetExtendedAgentCard")
        other = bob.rpc("GetExtendedAgentCard")
        assert {s["id"] for s in public["skills"]} == {"review"}
        assert {s["id"] for s in authorised["skills"]} == {"review", "policy"}
        assert {s["id"] for s in other["skills"]} == {"review"}
        contract = descriptor(authorised)
        digest = contract["bundle_digest"]
        assert digest == local["bundle_digest"]
        request = submission(digest)
        alice.request("SendMessage", request, discard_body=True)
        repeated = alice.rpc("SendMessage", request)["task"]
        task_id = repeated["id"]
        assert alice.rpc("SendMessage", request)["task"]["id"] == task_id
        complete = poll(alice, task_id)
        decision = output(complete)
        assert decision["release"] == INPUT["release"] and decision["policy_accepted"] is True
        if not args.live:
            assert decision["approved"] is True
        denied = {
            "foreign_task": bob.rejected("GetTask", {"id": task_id}, {-32001}),
            "private_agent": bob.rejected("SendMessage", submission(digest, "forbidden", agent="policy"), {-32001}),
            "changed_contract": alice.rejected("SendMessage", submission("0" * 64, "stale-contract"), {-32602}),
            "changed_message": alice.rejected("SendMessage", submission(digest, value={**INPUT, "has_rollback": False}), {-32602}),
            "missing_extension": alice.rejected("SendMessage", submission(digest, "missing-extension"), {-32008}, extension=""),
            "invalid_token": Client(alice.endpoint, "not-a-valid-token").rejected("GetExtendedAgentCard", {}, expected_status=401),
        }
        unsafe = alice.rpc("SendMessage", submission(digest, "policy-refusal", {**INPUT, "has_rollback": False}))["task"]
        refusal = output(poll(alice, unsafe["id"]))
        assert refusal["approved"] is False and refusal["policy_accepted"] is False
        return {"mode": "live-openai" if args.live else "deterministic-provider-fixture",
            "status": "passed", "protocol": "A2A/1.0", "profile": PROFILE,
            "descriptor_digest": digest, "public_skills": [s["id"] for s in public["skills"]],
            "authorised_skills": [s["id"] for s in authorised["skills"]],
            "same_identity_after_response_body_loss": True, "task_id": task_id,
            "decision": decision, "policy_refusal": refusal, "rejections": denied}


def save_report(args, report):
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    options = arguments()
    save_report(options, exercise(options))
