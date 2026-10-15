package review

import (
	"encoding/json"
	"testing"
)

func TestRequiredReportFieldsCannotDefaultToZero(t *testing.T) {
	for _, raw := range []string{
		`{"projected_minor":200000,"within_limit":false}`,
		`{"projected_minor":200000,"remaining_minor":null,"within_limit":false}`,
		`{"projected_minor":200000,"remaining_minor":0,"within_limit":false,"extra":1}`,
	} {
		if _, err := decodeReport[Exposure](json.RawMessage(raw), "projected_minor", "remaining_minor", "within_limit"); err == nil {
			t.Fatalf("accepted incomplete or unexpected evidence: %s", raw)
		}
	}
}

func TestMissingAndNullInputsCannotBecomeZeroBalances(t *testing.T) {
	raw, err := json.Marshal(proposal())
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"current_commitment_minor", "credit_limit_minor", "invoices"} {
		original := fields[field]
		delete(fields, field)
		missing, _ := json.Marshal(fields)
		var decoded Proposal
		if err := json.Unmarshal(missing, &decoded); err == nil {
			t.Fatalf("accepted missing %s", field)
		}
		fields[field] = json.RawMessage(`null`)
		null, _ := json.Marshal(fields)
		if err := json.Unmarshal(null, &decoded); err == nil {
			t.Fatalf("accepted null %s", field)
		}
		fields[field] = original
	}
	for _, bad := range []string{`{"amount_minor":0}`, `{"days_overdue":0}`, `{"amount_minor":null,"days_overdue":0}`} {
		var invoice Invoice
		if err := json.Unmarshal([]byte(bad), &invoice); err == nil {
			t.Fatalf("accepted incomplete invoice %s", bad)
		}
	}
	var explicit Invoice
	if err := json.Unmarshal([]byte(`{"amount_minor":0,"days_overdue":0}`), &explicit); err != nil {
		t.Fatal(err)
	}
}

func proposal() Proposal {
	return Proposal{RequestID: "purchase-42", CurrentCommitmentMinor: 120000, PurchaseMinor: 80000,
		CreditLimitMinor: 250000, Invoices: []Invoice{{10000, 0}, {5000, 7}}, MaxOverdueDays: 14, MaxOverdueMinor: 10000}
}

func TestAcceptAndDetectCorruptedReports(t *testing.T) {
	p := proposal()
	exposure := Exposure{200000, 50000, true}
	arrears := Arrears{5000, 7, true}
	decision, err := Accept(p, exposure, arrears)
	if err != nil || !decision.Approved {
		t.Fatalf("approved input: %+v, %v", decision, err)
	}
	exposure.ProjectedMinor++
	if _, err := Accept(p, exposure, arrears); err == nil {
		t.Fatal("accepted a corrupt exposure report")
	}
	exposure.ProjectedMinor--
	arrears.WithinPolicy = false
	if _, err := Accept(p, exposure, arrears); err == nil {
		t.Fatal("accepted a corrupt policy result")
	}
}

func TestExactBoundariesAndDomainRefusal(t *testing.T) {
	p := proposal()
	p.CreditLimitMinor, p.MaxOverdueDays, p.MaxOverdueMinor = 200000, 7, 5000
	decision, err := Accept(p, Exposure{200000, 0, true}, Arrears{5000, 7, true})
	if err != nil || !decision.Approved {
		t.Fatalf("exact inclusive limits: %+v %v", decision, err)
	}
	p.CreditLimitMinor, p.MaxOverdueDays = 199999, 6
	decision, err = Accept(p, Exposure{200000, 0, false}, Arrears{5000, 7, false})
	if err != nil || decision.Approved {
		t.Fatalf("domain refusal: %+v %v", decision, err)
	}
}

func TestZeroBalanceIsNotAnOverdueDebt(t *testing.T) {
	p := proposal()
	p.Invoices = []Invoice{{0, 36500}, {100, 0}}
	if _, err := Accept(p, Exposure{200000, 50000, true}, Arrears{0, 0, true}); err != nil {
		t.Fatal(err)
	}
}

func TestRejectOutOfRangeAmounts(t *testing.T) {
	p := proposal()
	p.CurrentCommitmentMinor = 1_000_000_000_001
	if _, err := Accept(p, Exposure{}, Arrears{}); err == nil {
		t.Fatal("accepted out-of-range input")
	}
	p = proposal()
	p.Invoices[0].DaysOverdue = -1
	if _, err := Accept(p, Exposure{}, Arrears{}); err == nil {
		t.Fatal("accepted negative days")
	}
}
