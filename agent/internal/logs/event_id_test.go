package logs

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestNewLogEventIDIsSortableAndUnique(t *testing.T) {
	now := time.Date(2026, time.July, 20, 12, 0, 0, 123456789, time.UTC)
	first, err := newLogEventID(now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newLogEventID(now)
	if err != nil {
		t.Fatal(err)
	}

	pattern := regexp.MustCompile(`^e[0-9]{19}[a-z]{26}$`)
	if !pattern.MatchString(first) {
		t.Fatalf("event ID %q does not match the public cursor format", first)
	}
	if !pattern.MatchString(second) {
		t.Fatalf("event ID %q does not match the public cursor format", second)
	}
	if first == second {
		t.Fatalf("equal collection times generated duplicate event IDs: %q", first)
	}
}

func TestVictoriaLogsSenderPreservesEventID(t *testing.T) {
	const eventID = "e1784546100123456789abcdefghijklmnopqrstuvwxyz"
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var err error
		body, err = io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	sender := NewVictoriaLogsSender(server.URL, "server-1")
	err := sender.SendLogs(&LogBatch{Logs: []LogEntry{{
		EventID:      eventID,
		DeploymentID: "deployment-1",
		ServiceID:    "service-1",
		Stream:       "stdout",
		Message:      "ready",
		Timestamp:    "2026-07-20T12:00:00Z",
	}}})
	if err != nil {
		t.Fatal(err)
	}

	var entry map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(body))), &entry); err != nil {
		t.Fatal(err)
	}
	if got := entry["event_id"]; got != eventID {
		t.Fatalf("event_id = %v, want %s", got, eventID)
	}
}
