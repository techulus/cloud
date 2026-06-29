package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestJSONSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "secret" {
			t.Fatalf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret")
	client.HTTPClient = server.Client()

	var got struct {
		OK bool `json:"ok"`
	}
	if err := client.RequestJSON(context.Background(), http.MethodGet, "/test", nil, nil, &got); err != nil {
		t.Fatalf("RequestJSON() error = %v", err)
	}
	if !got.OK {
		t.Fatal("ok = false")
	}
}

func TestRequestJSONAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"Bad manifest"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "")
	client.HTTPClient = server.Client()
	err := client.RequestJSON(context.Background(), http.MethodPost, "/test", nil, nil, nil)
	if err == nil || err.Error() != "Bad manifest" {
		t.Fatalf("error = %v", err)
	}
}

func TestRequestJSONUnauthorizedGuidance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"message":"Unauthorized","code":"UNAUTHORIZED"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "")
	client.HTTPClient = server.Client()
	err := client.RequestJSON(context.Background(), http.MethodGet, "/test", nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "tc auth login --host "+server.URL) {
		t.Fatalf("error = %v", err)
	}
}

func TestRequestJSONInvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not-json`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "")
	client.HTTPClient = server.Client()
	var got map[string]any
	err := client.RequestJSON(context.Background(), http.MethodGet, "/test", nil, nil, &got)
	if err == nil || !strings.Contains(err.Error(), "invalid JSON response") {
		t.Fatalf("error = %v", err)
	}
}
