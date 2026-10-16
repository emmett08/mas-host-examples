// These tests exercise the installed host through its public CLI. They contain
// no worker transport, generated bindings or alternate execution implementation.
package acceptance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type object = map[string]any

type harness struct {
	t               *testing.T
	root, host, sdk string
	state, scratch  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Fatal("the current MAS Host runtime requires Linux; run make acceptance on Linux")
	}
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Dir(filepath.Dir(source))
	sdk := os.Getenv("MAS_HOST_SDK_ROOT")
	if sdk == "" {
		sdk = filepath.Join(root, ".tools", "mas-host")
	}
	sdk, err := filepath.Abs(sdk)
	if err != nil {
		t.Fatal(err)
	}
	host := os.Getenv("MAS_HOST_BIN")
	if host == "" {
		host = filepath.Join(root, ".tools", "mas-host", "target", "debug", "mas-host")
	}
	if !filepath.IsAbs(host) {
		host, err = exec.LookPath(host)
		if err != nil {
			t.Fatalf("locate MAS_HOST_BIN: %v", err)
		}
	}
	if _, err := os.Stat(host); err != nil {
		t.Fatalf("MAS Host executable unavailable: %v; run make setup or set MAS_HOST_BIN and MAS_HOST_SDK_ROOT", err)
	}
	scratch := t.TempDir()
	return &harness{t: t, root: root, host: host, sdk: sdk, state: filepath.Join(scratch, "state"), scratch: scratch}
}

func (h *harness) command(args ...string) ([]byte, []byte, error) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.host, args...)
	cmd.Dir = h.root
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		h.t.Fatalf("host command timed out: %v\n%s", args, stderr.String())
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

func (h *harness) success(args ...string) object {
	h.t.Helper()
	stdout, stderr, err := h.command(args...)
	if err != nil {
		h.t.Fatalf("host %v failed: %v\nstdout: %s\nstderr: %s", args, err, stdout, stderr)
	}
	return decode(h.t, stdout)
}

func (h *harness) failure(want string, args ...string) {
	h.t.Helper()
	stdout, stderr, err := h.command(args...)
	if err == nil {
		h.t.Fatalf("host %v unexpectedly succeeded: %s", args, stdout)
	}
	// The CLI's errors are structured JSON on stderr. Checking the actual
	// diagnostic prevents a missing compiler or executable satisfying this test.
	diagnostic := decode(h.t, stderr)
	if diagnostic["status"] != "error" || !strings.Contains(fmt.Sprint(diagnostic["error"]), want) {
		h.t.Fatalf("host %v: expected diagnostic containing %q, got %s", args, want, stderr)
	}
}

func decode(t *testing.T, raw []byte) object {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var result object
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("invalid JSON object: %v\n%s", err, raw)
	}
	return result
}

func readObject(t *testing.T, path string) object {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return decode(t, raw)
}

func writeObject(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}

func child(t *testing.T, value object, key string) object {
	t.Helper()
	result, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("expected object %q in %#v", key, value)
	}
	return result
}

func entries(t *testing.T, value object, key string) []object {
	t.Helper()
	items, ok := value[key].([]any)
	if !ok {
		t.Fatalf("expected array %q in %#v", key, value)
	}
	result := make([]object, len(items))
	for i, item := range items {
		var ok bool
		result[i], ok = item.(map[string]any)
		if !ok {
			t.Fatalf("expected object %s[%d]", key, i)
		}
	}
	return result
}

func assertEqual(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v; want %#v", got, want)
	}
}

func assertFields(t *testing.T, got object, want object) {
	t.Helper()
	// Canonicalise expected Go literals through the same number-preserving
	// decoder, so exact 64-bit values are never compared through float64.
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	for key, expected := range decode(t, raw) {
		if !reflect.DeepEqual(got[key], expected) {
			t.Fatalf("field %s: got %#v; want %#v (output %#v)", key, got[key], expected, got)
		}
	}
}

func (h *harness) project(name string) string {
	return filepath.Join(h.root, "examples", name)
}

func (h *harness) build(project string) string {
	h.t.Helper()
	result := h.success("build", "--project", project, "--sdk-root", h.sdk)
	bundle, ok := result["bundle"].(string)
	if !ok || bundle == "" {
		h.t.Fatalf("build returned no bundle: %#v", result)
	}
	return bundle
}

func (h *harness) runArgs(bundle, input, run, agent string) []string {
	return []string{"run", "--bundle", bundle, "--input", input, "--state", h.state, "--run", run, "--agent", agent}
}

func (h *harness) run(bundle, input, run, agent string) object {
	h.t.Helper()
	result := h.success(h.runArgs(bundle, input, run, agent)...)
	assertEqual(h.t, result["status"], "completed")
	return child(h.t, result, "output")
}

func (h *harness) inspect(run string) object {
	h.t.Helper()
	return h.success("inspect", "--state", h.state, "--run", run)
}

func TestNativeApplications(t *testing.T) {
	for _, name := range []string{"rust-order", "cpp-telemetry"} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			project := h.project(name)
			bundle := h.build(project)
			input := filepath.Join(project, "input.yaml")
			var agent string
			switch name {
			case "rust-order":
				agent = "order"
				out := h.run(bundle, input, "accepted", agent)
				assertFields(t, out, object{"subtotal_minor": 4700, "discount_minor": 235, "net_minor": 4465, "tax_minor": 893, "total_minor": 5658, "within_budget": true, "item_count": 2, "unit_count": 5})
			case "cpp-telemetry":
				agent = "telemetry"
				out := h.run(bundle, input, "accepted", agent)
				assertFields(t, out, object{"samples": 6, "min": 410, "max": 480, "sum": 2620, "mean_floor": 436, "breaches": 2, "first_breach_index": 3, "acceptable": false})
			}
			before := h.inspect("accepted")
			h.run(bundle, input, "accepted", agent)
			after := h.inspect("accepted")
			assertEqual(t, after, before)
			assertEqual(t, len(entries(t, child(t, after, "protocol"), "calls")), 0)
			t.Log("completed replay preserved every retained step and protocol message; no admitted external calls")

			refusal := h.run(bundle, filepath.Join(project, "reject.yaml"), "policy-refusal", agent)
			var domainInput object
			var diagnostic string
			switch name {
			case "rust-order":
				assertFields(t, refusal, object{"within_budget": false, "total_minor": 5658})
				domainInput = object{"order_id": "overflow", "items": []object{
					{"sku": "gear", "quantity": 3, "unit_minor": 1250}, {"sku": "seal", "quantity": 2, "unit_minor": 475}},
					"discount_bps": 500, "tax_bps": 2000, "shipping_minor": 300, "budget_minor": 6000}
				domainInput["shipping_minor"] = json.Number("18446744073709551615")
				diagnostic = "total exceeds u64"
			case "cpp-telemetry":
				assertFields(t, refusal, object{"acceptable": false, "breaches": 2})
				domainInput = object{"sensor": "pump-7", "samples": []int{410, 420, 425, 470, 480, 415},
					"min_allowed": 400, "max_allowed": 450, "max_breaches": 1}
				domainInput["max_breaches"] = 2
				allowed := filepath.Join(h.scratch, "allowed.json")
				writeObject(t, allowed, domainInput)
				assertFields(t, h.run(bundle, allowed, "boundary-accepted", agent), object{"acceptable": true, "breaches": 2})
				domainInput["samples"] = []any{}
				diagnostic = "samples must contain 1..1024 integers"
			}
			domainPath := filepath.Join(h.scratch, "domain-invalid.json")
			writeObject(t, domainPath, domainInput)
			h.failure(diagnostic, h.runArgs(bundle, domainPath, "domain-invalid", agent)...)

			// A non-object is rejected by the public command before it can run
			// application code. Domain invalidity is checked separately below.
			invalid := filepath.Join(h.scratch, "invalid.json")
			writeObject(t, invalid, []any{1, 2})
			h.failure("application input must be an object", h.runArgs(bundle, invalid, "invalid-shape", agent)...)
		})
	}
}

// Scenario inputs are programme-generated values. Human-authored YAML fixtures
// are exercised directly by the baseline runs and documented commands.
func releaseProposal() object {
	return object{"release": "catalog-2026.10", "replicas": 1, "demand": 250,
		"per_replica": 100, "max_replicas": 5, "critical_vulnerabilities": 0,
		"observed_requests": 10000, "failed_requests": 20, "max_failure_basis_points": 25}
}

func TestGoReleasePoliciesAndReplay(t *testing.T) {
	h := newHarness(t)
	project := h.project("go-release")
	bundle := h.build(project)
	assertFields(t, h.run(bundle, filepath.Join(project, "input.yaml"), "authored-input", "planner"),
		object{"ready": true, "replicas": 3, "attempts": 3, "stop_reason": "ready"})
	for _, scenario := range []struct {
		name, field, stop  string
		value              any
		ready              bool
		replicas, attempts int
	}{
		{name: "capacity-replan", stop: "ready", ready: true, replicas: 3, attempts: 3},
		{name: "security-refusal", field: "critical_vulnerabilities", value: 1, stop: "security_rejected", replicas: 1, attempts: 1},
		{name: "reliability-refusal", field: "failed_requests", value: 26, stop: "reliability_rejected", replicas: 1, attempts: 1},
		{name: "replica-limit", field: "max_replicas", value: 2, stop: "replica_limit", replicas: 2, attempts: 2},
		{name: "attempt-limit", field: "demand", value: 450, stop: "attempt_limit", replicas: 3, attempts: 3},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := releaseProposal()
			if scenario.field != "" {
				input[scenario.field] = scenario.value
			}
			file := filepath.Join(h.scratch, scenario.name+".json")
			writeObject(t, file, input)
			out := h.run(bundle, file, scenario.name, "planner")
			assertFields(t, out, object{"ready": scenario.ready, "replicas": scenario.replicas, "attempts": scenario.attempts, "stop_reason": scenario.stop})
			assertEqual(t, len(entries(t, out, "history")), scenario.attempts)
			before := h.inspect(scenario.name)
			assertEqual(t, h.run(bundle, file, scenario.name, "planner"), out)
			assertEqual(t, h.inspect(scenario.name), before)
			assertEqual(t, len(entries(t, child(t, before, "protocol"), "calls")), 0)

			// Reusing an execution identity with altered business input must not
			// return the old answer or silently start another execution.
			input["release"] = "different-release"
			writeObject(t, file, input)
			h.failure("different", h.runArgs(bundle, file, scenario.name, "planner")...)
		})
	}
	invalid := releaseProposal()
	invalid["observed_requests"] = 0
	file := filepath.Join(h.scratch, "invalid-measurements.json")
	writeObject(t, file, invalid)
	h.failure("observations > 0", h.runArgs(bundle, file, "invalid-measurements", "planner")...)
	missing := releaseProposal()
	delete(missing, "critical_vulnerabilities")
	file = filepath.Join(h.scratch, "missing-evidence.json")
	writeObject(t, file, missing)
	h.failure("proposal requires field", h.runArgs(bundle, file, "missing-evidence", "planner")...)
}

// Only application sources/configuration are copied. Generated bundles refer to
// absolute binaries and therefore must be rebuilt in the temporary project.
func copyProject(t *testing.T, source, destination string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == ".mas" || entry.Name() == ".mas-host" || entry.Name() == "target") {
			return filepath.SkipDir
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected symlink in example: %s", path)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return os.WriteFile(target, raw, info.Mode().Perm())
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTopologyDeniesUndeclaredRoute(t *testing.T) {
	h := newHarness(t)
	project := filepath.Join(h.scratch, "python-review")
	copyProject(t, h.project("python-review"), project)
	path := filepath.Join(project, "topology.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	topology := strings.ReplaceAll(string(raw), "  - [reviewer, capacity]\n", "")
	topology = strings.ReplaceAll(topology, "  - [capacity, reviewer]\n", "")
	if topology == string(raw) {
		t.Fatal("fixture has no reviewer -> capacity route to remove")
	}
	if err := os.WriteFile(path, []byte(topology), 0600); err != nil {
		t.Fatal(err)
	}
	bundle := h.build(project)
	h.failure("route forbidden", h.runArgs(bundle, filepath.Join(project, "input.yaml"), "denied", "reviewer")...)
	snapshot := h.inspect("denied")
	for _, step := range entries(t, snapshot, "steps") {
		if step["target"] == "capacity" && step["state"] == "completed" {
			t.Fatal("forbidden capacity worker completed")
		}
	}
	assertEqual(t, len(entries(t, child(t, snapshot, "protocol"), "calls")), 0)
}
