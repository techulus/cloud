package build

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCleanupManagedTempArtifactsRemovesOnlyOldManagedArtifacts(t *testing.T) {
	tmpDir := t.TempDir()
	oldTime := time.Now().Add(-48 * time.Hour)
	cutoff := time.Now().Add(-24 * time.Hour)

	oldArchive := filepath.Join(tmpDir, "backup-11111111-1111-1111-1111-111111111111.tar.gz")
	youngArchive := filepath.Join(tmpDir, "restore-22222222-2222-2222-2222-222222222222.tar.gz")
	unmanagedArchive := filepath.Join(tmpDir, "backup-not-a-build-id.tar.gz")
	oldExtractDir := filepath.Join(tmpDir, "restore-extract-33333333-3333-3333-3333-333333333333")

	if err := os.WriteFile(oldArchive, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(youngArchive, []byte("young"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unmanagedArchive, []byte("unmanaged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(oldExtractDir, 0700); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{oldArchive, unmanagedArchive, oldExtractDir} {
		if err := os.Chtimes(path, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}

	if err := cleanupManagedTempArtifacts(tmpDir, cutoff); err != nil {
		t.Fatal(err)
	}

	assertMissing(t, oldArchive)
	assertMissing(t, oldExtractDir)
	assertExists(t, youngArchive)
	assertExists(t, unmanagedArchive)
}

func TestCleanupStaleBuildDirsRemovesOnlyOldDirectories(t *testing.T) {
	buildsDir := t.TempDir()
	oldTime := time.Now().Add(-2 * time.Hour)
	cutoff := time.Now().Add(-1 * time.Hour)

	oldDir := filepath.Join(buildsDir, "old-build")
	youngDir := filepath.Join(buildsDir, "young-build")
	filePath := filepath.Join(buildsDir, "not-a-dir")

	if err := os.Mkdir(oldDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(youngDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldDir, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	if err := cleanupStaleBuildDirs(buildsDir, cutoff); err != nil {
		t.Fatal(err)
	}

	assertMissing(t, oldDir)
	assertExists(t, youngDir)
	assertExists(t, filePath)
}

func TestCloneDeepensConfiguredBranchForSelectedCommit(t *testing.T) {
	workDir := filepath.Join(t.TempDir(), "work")
	remoteDir := filepath.Join(t.TempDir(), "remote.git")
	runGit(t, "init", "--initial-branch", "main", workDir)
	runGit(t, "-C", workDir, "config", "user.name", "Test User")
	runGit(t, "-C", workDir, "config", "user.email", "test@example.com")

	var selectedSHA string
	for i := range 60 {
		filePath := filepath.Join(workDir, "history.txt")
		if err := os.WriteFile(filePath, []byte(strconv.Itoa(i)), 0600); err != nil {
			t.Fatal(err)
		}
		runGit(t, "-C", workDir, "add", "history.txt")
		runGit(t, "-C", workDir, "commit", "-m", "commit "+strconv.Itoa(i))
		if i == 5 {
			selectedSHA = runGit(t, "-C", workDir, "rev-parse", "HEAD")
		}
	}
	runGit(t, "clone", "--bare", workDir, remoteDir)

	buildDir := filepath.Join(t.TempDir(), "build")
	config := &Config{
		BuildID:   "build-1",
		CloneURL:  "file://" + remoteDir,
		CommitSha: selectedSHA,
		Branch:    "main",
	}
	builder := NewBuilder(t.TempDir(), nil)

	if err := builder.clone(context.Background(), config, buildDir); err != nil {
		t.Fatal(err)
	}
	if config.ResolvedCommitSha != selectedSHA {
		t.Fatalf("resolved commit = %s, want %s", config.ResolvedCommitSha, selectedSHA)
	}
}

func TestResolveDockerfile(t *testing.T) {
	contextDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(contextDir, "Dockerfile"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(contextDir, "docker"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contextDir, "docker", "Dockerfile.prod"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contextDir, "Dockerfile.custom"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(contextDir, "dockerfiles"), 0700); err != nil {
		t.Fatal(err)
	}
	outsideDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outsideDir, "Dockerfile"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(contextDir, "outside")); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		secrets   map[string]string
		directory string
		filename  string
		wantErr   bool
	}{
		{name: "default", secrets: map[string]string{}, directory: ".", filename: "Dockerfile"},
		{
			name:      "nested custom path",
			secrets:   map[string]string{dockerfilePathKey: "docker/Dockerfile.prod"},
			directory: "docker",
			filename:  "Dockerfile.prod",
		},
		{
			name:      "root custom filename",
			secrets:   map[string]string{dockerfilePathKey: "Dockerfile.custom"},
			directory: ".",
			filename:  "Dockerfile.custom",
		},
		{name: "missing custom path", secrets: map[string]string{dockerfilePathKey: "missing.Dockerfile"}, wantErr: true},
		{name: "empty custom path", secrets: map[string]string{dockerfilePathKey: "  "}, wantErr: true},
		{name: "absolute custom path", secrets: map[string]string{dockerfilePathKey: "/tmp/Dockerfile"}, wantErr: true},
		{name: "escaping custom path", secrets: map[string]string{dockerfilePathKey: "../Dockerfile"}, wantErr: true},
		{name: "directory custom path", secrets: map[string]string{dockerfilePathKey: "dockerfiles"}, wantErr: true},
		{name: "symlink escape", secrets: map[string]string{dockerfilePathKey: "outside/Dockerfile"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveDockerfile(contextDir, tt.secrets)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !got.found || got.directory != tt.directory || got.filename != tt.filename {
				t.Fatalf("resolveDockerfile() = %+v, want directory=%q filename=%q", got, tt.directory, tt.filename)
			}
		})
	}
}

func TestResolveDockerfileFallsBackToRailpack(t *testing.T) {
	got, err := resolveDockerfile(t.TempDir(), map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if got.found {
		t.Fatalf("resolveDockerfile() = %+v, want no Dockerfile", got)
	}
}

func runGit(t *testing.T, args ...string) string {
	t.Helper()
	output, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %s: %v", args, output, err)
	}
	return strings.TrimSpace(string(output))
}

func assertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be removed, got err=%v", path, err)
	}
}
