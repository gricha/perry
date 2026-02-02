---
sidebar_position: 3
---

# Agents

Configure agent sync behavior and OpenCode server defaults.

## Credentials sync

Perry copies host credentials into each workspace when they exist:

- Claude Code: `~/.claude/.credentials.json`
- OpenCode: `~/.config/opencode/opencode.json`, `~/.local/share/opencode/auth.json`
- Codex CLI: `~/.codex/`
- Pi: `~/.pi/agent/auth.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/models.json`

## OpenCode

```json
{
  "agents": {
    "opencode": {
      "server": {
        "hostname": "0.0.0.0",
        "username": "opencode",
        "password": "your-password"
      }
    }
  }
}
```

Perry starts `opencode serve` inside workspaces on port 4096 when the `opencode` binary is available.

## GitHub token

```json
{
  "agents": {
    "github": {
      "token": "ghp_..."
    }
  }
}
```

This sets `GITHUB_TOKEN` inside the workspace.

## Apply changes

Restart or sync a workspace:

```bash
perry sync myproject
```
