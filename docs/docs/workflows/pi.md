---
sidebar_position: 3
---

# Pi Workflow

Pi runs inside workspaces as a terminal-based coding agent. Connect via a terminal and run the client in the workspace.

## 1) Configure credentials

Sign in to Pi on the host via `pi` then `/login`, or set the `ANTHROPIC_API_KEY` environment variable. Perry syncs the following from the host if they exist:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/settings.json`
- `~/.pi/agent/models.json`

You can also set `ANTHROPIC_API_KEY` in Perry's environment config:

```json
{
  "credentials": {
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-..."
    }
  }
}
```

## 2) Start a workspace

```bash
perry start myproject
```

## 3) Run inside the workspace

```bash
perry shell myproject
pi
```

## Resume a session

Pi sessions are tracked in the Web UI. Clicking a session runs `pi --session <id>` in a terminal.

You can also resume manually:

```bash
pi -c              # continue most recent
pi --session <id>  # resume specific session
pi -r              # browse past sessions
```

## Ways to connect

- `perry shell` from any machine pointed at the agent
- Web UI terminal from the workspace page
- SSH directly (Tailscale) or with a client like Termius
