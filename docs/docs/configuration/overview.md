---
sidebar_position: 1
---

# Configuration Overview

Perry stores configuration in `~/.config/perry/`.

You can override the config directory with `PERRY_CONFIG_DIR` or `WS_CONFIG_DIR`.

## Configuration Files

| File | Purpose |
|------|---------|
| `config.json` | Agent configuration (credentials, SSH keys, scripts) |
| `client.json` | Client configuration (remote agent hostname) |
| `state.json` | Workspace state (managed automatically) |

## Agent Configuration

Location: `~/.config/perry/config.json`

```json
{
  "port": 7391,
  "host": "0.0.0.0",
  "credentials": {
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-...",
      "DATABASE_URL": "postgres://..."
    },
    "files": {
      "~/.gitconfig": "~/.gitconfig"
    }
  },
  "agents": {
    "github": {
      "token": "ghp_..."
    },
    "opencode": {
      "server": {
        "hostname": "0.0.0.0"
      }
    }
  },
  "ssh": {
    "autoAuthorizeHostKeys": true,
    "global": {
      "copy": ["~/.ssh/id_ed25519"],
      "authorize": ["~/.ssh/id_ed25519.pub"]
    },
    "workspaces": {}
  },
  "scripts": {
    "post_start": [
      "~/.perry/userscripts",
      "~/scripts/setup.sh"
    ],
    "fail_on_error": false
  },
  "tailscale": {
    "authKey": "tskey-auth-..."
  },
  "allowHostAccess": true
}
```

## Edit Configuration

**Option 1: Web UI**

Go to http://localhost:7391 and click Settings.

**Option 2: Edit file directly**

```bash
$EDITOR ~/.config/perry/config.json
```

**Option 3: Interactive wizard**

```bash
perry agent config
```

**Option 4: CLI commands**

```bash
perry agent show-config
perry ssh copy ~/.ssh/id_ed25519
```

## Apply Changes

Configuration changes take effect:
- **Immediately** for new workspaces
- **On sync** for running workspaces: `perry sync <name>`
- **On restart** for stopped workspaces

## Client Configuration

Location: `~/.config/perry/client.json`

Used when connecting to a remote agent from your local machine.

```json
{
  "agent": "myserver.tail1234.ts.net:7391"
}
```

Set via CLI:

```bash
perry config agent myserver.tail1234.ts.net
```

If you run any `perry` command without configuring an agent (and no local agent is running), Perry will interactively prompt you for the agent hostname.

## Bind Host

The `host` setting controls which network interface the agent listens on.

| Value | Description |
|-------|-------------|
| `0.0.0.0` | All interfaces (default) — accessible from other devices on the network |
| `127.0.0.1` | Localhost only — only accessible from this machine |
| Custom IP | Bind to a specific network interface |

You can set this via:

- **Config file**: `"host": "127.0.0.1"` in `config.json`
- **CLI flag**: `perry agent run --host 127.0.0.1`
- **Environment variable**: `PERRY_HOST=127.0.0.1`
- **Setup wizard**: `perry agent config` (Network step)

Priority: CLI flag > `PERRY_HOST` env var > config file > `0.0.0.0`

Use `127.0.0.1` if you only access Perry from the same machine, or if corporate security policies flag services listening on all interfaces. Use `0.0.0.0` if you need remote access (e.g., via Tailscale or from other machines on the LAN).

## Configuration Sections

- [Credentials](./credentials.md) - Env vars, files, and SSH keys
- [Agents](./agents.md) - Agent sync, OpenCode server, GitHub token
- [Scripts](./scripts.md) - Run scripts after workspace starts
- [Tailscale](./tailscale.md) - Remote agent access and workspace networking
- [GitHub](./github.md) - Token setup and cloning
