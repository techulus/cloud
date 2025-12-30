package dns

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	pb "techulus/cloud-agent/internal/proto"
	"techulus/cloud-agent/internal/retry"
)

const (
	dnsmasqConfigPath  = "/etc/dnsmasq.d/internal.conf"
	resolvedDropInPath = "/etc/systemd/resolved.conf.d/internal.conf"
)

func SetupLocalDNS(wireguardIP string) error {
	if err := os.MkdirAll("/etc/dnsmasq.d", 0o755); err != nil {
		return fmt.Errorf("failed to create dnsmasq.d: %w", err)
	}

	config := fmt.Sprintf("address=/internal/%s\n", wireguardIP)

	if err := os.WriteFile(dnsmasqConfigPath, []byte(config), 0o644); err != nil {
		return fmt.Errorf("failed to write dnsmasq config: %w", err)
	}

	mainConfig := `port=53
listen-address=127.0.0.1,` + wireguardIP + `
bind-interfaces
conf-dir=/etc/dnsmasq.d
`

	if err := os.WriteFile("/etc/dnsmasq.conf", []byte(mainConfig), 0o644); err != nil {
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
	if err := os.MkdirAll("/etc/systemd/resolved.conf.d", 0o755); err != nil {
		return fmt.Errorf("failed to create resolved.conf.d: %w", err)
	}

	config := fmt.Sprintf(`[Resolve]
DNS=%s
Domains=~internal
`, dnsServer)

	if err := os.WriteFile(resolvedDropInPath, []byte(config), 0o644); err != nil {
		return fmt.Errorf("failed to write resolved config: %w", err)
	}

	cmd := exec.Command("systemctl", "restart", "systemd-resolved")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart systemd-resolved: %w", err)
	}

	return nil
}

func VerifyDNSRecord(hostname string, expectedIPs []string) (bool, error) {
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 2 * time.Second}
			return d.DialContext(ctx, "udp", "127.0.0.1:53")
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ips, err := resolver.LookupHost(ctx, hostname)
	if err != nil {
		return false, fmt.Errorf("DNS lookup failed for %s: %w", hostname, err)
	}

	sort.Strings(ips)
	sortedExpected := make([]string, len(expectedIPs))
	copy(sortedExpected, expectedIPs)
	sort.Strings(sortedExpected)

	if len(ips) != len(sortedExpected) {
		return false, nil
	}

	for i := range ips {
		if ips[i] != sortedExpected[i] {
			return false, nil
		}
	}

	return true, nil
}

func UpdateRecords(config *pb.DnsConfig) error {
	var configLines []string

	for _, record := range config.Records {
		for _, ip := range record.Ips {
			configLines = append(configLines, fmt.Sprintf("address=/%s/%s", record.Name, ip))
		}
	}

	configContent := strings.Join(configLines, "\n")
	if len(configLines) > 0 {
		configContent += "\n"
	}

	log.Printf("[dns] updating %d records", len(config.Records))

	if err := os.WriteFile(dnsmasqConfigPath, []byte(configContent), 0o644); err != nil {
		return fmt.Errorf("failed to write dnsmasq config: %w", err)
	}

	cmd := exec.Command("systemctl", "restart", "dnsmasq")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart dnsmasq: %w", err)
	}

	if len(config.Records) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[dns] verifying DNS records...")
	var failedRecords []string

	for _, record := range config.Records {
		err := retry.WithBackoff(ctx, retry.ConfigBackoff, func() (bool, error) {
			verified, err := VerifyDNSRecord(record.Name, record.Ips)
			if err != nil {
				log.Printf("[dns:verify] record %s lookup error: %v", record.Name, err)
				return false, nil
			}
			return verified, nil
		})

		if err != nil {
			failedRecords = append(failedRecords, record.Name)
			log.Printf("[dns:verify] record %s verification failed after retries", record.Name)
		} else {
			log.Printf("[dns:verify] record %s verified successfully", record.Name)
		}
	}

	if len(failedRecords) > 0 {
		return fmt.Errorf("failed to verify DNS records: %v", failedRecords)
	}

	log.Printf("[dns] all records verified successfully")
	return nil
}
