# Agent Instructions

## Skills

Use the `skill` tool for common workflows:

| Skill | When to use |
|-------|-------------|
| `validate` | Before committing, after changes, to verify code quality |
| `test` | To run targeted tests for your changes |
| `release` | To cut a new version release |
| `create-pr` | To create a pull request with concise description |

If validation fails due to missing tools, install dependencies first with `bun install`.

## Code Review

Code reviews (security, react best practices, code simplification) are handled automatically by [Warden](https://github.com/getsentry/warden) on pull requests. See `warden.toml` for the configured triggers.

## Architecture

Read `DESIGN.md` for comprehensive architecture, data models, and API specifications.

Perry is a distributed development environment orchestrator using Docker-in-Docker containers.

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript with ES modules
- **API**: oRPC server with WebSocket terminals
- **Clients**: CLI with TUI, React web UI, React Native mobile app

## Implementation Patterns

- **Docker Operations**: CLI spawning (`src/docker/`), not Docker SDK
- **State Management**: File-locked JSON (`~/.config/perry/state.json`)
- **oRPC API**: Type-safe client/server communication
- **Worker Binary**: Compiled bun binary synced to containers

## Code Style

- Fight entropy - leave the codebase better than you found it. Prefer simpler solutions where it reasonably makes sense.
- Minimal dependencies
- Early returns, fail fast
- TypeScript strict mode
- Use `withLock()` for state mutations
- No comments in code (self-documenting)

## Constraints

- No CLI command additions without approval
- No complex bash in docker exec (use TypeScript)
- No skipping failing tests
- Use SSH for user interaction (not `docker exec`)
- Follow naming: `workspace-<name>` containers, `workspace-internal-` resources

## Mobile

Install deps and run on iOS device:
```bash
cd mobile && bun install
bunx expo run:ios --device "<Your iPhone Name>" --no-bundler  # Terminal 1
bunx expo start --dev-client                                   # Terminal 2
```

Environment: `mobile/.env.local` (use `EXPO_PUBLIC_` prefix for runtime vars)
