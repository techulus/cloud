# Registry

Docker Distribution registry for storing built container images. Agents push images here after builds, and pull them for deployments.

## Usage

```bash
docker compose up -d
```

## Configuration

- **Port**: 5000
- **Storage**: Filesystem at `/var/lib/registry`
- **Delete**: Enabled (for garbage collection)
- **Data**: Persisted in `registry-data` volume

## Image Naming

```
{registry_host}/{project_id}/{service_id}:{commit_sha}
```

## Network

Should only be accessible via WireGuard mesh - not exposed publicly.

## Garbage Collection

Garbage collection removes blobs that are no longer referenced by a manifest.
It does not choose which tagged images to retain: delete unwanted tags first,
then run garbage collection to reclaim their storage. This repository does not
install or schedule garbage collection automatically.

### Dry run

A dry run can run while the registry is serving traffic:

```bash
REGISTRY=techulus-cloud-registry-1

docker exec "$REGISTRY" \
  /bin/registry garbage-collect \
  --dry-run \
  --delete-untagged \
  /etc/docker/registry/config.yml
```

`--delete-untagged` removes untagged manifests so that their unreferenced blobs
can also be collected.

### Run garbage collection

Garbage collection must not race with image pushes. The following maintenance
script stops the registry while collecting, so the registry is briefly
unavailable. It also prevents overlapping runs and restarts the registry if
garbage collection fails.

Install it as `/usr/local/sbin/techulus-registry-gc`:

```bash
cat >/usr/local/sbin/techulus-registry-gc <<'EOF'
#!/bin/sh
set -eu

exec 9>/run/lock/techulus-registry-gc.lock
/usr/bin/flock -n 9 || exit 0

REGISTRY=${REGISTRY_CONTAINER:-techulus-cloud-registry-1}
IMAGE=$(/usr/bin/docker inspect --format '{{.Config.Image}}' "$REGISTRY")

restart_registry() {
    /usr/bin/docker start "$REGISTRY" >/dev/null 2>&1 || true
}

trap restart_registry EXIT
trap 'exit 1' HUP INT TERM

/usr/bin/docker stop "$REGISTRY"
/usr/bin/docker run --rm \
    --volumes-from "$REGISTRY" \
    --entrypoint /bin/registry \
    "$IMAGE" \
    garbage-collect \
    --delete-untagged \
    /etc/docker/registry/config.yml

restart_registry
trap - EXIT HUP INT TERM
EOF

chmod 0755 /usr/local/sbin/techulus-registry-gc
```

Run it manually with:

```bash
/usr/local/sbin/techulus-registry-gc
```

### Schedule weekly garbage collection

To run garbage collection every Sunday at 03:00, create
`/etc/cron.d/techulus-registry-gc` manually:

```cron
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 3 * * 0 root /usr/local/sbin/techulus-registry-gc 2>&1 | /usr/bin/logger -t techulus-registry-gc
```

View scheduled-run output with:

```bash
journalctl -t techulus-registry-gc
```

### Verify

After garbage collection, wait for the registry to report `healthy` and check
its storage usage:

```bash
docker inspect --format '{{.State.Health.Status}}' techulus-cloud-registry-1
docker run --rm --volumes-from techulus-cloud-registry-1 alpine du -sh /var/lib/registry
```
