package container

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestBuildPodmanRunArgsPublishesLoopbackPortsWithStaticIP(t *testing.T) {
	args := buildPodmanRunArgs(&DeployConfig{
		Name:              "svc-dep",
		Image:             "docker.io/library/nginx:latest",
		ServiceID:         "svc",
		ServiceName:       "api",
		DeploymentID:      "dep",
		IPAddress:         "10.200.1.2",
		PublishLocalPorts: true,
		PortMappings: []PortMapping{
			{ContainerPort: 80, HostPort: 30080},
		},
	}, "docker.io/library/nginx:latest")

	for _, want := range []string{
		"--network",
		NetworkName,
		"--ip",
		"10.200.1.2",
		"--mac-address",
		"02:42:0a:c8:01:02",
		"-p",
		"127.0.0.1:30080:80",
	} {
		if !slices.Contains(args, want) {
			t.Fatalf("args missing %q: %+v", want, args)
		}
	}
}

func TestStableMACAddress(t *testing.T) {
	tests := []struct {
		name      string
		ipAddress string
		want      string
	}{
		{name: "private IPv4", ipAddress: "10.200.7.4", want: "02:42:0a:c8:07:04"},
		{name: "trims whitespace", ipAddress: " 10.200.1.2 ", want: "02:42:0a:c8:01:02"},
		{name: "invalid", ipAddress: "not-an-ip", want: ""},
		{name: "IPv6", ipAddress: "fd00::1", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := StableMACAddress(tt.ipAddress); got != tt.want {
				t.Fatalf("StableMACAddress(%q) = %q, want %q", tt.ipAddress, got, tt.want)
			}
		})
	}
}

func TestBuildPodmanRunArgsDoesNotPublishStaticIPPortsByDefault(t *testing.T) {
	args := buildPodmanRunArgs(&DeployConfig{
		Name:         "svc-dep",
		Image:        "docker.io/library/nginx:latest",
		ServiceID:    "svc",
		ServiceName:  "api",
		DeploymentID: "dep",
		IPAddress:    "10.200.1.2",
		PortMappings: []PortMapping{
			{ContainerPort: 80, HostPort: 30080},
		},
	}, "docker.io/library/nginx:latest")

	if slices.Contains(args, "-p") {
		t.Fatalf("args unexpectedly publish ports: %+v", args)
	}
}

func TestDeployPullFailureLeavesExistingContainerUntouched(t *testing.T) {
	tempDir := t.TempDir()
	logPath := filepath.Join(tempDir, "podman.log")
	podmanPath := filepath.Join(tempDir, "podman")
	script := "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$PODMAN_TEST_LOG\"\nif [ \"$1\" = pull ]; then exit 1; fi\n"
	if err := os.WriteFile(podmanPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tempDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PODMAN_TEST_LOG", logPath)

	_, err := Deploy(&DeployConfig{
		Name:  "existing-container",
		Image: "registry.invalid/missing:latest",
	})
	if err == nil {
		t.Fatal("expected image pull to fail")
	}
	commands, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := strings.TrimSpace(string(commands)); got != "pull" {
		t.Fatalf("podman commands = %q, want only pull before failure", got)
	}
}
