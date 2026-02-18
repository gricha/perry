import { AddressInfo, createServer } from 'net';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import pkg from '../../package.json';
import type {
  AgentConfig,
  PortMapping,
  WorkspaceStartupState,
  WorkspaceStartupStatus,
} from '../shared/types';
import type { Workspace, CreateWorkspaceOptions } from './types';
import { StateManager } from './state';
import { expandPath } from '../config/loader';
import * as docker from '../docker';
import { getContainerName } from '../docker';
import {
  VOLUME_PREFIX,
  WORKSPACE_IMAGE_LOCAL,
  WORKSPACE_IMAGE_REGISTRY,
  SSH_PORT_RANGE_START,
  SSH_PORT_RANGE_END,
} from '../shared/constants';
import { collectAuthorizedKeys, collectCopyKeys } from '../ssh/sync';
import { syncAllAgents } from '../agents';
import { assertUserWorkspaceName } from '../shared/workspace-name';

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close(() => resolve(addr.port === port));
      });
      server.on('error', () => resolve(false));
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`No available port in range ${start}-${end}`);
}

async function ensureWorkspaceImage(): Promise<string> {
  const registryImage = `${WORKSPACE_IMAGE_REGISTRY}:${pkg.version}`;

  const localExists = await docker.imageExists(WORKSPACE_IMAGE_LOCAL);
  if (localExists) {
    return WORKSPACE_IMAGE_LOCAL;
  }

  const registryExists = await docker.imageExists(registryImage);
  if (registryExists) {
    return registryImage;
  }

  console.log(`Pulling workspace image ${registryImage}...`);
  const pulled = await docker.tryPullImage(registryImage);
  if (pulled) {
    return registryImage;
  }

  throw new Error(
    `Workspace image ${registryImage} not available.\n` +
      `The agent could not find or pull the required image.\n` +
      `This may happen if the version was just released and the image is still being published.`
  );
}

interface CopyCredentialOptions {
  source: string;
  dest: string;
  containerName: string;
  dirPermissions?: string;
  filePermissions?: string;
  tempPrefix?: string;
}

async function copyCredentialToContainer(options: CopyCredentialOptions): Promise<void> {
  const {
    source,
    dest,
    containerName,
    dirPermissions = '700',
    filePermissions = '600',
    tempPrefix = 'ws-cred',
  } = options;

  const expandedSource = expandPath(source);

  try {
    await fs.access(expandedSource);
  } catch {
    return;
  }

  const stat = await fs.stat(expandedSource);

  if (stat.isDirectory()) {
    const tempTar = path.join(os.tmpdir(), `${tempPrefix}-${Date.now()}.tar`);
    try {
      const { execSync } = await import('child_process');
      execSync(`tar -cf "${tempTar}" -C "${expandedSource}" .`, { stdio: 'pipe' });
      await docker.execInContainer(containerName, ['mkdir', '-p', dest], {
        user: 'workspace',
      });
      await docker.copyToContainer(containerName, tempTar, '/tmp/creds.tar', { timeoutMs: 60_000 });
      await docker.execInContainer(containerName, ['tar', '-xf', '/tmp/creds.tar', '-C', dest], {
        user: 'workspace',
      });
      await docker.execInContainer(containerName, ['rm', '/tmp/creds.tar'], {
        user: 'workspace',
      });
      await docker.execInContainer(containerName, ['chmod', '-R', filePermissions, dest], {
        user: 'workspace',
      });
      await docker.execInContainer(containerName, ['chmod', dirPermissions, dest], {
        user: 'workspace',
      });
    } finally {
      await fs.unlink(tempTar).catch((err) => {
        console.warn(`[workspace] Failed to clean up temp file ${tempTar}:`, err);
      });
    }
  } else {
    const destDir = path.dirname(dest);
    await docker.execInContainer(containerName, ['mkdir', '-p', destDir], {
      user: 'workspace',
    });
    await docker.copyToContainer(containerName, expandedSource, dest, { timeoutMs: 60_000 });
    await docker.execInContainer(containerName, ['chown', 'workspace:workspace', dest], {
      user: 'root',
    });
    await docker.execInContainer(containerName, ['chmod', filePermissions, dest], {
      user: 'workspace',
    });
  }
}

export class WorkspaceManager {
  private state: StateManager;
  private config: AgentConfig;
  private configDir: string;

  constructor(configDir: string, config: AgentConfig) {
    this.state = new StateManager(configDir);
    this.config = config;
    this.configDir = configDir;
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
  }

  private async copyCredentialFiles(containerName: string): Promise<void> {
    const files = this.config.credentials.files;
    if (!files || Object.keys(files).length === 0) {
      return;
    }

    for (const [destPath, sourcePath] of Object.entries(files)) {
      const expandedDest = destPath.startsWith('~/')
        ? `/home/workspace/${destPath.slice(2)}`
        : destPath;

      const isPrivateKey =
        expandedDest.includes('.ssh') &&
        !expandedDest.endsWith('.pub') &&
        !expandedDest.endsWith('config') &&
        !expandedDest.endsWith('known_hosts');
      const filePermissions = isPrivateKey ? '600' : '644';

      await copyCredentialToContainer({
        source: sourcePath,
        dest: expandedDest,
        containerName,
        filePermissions,
        tempPrefix: 'ws-cred',
      });
    }
  }

  private async copyGitConfig(containerName: string): Promise<void> {
    await copyCredentialToContainer({
      source: '~/.gitconfig',
      dest: '/home/workspace/.gitconfig',
      containerName,
      filePermissions: '644',
      tempPrefix: 'ws-gitconfig',
    });
  }

  private async syncEnvironmentFile(containerName: string): Promise<void> {
    const env: Record<string, string> = {
      ...this.config.credentials.env,
    };

    if (this.config.agents?.github?.token) {
      env.GITHUB_TOKEN = this.config.agents.github.token;
    }

    if (Object.keys(env).length === 0) {
      return;
    }

    const lines = Object.entries(env)
      .map(([key, value]) => {
        const escaped =
          value.includes(' ') || value.includes('"') || value.includes("'")
            ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
            : value;
        return `${key}=${escaped}`;
      })
      .sort();

    const content = lines.join('\n') + '\n';
    const tempFile = path.join(os.tmpdir(), `ws-env-${Date.now()}`);

    try {
      await fs.writeFile(tempFile, content);
      await docker.copyToContainer(containerName, tempFile, '/etc/environment', {
        timeoutMs: 60_000,
      });
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  private async setupSSHKeys(containerName: string, workspaceName: string): Promise<void> {
    if (!this.config.ssh) {
      return;
    }

    await docker.execInContainer(containerName, ['mkdir', '-p', '/home/workspace/.ssh'], {
      user: 'workspace',
    });
    await docker.execInContainer(containerName, ['chmod', '700', '/home/workspace/.ssh'], {
      user: 'workspace',
    });

    const authorizedKeys = await collectAuthorizedKeys(this.config.ssh, workspaceName);
    if (authorizedKeys.length > 0) {
      const content = authorizedKeys.join('\n') + '\n';
      const tempFile = path.join(os.tmpdir(), `ws-authkeys-${Date.now()}`);
      try {
        await fs.writeFile(tempFile, content);
        await docker.copyToContainer(
          containerName,
          tempFile,
          '/home/workspace/.ssh/authorized_keys',
          { timeoutMs: 60_000 }
        );
        await docker.execInContainer(
          containerName,
          ['chown', 'workspace:workspace', '/home/workspace/.ssh/authorized_keys'],
          { user: 'root' }
        );
        await docker.execInContainer(
          containerName,
          ['chmod', '600', '/home/workspace/.ssh/authorized_keys'],
          { user: 'workspace' }
        );
      } finally {
        await fs.unlink(tempFile).catch(() => {});
      }
    }

    const copyKeys = await collectCopyKeys(this.config.ssh, workspaceName);
    for (const key of copyKeys) {
      const privateKeyPath = `/home/workspace/.ssh/${key.name}`;
      const publicKeyPath = `/home/workspace/.ssh/${key.name}.pub`;

      const privateTempFile = path.join(os.tmpdir(), `ws-privkey-${Date.now()}`);
      const publicTempFile = path.join(os.tmpdir(), `ws-pubkey-${Date.now()}`);

      try {
        await fs.writeFile(privateTempFile, key.privateKey + '\n');
        await fs.writeFile(publicTempFile, key.publicKey + '\n');

        await docker.copyToContainer(containerName, privateTempFile, privateKeyPath, {
          timeoutMs: 60_000,
        });
        await docker.copyToContainer(containerName, publicTempFile, publicKeyPath, {
          timeoutMs: 60_000,
        });

        await docker.execInContainer(
          containerName,
          ['chown', 'workspace:workspace', privateKeyPath, publicKeyPath],
          { user: 'root' }
        );
        await docker.execInContainer(containerName, ['chmod', '600', privateKeyPath], {
          user: 'workspace',
        });
        await docker.execInContainer(containerName, ['chmod', '644', publicKeyPath], {
          user: 'workspace',
        });
      } finally {
        await fs.unlink(privateTempFile).catch(() => {});
        await fs.unlink(publicTempFile).catch(() => {});
      }
    }
  }

  private async setupWorkspaceCredentials(
    containerName: string,
    workspaceName: string | undefined,
    options: { strictWorker: boolean; startOpenCodeServer?: boolean }
  ): Promise<void> {
    await this.copyGitConfig(containerName);
    await this.copyCredentialFiles(containerName);
    await this.syncEnvironmentFile(containerName);
    await syncAllAgents(containerName, this.config);
    await this.copyPerryWorker(containerName);
    await this.ensurePerryOnPath(containerName);
    await this.startWorkerServer(containerName, options);
    if (options.startOpenCodeServer ?? true) {
      await this.startOpenCodeServer(containerName);
    }
    if (workspaceName) {
      await this.setupSSHKeys(containerName, workspaceName);
    }
  }

  private createStartupState(): WorkspaceStartupState {
    const steps = [
      { id: 'prepare', label: 'Preparing container', status: 'pending' as const },
      { id: 'start', label: 'Starting container', status: 'pending' as const },
      { id: 'sync', label: 'Syncing workspace files', status: 'pending' as const },
      { id: 'update', label: 'Updating agents', status: 'pending' as const },
      { id: 'scripts', label: 'Running startup scripts', status: 'pending' as const },
      { id: 'tailscale', label: 'Configuring Tailscale', status: 'pending' as const },
    ];
    return { steps, updatedAt: new Date().toISOString() };
  }

  private async setStartupStep(
    workspace: Workspace,
    id: string,
    status: WorkspaceStartupStatus,
    message?: string
  ): Promise<void> {
    if (!workspace.startup) {
      workspace.startup = this.createStartupState();
    }
    const step = workspace.startup.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      step.message = message;
    }
    workspace.startup.updatedAt = new Date().toISOString();
    await this.state.setWorkspace(workspace);
  }

  private async setStartupError(workspace: Workspace, message: string): Promise<void> {
    if (!workspace.startup) {
      return;
    }
    const step =
      workspace.startup.steps.find((s) => s.status === 'running') ||
      workspace.startup.steps.find((s) => s.status === 'pending');
    if (step) {
      step.status = 'error';
      step.message = message;
    }
    workspace.startup.updatedAt = new Date().toISOString();
    await this.state.setWorkspace(workspace);
  }

  private async finalizeStartup(workspace: Workspace): Promise<void> {
    workspace.startup = undefined;
    await this.state.setWorkspace(workspace);
  }

  private async updateAgentBinaries(containerName: string): Promise<void> {
    if (process.env.SKIP_AGENT_UPDATES === 'true') {
      return;
    }

    const updates = [
      {
        name: 'claude',
        command: 'curl -fsSL https://claude.ai/install.sh | bash',
      },
      {
        name: 'opencode',
        command: 'curl -fsSL https://opencode.ai/install | bash',
      },
      {
        name: 'pi',
        command: 'npm install -g @mariozechner/pi-coding-agent',
      },
    ];

    for (const update of updates) {
      const result = await docker.execInContainer(containerName, ['sh', '-c', update.command], {
        user: 'workspace',
      });
      if (result.exitCode !== 0) {
        const details = result.stderr || result.stdout || 'unknown error';
        console.warn(`[agents] ${update.name} update failed: ${details}`);
      }
    }
  }

  private async copyPerryWorker(containerName: string): Promise<void> {
    const installedPath = path.join(os.homedir(), '.perry', 'bin', 'perry');
    const cwdDistPath = path.join(process.cwd(), 'dist', 'perry-worker');
    const distDir = path.dirname(new URL(import.meta.url).pathname);
    const distPath = path.join(distDir, '..', 'perry-worker');

    let workerBinaryPath: string | null = null;

    for (const candidate of [installedPath, cwdDistPath, distPath]) {
      try {
        await fs.access(candidate);
        workerBinaryPath = candidate;
        break;
      } catch {
        // Try next
      }
    }

    if (!workerBinaryPath) {
      console.warn(
        `[sync] perry binary not found at ${installedPath}, ${cwdDistPath}, or ${distPath}, session discovery may not work`
      );
      return;
    }

    const destPath = '/usr/local/bin/perry';

    try {
      await docker.copyToContainer(containerName, workerBinaryPath, destPath, {
        timeoutMs: 60_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[sync] Timed out copying perry worker binary to ${containerName}. ` +
          `This may indicate a stuck Docker daemon or slow filesystem. ` +
          `Original error: ${message}`
      );
    }

    await docker.execInContainer(containerName, ['chown', 'root:root', destPath], {
      user: 'root',
    });
    await docker.execInContainer(containerName, ['chmod', '755', destPath], {
      user: 'root',
    });
  }

  private async ensurePerryOnPath(containerName: string): Promise<void> {
    await docker.execInContainer(
      containerName,
      [
        'sh',
        '-c',
        'if [ -x /usr/local/bin/perry ]; then mkdir -p /home/workspace/.local/bin && ln -sf /usr/local/bin/perry /home/workspace/.local/bin/perry; fi',
      ],
      { user: 'workspace' }
    );
  }

  async updateWorkerBinary(name: string): Promise<void> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    const running = await docker.containerRunning(containerName);
    if (!running) {
      throw new Error(`Workspace '${name}' is not running`);
    }

    await docker.execInContainer(
      containerName,
      ['sh', '-c', 'pkill -f "perry worker serve" || true'],
      { user: 'workspace' }
    );

    await this.copyPerryWorker(containerName);
    await this.startWorkerServer(containerName, { strictWorker: true });
  }

  private async startWorkerServer(
    containerName: string,
    options: { strictWorker: boolean }
  ): Promise<void> {
    const WORKER_PORT = 7392;
    const isPodman = this.config.runtime === 'podman';

    const desiredVersion = pkg.version;

    const hasSyncedPerry =
      (
        await docker.execInContainer(containerName, ['sh', '-c', 'test -x /usr/local/bin/perry'], {
          user: 'workspace',
        })
      ).exitCode === 0;

    const checkHealth = async (): Promise<{ ok: boolean; version?: string }> => {
      if (isPodman) {
        try {
          const result = await docker.execInContainer(
            containerName,
            ['curl', '-s', '-w', '\\n%{http_code}', `http://localhost:${WORKER_PORT}/health`],
            { user: 'workspace' }
          );
          const lines = result.stdout.trim().split('\n');
          const statusCode = parseInt(lines.pop() || '0', 10);
          const body = lines.join('\n');
          if (statusCode >= 200 && statusCode < 300) {
            const health = JSON.parse(body);
            return { ok: true, version: health.version };
          }
          return { ok: false };
        } catch {
          return { ok: false };
        }
      } else {
        const ip = await docker.getContainerIp(containerName);
        if (!ip) {
          console.warn(
            `[sync] Could not get container IP for ${containerName}, skipping worker server`
          );
          return { ok: false };
        }
        try {
          const healthResponse = await fetch(`http://${ip}:${WORKER_PORT}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (healthResponse.ok) {
            const health = (await healthResponse.json().catch(() => null)) as {
              version?: string;
            } | null;
            return { ok: true, version: health?.version };
          }
          return { ok: false };
        } catch {
          return { ok: false };
        }
      }
    };

    try {
      const health = await checkHealth();
      if (health.ok) {
        if (!hasSyncedPerry) {
          return;
        }

        if (health.version === desiredVersion) {
          return;
        }

        await docker.execInContainer(
          containerName,
          ['sh', '-c', 'pkill -f "perry worker serve" || true'],
          { user: 'workspace' }
        );
      }
    } catch {
      // Worker not running, start it
    }

    await docker.execInContainer(
      containerName,
      [
        'sh',
        '-c',
        "nohup sh -c 'if [ -x /usr/local/bin/perry ]; then exec /usr/local/bin/perry worker serve; else exec perry worker serve; fi' > /tmp/perry-worker.log 2>&1 &",
      ],
      { user: 'workspace' }
    );

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const health = await checkHealth();
        if (!health.ok) {
          continue;
        }

        if (!hasSyncedPerry) {
          return;
        }

        if (health.version === desiredVersion) {
          return;
        }
      } catch {
        // Not ready yet
      }
    }

    if (options.strictWorker && hasSyncedPerry) {
      throw new Error(
        `[sync] Worker server failed to start in ${containerName}. Check /tmp/perry-worker.log`
      );
    }

    console.warn(`[sync] Worker server failed to start in ${containerName}`);
  }

  private async startOpenCodeServer(containerName: string): Promise<void> {
    const opencodeConfig = this.config.agents?.opencode?.server;
    const hostname = opencodeConfig?.hostname ?? '0.0.0.0';
    const username = opencodeConfig?.username;
    const password = opencodeConfig?.password;

    const env = {
      ...(username ? { OPENCODE_SERVER_USERNAME: username } : {}),
      ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
    };

    const startResult = await docker.execInContainer(
      containerName,
      [
        'sh',
        '-c',
        'command -v opencode >/dev/null || exit 0; pgrep -f "opencode serve" | grep -v $$ >/dev/null && exit 0; nohup opencode serve --port 4096 --hostname "$1" > /tmp/opencode-server.log 2>&1 &',
        'opencode',
        hostname,
      ],
      { user: 'workspace', env }
    );

    if (startResult.exitCode !== 0) {
      const details = startResult.stderr || startResult.stdout || 'unknown error';
      console.warn(`[opencode] Failed to start server in ${containerName}: ${details}`);
    }
  }

  private async restartOpenCodeServer(containerName: string): Promise<void> {
    await docker.execInContainer(
      containerName,
      [
        'sh',
        '-c',
        'pkill -f "opencode serve" || true; for i in $(seq 1 20); do pgrep -f "opencode serve" > /dev/null || break; sleep 0.25; done',
      ],
      { user: 'workspace' }
    );
    await this.startOpenCodeServer(containerName);
  }

  private async runUserScripts(containerName: string): Promise<void> {
    const scriptPaths = this.config.scripts.post_start;
    if (!scriptPaths || scriptPaths.length === 0) {
      return;
    }

    const failOnError = this.config.scripts.fail_on_error ?? false;

    for (const scriptPath of scriptPaths) {
      const expandedPath = expandPath(scriptPath);

      try {
        const stat = await fs.stat(expandedPath);

        if (stat.isDirectory()) {
          await this.runScriptsFromDirectory(containerName, expandedPath, failOnError);
        } else if (stat.isFile()) {
          await this.runSingleScript(containerName, expandedPath, failOnError);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        console.warn(`Error accessing script path ${expandedPath}:`, err);
        if (failOnError) {
          throw err;
        }
      }
    }
  }

  private async runScriptsFromDirectory(
    containerName: string,
    dirPath: string,
    failOnError: boolean
  ): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const scripts = entries
      .filter((e) => e.isFile() && e.name.endsWith('.sh'))
      .map((e) => e.name)
      .sort();

    for (const scriptName of scripts) {
      const scriptPath = path.join(dirPath, scriptName);
      await this.runSingleScript(containerName, scriptPath, failOnError);
    }
  }

  private async runSingleScript(
    containerName: string,
    scriptPath: string,
    failOnError: boolean
  ): Promise<void> {
    const scriptName = path.basename(scriptPath);
    const destPath = `/workspace/.perry-script-${scriptName}`;

    try {
      await docker.copyToContainer(containerName, scriptPath, destPath, { timeoutMs: 60_000 });
      await docker.execInContainer(containerName, ['chown', 'workspace:workspace', destPath], {
        user: 'root',
      });
      await docker.execInContainer(containerName, ['chmod', '+x', destPath], {
        user: 'workspace',
      });

      console.log(`[scripts] Running: ${scriptPath}`);
      await docker.execInContainer(containerName, ['bash', destPath], {
        user: 'workspace',
      });

      await docker.execInContainer(containerName, ['rm', '-f', destPath], {
        user: 'workspace',
      });
    } catch (err) {
      console.warn(`[scripts] Error running ${scriptPath}:`, err);
      if (failOnError) {
        throw err;
      }
    }
  }

  private async waitForTailscaled(containerName: string, timeoutMs = 30000): Promise<boolean> {
    const startTime = Date.now();
    const interval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const result = await docker.execInContainer(containerName, ['tailscale', 'status'], {
        user: 'root',
      });
      const output = result.stdout + result.stderr;
      if (result.exitCode === 0 || output.includes('Logged out')) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return false;
  }

  private async setupTailscale(containerName: string, workspace: Workspace): Promise<void> {
    if (!this.config.tailscale?.enabled || !this.config.tailscale?.authKey) {
      workspace.tailscale = { status: 'none' };
      return;
    }

    const prefix = this.config.tailscale.hostnamePrefix;
    const hostname = prefix ? `${prefix}${workspace.name}` : workspace.name;

    try {
      console.log(`[tailscale] Waiting for tailscaled to be ready...`);
      const tailscaledReady = await this.waitForTailscaled(containerName);
      if (!tailscaledReady) {
        console.warn(`[tailscale] tailscaled did not become ready in time`);
        workspace.tailscale = {
          status: 'failed',
          hostname,
          error: 'tailscaled did not start in time',
        };
        return;
      }

      console.log(`[tailscale] Setting up Tailscale for ${workspace.name} as ${hostname}...`);

      const result = await docker.execInContainer(
        containerName,
        [
          'tailscale',
          'up',
          `--authkey=${this.config.tailscale.authKey}`,
          `--hostname=${hostname}`,
          '--accept-routes',
          '--accept-dns=false',
        ],
        { user: 'root' }
      );

      if (result.exitCode !== 0) {
        console.warn(`[tailscale] tailscale up failed: ${result.stderr}`);
        workspace.tailscale = {
          status: 'failed',
          hostname,
          error: result.stderr || `exit code ${result.exitCode}`,
        };
        return;
      }

      const statusResult = await docker.execInContainer(
        containerName,
        ['tailscale', 'status', '--json'],
        { user: 'root' }
      );

      if (statusResult.exitCode === 0) {
        try {
          const status = JSON.parse(statusResult.stdout);
          const dnsName = status.Self?.DNSName?.replace(/\.$/, '') || hostname;
          const ip = status.Self?.TailscaleIPs?.[0] || '';

          console.log(`[tailscale] Connected as ${dnsName} (${ip})`);
          workspace.tailscale = {
            status: 'connected',
            hostname: dnsName,
            ip,
          };
        } catch {
          workspace.tailscale = { status: 'connected', hostname };
        }
      } else {
        workspace.tailscale = { status: 'connected', hostname };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[tailscale] Setup error: ${error}`);
      workspace.tailscale = {
        status: 'failed',
        hostname,
        error,
      };
    }
  }

  private async teardownTailscale(containerName: string): Promise<void> {
    if (!this.config.tailscale?.enabled) {
      return;
    }

    try {
      console.log(`[tailscale] Running tailscale logout in ${containerName}...`);
      await docker.execInContainer(containerName, ['tailscale', 'logout'], {
        user: 'root',
      });
      console.log('[tailscale] Logged out');
    } catch (err) {
      console.warn(`[tailscale] Logout error (non-fatal): ${(err as Error).message}`);
    }
  }

  private async syncWorkspaceStatus(workspace: Workspace): Promise<void> {
    if (workspace.status === 'creating') {
      return;
    }

    const containerName = getContainerName(workspace.name);

    const exists = await docker.containerExists(containerName);
    if (!exists) {
      if (workspace.status !== 'error') {
        workspace.status = 'error';
        await this.state.setWorkspace(workspace);
      }
      return;
    }

    const running = await docker.containerRunning(containerName);
    const newStatus = running ? 'running' : 'stopped';
    if (workspace.status !== newStatus) {
      workspace.status = newStatus;
      await this.state.setWorkspace(workspace);
    }
  }

  async list(): Promise<Workspace[]> {
    const workspaces = await this.state.getAllWorkspaces();

    for (const ws of workspaces) {
      await this.syncWorkspaceStatus(ws);
    }

    return workspaces;
  }

  async get(name: string): Promise<Workspace | null> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      return null;
    }

    await this.syncWorkspaceStatus(workspace);

    return workspace;
  }

  async touch(name: string): Promise<Workspace | null> {
    name = assertUserWorkspaceName(name);
    return this.state.touchWorkspace(name);
  }

  async create(options: CreateWorkspaceOptions): Promise<Workspace> {
    const { name: rawName, clone, env } = options;
    const name = assertUserWorkspaceName(rawName);
    const containerName = getContainerName(name);
    const volumeName = `${VOLUME_PREFIX}${name}`;

    const existing = await this.state.getWorkspace(name);
    if (existing) {
      throw new Error(`Workspace '${name}' already exists`);
    }

    const workspace: Workspace = {
      name,
      status: 'creating',
      containerId: '',
      created: new Date().toISOString(),
      repo: clone,
      ports: {
        ssh: 0,
      },
      lastUsed: new Date().toISOString(),
    };
    workspace.startup = this.createStartupState();
    if (!this.config.tailscale?.enabled || !this.config.tailscale?.authKey) {
      const step = workspace.startup.steps.find((s) => s.id === 'tailscale');
      if (step) {
        step.status = 'skipped';
      }
    }
    await this.state.setWorkspace(workspace);

    try {
      await this.setStartupStep(workspace, 'prepare', 'running');
      const workspaceImage = await ensureWorkspaceImage();

      if (!(await docker.volumeExists(volumeName))) {
        await docker.createVolume(volumeName);
      }

      const sshPort = await findAvailablePort(SSH_PORT_RANGE_START, SSH_PORT_RANGE_END);

      const containerEnv: Record<string, string> = {
        ...this.config.credentials.env,
        ...env,
      };

      if (this.config.agents?.github?.token) {
        containerEnv.GITHUB_TOKEN = this.config.agents.github.token;
      }

      if (clone) {
        containerEnv.WORKSPACE_REPO_URL = clone;
      }

      if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
        containerEnv.TS_AUTHKEY = this.config.tailscale.authKey;
      }

      const isPodman = this.config.runtime === 'podman';

      // For podman runtime, pass DOCKER_HOST so entrypoint skips local dockerd
      if (isPodman && process.env.DOCKER_HOST) {
        containerEnv.DOCKER_HOST = process.env.DOCKER_HOST;
      }

      const dockerVolumeName = `${VOLUME_PREFIX}${name}-docker`;

      // Only create Docker-in-Docker volume for docker runtime
      if (!isPodman && !(await docker.volumeExists(dockerVolumeName))) {
        await docker.createVolume(dockerVolumeName);
      }

      const volumes = [{ source: volumeName, target: '/home/workspace', readonly: false }];

      // Only add Docker-in-Docker volume for docker runtime
      if (!isPodman) {
        volumes.push({ source: dockerVolumeName, target: '/var/lib/docker', readonly: false });
      }

      const containerId = await docker.createContainer({
        name: containerName,
        image: workspaceImage,
        hostname: isPodman ? undefined : name, // Skip hostname for podman (UTS namespace conflict)
        privileged: !isPodman, // Skip privileged mode for podman
        restartPolicy: 'unless-stopped',
        env: containerEnv,
        volumes,
        ports: [{ hostPort: sshPort, containerPort: 22, protocol: 'tcp' }],
        labels: {
          'workspace.name': name,
          'workspace.managed': 'true',
        },
      });

      workspace.containerId = containerId;
      workspace.ports.ssh = sshPort;
      await this.state.setWorkspace(workspace);

      await this.setStartupStep(workspace, 'prepare', 'done');
      await this.setStartupStep(workspace, 'start', 'running');
      await docker.startContainer(containerName);
      await docker.waitForContainerReady(containerName);
      await this.setStartupStep(workspace, 'start', 'done');
      await this.setStartupStep(workspace, 'sync', 'running');
      await this.setupWorkspaceCredentials(containerName, name, {
        strictWorker: false,
        startOpenCodeServer: false,
      });
      await this.setStartupStep(workspace, 'sync', 'done');
      await this.setStartupStep(workspace, 'update', 'running');
      await this.updateAgentBinaries(containerName);
      await this.setStartupStep(workspace, 'update', 'done');
      await this.startOpenCodeServer(containerName);

      workspace.status = 'running';
      workspace.lastUsed = new Date().toISOString();
      await this.state.setWorkspace(workspace);

      await this.setStartupStep(workspace, 'scripts', 'running');
      await this.runUserScripts(containerName);
      await this.setStartupStep(workspace, 'scripts', 'done');

      if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
        await this.setStartupStep(workspace, 'tailscale', 'running');
        await this.setupTailscale(containerName, workspace);
        await this.setStartupStep(workspace, 'tailscale', 'done');
        await this.state.setWorkspace(workspace);
      }

      await this.finalizeStartup(workspace);
      return workspace;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStartupError(workspace, message);
      workspace.status = 'error';
      await this.state.setWorkspace(workspace);
      throw err;
    }
  }

  async start(
    name: string,
    options?: { clone?: string; env?: Record<string, string> }
  ): Promise<Workspace> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      return this.create({ name, clone: options?.clone, env: options?.env });
    }

    const previousStatus = workspace.status;
    workspace.status = 'creating';
    await this.state.setWorkspace(workspace);

    try {
      const containerName = getContainerName(name);
      const volumeName = `${VOLUME_PREFIX}${name}`;
      const exists = await docker.containerExists(containerName);
      const running = exists ? await docker.containerRunning(containerName) : false;
      if (running) {
        workspace.status = 'running';
        workspace.lastUsed = new Date().toISOString();
        workspace.startup = undefined;
        await this.state.setWorkspace(workspace);
        return workspace;
      }
      workspace.startup = this.createStartupState();
      if (!this.config.tailscale?.enabled || !this.config.tailscale?.authKey) {
        const step = workspace.startup.steps.find((s) => s.id === 'tailscale');
        if (step) {
          step.status = 'skipped';
        }
      }
      if (exists) {
        const step = workspace.startup.steps.find((s) => s.id === 'prepare');
        if (step) {
          step.status = 'skipped';
        }
      }
      await this.state.setWorkspace(workspace);

      if (!exists) {
        await this.setStartupStep(workspace, 'prepare', 'running');
        const volumeExists = await docker.volumeExists(volumeName);
        if (!volumeExists) {
          throw new Error(
            `Container and volume for workspace '${name}' were deleted. ` +
              `Please delete this workspace and create a new one.`
          );
        }

        const workspaceImage = await ensureWorkspaceImage();
        const sshPort = await findAvailablePort(SSH_PORT_RANGE_START, SSH_PORT_RANGE_END);

        const containerEnv: Record<string, string> = {
          ...this.config.credentials.env,
        };

        if (this.config.agents?.github?.token) {
          containerEnv.GITHUB_TOKEN = this.config.agents.github.token;
        }

        if (workspace.repo) {
          containerEnv.WORKSPACE_REPO_URL = workspace.repo;
        }

        if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
          containerEnv.TS_AUTHKEY = this.config.tailscale.authKey;
        }

        const isPodman = this.config.runtime === 'podman';

        // For podman runtime, pass DOCKER_HOST so entrypoint skips local dockerd
        if (isPodman && process.env.DOCKER_HOST) {
          containerEnv.DOCKER_HOST = process.env.DOCKER_HOST;
        }

        const dockerVolumeName = `${VOLUME_PREFIX}${name}-docker`;

        // Only create Docker-in-Docker volume for docker runtime
        if (!isPodman && !(await docker.volumeExists(dockerVolumeName))) {
          await docker.createVolume(dockerVolumeName);
        }

        const volumes = [{ source: volumeName, target: '/home/workspace', readonly: false }];

        // Only add Docker-in-Docker volume for docker runtime
        if (!isPodman) {
          volumes.push({ source: dockerVolumeName, target: '/var/lib/docker', readonly: false });
        }

        const containerId = await docker.createContainer({
          name: containerName,
          image: workspaceImage,
          hostname: isPodman ? undefined : name, // Skip hostname for podman (UTS namespace conflict)
          privileged: !isPodman, // Skip privileged mode for podman
          restartPolicy: 'unless-stopped',
          env: containerEnv,
          volumes,
          ports: [{ hostPort: sshPort, containerPort: 22, protocol: 'tcp' }],
          labels: {
            'workspace.name': name,
            'workspace.managed': 'true',
          },
        });

        workspace.containerId = containerId;
        workspace.ports.ssh = sshPort;
        await this.state.setWorkspace(workspace);
        await this.setStartupStep(workspace, 'prepare', 'done');
      }

      await this.setStartupStep(workspace, 'start', 'running');
      await docker.startContainer(containerName);
      await docker.waitForContainerReady(containerName);
      await this.setStartupStep(workspace, 'start', 'done');
      await this.setStartupStep(workspace, 'sync', 'running');
      await this.setupWorkspaceCredentials(containerName, name, {
        strictWorker: false,
        startOpenCodeServer: false,
      });
      await this.setStartupStep(workspace, 'sync', 'done');
      await this.setStartupStep(workspace, 'update', 'running');
      await this.updateAgentBinaries(containerName);
      await this.setStartupStep(workspace, 'update', 'done');
      await this.startOpenCodeServer(containerName);

      workspace.status = 'running';
      workspace.lastUsed = new Date().toISOString();
      await this.state.setWorkspace(workspace);

      await this.setStartupStep(workspace, 'scripts', 'running');
      await this.runUserScripts(containerName);
      await this.setStartupStep(workspace, 'scripts', 'done');

      if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
        await this.setStartupStep(workspace, 'tailscale', 'running');
        await this.setupTailscale(containerName, workspace);
        await this.setStartupStep(workspace, 'tailscale', 'done');
        await this.state.setWorkspace(workspace);
      }

      await this.finalizeStartup(workspace);
      return workspace;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStartupError(workspace, message);
      workspace.status = previousStatus === 'error' ? 'error' : 'stopped';
      await this.state.setWorkspace(workspace);
      throw err;
    }
  }

  async stop(name: string): Promise<Workspace> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    const running = await docker.containerRunning(containerName);
    if (!running) {
      workspace.status = 'stopped';
      await this.state.setWorkspace(workspace);
      return workspace;
    }

    await docker.stopContainer(containerName);
    workspace.status = 'stopped';
    if (workspace.tailscale) {
      workspace.tailscale.status = 'none';
    }
    await this.state.setWorkspace(workspace);

    return workspace;
  }

  async delete(name: string): Promise<void> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    const volumeName = `${VOLUME_PREFIX}${name}`;
    const dockerVolumeName = `${VOLUME_PREFIX}${name}-docker`;

    if (await docker.containerExists(containerName)) {
      const running = await docker.containerRunning(containerName);
      if (running) {
        await this.teardownTailscale(containerName);
      }
      await docker.removeContainer(containerName, true);
    }

    if (await docker.volumeExists(volumeName)) {
      await docker.removeVolume(volumeName, true);
    }

    if (await docker.volumeExists(dockerVolumeName)) {
      await docker.removeVolume(dockerVolumeName, true);
    }

    await this.state.deleteWorkspace(name);
  }

  async exec(name: string, command: string[]): Promise<docker.ExecResult> {
    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    const running = await docker.containerRunning(containerName);
    if (!running) {
      throw new Error(`Workspace '${name}' is not running`);
    }

    return docker.execInContainer(containerName, command, { user: 'workspace' });
  }

  async getLogs(name: string, tail = 100): Promise<string> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    return docker.getLogs(containerName, { tail });
  }

  async sync(name: string): Promise<void> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    const containerName = getContainerName(name);
    const running = await docker.containerRunning(containerName);
    if (!running) {
      throw new Error(`Workspace '${name}' is not running`);
    }

    await this.setupWorkspaceCredentials(containerName, name, {
      strictWorker: true,
      startOpenCodeServer: false,
    });
    await this.updateAgentBinaries(containerName);
    await this.restartOpenCodeServer(containerName);
  }

  async setPortForwards(name: string, forwards: PortMapping[]): Promise<Workspace> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }

    workspace.ports.forwards = forwards;
    await this.state.setWorkspace(workspace);
    return workspace;
  }

  async getPortForwards(name: string): Promise<PortMapping[]> {
    name = assertUserWorkspaceName(name);

    const workspace = await this.state.getWorkspace(name);
    if (!workspace) {
      throw new Error(`Workspace '${name}' not found`);
    }
    return workspace.ports.forwards || [];
  }

  async clone(sourceName: string, cloneName: string): Promise<Workspace> {
    sourceName = assertUserWorkspaceName(sourceName);
    cloneName = assertUserWorkspaceName(cloneName);

    const source = await this.state.getWorkspace(sourceName);
    if (!source) {
      throw new Error(`Workspace '${sourceName}' not found`);
    }

    const existing = await this.state.getWorkspace(cloneName);
    if (existing) {
      throw new Error(`Workspace '${cloneName}' already exists`);
    }

    const sourceContainerName = getContainerName(sourceName);
    const cloneContainerName = getContainerName(cloneName);
    const sourceVolumeName = `${VOLUME_PREFIX}${sourceName}`;
    const sourceDockerVolume = `${VOLUME_PREFIX}${sourceName}-docker`;
    const cloneVolumeName = `${VOLUME_PREFIX}${cloneName}`;
    const cloneDockerVolume = `${VOLUME_PREFIX}${cloneName}-docker`;

    const workspace: Workspace = {
      name: cloneName,
      status: 'creating',
      containerId: '',
      created: new Date().toISOString(),
      repo: source.repo,
      ports: {
        ssh: 0,
        forwards: source.ports.forwards ? [...source.ports.forwards] : undefined,
      },
      lastUsed: new Date().toISOString(),
    };
    workspace.startup = this.createStartupState();
    if (!this.config.tailscale?.enabled || !this.config.tailscale?.authKey) {
      const step = workspace.startup.steps.find((s) => s.id === 'tailscale');
      if (step) {
        step.status = 'skipped';
      }
    }
    await this.state.setWorkspace(workspace);

    const wasRunning = await docker.containerRunning(sourceContainerName);

    try {
      await this.setStartupStep(workspace, 'prepare', 'running');
      if (wasRunning) {
        await docker.stopContainer(sourceContainerName);
      }

      await docker.cloneVolume(sourceVolumeName, cloneVolumeName);
      await docker.cloneVolume(sourceDockerVolume, cloneDockerVolume);

      if (wasRunning) {
        await docker.startContainer(sourceContainerName);
      }

      const workspaceImage = await ensureWorkspaceImage();
      const sshPort = await findAvailablePort(SSH_PORT_RANGE_START, SSH_PORT_RANGE_END);

      const containerEnv: Record<string, string> = {
        ...this.config.credentials.env,
      };

      if (this.config.agents?.github?.token) {
        containerEnv.GITHUB_TOKEN = this.config.agents.github.token;
      }

      if (workspace.repo) {
        containerEnv.WORKSPACE_REPO_URL = workspace.repo;
      }

      if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
        containerEnv.TS_AUTHKEY = this.config.tailscale.authKey;
      }

      const isPodman = this.config.runtime === 'podman';

      // For podman runtime, pass DOCKER_HOST so entrypoint skips local dockerd
      if (isPodman && process.env.DOCKER_HOST) {
        containerEnv.DOCKER_HOST = process.env.DOCKER_HOST;
      }

      const volumes = [{ source: cloneVolumeName, target: '/home/workspace', readonly: false }];

      // Only add Docker-in-Docker volume for docker runtime
      if (!isPodman) {
        volumes.push({ source: cloneDockerVolume, target: '/var/lib/docker', readonly: false });
      }

      const containerId = await docker.createContainer({
        name: cloneContainerName,
        image: workspaceImage,
        hostname: isPodman ? undefined : cloneName, // Skip hostname for podman (UTS namespace conflict)
        privileged: !isPodman, // Skip privileged mode for podman
        restartPolicy: 'unless-stopped',
        env: containerEnv,
        volumes,
        ports: [{ hostPort: sshPort, containerPort: 22, protocol: 'tcp' }],
        labels: {
          'workspace.name': cloneName,
          'workspace.managed': 'true',
        },
      });

      workspace.containerId = containerId;
      workspace.ports.ssh = sshPort;
      await this.state.setWorkspace(workspace);

      await this.setStartupStep(workspace, 'prepare', 'done');
      await this.setStartupStep(workspace, 'start', 'running');
      await docker.startContainer(cloneContainerName);
      await docker.waitForContainerReady(cloneContainerName);
      await this.setStartupStep(workspace, 'start', 'done');
      await this.setStartupStep(workspace, 'sync', 'running');
      await this.setupWorkspaceCredentials(cloneContainerName, cloneName, {
        strictWorker: false,
        startOpenCodeServer: false,
      });
      await this.setStartupStep(workspace, 'sync', 'done');
      await this.setStartupStep(workspace, 'update', 'running');
      await this.updateAgentBinaries(cloneContainerName);
      await this.setStartupStep(workspace, 'update', 'done');
      await this.startOpenCodeServer(cloneContainerName);

      workspace.status = 'running';
      workspace.lastUsed = new Date().toISOString();
      await this.state.setWorkspace(workspace);

      await this.setStartupStep(workspace, 'scripts', 'running');
      await this.runUserScripts(cloneContainerName);
      await this.setStartupStep(workspace, 'scripts', 'done');

      if (this.config.tailscale?.enabled && this.config.tailscale?.authKey) {
        await this.setStartupStep(workspace, 'tailscale', 'running');
        await this.setupTailscale(cloneContainerName, workspace);
        await this.setStartupStep(workspace, 'tailscale', 'done');
        await this.state.setWorkspace(workspace);
      }

      await this.finalizeStartup(workspace);
      return workspace;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStartupError(workspace, message);
      workspace.status = 'error';
      await this.state.setWorkspace(workspace);

      if (await docker.containerExists(cloneContainerName)) {
        await docker.removeContainer(cloneContainerName, true).catch(() => {});
      }
      if (await docker.volumeExists(cloneVolumeName)) {
        await docker.removeVolume(cloneVolumeName, true).catch(() => {});
      }
      if (await docker.volumeExists(cloneDockerVolume)) {
        await docker.removeVolume(cloneDockerVolume, true).catch(() => {});
      }

      await this.state.deleteWorkspace(cloneName).catch(() => {});

      if (wasRunning && !(await docker.containerRunning(sourceContainerName))) {
        await docker.startContainer(sourceContainerName).catch(() => {});
      }

      throw err;
    }
  }
}
