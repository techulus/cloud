package agent

import (
	"testing"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func TestReconcileActionKey(t *testing.T) {
	tests := []struct {
		name   string
		first  reconcileAction
		second reconcileAction
		equal  bool
	}{
		{
			name:   "same deployment action",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			equal:  true,
		},
		{
			name:   "different deployment",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_2"},
		},
		{
			name:   "different action",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionRedeployContainer, DeploymentID: "dep_1"},
		},
		{
			name: "orphan container id",
			first: reconcileAction{
				Kind:   actionRemoveOrphanNoDeploymentID,
				Actual: &container.Container{ID: "ctr_1"},
			},
			second: reconcileAction{
				Kind:   actionRemoveOrphanNoDeploymentID,
				Actual: &container.Container{ID: "ctr_1"},
			},
			equal: true,
		},
		{
			name: "expected container name fallback",
			first: reconcileAction{
				Kind:     actionDeployMissingContainer,
				Expected: &agenthttp.ExpectedContainer{Name: "service-1"},
			},
			second: reconcileAction{
				Kind:     actionDeployMissingContainer,
				Expected: &agenthttp.ExpectedContainer{Name: "service-1"},
			},
			equal: true,
		},
		{
			name:   "singleton action",
			first:  reconcileAction{Kind: actionUpdateDNS},
			second: reconcileAction{Kind: actionUpdateDNS},
			equal:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reconcileActionKey(tt.first) == reconcileActionKey(tt.second); got != tt.equal {
				t.Fatalf("key equality = %t, want %t", got, tt.equal)
			}
		})
	}
}
