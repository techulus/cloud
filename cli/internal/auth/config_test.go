package auth

import (
	"path/filepath"
	"testing"
)

func TestConfigPathForPlatforms(t *testing.T) {
	tests := []struct {
		name    string
		version string
		goos    string
		env     map[string]string
		want    string
	}{
		{
			name: "darwin",
			goos: "darwin",
			want: filepath.Join("/home/alice", ".config", ConfigDirName, "config.json"),
		},
		{
			name: "linux xdg",
			goos: "linux",
			env:  map[string]string{"XDG_CONFIG_HOME": "/xdg"},
			want: filepath.Join("/xdg", ConfigDirName, "config.json"),
		},
		{
			name: "linux fallback",
			goos: "linux",
			want: filepath.Join("/home/alice", ".config", ConfigDirName, "config.json"),
		},
		{
			name:    "development",
			version: "dev",
			goos:    "linux",
			env:     map[string]string{"XDG_CONFIG_HOME": "/xdg"},
			want:    filepath.Join("/xdg", DevConfigDirName, "config.json"),
		},
		{
			name: "windows appdata",
			goos: "windows",
			env:  map[string]string{"APPDATA": `C:\Users\Alice\AppData\Roaming`},
			want: filepath.Join(`C:\Users\Alice\AppData\Roaming`, ConfigDirName, "config.json"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewConfigStore(tt.version)
			got := store.ConfigPathFor(tt.goos, "/home/alice", func(key string) string {
				return tt.env[key]
			})
			if got != tt.want {
				t.Fatalf("ConfigStore.ConfigPathFor() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestConfigStoreVersionClassification(t *testing.T) {
	tests := []struct {
		name    string
		store   ConfigStore
		wantDir string
	}{
		{name: "development", store: NewConfigStore("dev"), wantDir: DevConfigDirName},
		{name: "release", store: NewConfigStore("v1.0.0"), wantDir: ConfigDirName},
		{name: "empty version", store: NewConfigStore(""), wantDir: ConfigDirName},
		{name: "development suffix", store: NewConfigStore("dev-dirty"), wantDir: ConfigDirName},
		{name: "zero value", store: ConfigStore{}, wantDir: ConfigDirName},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.store.ConfigPathFor("linux", "/home/alice", func(string) string { return "" })
			want := filepath.Join("/home/alice", ".config", tt.wantDir, "config.json")
			if got != want {
				t.Fatalf("ConfigStore.ConfigPathFor() = %q, want %q", got, want)
			}
		})
	}
}

func TestDevelopmentAndProductionConfigsAreIndependent(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	production := NewConfigStore("v1.0.0")
	development := NewConfigStore("dev")
	if production.ConfigPath() == development.ConfigPath() {
		t.Fatalf("production and development config paths are both %q", production.ConfigPath())
	}

	if err := production.WriteConfig(Config{Host: "https://cloud.example.com", APIKey: "production"}); err != nil {
		t.Fatal(err)
	}
	if err := development.WriteConfig(Config{Host: "http://localhost:3000", APIKey: "development"}); err != nil {
		t.Fatal(err)
	}

	productionConfig, err := production.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	developmentConfig, err := development.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if productionConfig.APIKey != "production" || developmentConfig.APIKey != "development" {
		t.Fatalf("production config = %#v, development config = %#v", productionConfig, developmentConfig)
	}

	if err := development.DeleteConfig(); err != nil {
		t.Fatal(err)
	}
	developmentConfig, err = development.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	productionConfig, err = production.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if developmentConfig != nil || productionConfig == nil || productionConfig.APIKey != "production" {
		t.Fatalf("after development delete, production config = %#v, development config = %#v", productionConfig, developmentConfig)
	}

	if err := development.WriteConfig(Config{Host: "http://localhost:3000", APIKey: "development"}); err != nil {
		t.Fatal(err)
	}
	if err := production.DeleteConfig(); err != nil {
		t.Fatal(err)
	}
	productionConfig, err = production.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	developmentConfig, err = development.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if productionConfig != nil || developmentConfig == nil || developmentConfig.APIKey != "development" {
		t.Fatalf("after production delete, production config = %#v, development config = %#v", productionConfig, developmentConfig)
	}
}
