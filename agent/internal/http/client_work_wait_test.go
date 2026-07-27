package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"techulus/cloud-agent/internal/crypto"
)

func TestWaitForWork(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/api/v1/agent/work/wait" {
			t.Errorf("path = %s", r.URL.Path)
		}
		for _, header := range []string{"x-server-id", "x-timestamp", "x-signature"} {
			if r.Header.Get(header) == "" {
				t.Errorf("missing %s header", header)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workAvailable":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "server-1", keyPair, t.TempDir())
	available, err := client.WaitForWork(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !available {
		t.Fatal("work should be available")
	}
}

func TestWaitForWorkUnsupportedEndpoint(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{name: "method not allowed", status: http.StatusMethodNotAllowed},
		{name: "missing route", status: http.StatusNotFound, body: "not found"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, closeServer := workWaitTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			})
			defer closeServer()

			_, err := client.WaitForWork(context.Background())
			if !errors.Is(err, ErrWorkWaitUnsupported) {
				t.Fatalf("error = %v, want ErrWorkWaitUnsupported", err)
			}
		})
	}
}

func TestWaitForWorkRetriesRegisteredServerNotFound(t *testing.T) {
	client, closeServer := workWaitTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"Server not found or not registered"}`))
	})
	defer closeServer()

	_, err := client.WaitForWork(context.Background())
	if err == nil || errors.Is(err, ErrWorkWaitUnsupported) {
		t.Fatalf("error = %v, want retryable status error", err)
	}
}

func workWaitTestClient(t *testing.T, handler http.HandlerFunc) (*Client, func()) {
	t.Helper()
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	return NewClient(server.URL, "server-1", keyPair, t.TempDir()), server.Close
}
