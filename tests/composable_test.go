package acceptance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func assertRequests(t *testing.T, snapshot object, routes [][2]string) {
	t.Helper()
	found := make(map[[2]string]bool)
	for _, step := range entries(t, snapshot, "steps") {
		if step["kind"] == "request" && step["state"] == "completed" {
			from, fromOK := step["actor"].(string)
			to, toOK := step["target"].(string)
			if fromOK && toOK {
				found[[2]string{from, to}] = true
			}
		}
	}
	for _, route := range routes {
		if !found[route] {
			t.Fatalf("no completed MAS request from %s to %s", route[0], route[1])
		}
	}
	protocol := child(t, snapshot, "protocol")
	for _, message := range entries(t, protocol, "messages") {
		assertFields(t, message, object{"received": true, "acked": true})
	}
}

func TestComposableTopologiesAndReplay(t *testing.T) {
	h := newHarness(t)
	project := h.project("composable-agents")
	bundle := h.build(project)
	input := filepath.Join(project, "input.yaml")
	for _, scenario := range []struct {
		name, shape string
		calls       int
		routes      [][2]string
	}{
		{"star", "star", 3, [][2]string{{"star", "security"}, {"star", "delivery"}, {"star", "operations"}}},
		{"tree", "tree", 3, [][2]string{{"tree", "technical"}, {"tree", "governance"}, {"technical", "security"}, {"technical", "operations"}, {"governance", "delivery"}}},
		{"mesh_a", "", 3, [][2]string{{"mesh_a", "mesh_b"}, {"mesh_a", "mesh_c"}, {"mesh_a", "security"}, {"mesh_b", "delivery"}, {"mesh_c", "operations"}}},
		{"mesh_b", "", 3, [][2]string{{"mesh_b", "mesh_a"}, {"mesh_b", "mesh_c"}, {"mesh_a", "security"}, {"mesh_b", "delivery"}, {"mesh_c", "operations"}}},
		{"mesh_c", "", 3, [][2]string{{"mesh_c", "mesh_a"}, {"mesh_c", "mesh_b"}, {"mesh_a", "security"}, {"mesh_b", "delivery"}, {"mesh_c", "operations"}}},
		{"composed", "composed", 10, [][2]string{{"composed", "star"}, {"composed", "tree"}, {"composed", "mesh_a"}, {"composed", "decision"}, {"technical", "security"}, {"mesh_a", "mesh_b"}}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			sub := *h
			sub.t = t
			h := &sub
			out := h.run(bundle, input, scenario.name, scenario.name)
			if scenario.shape != "" {
				assertEqual(t, out["topology"], scenario.shape)
			} else {
				// The local result and two peer results are retained together.
				results := entries(t, out, "results")
				assertEqual(t, len(results), 3)
				localReview := child(t, results[0], "review")
				for _, peer := range results[1:] {
					// A model result was carried in the admitted peer's task input,
					// then returned alongside that peer's independent model result.
					assertEqual(t, child(t, child(t, peer, "received"), "upstream_review"), localReview)
				}
			}
			if scenario.name == "composed" {
				assertFields(t, child(t, out, "decision"), object{"approved": true})
			}
			before := h.inspect(scenario.name)
			assertRequests(t, before, scenario.routes)
			calls := entries(t, child(t, before, "protocol"), "calls")
			assertEqual(t, len(calls), scenario.calls)
			for _, call := range calls {
				assertEqual(t, call["state"], "recorded")
			}
			assertEqual(t, h.run(bundle, input, scenario.name, scenario.name), out)
			assertEqual(t, h.inspect(scenario.name), before)
			t.Log("replay retained all MAS messages and model effects without additional calls")
		})
	}
}

func TestComposableMeshHonoursRouteAdmission(t *testing.T) {
	h := newHarness(t)
	project := filepath.Join(h.scratch, "composable-agents")
	copyProject(t, h.project("composable-agents"), project)
	path := filepath.Join(project, "topology.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	topology := strings.ReplaceAll(string(raw), "  - [mesh_a, mesh_b]\n", "")
	topology = strings.ReplaceAll(topology, "  - [mesh_b, mesh_a]\n", "")
	if topology == string(raw) {
		t.Fatal("expected mesh route in YAML topology")
	}
	if err := os.WriteFile(path, []byte(topology), 0600); err != nil {
		t.Fatal(err)
	}
	bundle := h.build(project)
	h.failure("route forbidden", h.runArgs(bundle, filepath.Join(project, "input.yaml"), "mesh-denied", "mesh_a")...)
	for _, step := range entries(t, h.inspect("mesh-denied"), "steps") {
		if step["actor"] == "mesh_a" && step["target"] == "mesh_b" && step["state"] == "completed" {
			t.Fatal("removed mesh route completed an invocation")
		}
	}
}

func TestExplicitProviderConfigurations(t *testing.T) {
	h := newHarness(t)
	project := h.project("composable-agents")
	for _, variant := range []string{"openai", "cursor", "compatible", "mixed"} {
		result := h.success("build", "--project", project, "--sdk-root", h.sdk,
			"--connections", "connections."+variant+".toml")
		bundle := readObject(t, result["bundle"].(string))
		modelActors := 0
		for _, actor := range entries(t, bundle, "agents") {
			binding := child(t, actor, "configuration")
			if binding["kind"] != "llm" {
				continue
			}
			modelActors++
			connection := child(t, binding, "connection")
			if connection["kind"] == "mock" {
				t.Fatalf("live %s actor %s silently selects mock", variant, actor["name"])
			}
			credential, ok := connection["api_key_env"].(string)
			if !ok || credential == "" {
				t.Fatalf("live %s actor %s has no explicit credential binding", variant, actor["name"])
			}
		}
		assertEqual(t, modelActors, 4)
	}

	// Exercise the maintained OpenAI adapter with an explicitly missing secret.
	// No live request or fallback fixture should be attempted.
	projectCopy := filepath.Join(h.scratch, "live-config")
	copyProject(t, project, projectCopy)
	baseBundle := readObject(t, h.build(projectCopy))
	raw, err := os.ReadFile(filepath.Join(projectCopy, "connections.openai.toml"))
	if err != nil {
		t.Fatal(err)
	}
	credential := "MAS_EXAMPLES_MISSING_OPENAI_KEY"
	t.Setenv(credential, "")
	config := strings.ReplaceAll(string(raw), "OPENAI_API_KEY", credential)
	if err := os.WriteFile(filepath.Join(projectCopy, "missing-connections.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	result := h.success("build", "--project", projectCopy, "--sdk-root", h.sdk, "--connections", "missing-connections.toml")
	bundle := result["bundle"].(string)
	liveBundle := readObject(t, bundle)
	baseActors := entries(t, baseBundle, "agents")
	liveActors := entries(t, liveBundle, "agents")
	assertEqual(t, len(liveActors), len(baseActors))
	for i, actor := range liveActors {
		base := baseActors[i]
		assertFields(t, actor, object{"name": base["name"], "operation": base["operation"]})
		binding := child(t, actor, "configuration")
		baseBinding := child(t, base, "configuration")
		if binding["kind"] == "llm" {
			assertEqual(t, binding["model"], "<openai-model-id>")
			assertEqual(t, child(t, binding, "connection")["kind"], "openai")
			for _, field := range []string{"instructions", "output_schema", "max_output_tokens", "delegates"} {
				assertEqual(t, binding[field], baseBinding[field])
			}
		} else {
			assertEqual(t, binding, baseBinding)
		}
	}
	_, stderr, err := h.command(h.runArgs(bundle, filepath.Join(projectCopy, "input.yaml"), "missing-credential", "star")...)
	if err == nil {
		t.Fatal("live configuration with missing credentials returned fixture output")
	}
	diagnostic := decode(t, stderr)
	if diagnostic["status"] != "error" || !strings.Contains(strings.ToLower(diagnostic["error"].(string)), "not_sent") {
		t.Fatalf("expected known non-dispatch after missing credential, got %s", stderr)
	}
}
