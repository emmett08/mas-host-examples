package release

import (
	"os"
	"strconv"

	mas "github.com/emmett08/mas-host/sdk/go"
)

// Qualify joins three independent assessments per attempt. Only a capacity
// shortfall can trigger replanning: increase one replica, at most twice.
// The code outside Effect is deterministic so unfinished orchestration can replay.
func Qualify(ctx *mas.Context, original Proposal) (Decision, error) {
	if err := validate(original); err != nil {
		return Decision{}, err
	}
	p := original
	d := Decision{Release: p.Release}
	for attempt := int64(1); attempt <= maxAttempts; attempt++ {
		prefix := "attempt_" + strconv.FormatInt(attempt, 10)
		results, err := ctx.Parallel([]mas.RequestSpec{
			{Key: prefix + "_capacity", Target: "capacity", Input: p},
			{Key: prefix + "_security", Target: "security", Input: p},
			{Key: prefix + "_reliability", Target: "reliability", Input: p},
		})
		if err != nil {
			return Decision{}, err
		}
		round := Round{Replicas: p.Replicas}
		for i, destination := range []*Assessment{&round.Capacity, &round.Security, &round.Reliability} {
			*destination, err = mas.Decode[Assessment](results[i])
			if err != nil {
				return Decision{}, err
			}
		}
		d.History = append(d.History, round)
		d.Replicas, d.Attempts = p.Replicas, attempt
		d.Ready = round.Capacity.Ready && round.Security.Ready && round.Reliability.Ready
		switch {
		case d.Ready:
			d.StopReason = "ready"
		case !round.Security.Ready:
			d.StopReason = "security_rejected"
		case !round.Reliability.Ready:
			d.StopReason = "reliability_rejected"
		case p.Replicas == p.MaxReplicas:
			d.StopReason = "replica_limit"
		case attempt == maxAttempts:
			d.StopReason = "attempt_limit"
		}
		if d.StopReason != "" {
			break
		}
		p.Replicas++
	}
	checked, err := ctx.Request("independent_acceptance", "checker", CheckInput{Proposal: original, Decision: d})
	if err != nil {
		return Decision{}, err
	}
	d, err = mas.Decode[Decision](checked)
	if err != nil || original.ReceiptPath == "" {
		return d, err
	}
	// The receipt is an audit effect, including for rejected releases. It does
	// not deploy the proposal. Existing files are never replaced or retried.
	recorded, err := ctx.Effect("publish_receipt", map[string]any{
		"operation": "publish_release_receipt", "path": original.ReceiptPath, "decision": d,
	}, func(invocationID string) (mas.EffectResult, error) {
		if err := writeReceipt(original.ReceiptPath, invocationID, d); err != nil {
			return mas.EffectResult{}, err
		}
		if original.CrashAfterReceipt {
			// Intentional abrupt termination exercises a genuinely uncertain
			// admitted effect. The host has not received effect_complete.
			os.Exit(70)
		}
		return mas.EffectResult{Output: d, Evidence: map[string]any{
			"receipt_path": original.ReceiptPath, "invocation_id": invocationID,
		}}, nil
	})
	if err != nil {
		return Decision{}, err
	}
	return mas.Decode[Decision](recorded)
}
