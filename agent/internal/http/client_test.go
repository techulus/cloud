package http

import (
	"encoding/json"
	"io"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"techulus/cloud-agent/internal/crypto"
)

func TestSignedJSONRequests(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/api/v1/agent/status" {
			message := "agent-request:v2\x00" + r.Header.Get("x-timestamp") + "\x00" + r.Method + "\x00" + r.URL.RequestURI() + "\x00" + string(body)
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

func TestCompletedWorkItemCommandResultJSON(t *testing.T) {
	exitCode := 0
	encoded, err := json.Marshal(CompletedWorkItem{
		ID:      "command-1",
		Attempt: 1,
		Status:  "completed",
		Result: CommandWorkItemResult{
			Type:     "command",
			Output:   "hello\n",
			ExitCode: &exitCode,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	const expected = `{"id":"command-1","attempt":1,"status":"completed","result":{"type":"command","output":"hello\n","exitCode":0}}`
	if string(encoded) != expected {
		t.Fatalf("unexpected completion JSON: %s", encoded)
	}
}

func TestUpdateBuildStatusImageURI(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	digestURI := "registry.example/repository@sha256:" + strings.Repeat("a", 64)
	server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["status"] != "completed" || payload["imageUri"] != digestURI {
			t.Errorf("unexpected payload: %#v", payload)
		}
		w.WriteHeader(stdhttp.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "server-1", keyPair, "")
	if err := client.UpdateBuildStatus("build-1", "completed", "", "commit-sha", digestURI); err != nil {
		t.Fatal(err)
	}
}
