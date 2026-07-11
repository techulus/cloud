package container

import (
	"fmt"
	"net/netip"
	"strings"
)

// StableMACAddress derives a locally administered unicast MAC address from an
// IPv4 address. Containers that keep the same static IP must also keep the same
// MAC so hosts do not retain a stale neighbor entry across stop/recreate cycles.
func StableMACAddress(ipAddress string) string {
	ip, err := netip.ParseAddr(strings.TrimSpace(ipAddress))
	if err != nil || !ip.Is4() {
		return ""
	}

	octets := ip.As4()
	return fmt.Sprintf(
		"02:42:%02x:%02x:%02x:%02x",
		octets[0],
		octets[1],
		octets[2],
		octets[3],
	)
}
