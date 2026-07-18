package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

const ConfigDirName = "techulus-cloud-cli"

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

func ConfigDir() string {
	return filepath.Join(ConfigRoot(), ConfigDirName)
}

func ConfigPath() string {
	return filepath.Join(ConfigDir(), "config.json")
}

func ConfigPathFor(goos, home string, getenv func(string) string) string {
	return filepath.Join(ConfigRootFor(goos, home, getenv), ConfigDirName, "config.json")
}

func ReadConfig() (*Config, error) {
	contents, err := os.ReadFile(ConfigPath())
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

func WriteConfig(config Config) error {
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	contents, err := json.MarshalIndent(config, "", "\t")
	if err != nil {
		return err
	}
	if err := os.WriteFile(ConfigPath(), contents, 0o600); err != nil {
		return err
	}
	return os.Chmod(ConfigPath(), 0o600)
}

func DeleteConfig() error {
	err := os.Remove(ConfigPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
