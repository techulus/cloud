package container

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestExecCommand(t *testing.T) {
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1" = inspect ]; then echo '[{"State":{"Running":true}}]'; exit 0; fi
case "$5" in
 success) printf 'hello';;
 failure) printf 'bad'; exit 7;;
 exact) head -c 65536 /dev/zero | tr '\0' x;;
 large) head -c 70000 /dev/zero | tr '\0' x;;
 timeout) sleep 1;;
esac`
	if err := os.WriteFile(filepath.Join(dir, "podman"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	tests := []struct {
		name                string
		exit                int
		truncated, timedOut bool
	}{
		{"success", 0, false, false}, {"failure", 7, false, false}, {"exact", 0, false, false}, {"large", 0, true, false}, {"timeout", 124, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			old := commandTimeout
			if tt.timedOut {
				commandTimeout = 10 * time.Millisecond
			}
			defer func() { commandTimeout = old }()
			result, err := ExecCommand("container", tt.name)
			if err != nil {
				t.Fatal(err)
			}
			if result.ExitCode != tt.exit || result.Truncated != tt.truncated || result.TimedOut != tt.timedOut {
				t.Fatalf("unexpected result: %+v", result)
			}
			if len(result.Output) > CommandOutputLimit {
				t.Fatalf("output exceeded limit: %d", len(result.Output))
			}
		})
	}
}

func TestBuildPodmanPullArgs(t *testing.T) {
	tests := []struct {
		name      string
		tlsVerify bool
		want      []string
	}{
		{
			name:      "does not disable TLS by default",
			tlsVerify: true,
			want:      []string{"pull", "--authfile", "/managed/config.json", "--tls-verify=true", "registry.example.com/app:latest"},
		},
		{
			name: "disables TLS verification when configured",
			want: []string{"pull", "--authfile", "/managed/config.json", "--tls-verify=false", "registry.example.com/app:latest"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildPodmanPullArgs(&DeployConfig{
				Image:     "registry.example.com/app:latest",
				AuthFile:  "/managed/config.json",
				TLSVerify: tt.tlsVerify,
			})
			if !slices.Equal(got, tt.want) {
				t.Fatalf("buildPodmanPullArgs() = %q, want %q", got, tt.want)
			}
		})
	}
}

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

func TestEnsurePodmanSocketDoesNotEnableExistingSocket(t *testing.T) {
	socketPath := testPodmanSocketPath(t)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen on test socket: %v", err)
	}
	defer listener.Close()

	called := false
	err = ensurePodmanSocket(socketPath, func() ([]byte, error) {
		called = true
		return nil, nil
	})
	if err != nil {
		t.Fatalf("ensure socket: %v", err)
	}
	if called {
		t.Fatal("activation called for an existing socket")
	}
}

func TestEnsurePodmanSocketRepairsMissingSocket(t *testing.T) {
	socketPath := testPodmanSocketPath(t)
	var listener net.Listener
	err := ensurePodmanSocket(socketPath, func() ([]byte, error) {
		var err error
		listener, err = net.Listen("unix", socketPath)
		return nil, err
	})
	if listener != nil {
		defer listener.Close()
	}
	if err != nil {
		t.Fatalf("ensure socket: %v", err)
	}
}

func TestEnsurePodmanSocketReportsActivationFailure(t *testing.T) {
	socketPath := testPodmanSocketPath(t)
	err := ensurePodmanSocket(socketPath, func() ([]byte, error) {
		return []byte("permission denied"), errors.New("exit status 1")
	})
	if err == nil || !strings.Contains(err.Error(), "failed to enable podman.socket: permission denied") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestEnsurePodmanSocketReportsInvalidSocketAfterActivation(t *testing.T) {
	socketPath := testPodmanSocketPath(t)
	err := ensurePodmanSocket(socketPath, func() ([]byte, error) {
		return nil, os.WriteFile(socketPath, nil, 0o600)
	})
	if err == nil || !strings.Contains(err.Error(), "is not a Unix socket") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func testPodmanSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "podman-socket-")
	if err != nil {
		t.Fatalf("create socket test directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "podman.sock")
}
