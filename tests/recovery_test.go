package acceptance

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// verifyReceipt is an application-specific administrative check. The host
// requires evidence but cannot independently establish that a file is truthful.
func verifyReceipt(receipt object, effectID string, checkedDecision object) error {
	if receipt["version"] != "release-receipt/1" {
		return fmt.Errorf("unsupported receipt version")
	}
	if receipt["invocation_id"] != effectID {
		return fmt.Errorf("receipt does not identify the admitted effect")
	}
	if !reflect.DeepEqual(receipt["output"], checkedDecision) {
		return fmt.Errorf("receipt output differs from the independently checked decision")
	}
	return nil
}

func TestCrashRecovery(t *testing.T) {
	h := newHarness(t)
	project := h.project("go-release")
	bundle := h.build(project)
	input := readObject(t, filepath.Join(project, "input.json"))
	receiptPath := filepath.Join(h.scratch, "receipt.json")
	input["receipt_path"] = receiptPath
	input["crash_after_receipt"] = true
	inputPath := filepath.Join(h.scratch, "crash-input.json")
	writeObject(t, inputPath, input)
	args := h.runArgs(bundle, inputPath, "recovery", "planner")
	_, _, err := h.command(args...)
	if err == nil {
		t.Fatal("worker should exit after durable publication, before reporting completion")
	}
	receiptBytes, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatalf("worker failed before publishing the durable receipt: %v", err)
	}
	receiptInfo, err := os.Stat(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	uncertain := h.inspect("recovery")
	protocol := child(t, uncertain, "protocol")
	calls := entries(t, protocol, "calls")
	assertEqual(t, len(calls), 1)
	completed := make(map[string]object)
	var effect object
	var checkedDecision object
	var checkedParent string
	for _, step := range entries(t, uncertain, "steps") {
		if step["kind"] == "request" && step["state"] == "completed" {
			completed[step["id"].(string)] = step
			if step["key"] == "independent_acceptance" {
				checkedDecision = child(t, step, "output")
				checkedParent = step["parent"].(string)
			}
		}
		if step["kind"] == "effect" {
			if effect != nil {
				t.Fatal("expected exactly one receipt effect")
			}
			effect = step
		}
	}
	assertEqual(t, len(completed), 10) // Three checks per round, then independent acceptance.
	if effect == nil || checkedDecision == nil {
		t.Fatal("missing admitted effect or independent acceptance checkpoint")
	}
	assertEqual(t, effect["state"], "unknown")
	assertFields(t, effect, object{"actor": "planner", "key": "publish_receipt", "parent": checkedParent})
	effectID := effect["id"].(string)
	assertFields(t, calls[0], object{"id": effectID, "actor": "planner", "state": "reserved"})
	assertFields(t, checkedDecision, object{"ready": true, "replicas": 3, "attempts": 3, "stop_reason": "ready"})
	receipt := decode(t, receiptBytes)
	if err := verifyReceipt(receipt, effectID, checkedDecision); err != nil {
		t.Fatal(err)
	}
	// Demonstrate that reconciliation would reject a mismatched identity or
	// output; the existence of a JSON file alone is not sufficient evidence.
	wrongIdentity := decode(t, receiptBytes)
	wrongIdentity["invocation_id"] = "unrelated-effect"
	if verifyReceipt(wrongIdentity, effectID, checkedDecision) == nil {
		t.Fatal("receipt verifier accepted an unrelated effect")
	}
	wrongOutput := decode(t, receiptBytes)
	child(t, wrongOutput, "output")["ready"] = false
	if verifyReceipt(wrongOutput, effectID, checkedDecision) == nil {
		t.Fatal("receipt verifier accepted a changed decision")
	}

	// The original input still contains crash_after_receipt=true. A blind retry
	// must stop before restarting the worker or changing protocol state.
	h.failure("uncertain", args...)
	assertEqual(t, h.inspect("recovery"), uncertain)
	unchanged, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	assertEqual(t, unchanged, receiptBytes)

	outputPath := filepath.Join(h.scratch, "confirmed-output.json")
	evidencePath := filepath.Join(h.scratch, "reconciliation-evidence.json")
	writeObject(t, outputPath, checkedDecision)
	writeObject(t, evidencePath, object{})
	resolveArgs := []string{"resolve", "--state", h.state, "--run", "recovery", "--effect", effectID, "--output", outputPath, "--evidence", evidencePath}
	h.failure("non-empty", resolveArgs...)
	assertEqual(t, h.inspect("recovery"), uncertain)
	digest := fmt.Sprintf("%x", sha256.Sum256(receiptBytes))
	evidence := object{
		"receipt_path": receiptPath, "receipt_sha256": digest,
		"invocation_id": effectID, "verification": "receipt identity and output matched independent_acceptance checkpoint",
	}
	writeObject(t, evidencePath, evidence)
	h.success(resolveArgs...)
	// Resume the exact original bundle/input/run, without clearing the crash
	// switch or changing the binary. The completed effect must be reused.
	assertEqual(t, h.run(bundle, inputPath, "recovery", "planner"), checkedDecision)
	recovered := h.inspect("recovery")
	recoveredProtocol := child(t, recovered, "protocol")
	recoveredCalls := entries(t, recoveredProtocol, "calls")
	assertEqual(t, len(recoveredCalls), 1)
	assertEqual(t, recoveredCalls[0]["state"], "recorded")
	callEvidence := child(t, recoveredCalls[0], "evidence")
	assertEqual(t, callEvidence["output"], checkedDecision)
	assertEqual(t, callEvidence["evidence"], evidence)
	assertEqual(t, callEvidence["resolution"], true)
	for _, step := range entries(t, recovered, "steps") {
		if previous, ok := completed[step["id"].(string)]; ok {
			assertEqual(t, step, previous)
			delete(completed, step["id"].(string))
		}
	}
	assertEqual(t, len(completed), 0)
	// Only the root completion message is added: completed child requests are
	// reused and cannot generate another set of request/result messages.
	assertEqual(t, len(entries(t, recoveredProtocol, "messages")), len(entries(t, protocol, "messages"))+1)
	assertEqual(t, recoveredProtocol["deadline"], protocol["deadline"])
	finalBytes, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	finalInfo, err := os.Stat(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	assertEqual(t, finalBytes, receiptBytes)
	if !os.SameFile(receiptInfo, finalInfo) || !receiptInfo.ModTime().Equal(finalInfo.ModTime()) {
		t.Fatal("receipt was replaced or rewritten during recovery")
	}
	assertEqual(t, h.run(bundle, inputPath, "recovery", "planner"), checkedDecision)
	assertEqual(t, h.inspect("recovery"), recovered)
	t.Logf("recovered with 10 unchanged completed child steps, one admitted call and one unchanged receipt (SHA-256 %s)", digest)
}
