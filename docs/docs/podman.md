---
sidebar_position: 10
---

# Podman Support

Perry supports running with Podman as an alternative to Docker. This allows you to use Perry in environments where Podman is preferred or required.

## Overview

When using Podman, Perry workspaces connect to an external container engine instead of running Docker-in-Docker. This is achieved through a podman-in-podman sidecar pattern where the workspace container connects to the host's Podman socket.

## Prerequisites

- **Podman** - [Install Podman](https://podman.io/getting-started/installation)
- **Podman socket enabled** - Required for container management
- **macOS or Linux** - Windows via WSL2

Verify Podman is running:

```bash
podman info
```

Enable the Podman socket:

```bash
# On systemd-based systems
systemctl --user enable --now podman.socket

# Verify socket is running
systemctl --user status podman.socket
```

## Configuration

Add the `runtime` field to your Perry configuration file (`~/.perry/config.json`):

```json
{
  "runtime": "podman",
  "port": 7391,
  "host": "0.0.0.0",
  "credentials": {
    "env": {},
    "files": {}
  },
  "scripts": {
    "post_start": [],
    "fail_on_error": false
  }
}
```

The `runtime` field accepts two values:
- `"docker"` (default) - Use Docker with Docker-in-Docker
- `"podman"` - Use external Podman engine

## Building the Workspace Image

When building a workspace image for Podman, use the `RUNTIME` build argument:

```bash
# Build for Podman
podman build \
  --build-arg RUNTIME=podman \
  -t perry-workspace:podman \
  -f perry/Dockerfile.base \
  .

# Build for Docker (default)
docker build \
  -t perry-workspace:latest \
  -f perry/Dockerfile.base \
  .
```

The `RUNTIME=podman` build argument:
- Skips Docker CE installation
- Omits containerd.io and Docker plugins
- Sets `DOCKER_HOST=tcp://host.containers.internal:2375` environment variable

## Podman-in-Podman Sidecar Pattern

Perry workspaces running with Podman use an external container engine. The workspace container connects to the host's Podman socket through the `DOCKER_HOST` environment variable.

### Container Creation

When `runtime: "podman"` is configured, Perry:
- Does NOT set `privileged: true` on workspace containers
- Skips the Docker-in-Docker volume (`workspace-name-docker` → `/var/lib/docker`)
- Relies on `DOCKER_HOST` for container operations

### Entrypoint Behavior

The workspace entrypoint (`perry/internal/src/commands/entrypoint.ts`) checks for the `DOCKER_HOST` environment variable:
- If set: Skips `ensureDockerd()` and `waitForDocker()`
- If not set: Starts Docker daemon as normal (Docker-in-Docker)

All other initialization (SSH, Tailscale, user scripts) proceeds normally.

## Networking

When using Podman, ensure the workspace container can reach the host's Podman socket:

```bash
# Start workspace with host network access
podman run \
  --network slirp4netns:allow_host_loopback=true \
  ...
```

Or expose the Podman socket on a TCP port:

```bash
# Expose Podman socket on TCP (development only)
podman system service --time=0 tcp:0.0.0.0:2375
```

**Security Note**: Exposing the Podman socket on TCP without authentication is insecure. Use this only in trusted development environments.

## Differences from Docker

| Feature | Docker | Podman |
|---------|--------|--------|
| Privileged mode | Required | Not used |
| Docker-in-Docker volume | Created | Skipped |
| Container engine | Internal (dind) | External (host) |
| Socket location | `/var/run/docker.sock` | Via `DOCKER_HOST` |

## Troubleshooting

### Workspace can't connect to Podman

Check that `DOCKER_HOST` is set correctly:

```bash
perry exec <workspace-name> -- env | grep DOCKER_HOST
```

Verify the Podman socket is accessible:

```bash
podman system connection list
```

### Permission denied errors

Ensure the workspace user has access to the Podman socket. You may need to adjust socket permissions or run Podman in rootless mode.

### Container operations fail

Check Podman logs:

```bash
journalctl --user -u podman.socket -f
```

## Limitations

- Docker Compose may have compatibility issues with Podman
- Some Docker-specific features may not work identically
- Performance characteristics differ from Docker-in-Docker

## Next Steps

- [Workspaces](./workspaces.md) - Learn about workspace management
- [Configuration](./configuration/overview.md) - Advanced configuration options
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
