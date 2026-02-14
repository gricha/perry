import { os, ORPCError } from '@orpc/server';
import * as z from 'zod';
import os_module from 'os';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AgentConfig } from '../shared/types';
import { HOST_WORKSPACE_NAME } from '../shared/client-types';
import { AnyWorkspaceNameSchema, UserWorkspaceNameSchema } from '../shared/workspace-name';
import type { ModelInfo } from '../models/cache';
import { getDockerVersion, execInContainer, getContainerName, type ExecResult } from '../docker';
import { createWorkerClient } from '../worker/client';
import type { WorkspaceManager } from '../workspace/manager';
interface TerminalServerLike {
  closeConnectionsForWorkspace(workspaceName: string): void;
  getConnectionCount(): number;
}
import { saveAgentConfig } from '../config/loader';
import {
  setSessionName,
  getSessionNamesForWorkspace,
  deleteSessionName,
} from '../sessions/metadata';
import * as sessionRegistry from '../sessions/registry';
import { discoverSSHKeys } from '../ssh/discovery';
import type { SessionMessage } from '../sessions/types';
import {
  discoverAllSessions,
  getSessionDetails as getAgentSessionDetails,
  getSessionMessages,
  findSessionMessages,
  deleteSession as deleteSessionFromProvider,
  searchSessions as searchSessionsInContainer,
} from '../sessions/agents';
import { decodeClaudeProjectPath } from '../sessions/agents/utils';
import type { SessionsCacheManager } from '../sessions/cache';
import type { ModelCacheManager } from '../models/cache';
import {
  discoverClaudeCodeModels,
  discoverHostOpencodeModels,
  discoverContainerOpencodeModels,
  shouldUseCachedOpencodeModels,
} from '../models/discovery';
import { deleteOpencodeSession } from '../sessions/agents/opencode-storage';
import { SessionIndex } from '../worker/session-index';
import type { AgentType } from '../session-manager/types';

const WorkspaceStatusSchema = z.enum(['running', 'stopped', 'creating', 'error']);

const PortMappingSchema = z.object({
  host: z.number().int().min(1).max(65535),
  container: z.number().int().min(1).max(65535),
});

const WorkspacePortsSchema = z.object({
  ssh: z.number(),
  http: z.number().optional(),
  forwards: z.array(PortMappingSchema).optional(),
});

const WorkspaceTailscaleSchema = z.object({
  status: z.enum(['none', 'connected', 'failed']),
  hostname: z.string().optional(),
  ip: z.string().optional(),
  error: z.string().optional(),
});

const WorkspaceInfoSchema = z.object({
  name: z.string(),
  status: WorkspaceStatusSchema,
  containerId: z.string(),
  created: z.string(),
  repo: z.string().optional(),
  ports: WorkspacePortsSchema,
  lastUsed: z.string().optional(),
  tailscale: WorkspaceTailscaleSchema.optional(),
});

const CredentialsSchema = z.object({
  env: z.record(z.string(), z.string()),
  files: z.record(z.string(), z.string()),
});

const ScriptsSchema = z.object({
  post_start: z.array(z.string()).optional(),
  fail_on_error: z.boolean().optional(),
});

const CodingAgentsSchema = z.object({
  opencode: z
    .object({
      server: z
        .object({
          hostname: z.string().optional(),
          username: z.string().optional(),
          password: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  github: z
    .object({
      token: z.string().optional(),
    })
    .optional(),
});

const AgentTypeSchema = z.enum(['claude-code', 'opencode', 'codex', 'pi']);

const SkillAppliesToSchema = z.union([z.literal('all'), z.array(AgentTypeSchema)]);

const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/);

const SkillDefinitionSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  enabled: z.boolean(),
  appliesTo: SkillAppliesToSchema,
  skillMd: z.string(),
});

const McpServerTypeSchema = z.enum(['local', 'remote']);

const McpOauthSchema = z.union([
  z.literal(false),
  z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

const McpServerDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    type: McpServerTypeSchema,

    // Local
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),

    // Remote
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),

    // OpenCode-specific OAuth config
    oauth: McpOauthSchema.optional(),
  })
  .strict();

const SkillsSchema = z.array(SkillDefinitionSchema);
const McpServersSchema = z.array(McpServerDefinitionSchema);

const SSHKeyConfigSchema = z.object({
  copy: z.array(z.string()),
  authorize: z.array(z.string()),
});

const SSHSettingsSchema = z.object({
  autoAuthorizeHostKeys: z.boolean(),
  global: SSHKeyConfigSchema,
  workspaces: z.record(z.string(), SSHKeyConfigSchema.partial()),
});

const SSHKeyInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  publicKeyPath: z.string(),
  type: z.enum(['ed25519', 'rsa', 'ecdsa', 'dsa', 'unknown']),
  fingerprint: z.string(),
  hasPrivateKey: z.boolean(),
});

const TerminalSettingsSchema = z.object({
  preferredShell: z.string().optional(),
});

const TailscaleConfigSchema = z.object({
  enabled: z.boolean(),
  authKey: z.string(),
  hostnamePrefix: z.string().optional(),
});

const AuthConfigSchema = z.object({
  hasToken: z.boolean(),
  tokenPreview: z.string().optional(),
});

export interface TailscaleInfo {
  running: boolean;
  dnsName?: string;
  serveActive: boolean;
  httpsUrl?: string;
}

export interface RouterContext {
  workspaces: WorkspaceManager;
  config: { get: () => AgentConfig; set: (config: AgentConfig) => void };
  configDir: string;
  stateDir: string;
  startTime: number;
  terminalServer: TerminalServerLike;
  sessionsCache: SessionsCacheManager;
  modelCache: ModelCacheManager;
  tailscale?: TailscaleInfo;
  triggerAutoSync: () => void;
}

function mapErrorToORPC(err: unknown, defaultMessage: string): never {
  const message = err instanceof Error ? err.message : defaultMessage;
  if (message.match(/Workspace '.*' not found/)) {
    throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
  }
  if (message.includes('already exists')) {
    throw new ORPCError('CONFLICT', { message });
  }
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

export function createRouter(ctx: RouterContext) {
  const listWorkspaces = os.handler(async () => {
    return ctx.workspaces.list();
  });

  const getWorkspace = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .handler(async ({ input }) => {
      const workspace = await ctx.workspaces.get(input.name);
      if (!workspace) {
        throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
      }

      let workerVersion: string | null = null;
      if (workspace.status === 'running') {
        try {
          const containerName = getContainerName(input.name);
          const client = await createWorkerClient(containerName);
          const health = await client.health();
          workerVersion = health.version;
        } catch {
          // Worker not reachable
        }
      }

      return { ...workspace, workerVersion };
    });

  const createWorkspace = os
    .input(
      z.object({
        name: UserWorkspaceNameSchema,
        clone: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
    )
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      try {
        return await ctx.workspaces.create(input);
      } catch (err) {
        mapErrorToORPC(err, 'Failed to create workspace');
      }
    });

  const deleteWorkspace = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .handler(async ({ input }) => {
      try {
        ctx.terminalServer.closeConnectionsForWorkspace(input.name);
        await ctx.workspaces.delete(input.name);
        return { success: true };
      } catch (err) {
        mapErrorToORPC(err, 'Failed to delete workspace');
      }
    });

  const startWorkspace = os
    .input(
      z.object({
        name: UserWorkspaceNameSchema,
        clone: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
    )
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      try {
        return await ctx.workspaces.start(input.name, {
          clone: input.clone,
          env: input.env,
        });
      } catch (err) {
        mapErrorToORPC(err, 'Failed to start workspace');
      }
    });

  const stopWorkspace = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      try {
        ctx.terminalServer.closeConnectionsForWorkspace(input.name);
        return await ctx.workspaces.stop(input.name);
      } catch (err) {
        mapErrorToORPC(err, 'Failed to stop workspace');
      }
    });

  const getLogs = os
    .input(z.object({ name: UserWorkspaceNameSchema, tail: z.number().optional().default(100) }))
    .handler(async ({ input }) => {
      try {
        return await ctx.workspaces.getLogs(input.name, input.tail);
      } catch (err) {
        mapErrorToORPC(err, 'Failed to get logs');
      }
    });

  const syncWorkspace = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .handler(async ({ input }) => {
      try {
        await ctx.workspaces.sync(input.name);
        return { success: true };
      } catch (err) {
        mapErrorToORPC(err, 'Failed to sync workspace');
      }
    });

  const syncAllWorkspaces = os.handler(async () => {
    const workspaces = await ctx.workspaces.list();
    const runningWorkspaces = workspaces.filter((ws) => ws.status === 'running');
    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const ws of runningWorkspaces) {
      try {
        await ctx.workspaces.sync(ws.name);
        results.push({ name: ws.name, success: true });
      } catch (err) {
        results.push({ name: ws.name, success: false, error: (err as Error).message });
      }
    }

    return {
      synced: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  });

  const updateWorker = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .handler(async ({ input }) => {
      try {
        await ctx.workspaces.updateWorkerBinary(input.name);
        return { success: true };
      } catch (err) {
        mapErrorToORPC(err, 'Failed to update worker');
      }
    });

  const touchWorkspace = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      const workspace = await ctx.workspaces.touch(input.name);
      if (!workspace) {
        throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
      }
      return workspace;
    });

  const getPortForwards = os
    .input(z.object({ name: UserWorkspaceNameSchema }))
    .output(z.object({ forwards: z.array(PortMappingSchema) }))
    .handler(async ({ input }) => {
      try {
        const forwards = await ctx.workspaces.getPortForwards(input.name);
        return { forwards };
      } catch (err) {
        mapErrorToORPC(err, 'Failed to get port forwards');
      }
    });

  const setPortForwards = os
    .input(z.object({ name: UserWorkspaceNameSchema, forwards: z.array(PortMappingSchema) }))
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      try {
        return await ctx.workspaces.setPortForwards(input.name, input.forwards);
      } catch (err) {
        mapErrorToORPC(err, 'Failed to set port forwards');
      }
    });

  const cloneWorkspace = os
    .input(
      z.object({
        sourceName: UserWorkspaceNameSchema,
        cloneName: UserWorkspaceNameSchema,
      })
    )
    .output(WorkspaceInfoSchema)
    .handler(async ({ input }) => {
      try {
        return await ctx.workspaces.clone(input.sourceName, input.cloneName);
      } catch (err) {
        mapErrorToORPC(err, 'Failed to clone workspace');
      }
    });

  const execInWorkspace = os
    .input(
      z.object({
        name: UserWorkspaceNameSchema,
        command: z.union([z.string(), z.array(z.string())]),
        timeout: z.number().optional(),
      })
    )
    .output(
      z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
      })
    )
    .handler(async ({ input }) => {
      const workspace = await ctx.workspaces.get(input.name);
      if (!workspace) {
        throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
      }
      if (workspace.status !== 'running') {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
      }

      const containerName = getContainerName(input.name);
      const commandArray = Array.isArray(input.command)
        ? input.command
        : ['/bin/sh', '-c', input.command];

      try {
        const execPromise = execInContainer(containerName, commandArray, { user: 'workspace' });

        let result: ExecResult;
        if (input.timeout) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Command execution timed out after ${input.timeout}ms`));
            }, input.timeout);
          });

          result = await Promise.race([execPromise, timeoutPromise]);
        } else {
          result = await execPromise;
        }

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes('timed out')) {
          throw new ORPCError('TIMEOUT', { message: err.message });
        }
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: `Failed to execute command: ${(err as Error).message}`,
        });
      }
    });

  const getInfo = os.handler(async () => {
    let dockerVersion = 'unknown';
    try {
      dockerVersion = await getDockerVersion();
    } catch {
      dockerVersion = 'unavailable';
    }

    const allWorkspaces = await ctx.workspaces.list();

    return {
      hostname: os_module.hostname(),
      uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
      workspacesCount: allWorkspaces.length,
      dockerVersion,
      terminalConnections: ctx.terminalServer.getConnectionCount(),
      tailscale: ctx.tailscale,
    };
  });

  const getCredentials = os.output(CredentialsSchema).handler(async () => {
    return ctx.config.get().credentials;
  });

  const updateCredentials = os
    .input(CredentialsSchema)
    .output(CredentialsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, credentials: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      ctx.triggerAutoSync();
      return input;
    });

  const getScripts = os.output(ScriptsSchema).handler(async () => {
    return ctx.config.get().scripts;
  });

  const updateScripts = os
    .input(ScriptsSchema)
    .output(ScriptsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, scripts: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      ctx.triggerAutoSync();
      return input;
    });

  const getAgents = os.output(CodingAgentsSchema).handler(async () => {
    return ctx.config.get().agents || {};
  });

  const updateAgents = os
    .input(CodingAgentsSchema)
    .output(CodingAgentsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, agents: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      await ctx.modelCache.clearCache();
      ctx.triggerAutoSync();
      return input;
    });

  const getSkills = os.output(SkillsSchema).handler(async () => {
    return ctx.config.get().skills || [];
  });

  const updateSkills = os
    .input(SkillsSchema)
    .output(SkillsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, skills: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      ctx.triggerAutoSync();
      return input;
    });

  const getMcpServers = os.output(McpServersSchema).handler(async () => {
    return ctx.config.get().mcpServers || [];
  });

  const updateMcpServers = os
    .input(McpServersSchema)
    .output(McpServersSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, mcpServers: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      ctx.triggerAutoSync();
      return input;
    });

  const getSSHSettings = os.output(SSHSettingsSchema).handler(async () => {
    const config = ctx.config.get();
    return (
      config.ssh || {
        autoAuthorizeHostKeys: true,
        global: { copy: [], authorize: [] },
        workspaces: {},
      }
    );
  });

  const updateSSHSettings = os
    .input(SSHSettingsSchema)
    .output(SSHSettingsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, ssh: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      ctx.triggerAutoSync();
      return input;
    });

  const listSSHKeys = os.output(z.array(SSHKeyInfoSchema)).handler(async () => {
    return discoverSSHKeys();
  });

  const getTerminalSettings = os
    .output(
      z.object({
        preferredShell: z.string().optional(),
        detectedShell: z.string().optional(),
      })
    )
    .handler(async () => {
      const config = ctx.config.get();
      return {
        preferredShell: config.terminal?.preferredShell,
        detectedShell: process.env.SHELL,
      };
    });

  const updateTerminalSettings = os
    .input(TerminalSettingsSchema)
    .output(TerminalSettingsSchema)
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const newConfig = { ...currentConfig, terminal: input };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      return input;
    });

  const getTailscaleConfig = os
    .output(TailscaleConfigSchema.partial().extend({ enabled: z.boolean() }))
    .handler(async () => {
      const config = ctx.config.get();
      return {
        enabled: config.tailscale?.enabled ?? false,
        authKey: config.tailscale?.authKey ? '********' : '',
        hostnamePrefix: config.tailscale?.hostnamePrefix,
      };
    });

  const updateTailscaleConfig = os
    .input(TailscaleConfigSchema.partial())
    .output(TailscaleConfigSchema.partial().extend({ enabled: z.boolean() }))
    .handler(async ({ input }) => {
      const currentConfig = ctx.config.get();
      const currentTailscale = currentConfig.tailscale || { enabled: false, authKey: '' };
      const newTailscale = {
        ...currentTailscale,
        ...input,
        authKey:
          input.authKey && input.authKey !== '********' ? input.authKey : currentTailscale.authKey,
      };
      const newConfig = { ...currentConfig, tailscale: newTailscale };
      ctx.config.set(newConfig);
      await saveAgentConfig(newConfig, ctx.configDir);
      return {
        enabled: newTailscale.enabled,
        authKey: newTailscale.authKey ? '********' : '',
        hostnamePrefix: newTailscale.hostnamePrefix,
      };
    });

  const getAuthConfig = os.output(AuthConfigSchema).handler(async () => {
    const config = ctx.config.get();
    const token = config.auth?.token;
    return {
      hasToken: !!token,
      tokenPreview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : undefined,
    };
  });

  const generateAuthToken = os.output(z.object({ token: z.string() })).handler(async () => {
    const currentConfig = ctx.config.get();
    const token = crypto.randomBytes(12).toString('hex');
    const newConfig = { ...currentConfig, auth: { ...currentConfig.auth, token } };
    ctx.config.set(newConfig);
    await saveAgentConfig(newConfig, ctx.configDir);
    return { token };
  });

  const disableAuth = os.output(z.object({ success: z.boolean() })).handler(async () => {
    const currentConfig = ctx.config.get();
    const { token: _, ...restAuth } = currentConfig.auth || {};
    const newConfig = { ...currentConfig, auth: restAuth };
    ctx.config.set(newConfig);
    await saveAgentConfig(newConfig, ctx.configDir);
    return { success: true };
  });

  const GitHubRepoSchema = z.object({
    name: z.string(),
    fullName: z.string(),
    cloneUrl: z.string(),
    sshUrl: z.string(),
    private: z.boolean(),
    description: z.string().nullable(),
    updatedAt: z.string(),
  });

  const listGitHubRepos = os
    .input(
      z.object({
        search: z.string().optional(),
        perPage: z.number().optional().default(30),
        page: z.number().optional().default(1),
      })
    )
    .output(
      z.object({
        configured: z.boolean(),
        repos: z.array(GitHubRepoSchema),
        hasMore: z.boolean(),
      })
    )
    .handler(async ({ input }) => {
      const config = ctx.config.get();
      const token = config.agents?.github?.token;

      if (!token) {
        return { configured: false, repos: [], hasMore: false };
      }

      try {
        const params = new URLSearchParams({
          per_page: String(input.perPage),
          page: String(input.page),
          sort: 'updated',
          direction: 'desc',
        });

        const url = input.search
          ? `https://api.github.com/search/repositories?q=${encodeURIComponent(input.search)}+user:@me&${params}`
          : `https://api.github.com/user/repos?${params}`;

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { configured: false, repos: [], hasMore: false };
          }
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const data = await response.json();
        const items = input.search ? data.items : data;

        const repos = items.map(
          (repo: {
            name: string;
            full_name: string;
            clone_url: string;
            ssh_url: string;
            private: boolean;
            description: string | null;
            updated_at: string;
          }) => ({
            name: repo.name,
            fullName: repo.full_name,
            cloneUrl: repo.clone_url,
            sshUrl: repo.ssh_url,
            private: repo.private,
            description: repo.description,
            updatedAt: repo.updated_at,
          })
        );

        const linkHeader = response.headers.get('Link');
        const hasMore = linkHeader?.includes('rel="next"') ?? false;

        return { configured: true, repos, hasMore };
      } catch (err) {
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: `Failed to fetch GitHub repos: ${(err as Error).message}`,
        });
      }
    });

  type ListSessionsInput = {
    workspaceName: string;
    agentType?: 'claude-code' | 'opencode' | 'codex' | 'pi';
    limit?: number;
    offset?: number;
  };

  const hostSessionIndex = new SessionIndex();
  let hostSessionIndexInitialized = false;

  function toRegistryAgentType(agentType: 'claude-code' | 'opencode' | 'codex' | 'pi' | 'claude') {
    return agentType === 'claude-code' ? 'claude' : agentType;
  }

  function toClientAgentType(agentType: 'claude' | 'opencode' | 'codex' | 'pi') {
    return agentType === 'claude' ? 'claude-code' : agentType;
  }

  async function ensureRegistrySession(
    workspaceName: string,
    agentType: 'claude-code' | 'opencode' | 'codex' | 'pi' | 'claude',
    agentSessionId: string,
    options?: { projectPath?: string | null; createdAt?: string; lastActivity?: string }
  ) {
    const existing = await sessionRegistry.findByAgentSessionId(ctx.stateDir, agentSessionId);
    if (existing) {
      return existing;
    }

    return sessionRegistry.importExternalSession(ctx.stateDir, {
      perrySessionId: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      workspaceName,
      agentType: toRegistryAgentType(agentType) as sessionRegistry.AgentType,
      agentSessionId,
      projectPath: options?.projectPath ?? null,
      createdAt: options?.createdAt,
      lastActivity: options?.lastActivity,
    });
  }

  async function resolveSessionRecord(sessionId: string) {
    const byPerry = await sessionRegistry.getSession(ctx.stateDir, sessionId);
    if (byPerry) {
      return byPerry;
    }
    return sessionRegistry.findByAgentSessionId(ctx.stateDir, sessionId);
  }

  async function listHostSessions(input: ListSessionsInput) {
    if (!hostSessionIndexInitialized) {
      await hostSessionIndex.initialize();
      hostSessionIndex.startWatchers();
      hostSessionIndexInitialized = true;
    }

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    let sessions = hostSessionIndex.list();

    if (input.agentType) {
      const filterType = input.agentType === 'claude-code' ? 'claude' : input.agentType;
      sessions = sessions.filter((s) => s.agentType === filterType);
    }

    const nonEmptySessions = sessions.filter((s) => s.messageCount > 0);
    const sessionNames = await getSessionNamesForWorkspace(ctx.configDir, HOST_WORKSPACE_NAME);

    const paginatedRaw = nonEmptySessions.slice(offset, offset + limit);
    const paginatedSessions = await Promise.all(
      paginatedRaw.map(async (session) => {
        const projectPath =
          session.agentType === 'claude'
            ? decodeClaudeProjectPath(session.directory)
            : session.directory;
        const record = await ensureRegistrySession(
          HOST_WORKSPACE_NAME,
          session.agentType,
          session.id,
          {
            projectPath,
            createdAt: new Date(session.lastActivity).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
          }
        );
        const name = sessionNames[record.perrySessionId] || sessionNames[session.id] || null;
        return {
          id: record.perrySessionId,
          agentSessionId: session.id,
          name,
          agentType: toClientAgentType(session.agentType) as AgentType,
          projectPath,
          messageCount: session.messageCount,
          lastActivity: new Date(session.lastActivity).toISOString(),
          firstPrompt: session.firstPrompt,
        };
      })
    );

    return {
      sessions: paginatedSessions,
      total: nonEmptySessions.length,
      hasMore: offset + limit < nonEmptySessions.length,
    };
  }

  async function getHostSession(
    sessionId: string,
    _agentType?: 'claude-code' | 'opencode' | 'codex' | 'pi'
  ) {
    if (!hostSessionIndexInitialized) {
      await hostSessionIndex.initialize();
      hostSessionIndex.startWatchers();
      hostSessionIndexInitialized = true;
    }

    const record = await resolveSessionRecord(sessionId);
    const agentSessionId = record?.agentSessionId || sessionId;
    const session = hostSessionIndex.get(agentSessionId);
    if (!session) {
      return { id: sessionId, messages: [] };
    }

    const result = await hostSessionIndex.getMessages(agentSessionId, { limit: 10000, offset: 0 });
    const agentType = toClientAgentType(session.agentType);

    const messages: SessionMessage[] = result.messages.map((m) => ({
      type: m.type as SessionMessage['type'],
      content: m.content,
      toolName: m.toolName,
      toolId: m.toolId,
      toolInput: m.toolInput,
      timestamp: m.timestamp,
    }));

    const ensured =
      record ||
      (await ensureRegistrySession(HOST_WORKSPACE_NAME, session.agentType, agentSessionId, {
        projectPath:
          session.agentType === 'claude'
            ? decodeClaudeProjectPath(session.directory)
            : session.directory,
      }));
    return { id: ensured.perrySessionId, agentType, messages, agentSessionId };
  }

  async function listSessionsCore(input: ListSessionsInput) {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const isHost = input.workspaceName === HOST_WORKSPACE_NAME;

    if (isHost) {
      const config = ctx.config.get();
      if (!config.allowHostAccess) {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'Host access is disabled' });
      }
      return listHostSessions(input);
    }

    const workspace = await ctx.workspaces.get(input.workspaceName);
    if (!workspace) {
      throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
    }
    if (workspace.status !== 'running') {
      throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
    }

    const containerName = `workspace-${input.workspaceName}`;

    const rawSessions = await discoverAllSessions(containerName, execInContainer);

    const customNames = await getSessionNamesForWorkspace(ctx.stateDir, input.workspaceName);

    const registryByAgentId = new Map<string, sessionRegistry.SessionRecord>();
    for (const raw of rawSessions) {
      const record = await ensureRegistrySession(input.workspaceName, raw.agentType, raw.id, {
        createdAt: new Date(raw.mtime).toISOString(),
        lastActivity: new Date(raw.mtime).toISOString(),
      });
      registryByAgentId.set(raw.id, record);
    }

    const filteredSessions = rawSessions
      .filter((s) => !input.agentType || s.agentType === input.agentType)
      .sort((a, b) => b.mtime - a.mtime);

    const paginatedRawSessions = filteredSessions.slice(offset, offset + limit);

    const detailsResults = await Promise.all(
      paginatedRawSessions.map((rawSession) =>
        getAgentSessionDetails(containerName, rawSession, execInContainer)
      )
    );

    const sessions = detailsResults
      .filter((details): details is NonNullable<typeof details> => details !== null)
      .map((details) => {
        const record = registryByAgentId.get(details.id);
        const perryId = record?.perrySessionId || details.id;
        const name = customNames[perryId] || customNames[details.id] || details.name;
        const projectPath =
          details.agentType === 'claude-code'
            ? decodeClaudeProjectPath(details.projectPath)
            : details.projectPath;
        return {
          ...details,
          id: perryId,
          agentSessionId: details.id,
          name,
          projectPath,
        };
      });

    return {
      sessions,
      total: filteredSessions.length,
      hasMore: offset + limit < filteredSessions.length,
    };
  }

  const listSessions = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        agentType: z.enum(['claude-code', 'opencode', 'codex', 'pi']).optional(),
        limit: z.number().optional().default(50),
        offset: z.number().optional().default(0),
      })
    )
    .handler(async ({ input }) => {
      return listSessionsCore(input);
    });

  const getSession = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        sessionId: z.string(),
        agentType: z.enum(['claude-code', 'opencode', 'codex', 'pi']).optional(),
        projectPath: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      })
    )
    .handler(async ({ input }) => {
      const isHost = input.workspaceName === HOST_WORKSPACE_NAME;

      let result;
      if (isHost) {
        const config = ctx.config.get();
        if (!config.allowHostAccess) {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Host access is disabled' });
        }
        result = await getHostSession(input.sessionId, input.agentType);
      } else {
        const workspace = await ctx.workspaces.get(input.workspaceName);
        if (!workspace) {
          throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
        }
        if (workspace.status !== 'running') {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
        }

        const containerName = `workspace-${input.workspaceName}`;

        const record = await resolveSessionRecord(input.sessionId);
        if (record && !record.agentSessionId) {
          throw new ORPCError('NOT_FOUND', { message: 'Session not found' });
        }
        const agentSessionId = record?.agentSessionId || input.sessionId;
        const resolvedAgentType = record?.agentType
          ? toClientAgentType(record.agentType)
          : input.agentType;

        result = resolvedAgentType
          ? await getSessionMessages(
              containerName,
              agentSessionId,
              resolvedAgentType,
              execInContainer,
              input.projectPath
            )
          : await findSessionMessages(containerName, agentSessionId, execInContainer);

        if (result && !record) {
          const agentType = toRegistryAgentType(result.agentType || resolvedAgentType);
          const created = await ensureRegistrySession(input.workspaceName, agentType, result.id, {
            projectPath: input.projectPath,
          });
          result = {
            ...result,
            id: created.perrySessionId,
            agentSessionId: result.id,
          };
        } else if (result && record) {
          result = {
            ...result,
            id: record.perrySessionId,
            agentSessionId: record.agentSessionId || agentSessionId,
          };
        }
      }

      if (!result) {
        throw new ORPCError('NOT_FOUND', { message: 'Session not found' });
      }

      const allMessages = result.messages || [];
      const total = allMessages.length;

      if (input.limit !== undefined) {
        const offset = input.offset ?? 0;
        const startIndex = Math.max(0, total - offset - input.limit);
        const endIndex = total - offset;
        const paginatedMessages = allMessages.slice(startIndex, endIndex);
        return {
          ...result,
          messages: paginatedMessages,
          total,
          hasMore: startIndex > 0,
        };
      }

      return { ...result, total, hasMore: false };
    });

  const renameSession = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        sessionId: z.string(),
        name: z.string().min(1).max(200),
      })
    )
    .handler(async ({ input }) => {
      await setSessionName(ctx.stateDir, input.workspaceName, input.sessionId, input.name);
      return { success: true };
    });

  const clearSessionName = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        sessionId: z.string(),
      })
    )
    .handler(async ({ input }) => {
      await deleteSessionName(ctx.stateDir, input.workspaceName, input.sessionId);
      return { success: true };
    });

  const getRecentSessions = os
    .input(
      z.object({
        limit: z.number().optional().default(10),
      })
    )
    .handler(async ({ input }) => {
      const recent = await ctx.sessionsCache.getRecent(input.limit);
      return { sessions: recent };
    });

  const recordSessionAccess = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        sessionId: z.string(),
        agentType: z.enum(['claude-code', 'opencode', 'codex', 'pi']),
      })
    )
    .handler(async ({ input }) => {
      await ctx.sessionsCache.recordAccess(input.workspaceName, input.sessionId, input.agentType);
      return { success: true };
    });

  const deleteSession = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        sessionId: z.string(),
        agentType: z.enum(['claude-code', 'opencode', 'codex', 'pi']),
      })
    )
    .handler(async ({ input }) => {
      const isHost = input.workspaceName === HOST_WORKSPACE_NAME;

      if (isHost) {
        const config = ctx.config.get();
        if (!config.allowHostAccess) {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Host access is disabled' });
        }

        const record = await resolveSessionRecord(input.sessionId);
        const agentSessionId = record?.agentSessionId || input.sessionId;
        const agentType = record?.agentType ? toClientAgentType(record.agentType) : input.agentType;
        const result = await deleteHostSession(agentSessionId, agentType);
        if (!result.success) {
          throw new ORPCError('INTERNAL_SERVER_ERROR', {
            message: result.error || 'Failed to delete session',
          });
        }

        const perryId = record?.perrySessionId || input.sessionId;
        await deleteSessionName(ctx.stateDir, input.workspaceName, perryId);
        await ctx.sessionsCache.removeSession(input.workspaceName, perryId);

        return { success: true };
      }

      const workspace = await ctx.workspaces.get(input.workspaceName);
      if (!workspace) {
        throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
      }
      if (workspace.status !== 'running') {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
      }

      const containerName = `workspace-${input.workspaceName}`;

      const record = await resolveSessionRecord(input.sessionId);
      const agentSessionId = record?.agentSessionId || input.sessionId;
      const agentType = record?.agentType ? toClientAgentType(record.agentType) : input.agentType;
      const result = await deleteSessionFromProvider(
        containerName,
        agentSessionId,
        agentType,
        execInContainer
      );

      if (!result.success) {
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: result.error || 'Failed to delete session',
        });
      }

      const perryId = record?.perrySessionId || input.sessionId;
      await deleteSessionName(ctx.stateDir, input.workspaceName, perryId);
      await ctx.sessionsCache.removeSession(input.workspaceName, perryId);

      return { success: true };
    });

  const searchSessions = os
    .input(
      z.object({
        workspaceName: AnyWorkspaceNameSchema,
        query: z.string().min(1).max(500),
      })
    )
    .handler(async ({ input }) => {
      const isHost = input.workspaceName === HOST_WORKSPACE_NAME;

      if (isHost) {
        const config = ctx.config.get();
        if (!config.allowHostAccess) {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Host access is disabled' });
        }

        const results = await searchHostSessions(input.query);
        return { results };
      }

      const workspace = await ctx.workspaces.get(input.workspaceName);
      if (!workspace) {
        throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
      }
      if (workspace.status !== 'running') {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
      }

      const containerName = `workspace-${input.workspaceName}`;
      const rawResults = await searchSessionsInContainer(
        containerName,
        input.query,
        execInContainer
      );
      const results = await Promise.all(
        rawResults.map(async (result) => {
          const record = await ensureRegistrySession(
            input.workspaceName,
            result.agentType,
            result.sessionId
          );
          return {
            ...result,
            sessionId: record.perrySessionId,
            agentSessionId: result.sessionId,
          };
        })
      );

      return { results };
    });

  async function searchHostSessions(query: string): Promise<
    Array<{
      sessionId: string;
      agentType: 'claude-code' | 'opencode' | 'codex' | 'pi';
      matchCount: number;
      agentSessionId?: string;
    }>
  > {
    const homeDir = os_module.homedir();
    const safeQuery = query.replace(/['"\\]/g, '\\$&');
    const searchPaths = [
      path.join(homeDir, '.claude', 'projects'),
      path.join(homeDir, '.codex', 'sessions'),
      path.join(homeDir, '.pi', 'agent', 'sessions'),
    ].filter((p) => {
      try {
        require('fs').accessSync(p);
        return true;
      } catch {
        return false;
      }
    });

    if (searchPaths.length === 0) {
      return [];
    }

    const { execSync } = await import('child_process');
    try {
      const output = execSync(
        `rg -l -i --no-messages "${safeQuery}" ${searchPaths.join(' ')} 2>/dev/null | head -100`,
        {
          encoding: 'utf-8',
          timeout: 30000,
        }
      );

      const files = output.trim().split('\n').filter(Boolean);
      const results: Array<{
        sessionId: string;
        agentType: 'claude-code' | 'opencode' | 'codex' | 'pi';
        matchCount: number;
        agentSessionId?: string;
      }> = [];

      for (const file of files) {
        let sessionId: string | null = null;
        let agentType: 'claude-code' | 'opencode' | 'codex' | 'pi' | null = null;

        if (file.includes('/.claude/projects/')) {
          const match = file.match(/\/([^/]+)\.jsonl$/);
          if (match && !match[1].startsWith('agent-')) {
            sessionId = match[1];
            agentType = 'claude-code';
          }
        } else if (file.includes('/.codex/sessions/')) {
          const match = file.match(/\/([^/]+)\.jsonl$/);
          if (match) {
            sessionId = match[1];
            agentType = 'codex';
          }
        } else if (file.includes('/.pi/agent/sessions/')) {
          const match = file.match(/\/([^/]+)\.jsonl$/);
          if (match) {
            sessionId = match[1];
            agentType = 'pi';
          }
        }

        if (sessionId && agentType) {
          const record = await ensureRegistrySession(HOST_WORKSPACE_NAME, agentType, sessionId);
          results.push({
            sessionId: record.perrySessionId,
            agentSessionId: sessionId,
            agentType,
            matchCount: 1,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  async function findPiSessionFileOnHost(
    baseDir: string,
    sessionId: string
  ): Promise<string | null> {
    async function scan(dir: string): Promise<string | null> {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          const entryPath = path.join(dir, entry);
          const entryStat = await fs.stat(entryPath);
          if (entryStat.isDirectory()) {
            const found = await scan(entryPath);
            if (found) return found;
          } else if (entry.endsWith('.jsonl') && entry.includes(sessionId)) {
            return entryPath;
          } else if (entry.endsWith('.jsonl')) {
            try {
              const content = await fs.readFile(entryPath, 'utf-8');
              const firstLine = content.split('\n')[0];
              const header = JSON.parse(firstLine) as { id?: string };
              if (header.id === sessionId) return entryPath;
            } catch {
              continue;
            }
          }
        }
      } catch {
        // directory doesn't exist
      }
      return null;
    }
    return scan(baseDir);
  }

  async function deleteHostSession(
    sessionId: string,
    agentType: 'claude-code' | 'opencode' | 'codex' | 'pi'
  ): Promise<{ success: boolean; error?: string }> {
    const homeDir = os_module.homedir();

    if (agentType === 'claude-code') {
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      try {
        const projectDirs = await fs.readdir(claudeProjectsDir);
        for (const projectDir of projectDirs) {
          const sessionFile = path.join(claudeProjectsDir, projectDir, `${safeSessionId}.jsonl`);
          try {
            await fs.unlink(sessionFile);
            return { success: true };
          } catch {
            continue;
          }
        }
      } catch {
        return { success: false, error: 'Session not found' };
      }
      return { success: false, error: 'Session not found' };
    }

    if (agentType === 'opencode') {
      return deleteOpencodeSession(sessionId);
    }

    if (agentType === 'codex') {
      const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');
      try {
        const files = await fs.readdir(codexSessionsDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(codexSessionsDir, file);
          const fileId = file.replace('.jsonl', '');

          if (fileId === sessionId) {
            await fs.unlink(filePath);
            return { success: true };
          }

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const firstLine = content.split('\n')[0];
            const meta = JSON.parse(firstLine) as { session_id?: string };
            if (meta.session_id === sessionId) {
              await fs.unlink(filePath);
              return { success: true };
            }
          } catch {
            continue;
          }
        }
      } catch {
        return { success: false, error: 'Session not found' };
      }
      return { success: false, error: 'Session not found' };
    }

    if (agentType === 'pi') {
      const piSessionsDir = path.join(homeDir, '.pi', 'agent', 'sessions');
      try {
        const found = await findPiSessionFileOnHost(piSessionsDir, sessionId);
        if (found) {
          await fs.unlink(found);
          return { success: true };
        }
      } catch {
        return { success: false, error: 'Session not found' };
      }
      return { success: false, error: 'Session not found' };
    }

    return { success: false, error: 'Unsupported agent type' };
  }

  const getHostInfo = os.handler(async () => {
    const config = ctx.config.get();
    return {
      enabled: config.allowHostAccess === true,
      hostname: os_module.hostname(),
      username: os_module.userInfo().username,
      homeDir: os_module.homedir(),
    };
  });

  const listModels = os
    .input(
      z.object({
        agentType: z.enum(['claude-code', 'opencode']),
        workspaceName: AnyWorkspaceNameSchema.optional(),
      })
    )
    .handler(async ({ input }) => {
      const config = ctx.config.get();

      if (input.agentType === 'claude-code') {
        const cached = await ctx.modelCache.getClaudeCodeModels();
        if (cached) {
          return { models: cached };
        }

        const models = await discoverClaudeCodeModels(config);
        await ctx.modelCache.setClaudeCodeModels(models);
        return { models };
      }

      const prefersWorkspaceModels = !config.allowHostAccess;
      const cached = await ctx.modelCache.getOpencodeModels();
      if (shouldUseCachedOpencodeModels(cached, prefersWorkspaceModels, input.workspaceName)) {
        return { models: cached };
      }

      let models: ModelInfo[] = [];
      if (input.workspaceName === HOST_WORKSPACE_NAME) {
        if (!config.allowHostAccess) {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Host access is disabled' });
        }
        models = await discoverHostOpencodeModels();
      } else if (input.workspaceName) {
        const workspace = await ctx.workspaces.get(input.workspaceName);
        if (!workspace) {
          throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
        }
        if (workspace.status !== 'running') {
          throw new ORPCError('PRECONDITION_FAILED', { message: 'Workspace is not running' });
        }
        const containerName = `workspace-${input.workspaceName}`;
        models = await discoverContainerOpencodeModels(containerName, execInContainer);
      } else {
        if (prefersWorkspaceModels) {
          const allWorkspaces = await ctx.workspaces.list();
          const runningWorkspace = allWorkspaces.find((w) => w.status === 'running');
          if (runningWorkspace) {
            const containerName = `workspace-${runningWorkspace.name}`;
            models = await discoverContainerOpencodeModels(containerName, execInContainer);
          }
          if (models.length === 0) {
            models = await discoverHostOpencodeModels();
          }
        } else {
          models = await discoverHostOpencodeModels();
          if (models.length === 0) {
            const allWorkspaces = await ctx.workspaces.list();
            const runningWorkspace = allWorkspaces.find((w) => w.status === 'running');
            if (runningWorkspace) {
              const containerName = `workspace-${runningWorkspace.name}`;
              models = await discoverContainerOpencodeModels(containerName, execInContainer);
            }
          }
        }
      }

      if (models.length > 0) {
        await ctx.modelCache.setOpencodeModels(models);
      }
      return { models };
    });

  return {
    workspaces: {
      list: listWorkspaces,
      get: getWorkspace,
      create: createWorkspace,
      clone: cloneWorkspace,
      delete: deleteWorkspace,
      start: startWorkspace,
      stop: stopWorkspace,
      logs: getLogs,
      sync: syncWorkspace,
      syncAll: syncAllWorkspaces,
      touch: touchWorkspace,
      getPortForwards: getPortForwards,
      setPortForwards: setPortForwards,
      updateWorker: updateWorker,
      exec: execInWorkspace,
    },
    sessions: {
      list: listSessions,
      get: getSession,
      rename: renameSession,
      clearName: clearSessionName,
      getRecent: getRecentSessions,
      recordAccess: recordSessionAccess,
      delete: deleteSession,
      search: searchSessions,
    },
    models: {
      list: listModels,
    },
    github: {
      listRepos: listGitHubRepos,
    },
    host: {
      info: getHostInfo,
    },
    info: getInfo,
    config: {
      credentials: {
        get: getCredentials,
        update: updateCredentials,
      },
      scripts: {
        get: getScripts,
        update: updateScripts,
      },
      agents: {
        get: getAgents,
        update: updateAgents,
      },
      skills: {
        get: getSkills,
        update: updateSkills,
      },
      mcp: {
        get: getMcpServers,
        update: updateMcpServers,
      },
      ssh: {
        get: getSSHSettings,
        update: updateSSHSettings,
        listKeys: listSSHKeys,
      },
      terminal: {
        get: getTerminalSettings,
        update: updateTerminalSettings,
      },
      tailscale: {
        get: getTailscaleConfig,
        update: updateTailscaleConfig,
      },
      auth: {
        get: getAuthConfig,
        generate: generateAuthToken,
        disable: disableAuth,
      },
    },
  };
}

export type AppRouter = ReturnType<typeof createRouter>;
