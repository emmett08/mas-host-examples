package release

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	mas "github.com/emmett08/mas-host/sdk/go"
)

func proposal() Proposal {
	return Proposal{Release: "catalog-2026.10", Replicas: 1, Demand: 250, PerReplica: 100, MaxReplicas: 5,
		ObservedRequests: 10000, FailedRequests: 20, MaxFailureBasisPoints: 25}
}

// The expected attempt count and final policy outcome come from test cases.
func decisionFor(t *testing.T, p Proposal, attempts int64, ready bool, stop string) Decision {
	t.Helper()
	d := Decision{Release: p.Release, Attempts: attempts, Ready: ready, StopReason: stop, Replicas: p.Replicas + attempts - 1}
	for i := int64(0); i < attempts; i++ {
		candidate := p
		candidate.Replicas += i
		capacity, err := AssessCapacity(nil, candidate)
		if err != nil {
			t.Fatal(err)
		}
		security, err := AssessSecurity(nil, candidate)
		if err != nil {
			t.Fatal(err)
		}
		reliability, err := AssessReliability(nil, candidate)
		if err != nil {
			t.Fatal(err)
		}
		d.History = append(d.History, Round{candidate.Replicas, capacity, security, reliability})
	}
	return d
}

func TestPolicyAndIndependentChecker(t *testing.T) {
	for _, tc := range []struct {
		name     string
		change   func(*Proposal)
		attempts int64
		ready    bool
		stop     string
	}{
		{"scale_twice", func(*Proposal) {}, 3, true, "ready"},
		{"immediately_ready", func(p *Proposal) { p.Replicas = 3 }, 1, true, "ready"},
		{"security_stops_scaling", func(p *Proposal) { p.CriticalVulnerabilities = 1 }, 1, false, "security_rejected"},
		{"reliability_stops_scaling", func(p *Proposal) { p.FailedRequests = 26 }, 1, false, "reliability_rejected"},
		{"replica_limit", func(p *Proposal) { p.MaxReplicas = 2 }, 2, false, "replica_limit"},
		{"attempt_limit", func(p *Proposal) { p.Demand = 450 }, 3, false, "attempt_limit"},
		{"empty_demand", func(p *Proposal) { p.Demand = 0 }, 1, true, "ready"},
		{"integer_extreme", func(p *Proposal) {
			p.Replicas, p.Demand, p.PerReplica = 3, math.MaxInt64, math.MaxInt64/2
			p.ObservedRequests, p.FailedRequests, p.MaxFailureBasisPoints = math.MaxInt64, math.MaxInt64, 10000
		}, 1, true, "ready"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := proposal()
			tc.change(&p)
			d := decisionFor(t, p, tc.attempts, tc.ready, tc.stop)
			got, err := Check(nil, CheckInput{p, d})
			if err != nil || !reflect.DeepEqual(got, d) {
				t.Fatalf("checker = %+v, %v", got, err)
			}
		})
	}
}

func TestReliabilityThresholdIsExact(t *testing.T) {
	for _, tc := range []struct {
		observed, failed, threshold int64
		ready                       bool
	}{
		{10000, 25, 25, true}, {10000, 26, 25, false},
		{3, 1, 3333, false}, {3, 1, 3334, true},
		{math.MaxInt64, math.MaxInt64 - 1, 9999, false},
		{math.MaxInt64, math.MaxInt64, 10000, true},
		{math.MaxInt64, 0, 0, true}, {math.MaxInt64, 1, 0, false},
	} {
		p := proposal()
		p.ObservedRequests, p.FailedRequests, p.MaxFailureBasisPoints = tc.observed, tc.failed, tc.threshold
		got, err := AssessReliability(nil, p)
		if err != nil || got.Ready != tc.ready {
			t.Fatalf("%+v => %+v, %v", tc, got, err)
		}
	}
}

func TestCheckerRejectsForgedHistory(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*Decision)
	}{
		{"acceptance", func(d *Decision) { d.Ready = false }},
		{"release", func(d *Decision) { d.Release = "different" }},
		{"attempt_count", func(d *Decision) { d.Attempts = 2 }},
		{"replica_count", func(d *Decision) { d.Replicas = 4 }},
		{"history_progression", func(d *Decision) { d.History[1].Replicas = 3 }},
		{"earlier_capacity", func(d *Decision) { d.History[0].Capacity.Ready = true }},
		{"evidence_reason", func(d *Decision) { d.History[0].Security.Reason = "fabricated" }},
		{"stopping_condition", func(d *Decision) { d.StopReason = "attempt_limit" }},
		{"premature_stop", func(d *Decision) {
			d.History = d.History[:1]
			d.Attempts, d.Replicas, d.Ready, d.StopReason = 1, 1, false, "attempt_limit"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := proposal()
			d := decisionFor(t, p, 3, true, "ready")
			tc.mutate(&d)
			if _, err := Check(nil, CheckInput{p, d}); err == nil {
				t.Fatal("checker accepted forged history")
			}
		})
	}
	p := proposal()
	p.Demand = 100
	d := decisionFor(t, p, 2, true, "ready")
	if _, err := Check(nil, CheckInput{p, d}); err == nil {
		t.Fatal("checker allowed another round after acceptance")
	}
}

func TestInvalidInput(t *testing.T) {
	for _, change := range []func(*Proposal){
		func(p *Proposal) { p.Release = "  " },
		func(p *Proposal) { p.Replicas = 0 },
		func(p *Proposal) { p.MaxReplicas = 0 },
		func(p *Proposal) { p.MaxReplicas = 1000001 },
		func(p *Proposal) { p.Demand = -1 },
		func(p *Proposal) { p.PerReplica = 0 },
		func(p *Proposal) { p.CriticalVulnerabilities = -1 },
		func(p *Proposal) { p.ObservedRequests = 0 },
		func(p *Proposal) { p.FailedRequests = -1 },
		func(p *Proposal) { p.FailedRequests = 10001 },
		func(p *Proposal) { p.MaxFailureBasisPoints = -1 },
		func(p *Proposal) { p.MaxFailureBasisPoints = 10001 },
		func(p *Proposal) { p.ReceiptPath = "relative.json" },
		func(p *Proposal) { p.ReceiptPath = "/tmp/a/../receipt.json" },
		func(p *Proposal) { p.CrashAfterReceipt = true },
	} {
		p := proposal()
		change(&p)
		if _, err := Qualify(nil, p); err == nil {
			t.Fatalf("accepted invalid proposal: %+v", p)
		}
	}
}

func TestMissingNullAndUnknownEvidenceRejected(t *testing.T) {
	p := proposal()
	// Genuine measured zero counts and zero demand remain valid inputs.
	p.CriticalVulnerabilities, p.FailedRequests, p.Demand = 0, 0, 0
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := mas.Decode[Proposal](raw); err != nil || decoded != p {
		t.Fatalf("explicit zero evidence did not round-trip: %+v, %v", decoded, err)
	}
	var original map[string]json.RawMessage
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	for field := range original {
		for _, kind := range []string{"missing", "null"} {
			t.Run(field+"_"+kind, func(t *testing.T) {
				fields := make(map[string]json.RawMessage)
				for name, value := range original {
					fields[name] = value
				}
				delete(fields, field)
				if kind == "null" {
					fields[field] = json.RawMessage("null")
				}
				bad, err := json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := mas.Decode[Proposal](bad); err == nil {
					t.Fatal("accepted absent or null required evidence")
				}
			})
		}
	}
	original["failed_request"] = json.RawMessage("0")
	bad, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mas.Decode[Proposal](bad); err == nil {
		t.Fatal("accepted misspelt unknown input field")
	}
}

func TestReceiptBindsEffectAndCannotBeOverwritten(t *testing.T) {
	p := proposal()
	d := decisionFor(t, p, 3, true, "ready")
	path := filepath.Join(t.TempDir(), "receipt.json")
	if err := writeReceipt(path, "", d); err == nil {
		t.Fatal("accepted empty invocation identity")
	}
	if err := writeReceipt(path, "admitted-effect-1", d); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt Receipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Version != "release-receipt/1" || receipt.InvocationID != "admitted-effect-1" || !reflect.DeepEqual(receipt.Output, d) {
		t.Fatalf("incorrect receipt: %+v", receipt)
	}
	if err := writeReceipt(path, "another-effect", d); !os.IsExist(err) {
		t.Fatalf("replacement should fail with existence error, got %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(raw) {
		t.Fatal("second publication changed receipt")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("receipt permissions = %v, %v", info, err)
	}
}
