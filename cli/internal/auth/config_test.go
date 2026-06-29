package auth

import (
	"path/filepath"
	"testing"
)

func TestConfigPathForPlatforms(t *testing.T) {
	tests := []struct {
		name string
		goos string
		env  map[string]string
		want string
	}{
		{
			name: "darwin",
			goos: "darwin",
			want: filepath.Join("/home/alice", "Library", "Application Support", ConfigDirName, "config.json"),
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
			name: "windows appdata",
			goos: "windows",
			env:  map[string]string{"APPDATA": `C:\Users\Alice\AppData\Roaming`},
			want: filepath.Join(`C:\Users\Alice\AppData\Roaming`, ConfigDirName, "config.json"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ConfigPathFor(tt.goos, "/home/alice", func(key string) string {
				return tt.env[key]
			})
			if got != tt.want {
				t.Fatalf("ConfigPathFor() = %q, want %q", got, tt.want)
			}
		})
	}
}
