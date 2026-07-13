package http

import "testing"

func TestValidateExpectedStateRejectsPartialRevisionContract(t *testing.T) {
	tests := []struct {
		name  string
		state ExpectedState
	}{
		{name: "old schema", state: ExpectedState{}},
		{
			name: "missing revision",
			state: ExpectedState{
				SchemaVersion: 1,
				Containers: []ExpectedContainer{
					{DeploymentID: "deployment", ContainerSpecHash: "hash"},
				},
			},
		},
		{
			name: "missing container hash",
			state: ExpectedState{
				SchemaVersion: 1,
				Containers: []ExpectedContainer{
					{DeploymentID: "deployment", RevisionID: "revision"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateExpectedState(&tt.state); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateExpectedStateAcceptsCompleteRevisionContract(t *testing.T) {
	state := ExpectedState{
		SchemaVersion: 1,
		Containers: []ExpectedContainer{
			{
				DeploymentID:      "deployment",
				RevisionID:        "revision",
				ContainerSpecHash: "hash",
			},
		},
	}
	if err := validateExpectedState(&state); err != nil {
		t.Fatalf("validateExpectedState() error = %v", err)
	}
}
