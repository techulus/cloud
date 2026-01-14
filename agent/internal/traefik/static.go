package traefik

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"gopkg.in/yaml.v3"
)

func validateStaticConfig(data []byte) error {
	var config map[string]interface{}
	if err := yaml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("invalid YAML syntax: %w", err)
	}

	if ep, ok := config["entryPoints"]; ok {
		entryPoints, ok := ep.(map[string]interface{})
		if !ok {
			return fmt.Errorf("entryPoints must be a map")
		}
		for name, epConfig := range entryPoints {
			epMap, ok := epConfig.(map[string]interface{})
			if !ok {
				return fmt.Errorf("entry point %q must be a map", name)
			}
			addr, ok := epMap["address"]
			if !ok {
				return fmt.Errorf("entry point %q missing required field 'address'", name)
			}
			if _, ok := addr.(string); !ok {
				return fmt.Errorf("entry point %q address must be a string", name)
			}
		}
	}

	return nil
}

func EnsureEntryPoints(tcpPorts []int, udpPorts []int) (needsRestart bool, err error) {
	for _, port := range tcpPorts {
		if err := ValidateTCPPort(port); err != nil {
			return false, fmt.Errorf("invalid entry point: %w", err)
		}
	}
	for _, port := range udpPorts {
		if err := ValidateUDPPort(port); err != nil {
			return false, fmt.Errorf("invalid entry point: %w", err)
		}
	}

	originalData, err := os.ReadFile(traefikStaticConfigPath)
	if err != nil {
		return false, fmt.Errorf("failed to read static config: %w", err)
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal(originalData, &config); err != nil {
		return false, fmt.Errorf("failed to parse static config: %w", err)
	}

	entryPoints, ok := config["entryPoints"].(map[string]interface{})
	if !ok {
		entryPoints = make(map[string]interface{})
		config["entryPoints"] = entryPoints
	}

	modified := false

	for _, port := range tcpPorts {
		name := fmt.Sprintf("tcp-%d", port)
		if _, exists := entryPoints[name]; !exists {
			entryPoints[name] = map[string]interface{}{
				"address": fmt.Sprintf(":%d", port),
			}
			modified = true
			log.Printf("[traefik] adding TCP entry point: %s", name)
		}
	}

	for _, port := range udpPorts {
		name := fmt.Sprintf("udp-%d", port)
		if _, exists := entryPoints[name]; !exists {
			entryPoints[name] = map[string]interface{}{
				"address": fmt.Sprintf(":%d/udp", port),
			}
			modified = true
			log.Printf("[traefik] adding UDP entry point: %s", name)
		}
	}

	if !modified {
		return false, nil
	}

	newData, err := yaml.Marshal(config)
	if err != nil {
		return false, fmt.Errorf("failed to marshal static config: %w", err)
	}

	if err := validateStaticConfig(newData); err != nil {
		return false, fmt.Errorf("config validation failed: %w", err)
	}

	if err := atomicWrite(traefikStaticConfigPath, newData, 0644); err != nil {
		return false, fmt.Errorf("failed to write static config: %w", err)
	}

	log.Printf("[traefik] static config updated, restart required")
	return true, nil
}

func ReloadTraefik() error {
	cmd := exec.Command("systemctl", "restart", "traefik")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart traefik: %w", err)
	}
	log.Printf("[traefik] restarted traefik to apply static config changes")
	time.Sleep(2 * time.Second)
	return nil
}
