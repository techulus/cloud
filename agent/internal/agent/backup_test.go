package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTempArtifactPathStaysUnderAgentDataDir(t *testing.T) {
	dataDir := t.TempDir()

	path, err := tempArtifactPath(dataDir, "backup-11111111-1111-1111-1111-111111111111.tar.gz")
	if err != nil {
		t.Fatal(err)
	}

	expectedPrefix := filepath.Join(dataDir, "tmp") + string(os.PathSeparator)
	if !strings.HasPrefix(path, expectedPrefix) {
		t.Fatalf("expected %s to be under %s", path, expectedPrefix)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "tmp")); err != nil {
		t.Fatalf("expected temp directory to exist: %v", err)
	}
}

func TestTempArtifactPathRejectsNestedNames(t *testing.T) {
	if _, err := tempArtifactPath(t.TempDir(), "../backup.tar.gz"); err == nil {
		t.Fatal("expected nested temp artifact name to be rejected")
	}
}
