//go:build linux

package paths

var DataDir = "/var/lib/techulus-agent"

const (
	BuildKitSocket = "unix:///run/buildkit/buildkitd.sock"
	WireGuardDir   = "/etc/wireguard"
	ResolvedDir    = "/etc/systemd/resolved.conf.d"
	BuildctlPath   = "/usr/local/bin/buildctl"
	RailpackPath   = "/usr/local/bin/railpack"
)
