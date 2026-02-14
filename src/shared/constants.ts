export const DEFAULT_AGENT_PORT = 7391;

export const DEFAULT_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_OPENCODE_MODEL = 'opencode/claude-sonnet-4';

export const SSH_PORT_RANGE_START = 2200;
export const SSH_PORT_RANGE_END = 2400;

export const WORKSPACE_IMAGE_LOCAL = 'perry:latest';
export const WORKSPACE_IMAGE_REGISTRY = 'ghcr.io/gricha/perry';

export const VOLUME_PREFIX = 'workspace-';
export const CONTAINER_PREFIX = 'workspace-';

export const AGENT_SESSION_PATHS = {
  claudeCode: '.claude/projects',
  opencode: '.local/share/opencode',
  codex: '.codex/sessions',
  pi: '.pi/agent/sessions',
} as const;
