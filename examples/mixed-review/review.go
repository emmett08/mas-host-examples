// Package review demonstrates a Go decision over independent Rust and C++ reports.
package review

import (
	"bytes"
	"encoding/json"
	"fmt"

	mas "github.com/emmett08/mas-host/sdk/go"
)

type Invoice struct {
	AmountMinor int64 `json:"amount_minor"`
	DaysOverdue int64 `json:"days_overdue"`
}

type Proposal struct {
	RequestID              string    `json:"request_id"`
	CurrentCommitmentMinor int64     `json:"current_commitment_minor"`
	PurchaseMinor          int64     `json:"purchase_minor"`
	CreditLimitMinor       int64     `json:"credit_limit_minor"`
	Invoices               []Invoice `json:"invoices"`
	MaxOverdueDays         int64     `json:"max_overdue_days"`
	MaxOverdueMinor        int64     `json:"max_overdue_minor"`
}

func (invoice *Invoice) UnmarshalJSON(raw []byte) error {
	type Fields Invoice
	value, err := decodeReport[Fields](raw, "amount_minor", "days_overdue")
	if err == nil {
		*invoice = Invoice(value)
	}
	return err
}

func (proposal *Proposal) UnmarshalJSON(raw []byte) error {
	type Fields Proposal
	value, err := decodeReport[Fields](raw, "request_id", "current_commitment_minor", "purchase_minor",
		"credit_limit_minor", "invoices", "max_overdue_days", "max_overdue_minor")
	if err == nil {
		*proposal = Proposal(value)
	}
	return err
}

type Exposure struct {
	ProjectedMinor int64 `json:"projected_minor"`
	RemainingMinor int64 `json:"remaining_minor"`
	WithinLimit    bool  `json:"within_limit"`
}

type Arrears struct {
	OverdueMinor int64 `json:"overdue_minor"`
	OldestDays   int64 `json:"oldest_days"`
	WithinPolicy bool  `json:"within_policy"`
}

type Decision struct {
	RequestID string   `json:"request_id"`
	Approved  bool     `json:"approved"`
	Exposure  Exposure `json:"exposure"`
	Arrears   Arrears  `json:"arrears"`
}

// Review runs independent arithmetic policies in parallel through durable child
// requests. Both native reports must agree with the Go acceptance computation.
func Review(ctx *mas.Context, input Proposal) (Decision, error) {
	if err := validate(input); err != nil {
		return Decision{}, err
	}
	results, err := ctx.Parallel([]mas.RequestSpec{
		{Key: "exposure_check", Target: "exposure", Input: input},
		{Key: "arrears_check", Target: "arrears", Input: input},
	})
	if err != nil {
		return Decision{}, err
	}
	exposure, err := decodeReport[Exposure](results[0], "projected_minor", "remaining_minor", "within_limit")
	if err != nil {
		return Decision{}, err
	}
	arrears, err := decodeReport[Arrears](results[1], "overdue_minor", "oldest_days", "within_policy")
	if err != nil {
		return Decision{}, err
	}
	return Accept(input, exposure, arrears)
}

// Required evidence must be present, even when its valid value is zero/false.
func decodeReport[T any](raw json.RawMessage, fields ...string) (T, error) {
	var empty T
	report, err := mas.Decode[map[string]json.RawMessage](raw)
	if err != nil {
		return empty, err
	}
	if len(report) != len(fields) {
		return empty, fmt.Errorf("report fields do not match the required evidence")
	}
	for _, field := range fields {
		value, exists := report[field]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return empty, fmt.Errorf("report is missing %s evidence", field)
		}
	}
	return mas.Decode[T](raw)
}

// Accept checks the reports without calling either worker's implementation.
// It is ordinary application code and can be tested without a host process.
func Accept(input Proposal, exposure Exposure, arrears Arrears) (Decision, error) {
	if err := validate(input); err != nil {
		return Decision{}, err
	}
	projected := input.CurrentCommitmentMinor + input.PurchaseMinor
	remaining := input.CreditLimitMinor - projected
	if remaining < 0 {
		remaining = 0
	}
	var overdue, oldest int64
	for _, invoice := range input.Invoices {
		if invoice.DaysOverdue > 0 && invoice.AmountMinor > 0 {
			overdue += invoice.AmountMinor
			if invoice.DaysOverdue > oldest {
				oldest = invoice.DaysOverdue
			}
		}
	}
	expectedExposure := Exposure{projected, remaining, projected <= input.CreditLimitMinor}
	expectedArrears := Arrears{overdue, oldest, overdue <= input.MaxOverdueMinor && oldest <= input.MaxOverdueDays}
	if exposure != expectedExposure || arrears != expectedArrears {
		return Decision{}, fmt.Errorf("native reports disagree with independent acceptance calculation")
	}
	return Decision{input.RequestID, exposure.WithinLimit && arrears.WithinPolicy, exposure, arrears}, nil
}

func validate(input Proposal) error {
	if len(input.RequestID) == 0 || len(input.RequestID) > 64 || len(input.Invoices) == 0 || len(input.Invoices) > 64 {
		return fmt.Errorf("request_id must contain 1..64 bytes and invoices must contain 1..64 records")
	}
	for _, value := range []int64{input.CurrentCommitmentMinor, input.PurchaseMinor, input.CreditLimitMinor, input.MaxOverdueMinor} {
		if value < 0 || value > 1_000_000_000_000 {
			return fmt.Errorf("monetary inputs must lie in 0..1000000000000 minor units")
		}
	}
	if input.PurchaseMinor == 0 || input.MaxOverdueDays < 0 || input.MaxOverdueDays > 36500 {
		return fmt.Errorf("purchase_minor must be positive and max_overdue_days must lie in 0..36500")
	}
	for _, invoice := range input.Invoices {
		if invoice.AmountMinor < 0 || invoice.AmountMinor > 1_000_000_000_000 || invoice.DaysOverdue < 0 || invoice.DaysOverdue > 36500 {
			return fmt.Errorf("invoice amount or days_overdue is outside its declared bound")
		}
	}
	return nil
}
