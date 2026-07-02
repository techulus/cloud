package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"techulus/cloud-cli/internal/auth"
	"techulus/cloud-cli/internal/manifest"
)

func TestInitCreatesManifest(t *testing.T) {
	tmp := t.TempDir()
	stdout, stderr, err := runTestCommand(t, nil, tmp, "init")
	if err != nil {
		t.Fatalf("init error = %v\nstderr=%s", err, stderr)
	}
	if !strings.Contains(stdout, "tc apply") {
		t.Fatalf("stdout = %s", stdout)
	}
	raw, err := os.ReadFile(filepath.Join(tmp, "techulus.yml"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if !strings.Contains(string(raw), "image: nginx:1.27") {
		t.Fatalf("manifest = %s", raw)
	}
}

func TestLogsRejectsInvalidTailBeforeConfig(t *testing.T) {
	_, _, err := runTestCommand(t, nil, t.TempDir(), "logs", "--tail", "0")
	if err == nil || !strings.Contains(err.Error(), "between 1 and 1000") {
		t.Fatalf("error = %v", err)
	}
}

func TestAgentHelpOutputsStructuredCommandMetadata(t *testing.T) {
	stdout, stderr, err := runTestCommand(t, nil, t.TempDir(), "status", "--help", "--agent")
	if err != nil {
		t.Fatalf("help error = %v\nstderr=%s", err, stderr)
	}
	var help agentHelpInfo
	if err := json.Unmarshal([]byte(stdout), &help); err != nil {
		t.Fatalf("decode help: %v\nstdout=%s", err, stdout)
	}
	if help.Command != "status" || help.Path != "tc status" {
		t.Fatalf("help = %#v", help)
	}
	if !agentFlagsContain(help.Flags, "project") || !agentFlagsContain(help.InheritedFlags, "agent") {
		t.Fatalf("flags = %#v inherited = %#v", help.Flags, help.InheritedFlags)
	}
	if len(help.Notes) == 0 || !strings.Contains(strings.Join(help.Notes, "\n"), "explicit target flags") {
		t.Fatalf("notes = %#v", help.Notes)
	}
}

func TestAgentCompletionHelpOutputsChoiceArg(t *testing.T) {
	stdout, stderr, err := runTestCommand(t, nil, t.TempDir(), "completion", "--help", "--agent")
	if err != nil {
		t.Fatalf("help error = %v\nstderr=%s", err, stderr)
	}
	var help agentHelpInfo
	if err := json.Unmarshal([]byte(stdout), &help); err != nil {
		t.Fatalf("decode help: %v\nstdout=%s", err, stdout)
	}
	if len(help.Args) != 1 {
		t.Fatalf("args = %#v", help.Args)
	}
	arg := help.Args[0]
	if arg.Name != "shell" || !arg.Required {
		t.Fatalf("arg = %#v", arg)
	}
	wantChoices := []string{"bash", "zsh", "fish", "powershell"}
	if strings.Join(arg.Choices, ",") != strings.Join(wantChoices, ",") {
		t.Fatalf("choices = %#v", arg.Choices)
	}
}

func TestJSONHelpOutputsEnvelope(t *testing.T) {
	stdout, stderr, err := runTestCommand(t, nil, t.TempDir(), "status", "--help", "--json")
	if err != nil {
		t.Fatalf("help error = %v\nstderr=%s", err, stderr)
	}
	var envelope struct {
		OK      bool          `json:"ok"`
		Data    agentHelpInfo `json:"data"`
		Summary string        `json:"summary"`
	}
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("decode envelope: %v\nstdout=%s", err, stdout)
	}
	if !envelope.OK || envelope.Summary != "Help" {
		t.Fatalf("envelope = %#v", envelope)
	}
	if envelope.Data.Command != "status" || envelope.Data.Path != "tc status" {
		t.Fatalf("data = %#v", envelope.Data)
	}
}

func TestAgentStatusOutputsRawJSON(t *testing.T) {
	tmp := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/status" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"service":{"id":"1234567890abcdef","name":"web","image":"nginx:1.27","hostname":null,"replicas":1},"latestRollout":null,"deployments":[]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "--agent", "status", "--project", "app", "--environment", "production", "--service", "web")
	if err != nil {
		t.Fatalf("status error = %v\nstderr=%s", err, stderr)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(stdout), &raw); err != nil {
		t.Fatalf("decode raw: %v\nstdout=%s", err, stdout)
	}
	if _, ok := raw["ok"]; ok {
		t.Fatalf("agent output should be raw data, got %s", stdout)
	}
	target := raw["target"].(map[string]any)
	if target["project"] != "app" || raw["status"] == nil {
		t.Fatalf("raw = %#v", raw)
	}
}

func TestJSONStatusOutputsEnvelope(t *testing.T) {
	tmp := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/status" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"service":{"id":"1234567890abcdef","name":"web","image":"nginx:1.27","hostname":null,"replicas":1},"latestRollout":null,"deployments":[]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "--json", "status", "--project", "app", "--environment", "production", "--service", "web")
	if err != nil {
		t.Fatalf("status error = %v\nstderr=%s", err, stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("decode envelope: %v\nstdout=%s", err, stdout)
	}
	if envelope["ok"] != true || envelope["data"] == nil || envelope["summary"] != "Status" {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestAgentLogsOutputsOneShotJSON(t *testing.T) {
	tmp := t.TempDir()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/logs" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		requests++
		w.Write([]byte(`{"loggingEnabled":true,"logs":[{"deploymentId":"d","stream":"stdout","message":"hello","timestamp":"2026-01-01T00:00:00Z"}]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "--agent", "logs", "--project", "app", "--environment", "production", "--service", "web")
	if err != nil {
		t.Fatalf("logs error = %v\nstderr=%s", err, stderr)
	}
	var result logsOutput
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("decode logs: %v\nstdout=%s", err, stdout)
	}
	if requests != 1 || !result.LoggingEnabled || len(result.Logs) != 1 || result.Logs[0].Message != "hello" {
		t.Fatalf("requests=%d result=%#v", requests, result)
	}
}

func TestAgentLogsRejectsFollowTrue(t *testing.T) {
	_, _, err := runTestCommand(t, nil, t.TempDir(), "--agent", "logs", "--project", "app", "--environment", "production", "--service", "web", "--follow=true")
	if err == nil || !strings.Contains(err.Error(), "--follow=true is not supported") {
		t.Fatalf("error = %v", err)
	}
}

func TestExecuteWritesMachineErrorEnvelope(t *testing.T) {
	tmp := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected API request: %s", r.URL.Path)
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestAppExecute(t, server.Client(), tmp, "--json", "status", "--project", "app")
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsHandledError(err) {
		t.Fatalf("error should be marked handled, got %T %v", err, err)
	}
	if stderr != "" {
		t.Fatalf("stderr = %q", stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("decode envelope: %v\nstdout=%s", err, stdout)
	}
	if envelope["ok"] != false || !strings.Contains(envelope["error"].(string), "provide --project") {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestHandledErrorUnwrapsOriginalError(t *testing.T) {
	base := errors.New("base")
	wrapped := handledError{err: base}
	if !errors.Is(wrapped, base) {
		t.Fatalf("handledError should unwrap original error")
	}
}

func TestAuthLoginRejectsMachineOutputBeforeWritingHumanText(t *testing.T) {
	stdout, stderr, err := runTestAppExecute(t, nil, t.TempDir(), "--agent", "auth", "login", "--host", "https://example.com")
	if err == nil {
		t.Fatal("expected error")
	}
	if stderr != "" {
		t.Fatalf("stderr = %q", stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("decode envelope: %v\nstdout=%s", err, stdout)
	}
	if envelope["ok"] != false || !strings.Contains(envelope["error"].(string), "requires human browser approval") {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestLinkRejectsMachineOutputWithSpecificMessage(t *testing.T) {
	stdout, stderr, err := runTestAppExecute(t, nil, t.TempDir(), "--json", "link")
	if err == nil {
		t.Fatal("expected error")
	}
	if stderr != "" {
		t.Fatalf("stderr = %q", stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("decode envelope: %v\nstdout=%s", err, stdout)
	}
	if envelope["ok"] != false || !strings.Contains(envelope["error"].(string), "does not support --agent or --json") {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestStatusUsesExplicitTargetWithoutManifest(t *testing.T) {
	tmp := t.TempDir()
	var sawStatus bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/status" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		query := r.URL.Query()
		if query.Get("project") != "app" || query.Get("environment") != "production" || query.Get("service") != "web" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		sawStatus = true
		w.Write([]byte(`{"service":{"id":"1234567890abcdef","name":"web","image":"nginx:1.27","hostname":null,"replicas":1},"latestRollout":null,"deployments":[]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "status", "--project", "app", "--environment", "production", "--service", "web")
	if err != nil {
		t.Fatalf("status error = %v\nstderr=%s", err, stderr)
	}
	if !sawStatus || !strings.Contains(stdout, "app/production/web") || !strings.Contains(stdout, "nginx:1.27") {
		t.Fatalf("stdout = %s sawStatus=%v", stdout, sawStatus)
	}
}

func TestLogsUsesExplicitTargetWithoutManifest(t *testing.T) {
	tmp := t.TempDir()
	var sawLogs bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/logs" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		query := r.URL.Query()
		if query.Get("project") != "app" || query.Get("environment") != "production" || query.Get("service") != "web" || query.Get("tail") != "10" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		sawLogs = true
		w.Write([]byte(`{"loggingEnabled":true,"logs":[{"deploymentId":"d","stream":"stdout","message":"hello","timestamp":"2026-01-01T00:00:00Z"}]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "logs", "--project", "app", "--environment", "production", "--service", "web", "--tail", "10", "--follow=false")
	if err != nil {
		t.Fatalf("logs error = %v\nstderr=%s", err, stderr)
	}
	if !sawLogs || !strings.Contains(stdout, "app/production/web") || !strings.Contains(stdout, "hello") {
		t.Fatalf("stdout = %s sawLogs=%v", stdout, sawLogs)
	}
}

func TestReadOnlyTargetsRejectPartialFlags(t *testing.T) {
	tmp := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected API request: %s", r.URL.Path)
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	_, _, err := runTestCommand(t, server.Client(), tmp, "status", "--project", "app")
	if err == nil || !strings.Contains(err.Error(), "provide --project, --environment, and --service together") {
		t.Fatalf("status error = %v", err)
	}

	_, _, err = runTestCommand(t, server.Client(), tmp, "logs", "--project", "app", "--service", "web", "--follow=false")
	if err == nil || !strings.Contains(err.Error(), "provide --project, --environment, and --service together") {
		t.Fatalf("logs error = %v", err)
	}
}

func TestApplyPostsManifest(t *testing.T) {
	tmp := t.TempDir()
	writeTestManifest(t, tmp)
	var sawApply bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/apply" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "secret" {
			t.Fatalf("api key = %q", r.Header.Get("x-api-key"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["project"] != "app" {
			t.Fatalf("body = %#v", body)
		}
		sawApply = true
		w.Write([]byte(`{"action":"updated","serviceId":"1234567890abcdef","changes":[]}`))
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommand(t, server.Client(), tmp, "apply")
	if err != nil {
		t.Fatalf("apply error = %v\nstderr=%s", err, stderr)
	}
	if !sawApply || !strings.Contains(stdout, "Action     updated") {
		t.Fatalf("stdout = %s sawApply=%v", stdout, sawApply)
	}
}

func TestAuthLoginDeviceFlow(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(tmp, "config"))
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device/code":
			w.Write([]byte(`{"device_code":"device","user_code":"ABCD","verification_uri":"https://verify","verification_uri_complete":"https://verify?code=ABCD","expires_in":600,"interval":1}`))
		case "/api/auth/device/token":
			polls++
			if polls == 1 {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			w.Write([]byte(`{"access_token":"access"}`))
		case "/api/v1/cli/auth/exchange":
			if r.Header.Get("authorization") != "Bearer access" {
				t.Fatalf("authorization = %q", r.Header.Get("authorization"))
			}
			w.Write([]byte(`{"apiKey":"secret","keyId":"key-123456789","name":"CLI","user":{"id":"user","email":"a@example.com","name":"Alice"}}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := NewApp("test", strings.NewReader(""), &stdout, &stderr)
	app.HTTPClient = server.Client()
	app.Sleep = func(time.Duration) {}
	app.GetCWD = func() (string, error) { return tmp, nil }
	cmd := app.rootCommand()
	cmd.SetArgs([]string{"auth", "login", "--host", server.URL})
	cmd.SetIn(app.In)
	cmd.SetOut(app.Out)
	cmd.SetErr(app.Err)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("auth login error = %v\nstderr=%s", err, stderr.String())
	}
	config, err := auth.ReadConfig()
	if err != nil {
		t.Fatalf("ReadConfig() error = %v", err)
	}
	if config == nil || config.APIKey != "secret" || config.Host != server.URL {
		t.Fatalf("config = %#v", config)
	}
	if !strings.Contains(stdout.String(), "Signed in") {
		t.Fatalf("stdout = %s", stdout.String())
	}
}

func TestAuthLoginStopsAtDeviceExpiry(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(tmp, "config"))
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device/code":
			w.Write([]byte(`{"device_code":"device","user_code":"ABCD","verification_uri":"https://verify","expires_in":2,"interval":1}`))
		case "/api/auth/device/token":
			polls++
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"authorization_pending"}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	now := time.Unix(0, 0)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := NewApp("test", strings.NewReader(""), &stdout, &stderr)
	app.HTTPClient = server.Client()
	app.Now = func() time.Time { return now }
	app.Sleep = func(duration time.Duration) { now = now.Add(duration) }
	app.GetCWD = func() (string, error) { return tmp, nil }
	cmd := app.rootCommand()
	cmd.SetArgs([]string{"auth", "login", "--host", server.URL})
	cmd.SetIn(app.In)
	cmd.SetOut(app.Out)
	cmd.SetErr(app.Err)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "device authorization expired") {
		t.Fatalf("auth login error = %v", err)
	}
	if polls != 1 {
		t.Fatalf("polls = %d, want 1", polls)
	}
}

func TestLinkInteractiveFlow(t *testing.T) {
	tmp := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/manifest/link-targets":
			w.Write([]byte(`{"projects":[{"id":"p","name":"Project","slug":"project","environments":[{"id":"e","name":"production","services":[{"id":"s1","name":"db","project":"Project","environment":"production","linkSupported":false,"unsupportedReason":"stateful"},{"id":"s2","name":"web","project":"Project","environment":"production","linkSupported":true,"unsupportedReason":null}]}]}]}`))
		case "/api/v1/manifest/link":
			w.Write([]byte(`{"manifest":{"apiVersion":"v1","project":"Project","environment":"production","service":{"name":"web","source":{"type":"image","image":"nginx"},"replicas":{"count":1},"ports":[]}},"service":{"id":"s2","name":"web","project":"Project","environment":"production"}}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()
	writeTestConfig(t, server.URL)

	stdout, stderr, err := runTestCommandWithInput(t, server.Client(), tmp, "1\n1\n1\n2\n", true, "link")
	if err != nil {
		t.Fatalf("link error = %v\nstderr=%s\nstdout=%s", err, stderr, stdout)
	}
	if !strings.Contains(stdout, "stateful") || !strings.Contains(stdout, "Linked") {
		t.Fatalf("stdout = %s", stdout)
	}
	if _, err := os.Stat(filepath.Join(tmp, "techulus.yml")); err != nil {
		t.Fatalf("manifest not written: %v", err)
	}
}

func TestRunLogsFollowPrintsDuplicateReturnedLines(t *testing.T) {
	tmp := t.TempDir()
	writeTestManifest(t, tmp)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/manifest/logs" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		requests++
		switch requests {
		case 1:
			w.Write([]byte(`{"loggingEnabled":true,"logs":[]}`))
		case 2:
			w.Write([]byte(`{"loggingEnabled":true,"logs":[{"deploymentId":"d","stream":"stdout","message":"same","timestamp":"2026-01-01T00:00:00Z"},{"deploymentId":"d","stream":"stdout","message":"same","timestamp":"2026-01-01T00:00:00Z"}]}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"stop"}`))
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	app := NewApp("test", strings.NewReader(""), &stdout, &bytes.Buffer{})
	app.HTTPClient = server.Client()
	app.Sleep = func(time.Duration) {}
	app.Now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	err := app.runLogs(context.Background(), &auth.Config{Host: server.URL, APIKey: "secret"}, testManifest(), 100, true)
	if err == nil || !strings.Contains(err.Error(), "stop") {
		t.Fatalf("runLogs error = %v", err)
	}
	if count := strings.Count(stdout.String(), " same\n"); count != 2 {
		t.Fatalf("printed duplicate count = %d, stdout = %s", count, stdout.String())
	}
}

func runTestCommand(t *testing.T, client *http.Client, cwd string, args ...string) (string, string, error) {
	t.Helper()
	return runTestCommandWithInput(t, client, cwd, "", false, args...)
}

func runTestCommandWithInput(t *testing.T, client *http.Client, cwd string, stdin string, interactive bool, args ...string) (string, string, error) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := NewApp("test", strings.NewReader(stdin), &stdout, &stderr)
	if client != nil {
		app.HTTPClient = client
	}
	app.GetCWD = func() (string, error) { return cwd, nil }
	app.IsInteractive = func() bool { return interactive }
	cmd := app.rootCommand()
	cmd.SetArgs(args)
	cmd.SetIn(app.In)
	cmd.SetOut(app.Out)
	cmd.SetErr(app.Err)
	err := cmd.Execute()
	return stdout.String(), stderr.String(), err
}

func runTestAppExecute(t *testing.T, client *http.Client, cwd string, args ...string) (string, string, error) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	app := NewApp("test", strings.NewReader(""), &stdout, &stderr)
	app.Args = args
	if client != nil {
		app.HTTPClient = client
	}
	app.GetCWD = func() (string, error) { return cwd, nil }
	err := app.Execute()
	return stdout.String(), stderr.String(), err
}

func writeTestManifest(t *testing.T, dir string) {
	t.Helper()
	raw := `apiVersion: v1
project: app
environment: production
service:
  name: web
  source:
    type: image
    image: nginx:1.27
  replicas:
    count: 1
`
	if err := os.WriteFile(filepath.Join(dir, "techulus.yml"), []byte(raw), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func testManifest() manifest.Manifest {
	return manifest.Manifest{
		APIVersion:  "v1",
		Project:     "app",
		Environment: "production",
		Service: manifest.Service{
			Name:     "web",
			Source:   manifest.Source{Type: "image", Image: "nginx:1.27"},
			Replicas: manifest.Replicas{Count: 1},
			Ports:    []manifest.Port{},
		},
	}
}

func writeTestConfig(t *testing.T, host string) {
	t.Helper()
	configRoot := filepath.Join(t.TempDir(), "config")
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	if err := auth.WriteConfig(auth.Config{Host: host, APIKey: "secret"}); err != nil {
		t.Fatalf("WriteConfig() error = %v", err)
	}
}

func agentFlagsContain(flags []agentFlag, name string) bool {
	for _, flag := range flags {
		if flag.Name == name {
			return true
		}
	}
	return false
}
