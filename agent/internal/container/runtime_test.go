package container

import (
	"slices"
	"testing"
)

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
