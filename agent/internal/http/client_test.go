package http

import (
	"encoding/json"
	"io"
	stdhttp "net/http"
	"net/http/httptest"
	"testing"

	"techulus/cloud-agent/internal/crypto"
)

func TestRoutingProtocolJSONFixtures(t *testing.T) {
	fixture := []byte(`{"generation":42,"routingSync":[{"rolloutId":"rollout-1","requiredGeneration":41}],"containers":[],"dns":{"records":[]},"serverless":{"routes":[]},"traefik":{"httpRoutes":[],"tcpRoutes":[],"udpRoutes":[]},"wireguard":{"peers":[]}}`)
	var state ExpectedState
	if err := json.Unmarshal(fixture, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.RoutingSync) != 1 || state.RoutingSync[0].RequiredGeneration != 41 {
		t.Fatalf("unexpected routing sync decode: %+v", state.RoutingSync)
	}
	report, err := json.Marshal(StatusReport{RoutingAcknowledgements: []RoutingAcknowledgement{{RolloutID: "rollout-1", Generation: 42}}})
	if err != nil {
		t.Fatal(err)
	}
	var shape map[string]json.RawMessage
	if err := json.Unmarshal(report, &shape); err != nil {
		t.Fatal(err)
	}
	if string(shape["routingAcknowledgements"]) != `[{"rolloutId":"rollout-1","generation":42}]` {
		t.Fatalf("unexpected status fixture: %s", report)
	}
	if _, old := shape["routingSyncedRollouts"]; old {
		t.Fatalf("legacy routing field emitted: %s", report)
	}
}

func TestSignedJSONRequests(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/api/v1/agent/status" {
			message := r.Header.Get("x-timestamp") + ":" + string(body)
			if r.Method != stdhttp.MethodPost || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("x-server-id") != "server-1" || r.Header.Get("x-signature") != keyPair.Sign([]byte(message)) {
				t.Error("request method, headers, or signature not preserved")
			}
			w.WriteHeader(stdhttp.StatusAccepted)
			io.WriteString(w, "{\"ok\":true}")
			return
		}
		w.WriteHeader(stdhttp.StatusTeapot)
		io.WriteString(w, "backup rejected")
	}))
	defer server.Close()
	client := NewClient(server.URL, "server-1", keyPair, "")
	response, err := client.ReportStatus(&StatusReport{}, nil, nil, nil)
	if err != nil || !response.OK {
		t.Fatalf("accepted response was not decoded: response=%+v err=%v", response, err)
	}
	if err := client.ReportBackupFailed("backup-1", "failed"); err == nil || err.Error() != "backup failed report failed with status 418: backup rejected" {
		t.Fatalf("unexpected error response: %v", err)
	}
}
