package agent

import (
	"testing"

	agenthttp "techulus/cloud-agent/internal/http"
)

func TestProcessCommandRequiresOwnershipIdentifiers(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{"service ID", `{"commandRunId":"run","deploymentId":"deployment","containerId":"container","command":"true"}`},
		{"deployment ID", `{"commandRunId":"run","serviceId":"service","containerId":"container","command":"true"}`},
		{"container ID", `{"commandRunId":"run","serviceId":"service","deploymentId":"deployment","command":"true"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := (&Agent{}).ProcessCommand(agenthttp.WorkQueueItem{ID: "run", Payload: tt.payload})
			if err == nil || err.Error() != "invalid command payload" {
				t.Fatalf("expected invalid payload for missing %s, got %v", tt.name, err)
			}
		})
	}
}
