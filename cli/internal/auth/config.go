package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

const (
	ConfigDirName    = "techulus-cloud-cli"
	DevConfigDirName = "techulus-cloud-cli-dev"
)

type ConfigStore struct {
	development bool
}

func NewConfigStore(version string) ConfigStore {
	return ConfigStore{development: version == "dev"}
}

func (s ConfigStore) dirName() string {
	if s.development {
		return DevConfigDirName
	}
	return ConfigDirName
}

type Config struct {
	Host    string `json:"host"`
	APIKey  string `json:"apiKey"`
	KeyID   string `json:"keyId,omitempty"`
	KeyName string `json:"keyName,omitempty"`
	User    *User  `json:"user,omitempty"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func ConfigRoot() string {
	home, _ := os.UserHomeDir()
	return ConfigRootFor(runtime.GOOS, home, os.Getenv)
}

func ConfigRootFor(goos, home string, getenv func(string) string) string {
	if xdg := getenv("XDG_CONFIG_HOME"); xdg != "" {
		return xdg
	}
	if goos == "windows" {
		if appData := getenv("APPDATA"); appData != "" {
			return appData
		}
	}
	return filepath.Join(home, ".config")
}

func (s ConfigStore) ConfigDir() string {
	return filepath.Join(ConfigRoot(), s.dirName())
}

func (s ConfigStore) ConfigPath() string {
	return filepath.Join(s.ConfigDir(), "config.json")
}

func (s ConfigStore) ConfigPathFor(goos, home string, getenv func(string) string) string {
	return filepath.Join(ConfigRootFor(goos, home, getenv), s.dirName(), "config.json")
}

func (s ConfigStore) ReadConfig() (*Config, error) {
	contents, err := os.ReadFile(s.ConfigPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var config Config
	if err := json.Unmarshal(contents, &config); err != nil {
		return nil, err
	}
	return &config, nil
}

func (s ConfigStore) WriteConfig(config Config) error {
	if err := os.MkdirAll(s.ConfigDir(), 0o700); err != nil {
		return err
	}
	contents, err := json.MarshalIndent(config, "", "\t")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.ConfigPath(), contents, 0o600); err != nil {
		return err
	}
	return os.Chmod(s.ConfigPath(), 0o600)
}

func (s ConfigStore) DeleteConfig() error {
	err := os.Remove(s.ConfigPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
