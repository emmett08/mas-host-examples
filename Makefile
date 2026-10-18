SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

# Unit and acceptance tests share generated worker directories and build locks.
.NOTPARALLEL:

export MAS_HOST_SDK_ROOT := $(CURDIR)/.tools/mas-host
export MAS_HOST_BUILD_PROFILE ?= debug
export MAS_HOST_BIN := $(MAS_HOST_SDK_ROOT)/target/$(MAS_HOST_BUILD_PROFILE)/mas-host
export PYTHONPATH := $(MAS_HOST_SDK_ROOT)/sdk/python
export PYTHONDONTWRITEBYTECODE := 1
export GOWORK := off
export GOTOOLCHAIN := local

.PHONY: setup check test acceptance recovery verify go rust cpp python python-client command command-agent star tree mesh composed a2a a2a-sdk

setup:
	bash scripts/setup.sh

check:
	bash scripts/check.sh

test: check
	cd examples/go-release && go test -race ./...
	bash scripts/test-native.sh
	cd examples/python-review && python3 -m unittest discover -s tests -v
	cd examples/command-policy && python3 -m unittest discover -s tests -v

acceptance:
	cd tests && go test -count=1 -v ./...

recovery:
	cd tests && go test -count=1 -v -run Recovery ./...

verify: test acceptance

go:
	"$(MAS_HOST_BIN)" run --project examples/go-release --agent planner --input examples/go-release/input.yaml --state .state --run go-release

rust:
	"$(MAS_HOST_BIN)" run --project examples/rust-order --agent order --input examples/rust-order/input.yaml --state .state --run rust-order

cpp:
	"$(MAS_HOST_BIN)" run --project examples/cpp-telemetry --agent telemetry --input examples/cpp-telemetry/input.yaml --state .state --run cpp-telemetry

python:
	"$(MAS_HOST_BIN)" run --project examples/python-review --agent reviewer --input examples/python-review/input.yaml --state .state --run python-review

python-client:
	python3 examples/python-review/call.py

command:
	"$(MAS_HOST_BIN)" run --project examples/command-policy --agent policy_check --input examples/command-policy/input.yaml --state .state --run command-policy

# Explicit live opt-in; excluded from verify and credential-free CI commands.
command-agent:
	@: "$${OPENAI_API_KEY:?Set OPENAI_API_KEY for this billed live model example}"
	"$(MAS_HOST_BIN)" run --project examples/command-policy --agent reviewer --input examples/command-policy/input.yaml --state .state --run command-policy-agent

star tree composed:
	"$(MAS_HOST_BIN)" run --project examples/composable-agents --agent $@ --input examples/composable-agents/input.yaml --state .state --run review-$@

mesh:
	"$(MAS_HOST_BIN)" run --project examples/composable-agents --agent mesh_a --input examples/composable-agents/input.yaml --state .state --run review-mesh

a2a:
	python3 examples/a2a-review/demo.py --report .state/a2a-review/demo.json

# Install examples/a2a-review/requirements-sdk.txt in this interpreter first.
a2a-sdk:
	python3 examples/a2a-review/sdk_check.py --report .state/a2a-review/official-sdk.json
