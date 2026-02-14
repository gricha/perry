import type { Server, ServerWebSocket } from 'bun';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { RPCHandler } from '@orpc/server/fetch';
import { loadAgentConfig, saveAgentConfig, getConfigDir, ensureConfigDir } from '../config/loader';
import type { AgentConfig } from '../shared/types';
import { CONFIG_FILE } from '../shared/types';
import { HOST_WORKSPACE_NAME } from '../shared/client-types';
import { DEFAULT_AGENT_PORT } from '../shared/constants';
import { WorkspaceManager } from '../workspace/manager';
import { containerRunning, getContainerName } from '../docker';
import { startEagerImagePull, stopEagerImagePull } from '../docker/eager-pull';
import { TerminalHandler } from '../terminal/bun-handler';
import { sessionManager } from '../session-manager';
import { createRouter } from './router';
import { serveStaticBun } from './static';
import { SessionsCacheManager } from '../sessions/cache';
import { ModelCacheManager } from '../models/cache';
import { FileWatcher } from './file-watcher';
import { checkAuth, unauthorizedResponse } from './auth';
import {
  getTailscaleStatus,
  getTailscaleIdentity,
  startTailscaleServe,
  stopTailscaleServe,
} from '../tailscale';
import pkg from '../../package.json';

const startTime = Date.now();

interface TailscaleInfo {
  running: boolean;
  dnsName?: string;
  serveActive: boolean;
  httpsUrl?: string;
}

interface WebSocketData {
  type: 'terminal';
  workspaceName: string;
}

function createAgentServer(
  configDir: string,
  config: AgentConfig,
  port: number,
  hostname: string,
  tailscale?: TailscaleInfo
) {
  sessionManager.init(configDir);

  let currentConfig = config;
  const workspaces = new WorkspaceManager(configDir, currentConfig);
  const sessionsCache = new SessionsCacheManager(configDir);
  const modelCache = new ModelCacheManager(configDir);

  const syncAllRunning = async () => {
    const allWorkspaces = await workspaces.list();
    const running = allWorkspaces.filter((ws) => ws.status === 'running');
    for (const ws of running) {
      try {
        await workspaces.sync(ws.name);
        console.log(`[sync] Synced workspace: ${ws.name}`);
      } catch (err) {
        console.error(`[sync] Failed to sync ${ws.name}:`, err);
      }
    }
  };

  const fileWatcher = new FileWatcher({
    config: currentConfig,
    syncCallback: syncAllRunning,
  });

  const isWorkspaceRunning = async (name: string) => {
    if (name === HOST_WORKSPACE_NAME) {
      return currentConfig.allowHostAccess === true;
    }
    return containerRunning(getContainerName(name));
  };

  const getPreferredShell = () => {
    return currentConfig.terminal?.preferredShell || process.env.SHELL || '/bin/bash';
  };

  const terminalHandler = new TerminalHandler({
    getContainerName,
    isWorkspaceRunning,
    isHostAccessAllowed: () => currentConfig.allowHostAccess === true,
    getPreferredShell,
  });

  const triggerAutoSync = () => {
    syncAllRunning().catch((err) => {
      console.error('[sync] Auto-sync failed:', err);
    });
  };

  const router = createRouter({
    workspaces,
    config: {
      get: () => currentConfig,
      set: (newConfig: AgentConfig) => {
        currentConfig = newConfig;
        workspaces.updateConfig(newConfig);
        fileWatcher.updateConfig(newConfig);
      },
    },
    configDir,
    stateDir: configDir,
    startTime,
    terminalServer: terminalHandler,
    sessionsCache,
    modelCache,
    tailscale,
    triggerAutoSync,
  });

  const rpcHandler = new RPCHandler(router);

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const staticResponse = await serveStaticBun(pathname);
      if (staticResponse) {
        return staticResponse;
      }

      const authResult = checkAuth(req, currentConfig);
      if (!authResult.ok) {
        return unauthorizedResponse();
      }

      const terminalMatch = pathname.match(/^\/rpc\/terminal\/([^/]+)$/);

      if (terminalMatch) {
        const type: WebSocketData['type'] = 'terminal';
        const workspaceName = decodeURIComponent(terminalMatch[1]);

        const running = await isWorkspaceRunning(workspaceName);
        if (!running) {
          return new Response('Not Found', { status: 404 });
        }

        const upgraded = server.upgrade(req, {
          data: { type, workspaceName },
        });

        if (upgraded) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      if (pathname === '/health' && method === 'GET') {
        const identity = getTailscaleIdentity(req);
        const response: Record<string, unknown> = { status: 'ok', version: pkg.version };
        if (identity) {
          response.user = identity.email;
        }
        return Response.json(response, { headers: corsHeaders });
      }

      if (pathname.startsWith('/rpc')) {
        const { matched, response } = await rpcHandler.handle(req, {
          prefix: '/rpc',
        });
        if (matched && response) {
          const newHeaders = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
    },

    websocket: {
      open(ws: ServerWebSocket<WebSocketData>) {
        const { type, workspaceName } = ws.data;
        if (type === 'terminal') {
          terminalHandler.handleOpen(ws, workspaceName);
        }
      },

      message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        const { type } = ws.data;
        const data = typeof message === 'string' ? message : message.toString();
        if (type === 'terminal') {
          terminalHandler.handleMessage(ws, data);
        }
      },

      close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
        const { type } = ws.data;
        if (type === 'terminal') {
          terminalHandler.handleClose(ws, code, reason);
        }
      },
    },
  });

  return {
    server,
    terminalHandler,
    fileWatcher,
  };
}

export interface StartAgentOptions {
  port?: number;
  host?: string;
  configDir?: string;
  noHostAccess?: boolean;
}

async function getProcessUsingPort(port: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(['lsof', '-i', `:${port}`, '-t'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    const pid = output.trim().split('\n')[0];
    if (!pid) return null;

    const psProc = Bun.spawn(['ps', '-p', pid, '-o', 'pid=,comm=,args='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const psOutput = await new Response(psProc.stdout).text();
    return psOutput.trim() || `PID ${pid}`;
  } catch {
    return null;
  }
}

const BANNER = `
  ____  _____ ____  ______   __
 |  _ \\| ____|  _ \\|  _ \\ \\ / /
 | |_) |  _| | |_) | |_) \\ V /
 |  __/| |___|  _ <|  _ < | |
 |_|   |_____|_| \\_\\_| \\_\\|_|
`;

async function ensureAuthForNewInstalls(configDir: string): Promise<AgentConfig> {
  const configPath = path.join(configDir, CONFIG_FILE);
  const configExists = fs.existsSync(configPath);

  const config = await loadAgentConfig(configDir);

  if (!configExists && !config.auth?.token) {
    const token = crypto.randomBytes(12).toString('hex');
    config.auth = { ...config.auth, token };
    await saveAgentConfig(config, configDir);

    console.log(`[agent] New install detected - auth enabled by default`);
    console.log(`[agent] Auth token generated: ${token}`);
    console.log(`[agent] Configure clients with: perry config token ${token}`);
  }

  return config;
}

export async function startAgent(options: StartAgentOptions = {}): Promise<void> {
  const configDir = options.configDir || getConfigDir();

  await ensureConfigDir(configDir);

  const config = await ensureAuthForNewInstalls(configDir);

  if (options.noHostAccess || process.env.PERRY_NO_HOST_ACCESS === 'true') {
    config.allowHostAccess = false;
  }

  const port =
    options.port || parseInt(process.env.PERRY_PORT || '', 10) || config.port || DEFAULT_AGENT_PORT;

  const host = options.host || process.env.PERRY_HOST || config.host || '0.0.0.0';

  console.log(BANNER);
  console.log(`  Documentation: https://gricha.github.io/perry/getting-started`);
  console.log(`  Web UI: http://localhost:${port}`);
  console.log('');
  console.log(`[agent] Config directory: ${configDir}`);
  console.log(`[agent] Binding to ${host}:${port}...`);

  const tailscale = await getTailscaleStatus();
  let tailscaleServeActive = false;

  if (tailscale.running && tailscale.dnsName) {
    console.log(`[agent] Tailscale detected: ${tailscale.dnsName}`);

    if (!tailscale.httpsEnabled) {
      console.log(`[agent] Tailscale HTTPS not enabled in tailnet, skipping Serve`);
    } else {
      const result = await startTailscaleServe(port);
      if (result.success) {
        tailscaleServeActive = true;
        console.log(`[agent] Tailscale Serve enabled`);
      } else if (result.error === 'permission_denied') {
        console.log(`[agent] Tailscale Serve requires operator permissions`);
        console.log(`[agent] To enable: ${result.message}`);
        console.log(`[agent] Continuing without HTTPS...`);
      } else {
        console.log(`[agent] Tailscale Serve failed: ${result.message || 'unknown error'}`);
      }
    }
  }

  const tailscaleInfo: TailscaleInfo | undefined =
    tailscale.running && tailscale.dnsName
      ? {
          running: true,
          dnsName: tailscale.dnsName,
          serveActive: tailscaleServeActive,
          httpsUrl: tailscaleServeActive ? `https://${tailscale.dnsName}` : undefined,
        }
      : undefined;

  let server: Server<WebSocketData>;
  let fileWatcher: FileWatcher;
  let terminalHandler: TerminalHandler;

  try {
    const result = createAgentServer(configDir, config, port, host, tailscaleInfo);
    server = result.server;
    fileWatcher = result.fileWatcher;
    terminalHandler = result.terminalHandler;
  } catch (err) {
    const error = err as Error & { code?: string };
    if (error.code === 'EADDRINUSE') {
      console.error(`[agent] Error: Port ${port} is already in use.`);
      const processInfo = await getProcessUsingPort(port);
      if (processInfo) {
        console.error(`[agent] Process using port: ${processInfo}`);
      }
      console.error(`[agent] Try using a different port with: perry agent run --port <port>`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`[agent] Agent running at http://localhost:${port}`);
  if (tailscale.running && tailscale.dnsName) {
    const shortName = tailscale.dnsName.split('.')[0];
    console.log(`[agent] Tailnet: http://${shortName}:${port}`);
    if (tailscaleServeActive) {
      console.log(`[agent] Tailnet HTTPS: https://${tailscale.dnsName}`);
    }
  }
  console.log(`[agent] oRPC endpoint: http://localhost:${port}/rpc`);
  console.log(`[agent] WebSocket terminal: ws://localhost:${port}/rpc/terminal/:name`);

  startEagerImagePull().catch((err) => {
    console.error('[agent] Error during image pull:', err);
  });

  let isShuttingDown = false;

  const shutdown = () => {
    if (isShuttingDown) {
      console.log('[agent] Force exit');
      process.exit(0);
    }
    isShuttingDown = true;

    console.log('[agent] Shutting down...');

    const forceExitTimeout = setTimeout(() => {
      console.log('[agent] Force exit after timeout');
      process.exit(0);
    }, 3000);
    forceExitTimeout.unref();

    stopEagerImagePull();
    fileWatcher.stop();

    const cleanup = async () => {
      if (tailscaleServeActive) {
        console.log('[agent] Stopping Tailscale Serve...');
        await stopTailscaleServe();
      }

      terminalHandler.close();

      await server.stop();

      clearTimeout(forceExitTimeout);
      console.log('[agent] Server closed');
      process.exit(0);
    };

    cleanup().catch((err) => {
      console.error('[agent] Shutdown error:', err);
      process.exit(1);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return new Promise(() => {});
}
