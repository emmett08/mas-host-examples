SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

# Unit and acceptance tests share generated worker directories and build locks.
.NOTPARALLEL:

export MAS_HOST_SDK_ROOT := $(CURDIR)/.tools/mas-host
export MAS_HOST_BIN := $(MAS_HOST_SDK_ROOT)/target/debug/mas-host
export GOWORK := off
export GOTOOLCHAIN := local

.PHONY: setup check test acceptance recovery verify go rust cpp mixed star tree mesh composed

setup:
	bash scripts/setup.sh

check:
	bash scripts/check.sh

test: check
	cd examples/go-release && go test -race ./...
	cd examples/mixed-review && go test -race ./...
	bash scripts/test-native.sh

acceptance:
	cd tests && go test -count=1 -v ./...

recovery:
	cd tests && go test -count=1 -v -run Recovery ./...

verify: test acceptance

go:
	"$(MAS_HOST_BIN)" run --project examples/go-release --agent planner --input examples/go-release/input.json --state .state --run go-release

rust:
	"$(MAS_HOST_BIN)" run --project examples/rust-order --agent order --input examples/rust-order/input.json --state .state --run rust-order

cpp:
	"$(MAS_HOST_BIN)" run --project examples/cpp-telemetry --agent telemetry --input examples/cpp-telemetry/input.json --state .state --run cpp-telemetry

mixed:
	"$(MAS_HOST_BIN)" run --project examples/mixed-review --agent reviewer --input examples/mixed-review/input.json --state .state --run mixed-review

star tree composed:
	"$(MAS_HOST_BIN)" run --project examples/composable-agents --agent $@ --input examples/composable-agents/input.json --state .state --run review-$@

mesh:
	"$(MAS_HOST_BIN)" run --project examples/composable-agents --agent mesh_a --input examples/composable-agents/input.json --state .state --run review-mesh
