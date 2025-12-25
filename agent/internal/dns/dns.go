package dns

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/techulus/cloud-agent/internal/config"
)

const (
	dnsmasqConfigPath  = "/etc/dnsmasq.d/internal.conf"
	resolvedDropInPath = "/etc/systemd/resolved.conf.d/internal.conf"
)

var ProxyWireGuardIP = config.ProxyWireGuardIP

func SetupProxyDNS(wireguardIp string) error {
	if err := os.MkdirAll("/etc/dnsmasq.d", 0755); err != nil {
		return fmt.Errorf("failed to create dnsmasq.d: %w", err)
	}

	config := fmt.Sprintf("address=/internal/%s\n", wireguardIp)

	if err := os.WriteFile(dnsmasqConfigPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write dnsmasq config: %w", err)
	}

	mainConfig := `port=53
listen-address=127.0.0.1,` + wireguardIp + `
bind-interfaces
conf-dir=/etc/dnsmasq.d
`

	if err := os.WriteFile("/etc/dnsmasq.conf", []byte(mainConfig), 0644); err != nil {
		return fmt.Errorf("failed to write main dnsmasq config: %w", err)
	}

	cmd := exec.Command("systemctl", "enable", "--now", "dnsmasq")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to enable dnsmasq: %w", err)
	}

	cmd = exec.Command("systemctl", "restart", "dnsmasq")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart dnsmasq: %w", err)
	}

	if err := ConfigureClientDNS("127.0.0.1"); err != nil {
		return fmt.Errorf("failed to configure local DNS: %w", err)
	}

	return nil
}

func ConfigureClientDNS(dnsServer string) error {
	if err := os.MkdirAll("/etc/systemd/resolved.conf.d", 0755); err != nil {
		return fmt.Errorf("failed to create resolved.conf.d: %w", err)
	}

	config := fmt.Sprintf(`[Resolve]
DNS=%s
Domains=~internal
`, dnsServer)

	if err := os.WriteFile(resolvedDropInPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write resolved config: %w", err)
	}

	cmd := exec.Command("systemctl", "restart", "systemd-resolved")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart systemd-resolved: %w", err)
	}

	return nil
}
