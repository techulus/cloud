//go:build darwin

package paths

import (
	"os"
	"path/filepath"
)

var DataDir = func() string {
	home, err := os.UserHomeDir()
	if err != nil {
		panic("failed to get user home directory: " + err.Error())
	}
	return filepath.Join(home, ".techulus-agent")
}()

const (
	BuildKitSocket = "unix:///opt/homebrew/var/run/buildkit/buildkitd.sock"
	WireGuardDir   = "/opt/homebrew/etc/wireguard"
	DnsmasqDir     = "/opt/homebrew/etc/dnsmasq.d"
	DnsmasqConf    = "/opt/homebrew/etc/dnsmasq.conf"
	ResolverDir    = "/etc/resolver"
)
