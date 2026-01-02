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
