package http

import (
	"crypto/ed25519"
	"encoding/base64"
	"io"
	stdhttp "net/http"
	"net/http/httptest"
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
			signature, _ := base64.StdEncoding.DecodeString(r.Header.Get("x-signature"))
			message := r.Header.Get("x-timestamp") + ":" + string(body)
			if r.Method != stdhttp.MethodPost || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("x-server-id") != "server-1" || !ed25519.Verify(keyPair.PublicKey, []byte(message), signature) {
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
