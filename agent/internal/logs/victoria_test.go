package logs

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVictoriaSendMethodsPostJSONLines(t *testing.T) {
	tests := []struct {
		name string
		send func(*VictoriaLogsSender) error
	}{
		{
			name: "container",
			send: func(v *VictoriaLogsSender) error {
				return v.SendLogs(&LogBatch{Logs: []LogEntry{{Message: "container ready"}}})
			},
		},
		{
			name: "HTTP",
			send: func(v *VictoriaLogsSender) error {
				return v.SendHTTPLogs([]HTTPLogEntry{{Method: "GET", Path: "/health", Status: 200}})
			},
		},
		{
			name: "build",
			send: func(v *VictoriaLogsSender) error {
				return v.SendBuildLogs("build-1", "service-1", "project-1", []string{"build ready"})
			},
		},
		{
			name: "agent",
			send: func(v *VictoriaLogsSender) error {
				return v.SendAgentLogs([]AgentLog{{Message: "agent ready"}})
			},
		},
	}

	for _, status := range []int{http.StatusOK, http.StatusNoContent} {
		for _, tt := range tests {
			t.Run(tt.name+http.StatusText(status), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodPost {
						t.Errorf("method = %s, want POST", r.Method)
					}
					if r.URL.Path != "/insert/jsonline" {
						t.Errorf("path = %q, want /insert/jsonline", r.URL.Path)
					}
					if got := r.Header.Get("Content-Type"); got != "application/json" {
						t.Errorf("Content-Type = %q, want application/json", got)
					}
					username, password, ok := r.BasicAuth()
					if !ok || username != "oracle" || password != "secret" {
						t.Errorf("Basic Auth = %q, %q, %v", username, password, ok)
					}
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Fatal(err)
					}
					if len(body) == 0 || body[0] != '{' || body[len(body)-1] != '\n' {
						t.Errorf("body is not a non-empty JSON line: %q", body)
					}
					w.WriteHeader(status)
				}))
				defer server.Close()

				sender := NewVictoriaLogsSender(strings.Replace(server.URL, "://", "://oracle:secret@", 1), "server-1")
				if err := tt.send(sender); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestSendHTTPLogsPostsEmptySlice(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if len(body) != 0 {
			t.Fatalf("body = %q, want empty", body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := NewVictoriaLogsSender(server.URL, "server-1").SendHTTPLogs(nil); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("SendHTTPLogs did not post the empty slice")
	}
}

func TestVictoriaSendMethodRejectsNonSuccessfulStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	err := NewVictoriaLogsSender(server.URL, "server-1").SendAgentLogs([]AgentLog{{Message: "hello"}})
	if err == nil || err.Error() != "unexpected status code: 502" {
		t.Fatalf("error = %v, want unexpected status code: 502", err)
	}
}
