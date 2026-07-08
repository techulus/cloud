package container

import (
	"slices"
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

	for _, want := range []string{"--network", NetworkName, "--ip", "10.200.1.2", "-p", "127.0.0.1:30080:80"} {
		if !slices.Contains(args, want) {
			t.Fatalf("args missing %q: %+v", want, args)
		}
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
