//go:build darwin

package paths

const (
	DataDir        = "/opt/homebrew/var/techulus-agent"
	BuildKitSocket = "unix:///opt/homebrew/var/run/buildkit/buildkitd.sock"
	WireGuardDir   = "/opt/homebrew/etc/wireguard"
	DnsmasqDir     = "/opt/homebrew/etc/dnsmasq.d"
	DnsmasqConf    = "/opt/homebrew/etc/dnsmasq.conf"
	ResolverDir    = "/etc/resolver"
)
