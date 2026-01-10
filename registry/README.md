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

Clean up unreferenced image layers to reclaim storage space.

**Dry-run** (see what would be deleted):
```bash
docker exec registry /bin/registry garbage-collect --dry-run /etc/docker/registry/config.yml
```

**Run GC**:
```bash
docker exec registry /bin/registry garbage-collect /etc/docker/registry/config.yml
```

**Scheduled GC** (daily at 2 AM via cron):
```bash
0 2 * * * docker exec registry /bin/registry garbage-collect /etc/docker/registry/config.yml >> /var/log/registry-gc.log 2>&1
```
