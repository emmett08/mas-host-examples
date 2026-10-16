package acceptance

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// The fixture replaces only the remote Responses endpoint. Both model turns
// pass through the maintained OpenAI adapter; policy runs in the actual CLI.
func delegationEndpoint(t *testing.T, requests chan<- object) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body object
		decoder := json.NewDecoder(io.LimitReader(r.Body, 65536))
		decoder.UseNumber()
		if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" ||
			r.Header.Get("Authorization") != "Bearer offline-fixture" || decoder.Decode(&body) != nil {
			t.Error("invalid request to offline Responses endpoint")
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		input, ok := body["input"].(string)
		var supplied struct {
			Task    object   `json:"task"`
			History []object `json:"history"`
		}
		decoder = json.NewDecoder(strings.NewReader(input))
		decoder.UseNumber()
		if !ok || decoder.Decode(&supplied) != nil || supplied.Task == nil || len(supplied.History) > 1 {
			t.Error("invalid delegated inference input")
			http.Error(w, "invalid input", http.StatusBadRequest)
			return
		}
		select {
		case requests <- body:
		default:
			t.Error("unexpected additional inference")
			http.Error(w, "unexpected inference", http.StatusBadRequest)
			return
		}
		var decision object
		if len(supplied.History) == 0 {
			input, err := json.Marshal(object{"service": supplied.Task["service"], "critical_findings": supplied.Task["critical_findings"]})
			if err != nil {
				t.Error(err)
				http.Error(w, "invalid task", http.StatusBadRequest)
				return
			}
			decision = object{"kind": "request", "target": "policy_check", "input_json": string(input)}
		} else {
			// Echo the result received through MAS: do not compute policy here.
			decision = object{"kind": "complete", "output": supplied.History[0]["result"]}
		}
		output, err := json.Marshal(object{"decision": decision})
		if err != nil {
			t.Error(err)
			http.Error(w, "invalid decision", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(object{
			"id": "offline-response", "status": "completed",
			"output": []object{{"type": "message", "content": []object{{"type": "output_text", "text": string(output)}}}},
		}); err != nil {
			t.Error(err)
		}
	}))
}

func TestCommandAgentDelegationAndReplay(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		findings int
		approved bool
	}{{"approved", 0, true}, {"refused", 1, false}} {
		t.Run(scenario.name, func(t *testing.T) {
			h := newHarness(t)
			requests := make(chan object, 4)
			server := delegationEndpoint(t, requests)
			defer server.Close()
			const credential = "MAS_EXAMPLES_OFFLINE_REVIEW_KEY"
			t.Setenv(credential, "offline-fixture")
			profile := filepath.Join(h.scratch, "connections.json")
			writeObject(t, profile, object{"version": "mas-connections/1", "connections": object{
				"reviewer_provider": object{"kind": "openai", "endpoint": server.URL + "/v1/responses", "api_key_env": credential},
			}})
			result := h.success("build", "--project", h.project("command-policy"), "--sdk-root", h.sdk, "--connections", profile)
			bundle := result["bundle"].(string)
			input := filepath.Join(h.scratch, "input.json")
			writeObject(t, input, object{"service": "billing with spaces; $(echo literal)", "critical_findings": scenario.findings})
			first := h.run(bundle, input, scenario.name, "reviewer")
			assertFields(t, first, object{"service": "billing with spaces; $(echo literal)", "approved": scenario.approved,
				"critical_findings": scenario.findings, "maximum_critical": 0})
			before := h.inspect(scenario.name)
			assertRequests(t, before, [][2]string{{"client", "reviewer"}, {"reviewer", "policy_check"}})
			calls := entries(t, child(t, before, "protocol"), "calls")
			assertEqual(t, len(calls), 3)
			for _, call := range calls {
				assertEqual(t, call["state"], "recorded")
			}
			assertEqual(t, len(requests), 2)
			initial, followup := <-requests, <-requests
			for _, request := range []object{initial, followup} {
				assertFields(t, request, object{"model": "gpt-5.4-2026-03-05", "max_output_tokens": 1024, "store": false})
				instructions := request["instructions"].(string)
				if !strings.Contains(instructions, "check_policy/1") || !strings.Contains(instructions, "critical_findings") {
					t.Fatal("model did not receive the CLI operation contract")
				}
			}
			assertEqual(t, len(entries(t, decode(t, []byte(initial["input"].(string))), "history")), 0)
			history := entries(t, decode(t, []byte(followup["input"].(string))), "history")
			assertEqual(t, len(history), 1)
			assertEqual(t, history[0]["result"], first)
			assertEqual(t, h.run(bundle, input, scenario.name, "reviewer"), first)
			assertEqual(t, h.inspect(scenario.name), before)
			assertEqual(t, len(requests), 0)
		})
	}
}
