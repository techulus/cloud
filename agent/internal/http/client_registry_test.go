package http

import (
	"context"
	stdhttp "net/http"
	"net/http/httptest"
	"testing"

	"techulus/cloud-agent/internal/crypto"
)

func TestGetRegistryBundle(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		if r.Method != stdhttp.MethodGet || r.URL.Path != "/api/v1/agent/registries" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		for _, header := range []string{"x-server-id", "x-timestamp", "x-signature"} {
			if r.Header.Get(header) == "" {
				t.Errorf("missing %s header", header)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"v1","registries":[]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "server-1", keyPair, t.TempDir())
	bundle, err := client.GetRegistryBundle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Version != "v1" || len(bundle.Registries) != 0 {
		t.Fatalf("unexpected bundle: %+v", bundle)
	}
}

func TestGetRegistryBundleDoesNotIncludeErrorBody(t *testing.T) {
	keyPair, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		w.WriteHeader(stdhttp.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"encryptedPassword":"must-not-be-returned"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "server-1", keyPair, t.TempDir())
	_, err = client.GetRegistryBundle(context.Background())
	if err == nil || err.Error() != "fetch registry bundle returned status 503" {
		t.Fatalf("unexpected error: %v", err)
	}
}
