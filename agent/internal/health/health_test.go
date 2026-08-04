package health

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
)

func TestCalculateAgentCPUUsagePercentNormalizesByCPUCount(t *testing.T) {
	previous := &cpu.TimesStat{User: 10, System: 5}
	current := &cpu.TimesStat{User: 12, System: 7}

	got := calculateAgentCPUUsagePercent(previous, current, 1, 4)
	if got != 100 {
		t.Fatalf("cpu percent = %f, want 100", got)
	}
}

func installCSCLIFixture(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "cscli")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestCollectCrowdSecHealthNormalizesSnapshot(t *testing.T) {
	installCSCLIFixture(t, `
case "$1 $2" in
  "lapi status") exit 0 ;;
  "metrics -o") cat <<'JSON'
{"acquisition":{"file:/var/log/traefik/access.log":{"reads":12,"parsed":10,"unparsed":2},"journald":{"reads":99}}}
JSON
  ;;
  "bouncers list") printf '%s' '[{"name":"traefik-bouncer","revoked":false,"last_pull":"2026-08-04T10:00:00Z"}]' ;;
  "decisions list") printf '%s' '[{"decisions":[{"scope":"Ip","value":"203.0.113.7","type":"ban","scenario":"http-bad-user-agent","origin":"crowdsec","until":"2026-08-04T11:00:00Z","extra":"discard"}]}]' ;;
  "alerts list") printf '%s' '[{"id":42,"created_at":"2026-08-04T09:00:00Z","scenario":"http-probing","events_count":3,"source":{"ip":"198.51.100.8","cn":"US"},"events":[{"raw":"discard"}]}]' ;;
  *) exit 2 ;;
esac
`)

	before := time.Now().UTC()
	got := CollectCrowdSecHealth()
	after := time.Now().UTC()
	checkedAt, err := time.Parse(time.RFC3339Nano, got.CheckedAt)
	if err != nil || checkedAt.Before(before) || checkedAt.After(after) {
		t.Fatalf("checkedAt = %q, expected timestamp between %s and %s", got.CheckedAt, before, after)
	}
	if !got.LAPI.Available {
		t.Fatal("LAPI should be available")
	}
	if !got.Metrics.Available || got.Metrics.Reads != 12 || got.Metrics.Parsed != 10 || got.Metrics.Unparsed != 2 {
		t.Fatalf("metrics = %+v", got.Metrics)
	}
	if !got.Bouncer.Available || !got.Bouncer.Registered || got.Bouncer.Revoked || got.Bouncer.LastPullAt != "2026-08-04T10:00:00Z" || got.Bouncer.Error != "" {
		t.Fatalf("bouncer = %+v", got.Bouncer)
	}
	if !got.Decisions.Available || len(got.Decisions.Records) != 1 {
		t.Fatalf("decisions = %+v", got.Decisions)
	}
	decision := got.Decisions.Records[0]
	if decision.Scope != "Ip" || decision.Value != "203.0.113.7" || decision.Action != "ban" || decision.Reason != "http-bad-user-agent" || decision.Origin != "crowdsec" || decision.ExpiresAt != "2026-08-04T11:00:00Z" {
		t.Fatalf("decision = %+v", decision)
	}
	if !got.Alerts.Available || len(got.Alerts.Records) != 1 {
		t.Fatalf("alerts = %+v", got.Alerts)
	}
	alert := got.Alerts.Records[0]
	if alert.ID != 42 || alert.DetectedAt != "2026-08-04T09:00:00Z" || alert.Scenario != "http-probing" || alert.SourceIP != "198.51.100.8" || alert.Country != "US" || alert.EventCount != 3 {
		t.Fatalf("alert = %+v", alert)
	}
}

func TestCollectCrowdSecHealthFailuresAndPartialData(t *testing.T) {
	installCSCLIFixture(t, `
case "$1 $2" in
  "lapi status") printf 'healthy-looking output'; exit 1 ;;
  "metrics -o") printf '%s' '{"acquisition":[{"source":"journald","metrics":{"lines_read":1}}]}' ;;
  "bouncers list") printf 'not-json' ;;
  "decisions list") printf 'not-json' ;;
  "alerts list") printf '%s' '[]' ;;
esac
`)
	got := CollectCrowdSecHealth()
	if got.LAPI.Available || got.Metrics.Available || got.Bouncer.Available || got.Bouncer.Error != "invalid_output" || got.Decisions.Available {
		t.Fatalf("unexpected partial snapshot: %+v", got)
	}
	if !got.Alerts.Available || got.Alerts.Records == nil || len(got.Alerts.Records) != 0 {
		t.Fatalf("empty alerts = %+v", got.Alerts)
	}
}

func TestCrowdSecSnapshotsAreCappedAndTruncated(t *testing.T) {
	decisions := make([]map[string]string, 51)
	for i := range decisions {
		decisions[i] = map[string]string{"scope": "Ip", "value": fmt.Sprintf("192.0.2.%d", i), "type": "ban"}
	}
	decisionJSON, _ := json.Marshal([]any{map[string]any{"decisions": decisions}})
	decisionResult := CrowdSecDecisionSnapshot{Records: []CrowdSecDecision{}}
	parseCrowdSecDecisions(decisionJSON, &decisionResult)
	if !decisionResult.Available || !decisionResult.Truncated || len(decisionResult.Records) != 50 || decisionResult.Records[49].Value != "192.0.2.49" {
		t.Fatalf("decisions cap = %+v", decisionResult)
	}
	duplicateAlerts := make([]map[string]any, 51)
	for i := range duplicateAlerts {
		duplicateAlerts[i] = map[string]any{"decisions": []map[string]string{}}
	}
	duplicateAlerts[0] = map[string]any{"decisions": []map[string]string{{"scope": "Ip", "value": "192.0.2.1", "type": "ban"}}}
	duplicateJSON, _ := json.Marshal(duplicateAlerts)
	decisionResult = CrowdSecDecisionSnapshot{Records: []CrowdSecDecision{}}
	parseCrowdSecDecisions(duplicateJSON, &decisionResult)
	if !decisionResult.Truncated || len(decisionResult.Records) != 1 {
		t.Fatalf("outer alert limit should conservatively mark decisions truncated: %+v", decisionResult)
	}

	alerts := make([]map[string]any, 21)
	for i := range alerts {
		alerts[i] = map[string]any{"id": i + 1, "source": map[string]string{"ip": fmt.Sprintf("198.51.100.%d", i)}}
	}
	alertJSON, _ := json.Marshal(alerts)
	alertResult := CrowdSecAlertSnapshot{Records: []CrowdSecAlert{}}
	parseCrowdSecAlerts(alertJSON, &alertResult)
	if !alertResult.Available || !alertResult.Truncated || len(alertResult.Records) != 20 || alertResult.Records[19].SourceIP != "198.51.100.19" {
		t.Fatalf("alerts cap = %+v", alertResult)
	}
}

func TestCrowdSecParsersRejectMalformedAndAcceptEmpty(t *testing.T) {
	metrics := CrowdSecMetrics{}
	parseCrowdSecMetrics([]byte(`{"acquisition":`), &metrics)
	if metrics.Available {
		t.Fatal("malformed metrics should be unavailable")
	}
	bouncer := CrowdSecBouncer{}
	if !parseCrowdSecBouncer([]byte(`[]`), &bouncer) || !bouncer.Available || bouncer.Registered {
		t.Fatalf("empty bouncers = %+v", bouncer)
	}
	bouncer = CrowdSecBouncer{}
	if !parseCrowdSecBouncer([]byte(`[{"name":"traefik-bouncer","last_pull":null}]`), &bouncer) || !bouncer.Available || !bouncer.Registered || bouncer.LastPullAt != "" {
		t.Fatalf("never-contacted bouncer = %+v", bouncer)
	}
	decisions := CrowdSecDecisionSnapshot{Records: []CrowdSecDecision{}}
	parseCrowdSecDecisions([]byte(`[]`), &decisions)
	if !decisions.Available || decisions.Records == nil {
		t.Fatalf("empty decisions = %+v", decisions)
	}
	if strings.Contains(fmt.Sprintf("%+v", decisions), "secret") {
		t.Fatal("unexpected raw data retained")
	}
}

func TestCalculateAgentCPUUsagePercentWarmupOrInvalidInputs(t *testing.T) {
	current := &cpu.TimesStat{User: 12, System: 7}

	tests := map[string]struct {
		previous       *cpu.TimesStat
		current        *cpu.TimesStat
		elapsedSeconds float64
		cpuCount       int
	}{
		"missing previous sample": {
			previous:       nil,
			current:        current,
			elapsedSeconds: 1,
			cpuCount:       4,
		},
		"missing current sample": {
			previous:       &cpu.TimesStat{User: 10, System: 5},
			current:        nil,
			elapsedSeconds: 1,
			cpuCount:       4,
		},
		"zero elapsed": {
			previous:       &cpu.TimesStat{User: 10, System: 5},
			current:        current,
			elapsedSeconds: 0,
			cpuCount:       4,
		},
		"negative counter delta": {
			previous:       current,
			current:        &cpu.TimesStat{User: 10, System: 5},
			elapsedSeconds: 1,
			cpuCount:       4,
		},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			got := calculateAgentCPUUsagePercent(
				test.previous,
				test.current,
				test.elapsedSeconds,
				test.cpuCount,
			)
			if got != 0 {
				t.Fatalf("cpu percent = %f, want 0", got)
			}
		})
	}
}
