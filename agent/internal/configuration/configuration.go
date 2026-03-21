// Package configuration handles loading and saving agent configuration files.
package configuration

import (
	"encoding/json"
	"os"
	"path/filepath"

	"techulus/cloud-agent/internal/agent"
	"techulus/cloud-agent/internal/paths"
)

var configPath = filepath.Join(paths.DataDir, "config.json")

func Load() (*agent.Config, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var config agent.Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

func Save(config *agent.Config) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0o600)
}
