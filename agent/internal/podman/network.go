package podman

import (
	"fmt"
	"os/exec"
	"strings"
)

const NetworkName = "techulus"

func EnsureNetwork(subnetId int) error {
	subnet := fmt.Sprintf("10.200.%d.0/24", subnetId)
	gateway := fmt.Sprintf("10.200.%d.1", subnetId)

	checkCmd := exec.Command("podman", "network", "inspect", NetworkName)
	if err := checkCmd.Run(); err == nil {
		return nil
	}

	args := []string{
		"network", "create",
		"--driver", "bridge",
		"--subnet", subnet,
		"--gateway", gateway,
		"--disable-dns",
		NetworkName,
	}

	createCmd := exec.Command("podman", args...)
	output, err := createCmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "already exists") {
			return nil
		}
		return fmt.Errorf("failed to create network: %s: %w", string(output), err)
	}

	return nil
}
