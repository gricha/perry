---
sidebar_position: 3
---

# Agents

Perry workspaces come with AI coding tools pre-installed and can sync credentials and configs from the host.

## Run agents inside a workspace

```bash
perry shell myproject
claude
opencode
codex
pi
```

## What gets synced

- Agent credentials and configs from the host
- `~/.claude/` and `~/.codex/` if present
- OpenCode config plus `auth.json` and any MCP server settings
- Pi credentials and settings from `~/.pi/agent/`

Sync happens on workspace start and when you run `perry sync`.

## Sessions in the Web UI

The Sessions tab is a history and shortcut list. Opening a session drops you into a terminal in that workspace.

## Workflows

- [OpenCode Workflow](./workflows/opencode.md)
- [Claude Code and Codex Workflow](./workflows/claude-code.md)
- [Pi Workflow](./workflows/pi.md)

## Perry skill

There is a command-focused Agent Skill available at `skills/perry/SKILL.md` and documented in [Skills](./skills.md).

## Configure agents

Set OpenCode server defaults in the Web UI (Settings > Agents), use the setup wizard, or edit `config.json` directly. See [Configuration: Agents](./configuration/agents.md).
