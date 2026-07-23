package api

import (
	"context"
	"errors"
	"io"
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
		w.Write([]byte(`{"error":"Bad manifest","code":"BAD_MANIFEST"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "")
	client.HTTPClient = server.Client()
	err := client.RequestJSON(context.Background(), http.MethodPost, "/test", nil, nil, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusBadRequest || apiErr.Message != "Bad manifest" || apiErr.Code != "BAD_MANIFEST" || apiErr.Host != server.URL {
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

func TestJSONSharedRequestMechanics(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if r.Method != http.MethodPost || r.Header.Get("content-type") != "application/json" || r.Header.Get("x-test") != "present" || string(body) != `{"hello":"world"}` {
			t.Fatalf("request = %s content-type=%q x-test=%q body=%s", r.Method, r.Header.Get("content-type"), r.Header.Get("x-test"), body)
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var got struct {
		OK bool `json:"ok"`
	}
	if err := JSON(context.Background(), nil, http.MethodPost, server.URL, map[string]string{"x-test": "present"}, map[string]string{"hello": "world"}, &got); err != nil || !got.OK {
		t.Fatalf("JSON() result = %#v, error = %v", got, err)
	}
}

func TestJSONStatusDecodesNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"authorization_pending","error_description":"waiting"}`))
	}))
	defer server.Close()

	var got struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	status, err := JSONStatus(context.Background(), server.Client(), http.MethodPost, server.URL, nil, &got)
	if err != nil || status != http.StatusBadRequest || got.Error != "authorization_pending" || got.ErrorDescription != "waiting" {
		t.Fatalf("status = %d, response = %#v, error = %v", status, got, err)
	}
}

func TestJSONStatusPreservesStatusOnReadError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-length", "100")
		w.WriteHeader(http.StatusTeapot)
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	status, err := JSONStatus(context.Background(), server.Client(), http.MethodGet, server.URL, nil, nil)
	if status != http.StatusTeapot || !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("status = %d, error = %v", status, err)
	}
}
