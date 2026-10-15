// Package release qualifies a release from declared capacity, vulnerability and
// reliability evidence. It makes a policy decision, not a production deployment.
package release

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	mas "github.com/emmett08/mas-host/sdk/go"
)

const maxAttempts int64 = 3

// Reliability uses integer basis points: 25 means a maximum failure rate of
// 0.25%. Measurements and vulnerabilities are supplied evidence, not live probes.
type Proposal struct {
	Release                 string `json:"release"`
	Replicas                int64  `json:"replicas"`
	Demand                  int64  `json:"demand"`
	PerReplica              int64  `json:"per_replica"`
	MaxReplicas             int64  `json:"max_replicas"`
	CriticalVulnerabilities int64  `json:"critical_vulnerabilities"`
	ObservedRequests        int64  `json:"observed_requests"`
	FailedRequests          int64  `json:"failed_requests"`
	MaxFailureBasisPoints   int64  `json:"max_failure_basis_points"`
	ReceiptPath             string `json:"receipt_path,omitempty"`
	CrashAfterReceipt       bool   `json:"crash_after_receipt,omitempty"`
}

// UnmarshalJSON distinguishes supplied zero evidence from missing evidence.
// In particular, omitted vulnerability/failure counts cannot imply a clean run.
func (p *Proposal) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	for _, name := range []string{
		"release", "replicas", "demand", "per_replica", "max_replicas",
		"critical_vulnerabilities", "observed_requests", "failed_requests", "max_failure_basis_points",
	} {
		if _, exists := fields[name]; !exists {
			return fmt.Errorf("proposal requires field %q", name)
		}
	}
	for name, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("proposal field %q cannot be null", name)
		}
	}
	// Use a distinct type to decode without invoking this method recursively.
	type decodedProposal Proposal
	var decoded decodedProposal
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*p = Proposal(decoded)
	return nil
}

type Assessment struct {
	Ready  bool   `json:"ready"`
	Reason string `json:"reason"`
}

type Round struct {
	Replicas    int64      `json:"replicas"`
	Capacity    Assessment `json:"capacity"`
	Security    Assessment `json:"security"`
	Reliability Assessment `json:"reliability"`
}

type Decision struct {
	Release    string  `json:"release"`
	Ready      bool    `json:"ready"`
	Replicas   int64   `json:"replicas"`
	Attempts   int64   `json:"attempts"`
	StopReason string  `json:"stop_reason"`
	History    []Round `json:"history"`
}

type CheckInput struct {
	Proposal Proposal `json:"proposal"`
	Decision Decision `json:"decision"`
}

func validate(p Proposal) error {
	if strings.TrimSpace(p.Release) == "" || len(p.Release) > 128 {
		return fmt.Errorf("release must contain 1..128 bytes and a non-space character")
	}
	if p.Replicas < 1 || p.MaxReplicas < p.Replicas || p.MaxReplicas > 1000000 || p.PerReplica < 1 || p.Demand < 0 {
		return fmt.Errorf("positive capacity, nonnegative demand and 1 <= replicas <= max_replicas <= 1000000 are required")
	}
	if p.CriticalVulnerabilities < 0 || p.ObservedRequests < 1 || p.FailedRequests < 0 || p.FailedRequests > p.ObservedRequests || p.MaxFailureBasisPoints < 0 || p.MaxFailureBasisPoints > 10000 {
		return fmt.Errorf("nonnegative vulnerabilities, 0 <= failed_requests <= observed_requests with observations > 0, and failure threshold in 0..10000 are required")
	}
	if p.ReceiptPath != "" && (!filepath.IsAbs(p.ReceiptPath) || filepath.Clean(p.ReceiptPath) != p.ReceiptPath) {
		return fmt.Errorf("receipt_path must be a clean absolute path")
	}
	if p.CrashAfterReceipt && p.ReceiptPath == "" {
		return fmt.Errorf("crash_after_receipt requires receipt_path")
	}
	return nil
}

func AssessCapacity(_ *mas.Context, p Proposal) (Assessment, error) {
	if err := validate(p); err != nil {
		return Assessment{}, err
	}
	// Ceiling division avoids overflow in replicas * per_replica.
	required := p.Demand / p.PerReplica
	if p.Demand%p.PerReplica != 0 {
		required++
	}
	if p.Replicas < required {
		return Assessment{false, "insufficient_capacity"}, nil
	}
	return Assessment{true, "capacity_sufficient"}, nil
}

func AssessSecurity(_ *mas.Context, p Proposal) (Assessment, error) {
	if err := validate(p); err != nil {
		return Assessment{}, err
	}
	if p.CriticalVulnerabilities > 0 {
		return Assessment{false, "critical_vulnerabilities"}, nil
	}
	return Assessment{true, "no_declared_critical_vulnerabilities"}, nil
}

func AssessReliability(_ *mas.Context, p Proposal) (Assessment, error) {
	if err := validate(p); err != nil {
		return Assessment{}, err
	}
	// floor(observations * threshold / 10000), without overflowing int64.
	allowed := (p.ObservedRequests/10000)*p.MaxFailureBasisPoints + (p.ObservedRequests%10000)*p.MaxFailureBasisPoints/10000
	if p.FailedRequests > allowed {
		return Assessment{false, "failure_rate_exceeded"}, nil
	}
	return Assessment{true, "failure_rate_within_limit"}, nil
}
