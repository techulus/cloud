# GitHub Deployments

## Overview

Automatic deployments triggered by GitHub push events. Users install a GitHub App, connect their repository to a service, and pushes to a configured branch trigger builds and deployments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GITHUB                                   │
│  ┌──────────────┐         webhook          ┌─────────────────┐  │
│  │ Private Repo │─────────────────────────▶│   GitHub App    │  │
│  └──────────────┘                          └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                                      │
                                    installation token + clone URL
                                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CONTROL PLANE                               │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  Webhook    │───▶│  Build Job  │───▶│  Railpack + Podman  │  │
│  │  Handler    │    │   Queue     │    │      Builder        │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│                                                   │              │
│                                                   ▼              │
│                                        ┌─────────────────────┐  │
│                                        │   Push to Registry  │  │
│                                        │ registry.internal/  │  │
│                                        │ {project}/{service} │  │
│                                        │ :{commit_sha}       │  │
│                                        └─────────────────────┘  │
│                                                   │              │
│                                                   ▼              │
│                                        ┌─────────────────────┐  │
│                                        │   Deploy Work Item  │  │
│                                        └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          │                         │
                          │ WireGuard               │ gRPC
                          ▼                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         AGENTS                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ podman pull registry.internal/{project}/{service}:{sha}     ││
│  │ podman run ...                                               ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Flow

1. User installs GitHub App on their account/org
2. User connects a repository to a service
3. GitHub sends push webhook on commits
4. Control plane clones repo using installation token
5. Railpack generates Dockerfile, Podman builds image
6. Image pushed to self-hosted registry
7. Deploy work items created for all service replicas
8. Agents pull from registry and start containers

## Registry

### Options

| Option | Pros | Cons |
|--------|------|------|
| **Harbor** | Garbage collection, UI, vulnerability scanning | Heavier setup |
| **Docker Distribution** | Simple, lightweight, official | Basic features, manual GC |
| **Zot** | OCI-native, lightweight, built-in GC | Newer, less documentation |

### Recommendation

**Harbor** - Built-in garbage collection policies solve storage management automatically.

### Setup

- Run on control plane server (or dedicated build server)
- Expose only on WireGuard network (`registry.internal` via dnsmasq)
- Agents pull via WireGuard mesh - no public exposure

### Image Naming Convention

```
registry.internal/{project_id}/{service_id}:{commit_sha}
```

## Storage Management

### Harbor Tag Retention Policy

- Keep last 5 images per service
- Delete untagged images after 24 hours
- Delete images older than 30 days (except those in active deployments)

### Build Server Cleanup

```bash
# After successful push, remove local image
podman rmi registry.internal/{project}/{service}:{sha}

# Periodic cleanup of dangling images
podman image prune -f

# Aggressive cleanup if disk > 80%
podman system prune -af
```

### Database-Driven Cleanup

Query active deployments, delete images not referenced by any running container.

## Database Schema

See `web/db/schema.ts` for table definitions:
- `github_installations` - GitHub App installations per user
- `github_repos` - Links repositories to services
- `builds` - Build jobs and status

## GitHub App Configuration

### Required Permissions

- `contents: read` - Clone repositories
- `metadata: read` - Repository information
- `deployments: read & write` - Create deployment status on GitHub

### Webhook Events

- `push` - Trigger builds on commits
- `installation` - Track app installations

### Environment Variables

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=<base64-encoded-private-key>
GITHUB_WEBHOOK_SECRET=<random-secret>
```

To encode the private key: `cat private-key.pem | base64`

## Build Process

```
WEBHOOK HANDLER (Control Plane):
1. Receive push webhook
2. Verify webhook signature (GITHUB_WEBHOOK_SECRET)
3. Find linked service by repo_id in github_repos table
4. Create build record (status: 'pending')
5. Create GitHub Deployment via API (optional)

AGENT BUILD WORKER:
6. Agent polls for pending builds
7. Agent claims build (status: 'claimed', claimed_by set)
8. Update status → 'cloning'
9. Generate installation access token
10. Clone: git clone https://x-access-token:{token}@github.com/{owner}/{repo}.git
11. Checkout: git checkout {commit_sha}

12. Update status → 'building'
13. Run: railpack build . (generates Dockerfile)
14. Run: podman build -t {registry}/{project}/{service}:{sha} .

15. Update status → 'pushing'
16. Run: podman push {registry}/{project}/{service}:{sha}

17. Cleanup:
    - podman rmi {registry}/{project}/{service}:{sha}
    - rm -rf /tmp/build/{build_id}

18. Update status → 'completed', set image_uri
19. Update GitHub Deployment status → 'success'

ON FAILURE:
- Update status → 'failed', set error
- Update GitHub Deployment status → 'failure'
- Cleanup temp files

ON CANCEL:
- Update status → 'cancelled'
- Stop running build process
- Cleanup temp files
```

## User Flow

### Connecting GitHub

1. User clicks GitHub App install link
2. Redirected to `github.com/apps/{APP_NAME}/installations/new`
3. User selects repositories to grant access
4. GitHub redirects to `/api/github/setup?installation_id=...`
5. Setup handler stores installation in database
6. User redirected to dashboard

### Creating Service with GitHub Repo

1. User clicks "Add Service" in project
2. Selects "GitHub Repo" tab
3. Repo selector shows connected repos from installations
4. User can also paste any public GitHub URL
5. User selects repo, branch, and service name
6. Service created with `github_repos` entry (if from installation)

### Automatic Deployment (Connected Repos)

1. User pushes to configured branch
2. GitHub sends webhook to `/api/webhooks/github`
3. Build created and queued
4. Agent claims and runs build
5. User sees build status in dashboard
6. On success, service image updated

### Manual Build (Public Repos)

1. User navigates to service configuration
2. Clicks "Deploy" to trigger build
3. Build uses public clone URL
4. Same build process as automatic

## Implementation Status

### ✅ Completed

- GitHub App webhook handler (`/api/webhooks/github`)
- Installation setup handler (`/api/github/setup`)
- GitHub repo selector in create service dialog
- Build queue with agent claiming
- Railpack + Podman build on agents
- Registry push/pull via WireGuard
- Build logs streaming to VictoriaLogs
- Build details UI with status, logs, cancel, retry
- GitHub Deployments API integration

### 🔄 In Progress

- Auto-deploy configuration per repo/branch

### 📋 TODO

- Garbage collection policies for registry
- Build notifications (webhook/email)

## Security Considerations

1. **Webhook Verification** - Always verify GitHub signature using HMAC-SHA256
2. **Installation Tokens** - Short-lived (1 hour), scoped to installation
3. **Registry Access** - WireGuard-only, no public exposure
4. **Build Isolation** - Builds run on agent servers with Podman
5. **Secrets** - Never log tokens, base64 encode private key in env vars
