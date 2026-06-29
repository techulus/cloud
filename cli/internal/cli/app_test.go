package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"techulus/cloud-cli/internal/auth"
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

func writeTestConfig(t *testing.T, host string) {
	t.Helper()
	configRoot := filepath.Join(t.TempDir(), "config")
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	if err := auth.WriteConfig(auth.Config{Host: host, APIKey: "secret"}); err != nil {
		t.Fatalf("WriteConfig() error = %v", err)
	}
}
