package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"techulus/cloud-cli/internal/api"
	"techulus/cloud-cli/internal/auth"
	"techulus/cloud-cli/internal/manifest"
)

const imageManifest = `apiVersion: v1
project: {id: p, slug: app}
environment: {id: e, name: prod}
service:
  id: s
  name: web
  source: {type: image, image: nginx:1.27}
  replicas: 2
  hostname: null
  healthCheck: null
  startCommand: null
  ports: []
`

func TestAuthDeviceExchangeCreatesAPIKeyAndWhoamiUsesIt(t *testing.T) {
	configHome(t)
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device/code":
			json.NewEncoder(w).Encode(deviceCodeResponse{DeviceCode: "device", UserCode: "ABCD", VerificationURI: "https://verify", ExpiresIn: 60, Interval: 1})
		case "/api/auth/device/token":
			polls++
			json.NewEncoder(w).Encode(deviceTokenResponse{AccessToken: "access"})
		case "/api/v1/api-keys":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer access" {
				t.Errorf("exchange request = %s auth=%q", r.Method, r.Header.Get("Authorization"))
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["name"] == "" || body["metadata"] == nil {
				t.Errorf("exchange body = %#v", body)
			}
			w.Write([]byte(`{"apiKey":"new-secret","keyId":"key-id","name":"CLI test"}`))
		case "/api/v1/me":
			if r.Header.Get("X-API-Key") != "new-secret" {
				t.Errorf("X-API-Key = %q", r.Header.Get("X-API-Key"))
			}
			w.Write([]byte(`{"user":{"id":"u","email":"a@example.com","name":"Alice"}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	app, out := testApp(t, t.TempDir(), server.Client())
	app.Sleep = func(time.Duration) {}
	if err := execute(app, "auth", "login", "--host", server.URL); err != nil {
		t.Fatal(err)
	}
	cfg, _ := auth.ReadConfig()
	if polls != 1 || cfg == nil || cfg.APIKey != "new-secret" || cfg.KeyID != "key-id" {
		t.Fatalf("polls=%d config=%#v", polls, cfg)
	}
	out.Reset()
	if err := execute(app, "auth", "whoami"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "a@example.com") || !strings.Contains(out.String(), server.URL) {
		t.Fatalf("whoami output = %s", out.String())
	}
}

func TestInitRecommendsLinkInHumanAndJSON(t *testing.T) {
	for _, mode := range []string{"human", "json", "agent"} {
		t.Run(mode, func(t *testing.T) {
			d := t.TempDir()
			app, out := testApp(t, d, nil)
			args := []string{"init"}
			if mode != "human" {
				args = append([]string{"--" + mode}, args...)
			}
			if err := execute(app, args...); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "tc link") {
				t.Fatalf("output = %s", out.String())
			}
			if _, err := os.Stat(filepath.Join(d, "techulus.yml")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLinkByIDsFetchesConfigurationAndSupportsPublicGitHub(t *testing.T) {
	configHome(t)
	root := "cmd/api"
	var paths []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/v1/projects":
			w.Write([]byte(`{"projects":[{"id":"p","name":"App","slug":"app"}]}`))
		case "/api/v1/projects/p/environments":
			w.Write([]byte(`{"environments":[{"id":"e","name":"prod"}]}`))
		case "/api/v1/projects/p/environments/e/services":
			w.Write([]byte(`{"services":[{"id":"s","name":"web","source":{"type":"github","repository":"https://github.com/acme/public","branch":"main","rootDir":"cmd/api"}}]}`))
		case "/api/v1/projects/p/environments/e/services/s/configuration":
			w.Write([]byte(`{"current":{"replicas":2,"hostname":null,"ports":[],"healthCheck":null,"startCommand":null},"management":{"patchable":true,"blockers":[]}}`))
		default:
			t.Errorf("path=%s", r.URL.Path)
		}
	}))
	defer s.Close()
	writeConfig(t, s.URL)
	d := t.TempDir()
	app, _ := testApp(t, d, s.Client())
	if err := execute(app, "link", "--project", "p", "--environment", "e", "--service", "s"); err != nil {
		t.Fatal(err)
	}
	loaded, err := manifest.Load(d)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Manifest.Service.Source.Repository != "https://github.com/acme/public" || loaded.Manifest.Service.Source.RootDir == nil || *loaded.Manifest.Service.Source.RootDir != root || loaded.Manifest.Service.Replicas != 2 {
		t.Fatalf("manifest=%#v", loaded.Manifest)
	}
	want := []string{"/api/v1/projects", "/api/v1/projects/p/environments", "/api/v1/projects/p/environments/e/services", "/api/v1/projects/p/environments/e/services/s/configuration"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths=%v", paths)
	}
}

func TestApplyExactNestedPatchForSources(t *testing.T) {
	for _, tc := range []struct{ name, source, sourceType string }{
		{"image", "{type: image, image: nginx:1.27}", "image"},
		{"github", "{type: github, repository: https://github.com/acme/repo, branch: main, rootDir: cmd/api}", "github"},
		{"github_clear_root", "{type: github, repository: https://github.com/acme/repo, branch: main}", "github"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			configHome(t)
			d := t.TempDir()
			writeManifest(t, d, strings.Replace(imageManifest, "{type: image, image: nginx:1.27}", tc.source, 1))
			var method, path string
			var body map[string]any
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				method, path = r.Method, r.URL.Path
				json.NewDecoder(r.Body).Decode(&body)
				w.Write([]byte(`{"action":"updated","changes":["source"]}`))
			}))
			defer s.Close()
			writeConfig(t, s.URL)
			app, _ := testApp(t, d, s.Client())
			if err := execute(app, "apply"); err != nil {
				t.Fatal(err)
			}
			if method != "PATCH" || path != "/api/v1/projects/p/environments/e/services/s/configuration" {
				t.Fatalf("%s %s", method, path)
			}
			source := body["source"].(map[string]any)
			if source["type"] != tc.sourceType || body["replicas"] != float64(2) || len(body) != 6 {
				t.Fatalf("body=%#v", body)
			}
			if tc.name == "github_clear_root" {
				rootDir, present := source["rootDir"]
				if !present || rootDir != nil {
					t.Fatalf("GitHub rootDir must be sent as explicit null: %#v", source)
				}
			}
		})
	}
}

func TestCollectionRequestsFollowPagination(t *testing.T) {
	queries := map[string][]string{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cursor := r.URL.Query().Get("cursor")
		queries[r.URL.Path] = append(queries[r.URL.Path], cursor)
		if r.URL.Query().Get("limit") != "100" {
			t.Errorf("limit=%q", r.URL.Query().Get("limit"))
		}
		switch r.URL.Path {
		case "/api/v1/projects":
			if cursor == "" {
				w.Write([]byte(`{"projects":[{"id":"p1","name":"One","slug":"one"}],"nextCursor":"projects-next"}`))
			} else {
				w.Write([]byte(`{"projects":[{"id":"p2","name":"Two","slug":"two"}],"nextCursor":null}`))
			}
		case "/environments":
			if cursor == "" {
				w.Write([]byte(`{"environments":[{"id":"e1","name":"One"}],"nextCursor":"environments-next"}`))
			} else {
				w.Write([]byte(`{"environments":[{"id":"e2","name":"Two"}],"nextCursor":null}`))
			}
		case "/services":
			if cursor == "" {
				w.Write([]byte(`{"services":[{"id":"s1","name":"One","source":{"type":"image","image":"one"}}],"nextCursor":"services-next"}`))
			} else {
				w.Write([]byte(`{"services":[{"id":"s2","name":"Two","source":{"type":"image","image":"two"}}],"nextCursor":null}`))
			}
		default:
			t.Errorf("path=%s", r.URL.Path)
		}
	}))
	defer s.Close()
	client := api.NewClient(s.URL, "secret")
	client.HTTPClient = s.Client()

	projects, err := fetchAllProjects(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	environments, err := fetchAllEnvironments(context.Background(), client, "/environments")
	if err != nil {
		t.Fatal(err)
	}
	services, err := fetchAllServices(context.Background(), client, "/services")
	if err != nil {
		t.Fatal(err)
	}
	if len(projects.Projects) != 2 || len(environments.Environments) != 2 || len(services.Services) != 2 {
		t.Fatalf("projects=%#v environments=%#v services=%#v", projects, environments, services)
	}
	for path, want := range map[string][]string{
		"/api/v1/projects": {"", "projects-next"},
		"/environments":    {"", "environments-next"},
		"/services":        {"", "services-next"},
	} {
		if !reflect.DeepEqual(queries[path], want) {
			t.Fatalf("%s queries=%v", path, queries[path])
		}
	}
}

func TestMissingIDsFailLocally(t *testing.T) {
	configHome(t)
	writeConfig(t, "http://unused")
	for _, command := range []string{"apply", "deploy", "status", "logs"} {
		t.Run(command, func(t *testing.T) {
			d := t.TempDir()
			writeManifest(t, d, strings.ReplaceAll(imageManifest, "id: p, ", ""))
			app, _ := testApp(t, d, &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				t.Fatal("unexpected network request")
				return nil, nil
			})})
			err := execute(app, command)
			if err == nil || !strings.Contains(err.Error(), "tc link") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestDeploySourceNeutralAndMismatch(t *testing.T) {
	for _, tc := range []struct {
		name, local, persisted string
		mismatch               bool
	}{
		{"image", `{type: image, image: nginx:1.27}`, `{"type":"image","image":"nginx:1.27"}`, false},
		{"github", `{type: github, repository: https://github.com/acme/repo, branch: main}`, `{"type":"github","repository":"https://github.com/acme/repo","branch":"main"}`, false},
		{"github repository casing", `{type: github, repository: https://github.com/Acme/Repo, branch: main}`, `{"type":"github","repository":"https://github.com/acme/repo","branch":"main"}`, false},
		{"mismatch", `{type: image, image: nginx:1.27}`, `{"type":"image","image":"nginx:latest"}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			configHome(t)
			d := t.TempDir()
			writeManifest(t, d, strings.Replace(imageManifest, `{type: image, image: nginx:1.27}`, tc.local, 1))
			posts := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					w.Write([]byte(`{"current":{"source":` + tc.persisted + `}}`))
					return
				}
				posts++
				w.Write([]byte(`{"operation":"rollout","status":"queued"}`))
			}))
			defer s.Close()
			writeConfig(t, s.URL)
			app, _ := testApp(t, d, s.Client())
			err := execute(app, "deploy")
			if tc.mismatch {
				if err == nil || !strings.Contains(err.Error(), "tc apply") || posts != 0 {
					t.Fatalf("err=%v posts=%d", err, posts)
				}
			} else if err != nil || posts != 1 {
				t.Fatalf("err=%v posts=%d", err, posts)
			}
		})
	}
}

func TestStatusAndResourceRoutesAndOutput(t *testing.T) {
	commands := []struct {
		args        []string
		path, query string
	}{
		{[]string{"status"}, "/status", ""},
		{[]string{"rollouts", "--limit", "7", "--cursor", "next"}, "/rollouts", "cursor=next&limit=7"},
		{[]string{"rollout", "r1"}, "/rollouts/r1", ""},
		{[]string{"rollout", "logs", "r1", "-q", "oops", "--limit", "9"}, "/rollouts/r1/logs", "limit=9&q=oops"},
		{[]string{"builds", "--limit", "3"}, "/builds", "limit=3"},
		{[]string{"metrics", "--range", "24h"}, "/metrics", "range=24h"},
		{[]string{"revisions", "--cursor", "rev"}, "/revisions", "cursor=rev"},
	}
	for _, tc := range commands {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			configHome(t)
			var gotPath, gotQuery string
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
				w.Write([]byte(`{"service":{"id":"s","name":"web","source":{"type":"image","image":"nginx"}},"latestBuild":null,"latestRollout":null,"deployments":[],"items":[]}`))
			}))
			defer s.Close()
			writeConfig(t, s.URL)
			for _, mode := range []string{"--agent", "--json"} {
				app, out := testApp(t, t.TempDir(), s.Client())
				args := append([]string{mode}, tc.args...)
				args = append(args, "--project", "p", "--environment", "e", "--service", "s")
				if err := execute(app, args...); err != nil {
					t.Fatal(err)
				}
				var value any
				if json.Unmarshal(out.Bytes(), &value) != nil {
					t.Fatalf("invalid JSON: %s", out.String())
				}
			}
			base := "/api/v1/projects/p/environments/e/services/s"
			if gotPath != base+tc.path || gotQuery != tc.query {
				t.Fatalf("got %s?%s", gotPath, gotQuery)
			}
		})
	}
}

func TestLogsQueryCursorLongPollAndCancellation(t *testing.T) {
	configHome(t)
	requests := 0
	ctx, cancel := context.WithCancel(context.Background())
	var queries []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		queries = append(queries, r.URL.RawQuery)
		if requests == 1 {
			w.Write([]byte(`{"provider":"enabled","logs":[{"stream":"stdout","message":"one","timestamp":"2026-01-01T00:00:00Z"}],"nextCursor":"opaque_cursor-1"}`))
			return
		}
		if r.URL.Query().Get("wait") != "20" {
			t.Errorf("wait=%q", r.URL.Query().Get("wait"))
		}
		cancel()
		<-r.Context().Done()
	}))
	defer s.Close()
	client := s.Client()
	client.Timeout = 30 * time.Second
	app, _ := testApp(t, t.TempDir(), client)
	err := app.runLogs(ctx, &auth.Config{Host: s.URL, APIKey: "secret"}, targetManifest(), 12, true, "needle", "6h")
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || !strings.Contains(queries[0], "q=needle") || !strings.Contains(queries[0], "range=6h") || !strings.Contains(queries[1], "cursor=opaque_cursor-1") {
		t.Fatalf("requests=%d queries=%v", requests, queries)
	}
}

func TestLogsDrainAvailablePagesWithoutSleeping(t *testing.T) {
	configHome(t)
	requests := 0
	ctx, cancel := context.WithCancel(context.Background())
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch requests {
		case 1:
			w.Write([]byte(`{"provider":"enabled","logs":[],"nextCursor":"page-1"}`))
		case 2:
			if got := r.URL.Query().Get("cursor"); got != "page-1" {
				t.Errorf("cursor=%q", got)
			}
			w.Write([]byte(`{"provider":"enabled","logs":[{"stream":"stdout","message":"same-time-a","timestamp":"2026-01-01T00:00:00Z"},{"stream":"stdout","message":"same-time-b","timestamp":"2026-01-01T00:00:00Z"}],"nextCursor":"page-2","hasMore":true,"pollAfterMs":9999}`))
		case 3:
			if got := r.URL.Query().Get("cursor"); got != "page-2" {
				t.Errorf("cursor=%q", got)
			}
			cancel()
			<-r.Context().Done()
		default:
			t.Errorf("unexpected request %d", requests)
		}
	}))
	defer s.Close()

	app, out := testApp(t, t.TempDir(), s.Client())
	sleeps := 0
	app.Sleep = func(time.Duration) { sleeps++ }
	err := app.runLogs(ctx, &auth.Config{Host: s.URL, APIKey: "secret"}, targetManifest(), 12, true, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if requests != 3 || sleeps != 0 {
		t.Fatalf("requests=%d sleeps=%d", requests, sleeps)
	}
	if !strings.Contains(out.String(), "same-time-a") || !strings.Contains(out.String(), "same-time-b") {
		t.Fatalf("missing equal-timestamp logs in output:\n%s", out.String())
	}
}

func testApp(t *testing.T, cwd string, client *http.Client) (*App, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	a := NewApp("test", strings.NewReader(""), &out, &bytes.Buffer{})
	if client != nil {
		a.HTTPClient = client
	}
	a.GetCWD = func() (string, error) { return cwd, nil }
	a.IsInteractive = func() bool { return false }
	return a, &out
}

func execute(a *App, args ...string) error {
	c := a.rootCommand()
	c.SetArgs(args)
	c.SetIn(a.In)
	c.SetOut(a.Out)
	c.SetErr(a.Err)
	return c.Execute()
}

func configHome(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
}
func writeConfig(t *testing.T, host string) {
	t.Helper()
	if err := auth.WriteConfig(auth.Config{Host: host, APIKey: "secret"}); err != nil {
		t.Fatal(err)
	}
}
func writeManifest(t *testing.T, dir, raw string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "techulus.yml"), []byte(raw), 0644); err != nil {
		t.Fatal(err)
	}
}
func targetManifest() manifest.Manifest { m, _ := manifest.Parse([]byte(imageManifest)); return m }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
