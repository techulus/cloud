package traefik

import (
	"fmt"
	"os"
	"os/exec"
)

const (
	traefikStaticConfigPath = "/etc/traefik/traefik.yaml"
	traefikDynamicDir       = "/etc/traefik/dynamic"
	traefikCertsDir         = "/etc/traefik/certs"
	routesFileName          = "routes.yaml"
	tlsFileName             = "tls.yaml"
	challengesFileName      = "challenges.yaml"

	TCPPortStart = 10000
	TCPPortEnd   = 10999
	UDPPortStart = 11000
	UDPPortEnd   = 11999
)

func CheckPrerequisites() error {
	if _, err := exec.LookPath("traefik"); err != nil {
		return fmt.Errorf("traefik command not found: %w", err)
	}
	return nil
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
