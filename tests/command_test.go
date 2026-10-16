package acceptance

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestCommandArgumentsPolicyAndReplay(t *testing.T) {
	h := newHarness(t)
	project := h.project("command-policy")
	bundle := h.build(project)
	input := filepath.Join(h.scratch, "command.json")
	writeObject(t, input, object{"service": "billing with spaces; $(echo literal)", "critical_findings": 0})
	first := h.run(bundle, input, "command", "policy_check")
	assertFields(t, first, object{"service": "billing with spaces; $(echo literal)", "approved": true, "critical_findings": 0, "maximum_critical": 0})
	before := h.inspect("command")
	assertEqual(t, len(entries(t, child(t, before, "protocol"), "calls")), 1)
	assertEqual(t, h.run(bundle, input, "command", "policy_check"), first)
	assertEqual(t, h.inspect("command"), before)
	writeObject(t, input, object{"service": "billing", "critical_findings": 1})
	assertFields(t, h.run(bundle, input, "refused", "policy_check"), object{"approved": false})
}

func TestCommandReceiptRecovery(t *testing.T) {
	h := newHarness(t)
	project := h.project("command-policy")
	bundle := h.build(project)
	receipt := filepath.Join(h.scratch, "command-receipt.json")
	input := filepath.Join(h.scratch, "crash.json")
	writeObject(t, input, object{"service": "billing", "critical_findings": 0, "receipt_path": receipt, "crash_after_receipt": true})
	args := h.runArgs(bundle, input, "command-recovery", "policy_check")
	h.failure("uncertain", args...)
	original, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatal(err)
	}
	observed := decode(t, original)
	before := h.inspect("command-recovery")
	var effect object
	for _, step := range entries(t, before, "steps") {
		if step["kind"] == "effect" {
			effect = step
		}
	}
	if effect == nil {
		t.Fatal("missing admitted command effect")
	}
	assertEqual(t, observed["invocation_id"], effect["id"])
	assertFields(t, child(t, observed, "output"), object{"service": "billing", "approved": true, "critical_findings": 0, "maximum_critical": 0})
	h.failure("uncertain", args...)
	confirmed := filepath.Join(h.scratch, "confirmed-command.json")
	evidence := filepath.Join(h.scratch, "command-evidence.json")
	writeObject(t, confirmed, object{"status": "completed", "output": observed["output"]})
	writeObject(t, evidence, object{"receipt_path": receipt, "invocation_id": effect["id"]})
	h.success("resolve", "--state", h.state, "--run", "command-recovery", "--effect", effect["id"].(string), "--output", confirmed, "--evidence", evidence)
	assertEqual(t, h.run(bundle, input, "command-recovery", "policy_check"), observed["output"])
	after, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, after) {
		t.Fatal("reconciliation changed the published receipt")
	}
	calls := entries(t, child(t, h.inspect("command-recovery"), "protocol"), "calls")
	assertEqual(t, len(calls), 1)
	assertEqual(t, calls[0]["state"], "recorded")
}

func TestCommandExecutableIsFrozen(t *testing.T) {
	h := newHarness(t)
	project := filepath.Join(h.scratch, "command-policy")
	copyProject(t, h.project("command-policy"), project)
	original := h.build(project)
	input := filepath.Join(project, "input.yaml")
	first := h.run(original, input, "original-tool", "policy_check")
	source := filepath.Join(project, "tools", "policy-check")
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	old := []byte("critical_findings <= maximum_critical")
	if bytes.Count(raw, old) != 1 {
		t.Fatal("expected one policy comparison")
	}
	if err := os.WriteFile(source, bytes.ReplaceAll(raw, old, []byte("critical_findings < maximum_critical")), 0755); err != nil {
		t.Fatal(err)
	}
	changed := h.build(project)
	if changed == original {
		t.Fatal("changed executable must change bundle identity")
	}
	h.failure("identity differs", h.runArgs(changed, input, "original-tool", "policy_check")...)
	assertEqual(t, h.run(original, input, "retained-tool", "policy_check"), first)
	assertFields(t, h.run(changed, input, "changed-tool", "policy_check"), object{"approved": false})
}
