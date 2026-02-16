import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { AddressInfo, createServer } from 'net';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '../../src/agent/router';
import type {
  AgentConfig,
  HealthResponse,
  InfoResponse,
  WorkspaceInfo,
  CreateWorkspaceRequest,
  ApiError,
  WorkspaceCredentials,
} from '../../src/shared/types';

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface ApiResponse<T> {
  status: number;
  data: T;
}

interface ApiClient {
  health(): Promise<HealthResponse>;
  info(): Promise<InfoResponse & { terminalConnections?: number }>;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  createWorkspace(data: CreateWorkspaceRequest): Promise<ApiResponse<WorkspaceInfo | ApiError>>;
  cloneWorkspace(
    sourceName: string,
    cloneName: string
  ): Promise<ApiResponse<WorkspaceInfo | ApiError>>;
  getWorkspace(name: string): Promise<WorkspaceInfo | null>;
  deleteWorkspace(name: string): Promise<{ status: number }>;
  startWorkspace(name: string): Promise<ApiResponse<WorkspaceInfo | ApiError>>;
  stopWorkspace(name: string): Promise<ApiResponse<WorkspaceInfo | ApiError>>;
  updateCredentials(credentials: WorkspaceCredentials): Promise<WorkspaceCredentials>;
  syncWorkspace(name: string): Promise<void>;
  execCommand(
    name: string,
    command: string | string[],
    timeout?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface TestAgent {
  port: number;
  baseUrl: string;
  configDir: string;
  testId: string;
  api: ApiClient;
  process: ChildProcess;
  exec(workspaceName: string, command: string): Promise<ExecResult>;
  cleanup(): Promise<void>;
  getOutput(): string;
  generateWorkspaceName(): string;
}

interface TestAgentOptions {
  config?: Partial<AgentConfig>;
  testId?: string;
}

export async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function createTempConfig(config: Partial<AgentConfig> = {}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-test-'));

  const agentConfig: AgentConfig = {
    port: config.port || 7391,
    credentials: {
      env: config.credentials?.env || { TEST_VAR: 'test-value' },
      files: config.credentials?.files || {},
    },
    scripts: config.scripts || {},
    agents: config.agents,
    auth: config.auth,
  };

  await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(agentConfig, null, 2));

  await fs.writeFile(path.join(tempDir, 'state.json'), JSON.stringify({ workspaces: {} }, null, 2));

  return tempDir;
}

export async function waitForHealthy(baseUrl: string, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Agent not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function createApiClient(baseUrl: string, token?: string): ApiClient {
  type Client = RouterClient<AppRouter>;
  const link = new RPCLink({
    url: `${baseUrl}/rpc`,
    fetch: (url, init) => {
      const reqInit = init as RequestInit;
      const headers = new Headers(reqInit?.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return fetch(url, { ...reqInit, headers });
    },
  });
  const client = createORPCClient<Client>(link);

  return {
    async health(): Promise<HealthResponse> {
      const res = await fetch(`${baseUrl}/health`);
      return res.json() as Promise<HealthResponse>;
    },

    async info(): Promise<InfoResponse & { terminalConnections?: number }> {
      return client.info();
    },

    async listWorkspaces(): Promise<WorkspaceInfo[]> {
      return client.workspaces.list();
    },

    async createWorkspace(
      data: CreateWorkspaceRequest
    ): Promise<ApiResponse<WorkspaceInfo | ApiError>> {
      try {
        const workspace = await client.workspaces.create(data);
        return { status: 201, data: workspace };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const orpcErr = err as { code?: string; status?: number };
        return {
          status: orpcErr.status || 500,
          data: { error: message, code: orpcErr.code } as ApiError,
        };
      }
    },

    async cloneWorkspace(
      sourceName: string,
      cloneName: string
    ): Promise<ApiResponse<WorkspaceInfo | ApiError>> {
      try {
        const workspace = await client.workspaces.clone({
          sourceName,
          cloneName,
        });
        return { status: 201, data: workspace };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const orpcErr = err as { code?: string; status?: number };
        return {
          status: orpcErr.status || 500,
          data: { error: message, code: orpcErr.code } as ApiError,
        };
      }
    },

    async getWorkspace(name: string): Promise<WorkspaceInfo | null> {
      try {
        return await client.workspaces.get({ name });
      } catch (err) {
        const orpcErr = err as { code?: string };
        if (orpcErr.code === 'NOT_FOUND') return null;
        throw err;
      }
    },

    async deleteWorkspace(name: string): Promise<{ status: number }> {
      try {
        await client.workspaces.delete({ name });
        return { status: 200 };
      } catch (err) {
        const orpcErr = err as { status?: number };
        return { status: orpcErr.status || 500 };
      }
    },

    async startWorkspace(name: string): Promise<ApiResponse<WorkspaceInfo | ApiError>> {
      try {
        const workspace = await client.workspaces.start({ name });
        return { status: 200, data: workspace };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const orpcErr = err as { code?: string; status?: number };
        return {
          status: orpcErr.status || 500,
          data: { error: message, code: orpcErr.code } as ApiError,
        };
      }
    },

    async stopWorkspace(name: string): Promise<ApiResponse<WorkspaceInfo | ApiError>> {
      try {
        const workspace = await client.workspaces.stop({ name });
        return { status: 200, data: workspace };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const orpcErr = err as { code?: string; status?: number };
        return {
          status: orpcErr.status || 500,
          data: { error: message, code: orpcErr.code } as ApiError,
        };
      }
    },

    async updateCredentials(credentials: WorkspaceCredentials): Promise<WorkspaceCredentials> {
      return client.config.credentials.update(credentials);
    },

    async syncWorkspace(name: string): Promise<void> {
      await client.workspaces.sync({ name });
    },

    async execCommand(
      name: string,
      command: string | string[],
      timeout?: number
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return client.workspaces.exec({ name, command, timeout });
    },
  };
}

export async function execInWorkspace(
  containerName: string,
  command: string,
  options?: { user?: string }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const args = ['exec'];
    if (options?.user) {
      args.push('-u', options.user);
    }
    args.push(containerName, 'bash', '-c', command);
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data;
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    proc.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });

    proc.on('error', reject);
  });
}

export async function cleanupContainers(prefix: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('docker', [
      'ps',
      '-a',
      '--filter',
      `name=${prefix}`,
      '--format',
      '{{.Names}}',
    ]);
    let containers = '';
    proc.stdout.on('data', (data: Buffer) => {
      containers += data;
    });
    proc.on('close', async () => {
      const names = containers
        .trim()
        .split('\n')
        .filter((n) => n);
      for (const name of names) {
        await new Promise<void>((r) => {
          spawn('docker', ['rm', '-f', name]).on('close', r);
        });
      }
      resolve();
    });
  });
}

export async function cleanupVolumes(prefix: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('docker', [
      'volume',
      'ls',
      '--filter',
      `name=${prefix}`,
      '--format',
      '{{.Name}}',
    ]);
    let volumes = '';
    proc.stdout.on('data', (data: Buffer) => {
      volumes += data;
    });
    proc.on('close', async () => {
      const names = volumes
        .trim()
        .split('\n')
        .filter((n) => n);
      for (const name of names) {
        await new Promise<void>((r) => {
          spawn('docker', ['volume', 'rm', '-f', name]).on('close', r);
        });
      }
      resolve();
    });
  });
}

export async function startTestAgent(options: TestAgentOptions = {}): Promise<TestAgent> {
  const port = options.config?.port || (await getRandomPort());
  const configDir = await createTempConfig({ ...options.config, port });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Generate a unique testId for this agent instance to scope cleanup
  // Uses perrytest- prefix so global cleanup can catch orphaned resources
  const testId =
    options.testId ||
    `perrytest-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const agentPath = path.join(process.cwd(), 'dist/agent/index.js');

  const proc = spawn('bun', ['run', agentPath], {
    env: {
      ...process.env,
      PERRY_CONFIG_DIR: configDir,
      PERRY_PORT: String(port),
      SKIP_AGENT_UPDATES: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let agentOutput = '';
  proc.stdout?.on('data', (data: Buffer) => {
    agentOutput += data;
  });
  proc.stderr?.on('data', (data: Buffer) => {
    agentOutput += data;
  });

  const healthy = await waitForHealthy(baseUrl);
  if (!healthy) {
    proc.kill();
    throw new Error(`Agent failed to start. Output:\n${agentOutput}`);
  }

  const api = createApiClient(baseUrl, options.config?.auth?.token);

  // Track workspaces created by this agent instance for cleanup
  const createdWorkspaces: string[] = [];
  const originalCreateWorkspace = api.createWorkspace.bind(api);
  api.createWorkspace = async (data: CreateWorkspaceRequest) => {
    const result = await originalCreateWorkspace(data);
    if (result.status === 201) {
      createdWorkspaces.push(data.name);
    }
    return result;
  };

  return {
    port,
    baseUrl,
    configDir,
    testId,
    api,
    process: proc,

    async exec(workspaceName: string, command: string): Promise<ExecResult> {
      return execInWorkspace(`workspace-${workspaceName}`, command);
    },

    generateWorkspaceName(): string {
      // Workspace names include testId prefix for scoped cleanup
      return `${testId}-${Math.random().toString(36).slice(2, 8)}`;
    },

    async cleanup(): Promise<void> {
      // Only delete workspaces that belong to this test instance
      // Either explicitly tracked or matching our testId prefix
      const workspacesToDelete: string[] = [...createdWorkspaces];
      try {
        const workspaces = await api.listWorkspaces();
        for (const ws of workspaces) {
          // Only add workspaces that match this test's testId prefix
          if (ws.name.startsWith(testId) && !workspacesToDelete.includes(ws.name)) {
            workspacesToDelete.push(ws.name);
          }
        }
      } catch {
        // Agent may already be down
      }

      // Delete only test workspaces through the API
      for (const name of workspacesToDelete) {
        try {
          await api.deleteWorkspace(name);
        } catch {
          // Workspace may already be deleted or agent may be down
        }
      }

      proc.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        proc.on('exit', () => resolve());
        setTimeout(resolve, 2000);
      });

      // Clean up containers/volumes matching this agent's testId prefix
      await cleanupContainers(`workspace-${testId}-`);
      await cleanupVolumes(`workspace-${testId}-`);

      await fs.rm(configDir, { recursive: true, force: true });
    },

    getOutput(): string {
      return agentOutput;
    },
  };
}

export function generateTestWorkspaceName(): string {
  return `perrytest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
