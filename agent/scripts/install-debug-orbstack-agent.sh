#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-techulus-agent}"
INSTALL_PATH="${INSTALL_PATH:-/usr/local/bin/techulus-agent}"
VERSION="${VERSION:-debug-fast-deploy-$(date +%Y%m%d%H%M%S)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$AGENT_DIR/bin/debug-orbstack}"

if [ "$#" -gt 0 ]; then
	MACHINES=("$@")
elif [ -n "${ORBSTACK_MACHINES:-}" ]; then
	# shellcheck disable=SC2206
	MACHINES=(${ORBSTACK_MACHINES})
else
	MACHINES=(ubuntu-1 ubuntu-2)
fi

log() {
	printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
	log "ERROR: $*"
	exit 1
}

run() {
	log "+ $*"
	"$@"
}

goarch_for_uname() {
	case "$1" in
		x86_64 | amd64)
			printf 'amd64'
			;;
		aarch64 | arm64)
			printf 'arm64'
			;;
		*)
			return 1
			;;
	esac
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

log "Techulus debug agent installer for OrbStack"
log "Agent source: $AGENT_DIR"
log "Build output: $BUILD_DIR"
log "Debug version: $VERSION"
log "Service name: $SERVICE_NAME"
log "Install path: $INSTALL_PATH"
log "Target machines: ${MACHINES[*]}"

require_cmd go
require_cmd orb

mkdir -p "$BUILD_DIR"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
MAC_BUILD_DIR="/mnt/mac${BUILD_DIR}"

MACHINE_ARCHES=()
ARCHES_BUILT=" "

for machine in "${MACHINES[@]}"; do
	log "Checking OrbStack machine '$machine'"
	if ! uname_value="$(orb -m "$machine" uname -m 2>&1)"; then
		printf '%s\n' "$uname_value"
		die "failed to run uname in OrbStack machine '$machine'"
	fi

	uname_value="$(printf '%s' "$uname_value" | tr -d '\r\n')"
	if ! goarch="$(goarch_for_uname "$uname_value")"; then
		die "unsupported architecture '$uname_value' for machine '$machine'"
	fi

	MACHINE_ARCHES+=("$machine:$goarch")
	log "Machine '$machine' reports '$uname_value'; using GOARCH=$goarch"
done

build_arch_if_needed() {
	goarch="$1"
	if [[ "$ARCHES_BUILT" == *" $goarch "* ]]; then
		log "Debug agent for linux/$goarch already built"
		return
	fi

	output="$BUILD_DIR/techulus-agent-debug-linux-$goarch"
	log "Building debug agent for linux/$goarch"
	(
		cd "$AGENT_DIR"
		run env CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" go build \
			-ldflags "-X techulus/cloud-agent/internal/agent.Version=$VERSION-$goarch" \
			-o "$output" \
			./cmd/agent
	)
	run ls -lh "$output"
	ARCHES_BUILT="$ARCHES_BUILT$goarch "
}

for entry in "${MACHINE_ARCHES[@]}"; do
	goarch="${entry#*:}"
	build_arch_if_needed "$goarch"
done

for entry in "${MACHINE_ARCHES[@]}"; do
	machine="${entry%%:*}"
	goarch="${entry#*:}"
	remote_binary="$MAC_BUILD_DIR/techulus-agent-debug-linux-$goarch"

	log "Installing debug agent on '$machine'"
	log "Remote binary path: $remote_binary"

	orb -m "$machine" -u root sh -s -- "$SERVICE_NAME" "$INSTALL_PATH" "$remote_binary" "$VERSION-$goarch" <<'REMOTE'
set -Eeuo pipefail

service_name="$1"
install_path="$2"
remote_binary="$3"
version="$4"

log() {
	printf '[remote:%s] %s\n' "$(hostname)" "$*"
}

log "Starting install for $service_name"
log "Expected version label: $version"
log "Using mounted binary: $remote_binary"

if [ ! -f "$remote_binary" ]; then
	log "ERROR: mounted binary does not exist: $remote_binary"
	exit 1
fi

log "Binary details:"
ls -lh "$remote_binary"

if command -v systemctl >/dev/null 2>&1; then
	if systemctl status "$service_name" >/dev/null 2>&1; then
		log "Stopping $service_name"
		systemctl stop "$service_name"
	else
		log "$service_name is not currently active; continuing"
	fi
else
	log "ERROR: systemctl not found"
	exit 1
fi

if [ -e "$install_path" ]; then
	backup_path="${install_path}.backup.$(date +%Y%m%d%H%M%S)"
	log "Backing up existing agent to $backup_path"
	cp -a "$install_path" "$backup_path"
else
	log "No existing agent found at $install_path"
fi

log "Installing new agent to $install_path"
install -m 0755 "$remote_binary" "$install_path"

log "Installed binary details:"
ls -lh "$install_path"

log "Starting $service_name"
systemctl start "$service_name"

log "Service status:"
systemctl status "$service_name" --no-pager

log "Recent service logs:"
journalctl -u "$service_name" -n 30 --no-pager
REMOTE

	log "Finished install on '$machine'"
done

log "All done"
log "Tail logs with: orb -m ${MACHINES[0]} -u root journalctl -u $SERVICE_NAME -f"
