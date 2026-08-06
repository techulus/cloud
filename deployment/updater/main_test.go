package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	testVersion = "v1.2.3"
	testCommit  = "0123456789abcdef0123456789abcdef01234567"
)

func validManifest() releaseManifest {
	checksum := strings.Repeat("a", 64)
	digest := "sha256:" + strings.Repeat("b", 64)
	return releaseManifest{
		Version: testVersion,
		Commit:  testCommit,
		Binaries: map[string]string{
			"agent-linux-amd64": checksum,
			"agent-linux-arm64": checksum,
		},
		ComposeFiles: map[string]string{
			"deployment/compose.production.yml": checksum,
			"deployment/compose.postgres.yml":   checksum,
		},
		Images: map[string]string{
			"web":      digest,
			"registry": digest,
			"updater":  digest,
		},
	}
}

func TestFetchReleaseManifest(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		mutate     func(*releaseManifest)
		wantError  string
	}{
		{name: "valid", statusCode: http.StatusOK},
		{name: "missing", statusCode: http.StatusNotFound, wantError: "status 404"},
		{
			name:       "version mismatch",
			statusCode: http.StatusOK,
			mutate: func(manifest *releaseManifest) {
				manifest.Version = "v1.2.4"
			},
			wantError: "does not match target",
		},
		{
			name:       "invalid image digest",
			statusCode: http.StatusOK,
			mutate: func(manifest *releaseManifest) {
				manifest.Images["web"] = "sha256:invalid"
			},
			wantError: "invalid digest for web",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := validManifest()
			if test.mutate != nil {
				test.mutate(&manifest)
			}
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1.2.3/release-manifest.json" {
					t.Fatalf("unexpected manifest path %q", r.URL.Path)
				}
				w.WriteHeader(test.statusCode)
				if test.statusCode == http.StatusOK {
					if err := json.NewEncoder(w).Encode(manifest); err != nil {
						t.Fatal(err)
					}
				}
			})
			httpServer := httptest.NewServer(handler)
			defer httpServer.Close()

			s := &server{releaseBaseURL: httpServer.URL, httpClient: httpServer.Client()}
			got, err := s.fetchReleaseManifest(testVersion)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("expected error containing %q, got %v", test.wantError, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Commit != testCommit {
				t.Fatalf("expected commit %q, got %q", testCommit, got.Commit)
			}
		})
	}
}

func TestFetchReleaseManifestRejectsMalformedJSON(t *testing.T) {
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":`))
	}))
	defer httpServer.Close()

	s := &server{releaseBaseURL: httpServer.URL, httpClient: httpServer.Client()}
	_, err := s.fetchReleaseManifest(testVersion)
	if err == nil || !strings.Contains(err.Error(), "failed to parse release manifest") {
		t.Fatalf("expected parse error, got %v", err)
	}
}

func TestFetchReleaseManifestRejectsTrailingAndOversizedData(t *testing.T) {
	manifest := validManifest()
	validJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name      string
		body      []byte
		wantError string
	}{
		{name: "trailing data", body: append(validJSON, []byte(` {}`)...), wantError: "trailing data"},
		{name: "oversized", body: make([]byte, maxReleaseManifestSize+1), wantError: "exceeds maximum size"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(test.body)
			}))
			defer httpServer.Close()

			s := &server{releaseBaseURL: httpServer.URL, httpClient: httpServer.Client()}
			_, err := s.fetchReleaseManifest(testVersion)
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("expected error containing %q, got %v", test.wantError, err)
			}
		})
	}
}

func TestStageComposeFilesVerifiesChecksumsAndUsesCommit(t *testing.T) {
	files := map[string]string{
		"deployment/compose.production.yml": "services:\n  web: {}\n",
		"deployment/compose.postgres.yml":   "services:\n  postgres: {}\n",
	}
	manifest := validManifest()
	for path, content := range files {
		manifest.ComposeFiles[path] = checksum(content)
	}

	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prefix := "/" + testCommit + "/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			t.Fatalf("compose request was not commit-pinned: %q", r.URL.Path)
		}
		content, ok := files[strings.TrimPrefix(r.URL.Path, prefix)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(content))
	}))
	defer httpServer.Close()

	stagingDir := t.TempDir()
	s := &server{rawBaseURL: httpServer.URL, httpClient: httpServer.Client()}
	if err := s.stageComposeFiles(&manifest, stagingDir); err != nil {
		t.Fatal(err)
	}
	for path, content := range files {
		data, err := os.ReadFile(filepath.Join(stagingDir, filepath.Base(path)))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != content {
			t.Fatalf("unexpected staged content for %s", path)
		}
	}

	manifest.ComposeFiles["deployment/compose.postgres.yml"] = strings.Repeat("0", 64)
	err := s.stageComposeFiles(&manifest, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "checksum verification failed") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}

func TestUpdateEnvWritesManifestImageReferences(t *testing.T) {
	manifest := validManifest()
	envPath := filepath.Join(t.TempDir(), ".env")
	input := "ROOT_DOMAIN=cloud.example.com\nTECHULUS_CLOUD_VERSION=v1.0.0\nTECHULUS_CLOUD_WEB_IMAGE=old\n"
	if err := updateEnv(envPath, input, manifestEnvSettings(testVersion, &manifest)); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	expected := []string{
		"ROOT_DOMAIN=cloud.example.com",
		"TECHULUS_CLOUD_VERSION=" + testVersion,
		"TECHULUS_CLOUD_WEB_IMAGE=ghcr.io/techulus/cloud/web@" + manifest.Images["web"],
		"TECHULUS_CLOUD_REGISTRY_IMAGE=ghcr.io/techulus/cloud/registry@" + manifest.Images["registry"],
		"TECHULUS_CLOUD_UPDATER_IMAGE=ghcr.io/techulus/cloud/updater@" + manifest.Images["updater"],
	}
	for _, line := range expected {
		if !strings.Contains(text, line+"\n") {
			t.Errorf("updated env missing %q:\n%s", line, text)
		}
	}
}

func TestSupportedComposeFile(t *testing.T) {
	for _, name := range []string{"compose.production.yml", "compose.postgres.yml"} {
		if !supportedComposeFile(name) {
			t.Errorf("expected %q to be supported", name)
		}
	}
	for _, name := range []string{"compose.custom.yml", "/tmp/compose.production.yml", "compose.production.yml:other.yml"} {
		if supportedComposeFile(name) {
			t.Errorf("expected %q to be rejected", name)
		}
	}
}

func checksum(content string) string {
	hash := sha256.Sum256([]byte(content))
	return hex.EncodeToString(hash[:])
}
