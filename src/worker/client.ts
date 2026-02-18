import { getContainerIp, execInContainer } from '../docker';
import type { IndexedSession, Message } from './session-index';

const WORKER_PORT = 7392;
const HEALTH_TIMEOUT = 2000;
const REQUEST_TIMEOUT = 30000;
const STARTUP_TIMEOUT = 15000;
const STARTUP_POLL_INTERVAL = 200;

export interface WorkerHealth {
  status: 'ok';
  version: string;
  sessionCount: number;
}

export interface WorkerClient {
  health(): Promise<WorkerHealth>;
  listSessions(): Promise<IndexedSession[]>;
  getSession(id: string): Promise<IndexedSession | null>;
  getMessages(
    id: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ id: string; messages: Message[]; total: number }>;
  deleteSession(id: string): Promise<{ success: boolean; error?: string }>;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const timeout = options.timeout ?? REQUEST_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function execFetch(
  containerName: string,
  path: string,
  options?: { method?: string; timeout?: number }
): Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }> {
  const method = options?.method || 'GET';
  const url = `http://localhost:${WORKER_PORT}${path}`;
  const curlArgs = ['-s', '-w', '\\n%{http_code}', '-X', method, url];
  const result = await execInContainer(containerName, ['curl', ...curlArgs], { user: 'workspace' });

  const lines = result.stdout.trim().split('\n');
  const statusCode = parseInt(lines.pop() || '0', 10);
  const body = lines.join('\n');

  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

async function isWorkerRunning(
  ipOrContainer: string,
  runtime?: 'docker' | 'podman'
): Promise<boolean> {
  try {
    if (runtime === 'podman') {
      const response = await execFetch(ipOrContainer, '/health', { timeout: HEALTH_TIMEOUT });
      return response.ok;
    } else {
      const response = await fetchWithTimeout(`http://${ipOrContainer}:${WORKER_PORT}/health`, {
        timeout: HEALTH_TIMEOUT,
      });
      return response.ok;
    }
  } catch {
    return false;
  }
}

async function startWorkerInContainer(containerName: string): Promise<void> {
  await execInContainer(
    containerName,
    [
      'sh',
      '-c',
      "nohup sh -c 'if [ -x /usr/local/bin/perry ]; then exec /usr/local/bin/perry worker serve; else exec perry worker serve; fi' > /tmp/perry-worker.log 2>&1 &",
    ],
    { user: 'workspace' }
  );
}

async function ensureWorkerRunning(
  containerName: string,
  runtime?: 'docker' | 'podman'
): Promise<string> {
  if (runtime === 'podman') {
    if (await isWorkerRunning(containerName, runtime)) {
      return containerName;
    }

    await startWorkerInContainer(containerName);

    const deadline = Date.now() + STARTUP_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL));
      if (await isWorkerRunning(containerName, runtime)) {
        return containerName;
      }
    }

    throw new Error(`Worker failed to start in container: ${containerName}`);
  } else {
    const ip = await getContainerIp(containerName);
    if (!ip) {
      throw new Error(`Could not get IP for container: ${containerName}`);
    }

    if (await isWorkerRunning(ip)) {
      return ip;
    }

    await startWorkerInContainer(containerName);

    const deadline = Date.now() + STARTUP_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL));
      if (await isWorkerRunning(ip)) {
        return ip;
      }
    }

    throw new Error(`Worker failed to start in container: ${containerName}`);
  }
}

export async function createWorkerClient(
  containerName: string,
  options?: { runtime?: 'docker' | 'podman' }
): Promise<WorkerClient> {
  const runtime = options?.runtime;
  const ipOrContainer = await ensureWorkerRunning(containerName, runtime);

  if (runtime === 'podman') {
    return {
      async health(): Promise<WorkerHealth> {
        const response = await execFetch(containerName, '/health');
        if (!response.ok) {
          throw new Error(`Failed to get health: ${response.status}`);
        }
        return response.json();
      },

      async listSessions(): Promise<IndexedSession[]> {
        const response = await execFetch(containerName, '/sessions');
        if (!response.ok) {
          throw new Error(`Failed to list sessions: ${response.status}`);
        }
        const data = await response.json();
        return data.sessions;
      },

      async getSession(id: string): Promise<IndexedSession | null> {
        const response = await execFetch(containerName, `/sessions/${encodeURIComponent(id)}`);
        if (response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw new Error(`Failed to get session: ${response.status}`);
        }
        const data = await response.json();
        return data.session;
      },

      async getMessages(
        id: string,
        opts: { limit?: number; offset?: number } = {}
      ): Promise<{ id: string; messages: Message[]; total: number }> {
        const params = new URLSearchParams();
        if (opts.limit !== undefined) params.set('limit', String(opts.limit));
        if (opts.offset !== undefined) params.set('offset', String(opts.offset));

        const path = `/sessions/${encodeURIComponent(id)}/messages?${params}`;
        const response = await execFetch(containerName, path);
        if (!response.ok) {
          throw new Error(`Failed to get messages: ${response.status}`);
        }
        return response.json();
      },

      async deleteSession(id: string): Promise<{ success: boolean; error?: string }> {
        const response = await execFetch(containerName, `/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        return response.json();
      },
    };
  } else {
    const baseUrl = `http://${ipOrContainer}:${WORKER_PORT}`;

    return {
      async health(): Promise<WorkerHealth> {
        const response = await fetchWithTimeout(`${baseUrl}/health`);
        if (!response.ok) {
          throw new Error(`Failed to get health: ${response.statusText}`);
        }
        return response.json();
      },

      async listSessions(): Promise<IndexedSession[]> {
        const response = await fetchWithTimeout(`${baseUrl}/sessions`);
        if (!response.ok) {
          throw new Error(`Failed to list sessions: ${response.statusText}`);
        }
        const data = await response.json();
        return data.sessions;
      },

      async getSession(id: string): Promise<IndexedSession | null> {
        const response = await fetchWithTimeout(`${baseUrl}/sessions/${encodeURIComponent(id)}`);
        if (response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw new Error(`Failed to get session: ${response.statusText}`);
        }
        const data = await response.json();
        return data.session;
      },

      async getMessages(
        id: string,
        opts: { limit?: number; offset?: number } = {}
      ): Promise<{ id: string; messages: Message[]; total: number }> {
        const params = new URLSearchParams();
        if (opts.limit !== undefined) params.set('limit', String(opts.limit));
        if (opts.offset !== undefined) params.set('offset', String(opts.offset));

        const url = `${baseUrl}/sessions/${encodeURIComponent(id)}/messages?${params}`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
          throw new Error(`Failed to get messages: ${response.statusText}`);
        }
        return response.json();
      },

      async deleteSession(id: string): Promise<{ success: boolean; error?: string }> {
        const response = await fetchWithTimeout(`${baseUrl}/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        return response.json();
      },
    };
  }
}

export { WORKER_PORT };
