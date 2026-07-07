package build

import (
	"os"
	"path/filepath"
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
