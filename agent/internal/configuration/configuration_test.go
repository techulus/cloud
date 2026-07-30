package configuration

import (
	"os"
	"path/filepath"
	"testing"

	"techulus/cloud-agent/internal/agent"
)

func TestRegistryInsecureRequiresPersistedOptIn(t *testing.T) {
	originalConfigPath := configPath
	configPath = filepath.Join(t.TempDir(), "config.json")
	t.Cleanup(func() { configPath = originalConfigPath })

	legacyConfig := []byte(`{"registryInsecure":true}`)
	if err := os.WriteFile(configPath, legacyConfig, 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RegistryInsecure {
		t.Fatal("legacy registryInsecure value unexpectedly enabled insecure registry access")
	}

	if err := Save(&agent.Config{RegistryInsecure: true}); err != nil {
		t.Fatal(err)
	}
	loaded, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.RegistryInsecure {
		t.Fatal("explicit registry insecure opt-in did not survive save and load")
	}
}
