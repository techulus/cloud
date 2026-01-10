//go:build darwin

package dns

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strings"

	"techulus/cloud-agent/internal/paths"
)

var (
	resolverPath   = paths.ResolverDir + "/internal"
	globalServer   *Server
	containerDNSIP string
)

type DnsRecord struct {
	Name string
	Ips  []string
}

func SetupLocalDNS(subnetID int) error {
	containerDNSIP = fmt.Sprintf("10.200.%d.1", subnetID)

	if err := ConfigureClientDNS(containerDNSIP); err != nil {
		return fmt.Errorf("failed to configure local DNS: %w", err)
	}

	globalServer = NewServer(DNSPort, containerDNSIP)
	if err := globalServer.Start(context.Background()); err != nil {
		return fmt.Errorf("failed to start DNS server: %w", err)
	}

	return nil
}

func GetContainerDNS() string {
	return containerDNSIP
}

func ConfigureClientDNS(dnsIP string) error {
	if err := os.MkdirAll(paths.ResolverDir, 0o755); err != nil {
		return fmt.Errorf("failed to create resolver dir: %w", err)
	}

	config := fmt.Sprintf("nameserver %s\n", dnsIP)

	if err := os.WriteFile(resolverPath, []byte(config), 0o644); err != nil {
		return fmt.Errorf("failed to write resolver config: %w", err)
	}

	return nil
}

func UpdateDnsRecords(records []DnsRecord) error {
	if globalServer == nil {
		return fmt.Errorf("DNS server not initialized")
	}
	globalServer.UpdateRecords(records)
	return nil
}

func GetCurrentConfigHash() string {
	if globalServer == nil {
		return HashRecords(nil)
	}
	return globalServer.GetRecordsHash()
}

func StopDNSServer(ctx context.Context) error {
	if globalServer != nil {
		return globalServer.Stop(ctx)
	}
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
