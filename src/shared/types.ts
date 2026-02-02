export interface WorkspaceCredentials {
  env: Record<string, string>;
  /**
   * File or directory mappings from host to workspace.
   * Key is destination path (in workspace), value is source path (on host).
   * Paths starting with ~/ are expanded to the home directory.
   * Directories are copied recursively via TAR.
   * Example: { "~/.ssh/id_rsa": "~/.ssh/id_rsa", "~/.config/myapp": "~/.config/myapp" }
   */
  files: Record<string, string>;
}

export interface WorkspaceScripts {
  post_start?: string[];
  fail_on_error?: boolean;
}

export interface CodingAgents {
  opencode?: {
    server?: {
      /** Hostname passed to `opencode serve --hostname` inside workspaces. */
      hostname?: string;
      /** Optional HTTP basic auth username for `opencode serve`. */
      username?: string;
      /** Optional HTTP basic auth password for `opencode serve`. */
      password?: string;
    };
  };
  github?: {
    token?: string;
  };
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

export interface TerminalSettings {
  preferredShell?: string;
}

export interface AuthConfig {
  token?: string;
}

export type TailscaleStatus = 'none' | 'connected' | 'failed';

export interface TailscaleConfig {
  enabled: boolean;
  authKey: string;
  hostnamePrefix?: string;
}

export interface WorkspaceTailscale {
  status: TailscaleStatus;
  hostname?: string;
  ip?: string;
  error?: string;
}

export type SkillAppliesTo = 'all' | Array<'claude-code' | 'opencode' | 'codex' | 'pi'>;

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

type McpOauthConfig =
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

export interface AgentConfig {
  port: number;
  credentials: WorkspaceCredentials;
  scripts: WorkspaceScripts;
  agents?: CodingAgents;
  skills?: SkillDefinition[];
  mcpServers?: McpServerDefinition[];
  allowHostAccess?: boolean;
  ssh?: SSHSettings;
  terminal?: TerminalSettings;
  tailscale?: TailscaleConfig;
  auth?: AuthConfig;
}

export interface ClientConfig {
  agent?: string;
  token?: string;
  /** @deprecated Use 'agent' instead */
  worker?: string;
}

export type WorkspaceStatus = 'running' | 'stopped' | 'creating' | 'error';
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

export interface PortMapping {
  host: number;
  container: number;
}

export interface WorkspacePorts {
  ssh: number;
  http?: number;
  forwards?: PortMapping[];
}

export interface WorkspaceInfo {
  name: string;
  status: WorkspaceStatus;
  containerId: string;
  created: string;
  repo?: string;
  ports: WorkspacePorts;
  lastUsed?: string;
  tailscale?: WorkspaceTailscale;
  startup?: WorkspaceStartupState;
}

export interface WorkspaceState {
  workspaces: Record<string, WorkspaceInfo>;
}

export interface CreateWorkspaceRequest {
  name: string;
  clone?: string;
  env?: Record<string, string>;
}

export interface ApiError {
  error: string;
  code?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface TailscaleInfo {
  running: boolean;
  dnsName?: string;
  serveActive: boolean;
  httpsUrl?: string;
}

export interface InfoResponse {
  hostname: string;
  uptime: number;
  workspacesCount: number;
  dockerVersion: string;
  terminalConnections: number;
  tailscale?: TailscaleInfo;
}

export const DEFAULT_CONFIG_DIR =
  process.env.PERRY_CONFIG_DIR || `${process.env.HOME}/.config/perry`;
export const STATE_FILE = 'state.json';
export const CONFIG_FILE = 'config.json';
export const CLIENT_CONFIG_FILE = 'client.json';
