export interface PortMapping {
  host: number;
  container: number;
}

export type TailscaleStatus = 'none' | 'connected' | 'failed';

export interface WorkspaceTailscale {
  status: TailscaleStatus;
  hostname?: string;
  ip?: string;
  error?: string;
}

export interface WorkspaceInfo {
  name: string;
  status: 'running' | 'stopped' | 'creating' | 'error';
  containerId: string;
  created: string;
  repo?: string;
  ports: {
    ssh: number;
    http?: number;
    forwards?: PortMapping[];
  };
  lastUsed?: string;
  tailscale?: WorkspaceTailscale;
  startup?: WorkspaceStartupState;
}

export type WorkspaceStartupStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface WorkspaceStartupStep {
  id: string;
  label: string;
  status: WorkspaceStartupStatus;
  message?: string;
}

export interface WorkspaceStartupState {
  steps: WorkspaceStartupStep[];
  updatedAt: string;
}

export interface RecentSession {
  workspaceName: string;
  sessionId: string;
  agentType: 'claude-code' | 'opencode' | 'codex';
  lastAccessed: string;
}

export interface InfoResponse {
  hostname: string;
  uptime: number;
  workspacesCount: number;
  dockerVersion: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  clone?: string;
}

export interface Credentials {
  env: Record<string, string>;
  files: Record<string, string>;
}

export interface Scripts {
  post_start?: string[];
  fail_on_error?: boolean;
}

export interface CodingAgents {
  opencode?: {
    server?: {
      hostname?: string;
      username?: string;
      password?: string;
    };
  };
  github?: {
    token?: string;
  };
}

export type SkillAppliesTo = 'all' | AgentType[];

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  appliesTo: SkillAppliesTo;
  /** Full SKILL.md contents (including YAML frontmatter). */
  skillMd: string;
}

export type McpServerType = 'local' | 'remote';

export type McpOauthConfig =
  | false
  | {
      clientId?: string;
      clientSecret?: string;
      scope?: string;
    };

export interface McpServerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  type: McpServerType;

  // Local
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // Remote
  url?: string;
  headers?: Record<string, string>;

  // OpenCode-specific OAuth config
  oauth?: McpOauthConfig;
}

export type Skill = SkillDefinition;

export type McpServer = McpServerDefinition;

export const AGENT_TYPES = ['claude-code', 'opencode', 'codex', 'pi'] as const;

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  provider?: string;
}

export type AgentType = 'claude-code' | 'opencode' | 'codex' | 'pi';

export interface SessionInfo {
  id: string;
  name: string | null;
  agentType: AgentType;
  agentSessionId?: string | null;
  projectPath: string;
  messageCount: number;
  lastActivity: string;
  firstPrompt: string | null;
}

export interface SessionInfoWithWorkspace extends SessionInfo {
  workspaceName: string;
}

export interface SessionMessage {
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string | null;
  timestamp: string | null;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
}

export interface SessionDetail {
  id: string;
  agentType?: AgentType;
  agentSessionId?: string | null;
  messages: SessionMessage[];
}

export const HOST_WORKSPACE_NAME = '@host';

export interface HostInfo {
  enabled: boolean;
  hostname: string;
  username: string;
  homeDir: string;
}

export interface SSHKeyConfig {
  copy: string[];
  authorize: string[];
}

export interface SSHSettings {
  autoAuthorizeHostKeys: boolean;
  global: SSHKeyConfig;
  workspaces: Record<string, Partial<SSHKeyConfig>>;
}

export interface SSHKeyInfo {
  name: string;
  path: string;
  publicKeyPath: string;
  type: 'ed25519' | 'rsa' | 'ecdsa' | 'dsa' | 'unknown';
  fingerprint: string;
  hasPrivateKey: boolean;
}

export interface TerminalSettings {
  preferredShell?: string;
  detectedShell?: string;
}

export interface TailscaleConfig {
  enabled: boolean;
  authKey?: string;
  hostnamePrefix?: string;
}
