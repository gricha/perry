import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type {
  WorkspaceInfo,
  WorkspaceTailscale,
  TailscaleStatus,
  InfoResponse,
  CreateWorkspaceRequest,
  Credentials,
  Scripts,
  CodingAgents,
  AgentType,
  SessionInfo,
  SessionMessage,
  SessionDetail,
  HostInfo,
  SSHSettings,
  SSHKeyInfo,
  RecentSession,
  ModelInfo,
  TerminalSettings,
  PortMapping,
  Skill,
  McpServer,
  TailscaleConfig,
} from '@shared/client-types';

export interface GitHubRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

export type {
  WorkspaceInfo,
  InfoResponse,
  CreateWorkspaceRequest,
  Credentials,
  Scripts,
  CodingAgents,
  AgentType,
  SessionInfo,
  SessionMessage,
  SessionDetail,
  HostInfo,
  SSHSettings,
  SSHKeyInfo,
  RecentSession,
  ModelInfo,
  TerminalSettings,
  PortMapping,
  Skill,
  WorkspaceTailscale,
  TailscaleStatus,
  TailscaleConfig,
};

const TOKEN_STORAGE_KEY = 'perry_auth_token';

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  initClient();
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  initClient();
}

export function getToken(): string | null {
  return getStoredToken();
}

function getRpcUrl(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/rpc`;
  }
  return '/rpc';
}

type ClientType = {
  workspaces: {
    list: () => Promise<WorkspaceInfo[]>;
    get: (input: { name: string }) => Promise<WorkspaceInfo>;
    create: (input: CreateWorkspaceRequest) => Promise<WorkspaceInfo>;
    delete: (input: { name: string }) => Promise<{ success: boolean }>;
    start: (input: {
      name: string;
      clone?: string;
      env?: Record<string, string>;
    }) => Promise<WorkspaceInfo>;
    stop: (input: { name: string }) => Promise<WorkspaceInfo>;
    logs: (input: { name: string; tail?: number }) => Promise<string>;
    sync: (input: { name: string }) => Promise<{ success: boolean }>;
    syncAll: () => Promise<{
      synced: number;
      failed: number;
      results: { name: string; success: boolean; error?: string }[];
    }>;
    touch: (input: { name: string }) => Promise<WorkspaceInfo>;
    getPortForwards: (input: { name: string }) => Promise<{ forwards: PortMapping[] }>;
    setPortForwards: (input: { name: string; forwards: PortMapping[] }) => Promise<WorkspaceInfo>;
    clone: (input: { sourceName: string; cloneName: string }) => Promise<WorkspaceInfo>;
  };
  sessions: {
    list: (input: {
      workspaceName: string;
      agentType?: AgentType;
      limit?: number;
      offset?: number;
    }) => Promise<{ sessions: SessionInfo[]; total: number; hasMore: boolean }>;
    get: (input: {
      workspaceName: string;
      sessionId: string;
      agentType?: AgentType;
      limit?: number;
      offset?: number;
    }) => Promise<SessionDetail & { total: number; hasMore: boolean }>;
    rename: (input: {
      workspaceName: string;
      sessionId: string;
      name: string;
    }) => Promise<{ success: boolean }>;
    clearName: (input: {
      workspaceName: string;
      sessionId: string;
    }) => Promise<{ success: boolean }>;
    getRecent: (input: { limit?: number }) => Promise<{ sessions: RecentSession[] }>;
    recordAccess: (input: {
      workspaceName: string;
      sessionId: string;
      agentType: AgentType;
    }) => Promise<{ success: boolean }>;
    delete: (input: {
      workspaceName: string;
      sessionId: string;
      agentType: AgentType;
    }) => Promise<{ success: boolean }>;
    search: (input: { workspaceName: string; query: string }) => Promise<{
      results: Array<{
        sessionId: string;
        agentType: AgentType;
        matchCount: number;
        agentSessionId?: string;
      }>;
    }>;
  };
  models: {
    list: (input: {
      agentType: 'claude-code' | 'opencode';
      workspaceName?: string;
    }) => Promise<{ models: ModelInfo[] }>;
  };
  github: {
    listRepos: (input: { search?: string; perPage?: number; page?: number }) => Promise<{
      configured: boolean;
      repos: GitHubRepo[];
      hasMore: boolean;
    }>;
  };
  info: () => Promise<InfoResponse>;
  host: {
    info: () => Promise<HostInfo>;
  };
  config: {
    credentials: {
      get: () => Promise<Credentials>;
      update: (input: Credentials) => Promise<Credentials>;
    };
    scripts: {
      get: () => Promise<Scripts>;
      update: (input: Scripts) => Promise<Scripts>;
    };
    agents: {
      get: () => Promise<CodingAgents>;
      update: (input: CodingAgents) => Promise<CodingAgents>;
    };
    ssh: {
      get: () => Promise<SSHSettings>;
      update: (input: SSHSettings) => Promise<SSHSettings>;
      listKeys: () => Promise<SSHKeyInfo[]>;
    };
    terminal: {
      get: () => Promise<TerminalSettings>;
      update: (input: { preferredShell?: string }) => Promise<{ preferredShell?: string }>;
    };
    skills: {
      get: () => Promise<Skill[]>;
      update: (input: Skill[]) => Promise<Skill[]>;
    };
    mcp: {
      get: () => Promise<McpServer[]>;
      update: (input: McpServer[]) => Promise<McpServer[]>;
    };
    tailscale: {
      get: () => Promise<{ enabled: boolean; authKey?: string; hostnamePrefix?: string }>;
      update: (input: {
        enabled?: boolean;
        authKey?: string;
        hostnamePrefix?: string;
      }) => Promise<{ enabled: boolean; authKey?: string; hostnamePrefix?: string }>;
    };
    auth: {
      get: () => Promise<{ hasToken: boolean; tokenPreview?: string }>;
      generate: () => Promise<{ token: string }>;
      disable: () => Promise<{ success: boolean }>;
    };
  };
};

let link: RPCLink<Record<string, unknown>>;
let client: ClientType;

function initClient() {
  const token = getStoredToken();
  link = new RPCLink({
    url: getRpcUrl(),
    fetch: (url, init) => {
      const headers = new Headers((init as RequestInit)?.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return fetch(url, { ...(init as RequestInit), headers });
    },
  });
  client = createORPCClient<ClientType>(link);
}

initClient();

export const api = {
  listWorkspaces: () => client.workspaces.list(),
  getWorkspace: (name: string) => client.workspaces.get({ name }),
  createWorkspace: (data: CreateWorkspaceRequest) => client.workspaces.create(data),
  deleteWorkspace: (name: string) => client.workspaces.delete({ name }),
  startWorkspace: (name: string, options?: { clone?: string; env?: Record<string, string> }) =>
    client.workspaces.start({ name, clone: options?.clone, env: options?.env }),
  stopWorkspace: (name: string) => client.workspaces.stop({ name }),
  getLogs: (name: string, tail = 100) => client.workspaces.logs({ name, tail }),
  syncWorkspace: (name: string) => client.workspaces.sync({ name }),
  syncAllWorkspaces: () => client.workspaces.syncAll(),
  touchWorkspace: (name: string) => client.workspaces.touch({ name }),
  getPortForwards: (name: string) => client.workspaces.getPortForwards({ name }),
  setPortForwards: (name: string, forwards: PortMapping[]) =>
    client.workspaces.setPortForwards({ name, forwards }),
  cloneWorkspace: (sourceName: string, cloneName: string) =>
    client.workspaces.clone({ sourceName, cloneName }),
  listSessions: (workspaceName: string, agentType?: AgentType, limit?: number, offset?: number) =>
    client.sessions.list({ workspaceName, agentType, limit, offset }),
  getRecentSessions: (limit?: number) => client.sessions.getRecent({ limit }),
  recordSessionAccess: (workspaceName: string, sessionId: string, agentType: AgentType) =>
    client.sessions.recordAccess({ workspaceName, sessionId, agentType }),
  getSession: (
    workspaceName: string,
    sessionId: string,
    agentType?: AgentType,
    limit?: number,
    offset?: number
  ) => client.sessions.get({ workspaceName, sessionId, agentType, limit, offset }),
  renameSession: (workspaceName: string, sessionId: string, name: string) =>
    client.sessions.rename({ workspaceName, sessionId, name }),
  clearSessionName: (workspaceName: string, sessionId: string) =>
    client.sessions.clearName({ workspaceName, sessionId }),
  deleteSession: (workspaceName: string, sessionId: string, agentType: AgentType) =>
    client.sessions.delete({ workspaceName, sessionId, agentType }),
  searchSessions: (workspaceName: string, query: string) =>
    client.sessions.search({ workspaceName, query }),
  getInfo: () => client.info(),
  getCredentials: () => client.config.credentials.get(),
  updateCredentials: (data: Credentials) => client.config.credentials.update(data),
  getScripts: () => client.config.scripts.get(),
  updateScripts: (data: Scripts) => client.config.scripts.update(data),
  getAgents: () => client.config.agents.get(),
  updateAgents: (data: CodingAgents) => client.config.agents.update(data),
  getHostInfo: () => client.host.info(),
  getSSHSettings: () => client.config.ssh.get(),
  updateSSHSettings: (data: SSHSettings) => client.config.ssh.update(data),
  listSSHKeys: () => client.config.ssh.listKeys(),
  listGitHubRepos: (search?: string, perPage?: number, page?: number) =>
    client.github.listRepos({ search, perPage, page }),
  getTerminalSettings: () => client.config.terminal.get(),
  updateTerminalSettings: (data: { preferredShell?: string }) =>
    client.config.terminal.update(data),
  getTailscaleConfig: () => client.config.tailscale.get(),
  updateTailscaleConfig: (data: { enabled?: boolean; authKey?: string; hostnamePrefix?: string }) =>
    client.config.tailscale.update(data),
  getSkills: () => client.config.skills.get(),
  updateSkills: (data: Skill[]) => client.config.skills.update(data),
  getMcpServers: () => client.config.mcp.get(),
  updateMcpServers: (data: McpServer[]) => client.config.mcp.update(data),
  getAuthConfig: () => client.config.auth.get(),
  generateAuthToken: () => client.config.auth.generate(),
  disableAuth: () => client.config.auth.disable(),
};

export function getTerminalUrl(name: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/rpc/terminal/${encodeURIComponent(name)}`;
}
