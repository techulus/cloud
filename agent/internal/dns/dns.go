package dns

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"techulus/cloud-agent/internal/retry"
)

const (
	dnsmasqInternalPath = "/etc/dnsmasq.d/internal.conf"
	dnsmasqServicesPath = "/etc/dnsmasq.d/services.conf"
	resolvedDropInPath  = "/etc/systemd/resolved.conf.d/internal.conf"
)

func SetupLocalDNS(wireguardIP string) error {
	if err := os.MkdirAll("/etc/dnsmasq.d", 0o755); err != nil {
		return fmt.Errorf("failed to create dnsmasq.d: %w", err)
	}

	config := fmt.Sprintf("address=/internal/%s\n", wireguardIP)

	if err := os.WriteFile(dnsmasqInternalPath, []byte(config), 0o644); err != nil {
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

type DnsRecord struct {
	Name string
	Ips  []string
}

func UpdateDnsRecords(records []DnsRecord) error {
	var configLines []string

	for _, record := range records {
		for _, ip := range record.Ips {
			configLines = append(configLines, fmt.Sprintf("address=/%s/%s", record.Name, ip))
		}
	}

	configContent := strings.Join(configLines, "\n")
	if len(configLines) > 0 {
		configContent += "\n"
	}

	log.Printf("[dns] updating %d records", len(records))

	if err := os.WriteFile(dnsmasqServicesPath, []byte(configContent), 0o644); err != nil {
		return fmt.Errorf("failed to write dnsmasq config: %w", err)
	}

	cmd := exec.Command("systemctl", "restart", "dnsmasq")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart dnsmasq: %w", err)
	}

	if len(records) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[dns] verifying DNS records...")
	var failedRecords []string

	for _, record := range records {
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

func HashRecords(records []DnsRecord) string {
	sortedRecords := make([]DnsRecord, len(records))
	copy(sortedRecords, records)
	sort.Slice(sortedRecords, func(i, j int) bool {
		return sortedRecords[i].Name < sortedRecords[j].Name
	})

	var sb strings.Builder
	for _, r := range sortedRecords {
		sb.WriteString(r.Name)
		sb.WriteString(":")
		sortedIps := make([]string, len(r.Ips))
		copy(sortedIps, r.Ips)
		sort.Strings(sortedIps)
		sb.WriteString(strings.Join(sortedIps, ","))
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentConfigHash() string {
	data, err := os.ReadFile(dnsmasqServicesPath)
	if err != nil {
		return HashRecords(nil)
	}

	recordMap := make(map[string][]string)
	lines := strings.Split(string(data), "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "address=/") {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(line, "address=/"), "/")
		if len(parts) >= 2 {
			name := parts[0]
			ip := parts[1]
			recordMap[name] = append(recordMap[name], ip)
		}
	}

	var records []DnsRecord
	for name, ips := range recordMap {
		records = append(records, DnsRecord{Name: name, Ips: ips})
	}

	sort.Slice(records, func(i, j int) bool {
		return records[i].Name < records[j].Name
	})

	return HashRecords(records)
}

