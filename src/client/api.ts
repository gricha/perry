import { createORPCClient } from '@orpc/client';
import { isIP } from 'node:net';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '../agent/router';
import type {
  WorkspaceInfo,
  CreateWorkspaceRequest,
  InfoResponse,
  PortMapping,
  SSHSettings,
} from '../shared/types';
import type { SSHKeyInfo } from '../shared/client-types';
import { DEFAULT_AGENT_PORT } from '../shared/constants';

export interface ApiClientOptions {
  baseUrl: string;
  timeout?: number;
  token?: string;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

type Client = RouterClient<AppRouter>;

export class ApiClient {
  private baseUrl: string;
  private client: Client;
  private token?: string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;

    const token = this.token;
    const timeout = options.timeout || 120000;
    const link = new RPCLink({
      url: `${this.baseUrl}/rpc`,
      fetch: (url, init) => {
        const headers = new Headers((init as RequestInit)?.headers);
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
        return fetch(url, {
          ...(init as RequestInit),
          headers,
          signal: AbortSignal.timeout(timeout),
        });
      },
    });

    this.client = createORPCClient<Client>(link);
  }

  async health(): Promise<{ status: string; version: string }> {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const response = await fetch(`${this.baseUrl}/health`, { headers });
    return response.json();
  }

  async info(): Promise<InfoResponse> {
    try {
      return await this.client.info();
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    try {
      return await this.client.workspaces.list();
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async getWorkspace(name: string): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.get({ name });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.create(request);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async deleteWorkspace(name: string): Promise<void> {
    try {
      await this.client.workspaces.delete({ name });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async startWorkspace(
    name: string,
    options?: { clone?: string; env?: Record<string, string> }
  ): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.start({ name, clone: options?.clone, env: options?.env });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async stopWorkspace(name: string): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.stop({ name });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async getLogs(name: string, tail?: number): Promise<string> {
    try {
      return await this.client.workspaces.logs({ name, tail });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async syncWorkspace(name: string): Promise<void> {
    try {
      await this.client.workspaces.sync({ name });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async syncAllWorkspaces(): Promise<{
    synced: number;
    failed: number;
    results: { name: string; success: boolean; error?: string }[];
  }> {
    try {
      return await this.client.workspaces.syncAll();
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async getPortForwards(name: string): Promise<PortMapping[]> {
    try {
      const result = await this.client.workspaces.getPortForwards({ name });
      return result.forwards;
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async setPortForwards(name: string, forwards: PortMapping[]): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.setPortForwards({ name, forwards });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async cloneWorkspace(sourceName: string, cloneName: string): Promise<WorkspaceInfo> {
    try {
      return await this.client.workspaces.clone({ sourceName, cloneName });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  getTerminalUrl(name: string): string {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws');
    return `${wsUrl}/rpc/terminal/${encodeURIComponent(name)}`;
  }

  getAuthToken(): string | undefined {
    return this.token;
  }

  getOpencodeUrl(name: string): string {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws');
    return `${wsUrl}/rpc/opencode/${encodeURIComponent(name)}`;
  }

  async getSSHSettings(): Promise<SSHSettings> {
    try {
      return await this.client.config.ssh.get();
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async updateSSHSettings(settings: SSHSettings): Promise<SSHSettings> {
    try {
      return await this.client.config.ssh.update(settings);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async listSSHKeys(): Promise<SSHKeyInfo[]> {
    try {
      return await this.client.config.ssh.listKeys();
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  private wrapError(err: unknown): ApiClientError {
    if (err instanceof ApiClientError) {
      return err;
    }

    if (err instanceof Error) {
      if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED')) {
        return new ApiClientError(
          `Cannot connect to agent at ${this.baseUrl}`,
          0,
          'CONNECTION_FAILED'
        );
      }
      if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
        return new ApiClientError('Request timed out', 0, 'TIMEOUT');
      }

      const orpcError = err as { code?: string; status?: number };
      if (orpcError.status === 401) {
        return new ApiClientError(
          'Unauthorized. Get the token by running `perry agent show-token` on the agent, then set it here with `perry config token <token>`.',
          401,
          'UNAUTHORIZED'
        );
      }
      if (orpcError.code) {
        return new ApiClientError(err.message, orpcError.status || 500, orpcError.code);
      }

      return new ApiClientError(err.message, 0, 'UNKNOWN');
    }

    return new ApiClientError('Unknown error', 0, 'UNKNOWN');
  }
}

export function formatWorkerBaseUrl(worker: string, port?: number): string {
  const trimmed = worker.trim();
  const effectivePort = port || DEFAULT_AGENT_PORT;

  if (trimmed.includes('://')) {
    // Validate early so we don't silently produce garbage.
    new URL(trimmed);
    return trimmed;
  }

  // Bracketed IPv6 (optionally with port).
  if (trimmed.startsWith('[')) {
    const parsed = new URL(`http://${trimmed}`);
    return parsed.port ? `http://${trimmed}` : `http://${trimmed}:${effectivePort}`;
  }

  // Bracketless IPv6 literal.
  if (isIP(trimmed) === 6) {
    return `http://[${trimmed}]:${effectivePort}`;
  }

  // IPv4/hostname (optionally with port).
  if (trimmed.includes(':')) {
    new URL(`http://${trimmed}`);
    return `http://${trimmed}`;
  }

  return `http://${trimmed}:${effectivePort}`;
}

export function createApiClient(
  worker: string,
  port?: number,
  timeoutMs?: number,
  token?: string
): ApiClient {
  const baseUrl = formatWorkerBaseUrl(worker, port);
  return new ApiClient({ baseUrl, timeout: timeoutMs, token });
}
