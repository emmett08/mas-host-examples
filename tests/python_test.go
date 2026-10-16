package acceptance

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestPythonDataclassesAndFourLanguageRouting(t *testing.T) {
	h := newHarness(t)
	project := h.project("python-review")
	bundle := h.build(project)
	out := h.run(bundle, filepath.Join(project, "input.yaml"), "python", "reviewer")
	assertFields(t, out, object{"release": "service-42", "approved": true, "available_capacity": 300, "critical_findings": 0})
	assertRequests(t, h.inspect("python"), [][2]string{{"reviewer", "capacity"}, {"reviewer", "security"}, {"reviewer", "acceptance"}})

	for _, scenario := range []struct {
		name, field string
		value       any
	}{
		{"capacity-refused", "required_capacity", 301},
		{"security-refused", "critical_findings", 1},
	} {
		input := object{"release": "service-42", "required_capacity": 240, "replicas": 3, "capacity_per_replica": 100, "critical_findings": 0}
		input[scenario.field] = scenario.value
		path := filepath.Join(h.scratch, scenario.name+".json")
		writeObject(t, path, input)
		assertFields(t, h.run(bundle, path, scenario.name, "reviewer"), object{"approved": false})
	}
	invalid := filepath.Join(h.scratch, "invalid-python.json")
	writeObject(t, invalid, object{"release": "service-42", "required_capacity": true, "replicas": 3, "capacity_per_replica": 100, "critical_findings": 0})
	h.failure("expected int", h.runArgs(bundle, invalid, "invalid-python", "reviewer")...)

	mixed := h.project("mixed-review")
	mixedBundle := h.build(mixed)
	out = h.run(mixedBundle, filepath.Join(mixed, "input.json"), "four-languages", "python_reviewer")
	assertFields(t, out, object{"request_id": "purchase-42", "approved": true})
	assertRequests(t, h.inspect("four-languages"), [][2]string{{"python_reviewer", "reviewer"}, {"reviewer", "exposure"}, {"reviewer", "arrears"}})
}

func TestPythonTypedClientAndRecovery(t *testing.T) {
	h := newHarness(t)
	project := h.project("python-review")
	receipt := filepath.Join(h.scratch, "python-receipt.json")
	invoke := func(nativeConfig bool) object {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "python3", filepath.Join(project, "call.py"),
			"--host", h.host, "--sdk-root", h.sdk, "--state", h.state, "--run", "python-client", "--receipt", receipt)
		if nativeConfig {
			cmd.Args = append(cmd.Args, "--native-config")
		}
		cmd.Dir = h.root
		cmd.Env = append(os.Environ(), "PYTHONPATH="+filepath.Join(h.sdk, "sdk", "python"), "PYTHONDONTWRITEBYTECODE=1")
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			t.Fatalf("typed Python client failed: %v\n%s\n%s", err, stdout.String(), stderr.String())
		}
		return decode(t, stdout.Bytes())
	}
	out := invoke(false)
	assertFields(t, out, object{"approved": true, "available_capacity": 300})
	before := h.inspect("python-client")
	calls := entries(t, child(t, before, "protocol"), "calls")
	assertEqual(t, len(calls), 1)
	assertEqual(t, calls[0]["state"], "recorded")
	raw, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatal(err)
	}
	stored := decode(t, raw)
	assertEqual(t, stored["output"], out)
	assertEqual(t, stored["invocation_id"], calls[0]["id"])
	assertEqual(t, invoke(true), out)
	assertEqual(t, h.inspect("python-client"), before)
	replayed, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatal(err)
	}
	assertEqual(t, replayed, raw)
	// The second invocation explicitly exports equivalent Python configuration
	// instead of reading TOML/YAML, while preserving the same run identity.
	// Receipt creation uses exclusive mode. Re-executing the recorded effect
	// would raise FileExistsError, so successful replay proves result reuse.
}

func TestPythonSourceChangeRequiresNewRun(t *testing.T) {
	h := newHarness(t)
	project := filepath.Join(h.scratch, "python-review")
	copyProject(t, h.project("python-review"), project)
	bundle := h.build(project)
	input := filepath.Join(project, "input.yaml")
	original := h.run(bundle, input, "frozen-python", "reviewer")
	source := filepath.Join(project, "review.py")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	before := []byte("available = proposal.replicas * proposal.capacity_per_replica")
	after := []byte("available = 1 + proposal.replicas * proposal.capacity_per_replica")
	if bytes.Count(raw, before) != 2 {
		t.Fatal("expected capacity and independent acceptance calculations")
	}
	if err := os.WriteFile(source, bytes.ReplaceAll(raw, before, after), 0600); err != nil {
		t.Fatal(err)
	}
	changed := h.build(project)
	if changed == bundle {
		t.Fatal("Python source edit did not change the bundle identity")
	}
	h.failure("identity differs", h.runArgs(changed, input, "frozen-python", "reviewer")...)
	assertEqual(t, h.run(bundle, input, "frozen-python", "reviewer"), original)
	// The old bundle must also execute its archived source for a fresh run.
	assertEqual(t, h.run(bundle, input, "original-source", "reviewer"), original)
	assertFields(t, h.run(changed, input, "changed-source", "reviewer"), object{"approved": true, "available_capacity": 301})
}
