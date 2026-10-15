package release

import (
	"fmt"
	"math/big"

	mas "github.com/emmett08/mas-host/sdk/go"
)

// Check reconstructs the complete expected history from the original proposal.
// It uses arbitrary-precision products independently of the assessment formulas
// and checks stopping policy independently of the coordinator. This detects
// implementation disagreement; all workers still trust the supplied evidence.
func Check(_ *mas.Context, in CheckInput) (Decision, error) {
	p, d := in.Proposal, in.Decision
	if err := validate(p); err != nil {
		return Decision{}, err
	}
	if d.Release != p.Release || d.Attempts < 1 || d.Attempts > 3 || int64(len(d.History)) != d.Attempts {
		return Decision{}, fmt.Errorf("checker: invalid release identity or attempt history")
	}
	for i, round := range d.History {
		replicas := p.Replicas + int64(i)
		if replicas > p.MaxReplicas || round.Replicas != replicas {
			return Decision{}, fmt.Errorf("checker: invalid replica progression at attempt %d", i+1)
		}
		capacity := new(big.Int).Mul(big.NewInt(replicas), big.NewInt(p.PerReplica)).Cmp(big.NewInt(p.Demand)) >= 0
		security := p.CriticalVulnerabilities == 0
		failures := new(big.Int).Mul(big.NewInt(p.FailedRequests), big.NewInt(10000))
		threshold := new(big.Int).Mul(big.NewInt(p.ObservedRequests), big.NewInt(p.MaxFailureBasisPoints))
		reliability := failures.Cmp(threshold) <= 0
		capacityReason, securityReason, reliabilityReason := "insufficient_capacity", "critical_vulnerabilities", "failure_rate_exceeded"
		if capacity {
			capacityReason = "capacity_sufficient"
		}
		if security {
			securityReason = "no_declared_critical_vulnerabilities"
		}
		if reliability {
			reliabilityReason = "failure_rate_within_limit"
		}
		if round.Capacity != (Assessment{capacity, capacityReason}) || round.Security != (Assessment{security, securityReason}) || round.Reliability != (Assessment{reliability, reliabilityReason}) {
			return Decision{}, fmt.Errorf("checker: reports contradict supplied evidence at attempt %d", i+1)
		}
		ready := capacity && security && reliability
		stop := ""
		if ready {
			stop = "ready"
		} else if !security {
			stop = "security_rejected"
		} else if !reliability {
			stop = "reliability_rejected"
		} else if replicas == p.MaxReplicas {
			stop = "replica_limit"
		} else if i == 2 {
			stop = "attempt_limit"
		}
		last := i == len(d.History)-1
		if !last && stop != "" {
			return Decision{}, fmt.Errorf("checker: history continues past stopping condition")
		}
		if last && (stop == "" || d.StopReason != stop || d.Ready != ready || d.Replicas != replicas) {
			return Decision{}, fmt.Errorf("checker: final decision or stopping condition is incorrect")
		}
	}
	return d, nil
}
