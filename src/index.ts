#!/usr/bin/env bun

import { Command } from 'commander';
import { spawn } from 'child_process';
import * as readline from 'readline';
import pkg from '../package.json';
import { startAgent } from './agent/run';
import { installService, uninstallService, showStatus, getServiceStatus } from './agent/systemd';
import { createApiClient, ApiClientError, formatWorkerBaseUrl } from './client/api';
import { loadClientConfig, getAgent, setAgent, getToken, setToken } from './client/config';
import {
  openWSShell,
  openDockerExec,
  openTailscaleSSH,
  getTerminalWSUrl,
  isLocalWorker,
} from './client/ws-shell';
import { getContainerName, getContainerIp } from './docker';
import { startProxy, parsePortForward, formatPortForwards } from './client/proxy';
import {
  startDockerProxy,
  parsePortForward as parseDockerPortForward,
  formatPortForwards as formatDockerPortForwards,
} from './client/docker-proxy';
import { loadAgentConfig, getConfigDir, ensureConfigDir } from './config/loader';
import { buildImage } from './docker';
import { DEFAULT_AGENT_PORT, WORKSPACE_IMAGE_LOCAL } from './shared/constants';
import { checkForUpdates } from './update-checker';
import { discoverSSHKeys } from './ssh';
import { formatUptime } from './shared/format-utils';

const program = new Command();

program
  .name('perry')
  .description('Distributed development environment orchestrator')
  .version(pkg.version)
  .action(() => {
    program.outputHelp();
  });

const agentCmd = program.command('agent').description('Manage the workspace agent daemon');

agentCmd
  .command('run')
  .description('Start the agent daemon')
  .option('-p, --port <port>', 'Port to listen on', parseInt)
  .option('--host <host>', 'Host to bind to')
  .option('-c, --config-dir <dir>', 'Configuration directory')
  .option('--no-host-access', 'Disable direct host machine access')
  .action(async (options) => {
    await startAgent({
      port: options.port,
      host: options.host,
      configDir: options.configDir,
      noHostAccess: options.hostAccess === false,
    });
  });

agentCmd
  .command('install')
  .description('Install agent as systemd user service')
  .option('-p, --port <port>', 'Port to listen on', parseInt)
  .option('-c, --config-dir <dir>', 'Configuration directory')
  .option('--no-host-access', 'Disable direct host machine access')
  .action(async (options) => {
    await installService({
      port: options.port,
      configDir: options.configDir,
      noHostAccess: options.hostAccess === false,
    });
  });

agentCmd
  .command('uninstall')
  .description('Uninstall agent systemd service')
  .action(async () => {
    await uninstallService();
  });

agentCmd
  .command('status')
  .description('Show agent service status')
  .action(async () => {
    await showStatus();
  });

agentCmd
  .command('logs')
  .description('View agent service logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <lines>', 'Number of lines to show', '50')
  .action(async (options) => {
    const { showLogs } = await import('./agent/systemd');
    await showLogs({
      follow: options.follow,
      lines: parseInt(options.lines, 10),
    });
  });

agentCmd
  .command('kill')
  .description('Stop the running agent daemon')
  .action(async () => {
    const status = await getServiceStatus();

    if (status.running) {
      console.log('Stopping agent via systemd...');
      const proc = spawn('systemctl', ['--user', 'stop', 'perry-agent'], {
        stdio: 'inherit',
      });
      await new Promise<void>((resolve) => proc.on('close', () => resolve()));
      console.log('Agent stopped.');
      return;
    }

    const agentRunning = await checkLocalAgent();
    if (!agentRunning) {
      console.log('No running agent found.');
      return;
    }

    console.log('Stopping agent process...');
    const proc = spawn('pkill', ['-f', 'perry.*agent.*run'], {
      stdio: 'inherit',
    });
    await new Promise<void>((resolve) => proc.on('close', () => resolve()));

    await new Promise((r) => setTimeout(r, 500));
    const stillRunning = await checkLocalAgent();
    if (stillRunning) {
      console.log('Agent still running, sending SIGKILL...');
      spawn('pkill', ['-9', '-f', 'perry.*agent.*run'], { stdio: 'inherit' });
    }
    console.log('Agent stopped.');
  });

async function checkLocalAgent(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${DEFAULT_AGENT_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkAgentReachable(host: string): Promise<boolean> {
  try {
    // Use formatWorkerBaseUrl which already handles IPv6 correctly
    const baseUrl = formatWorkerBaseUrl(host);
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Extract host:port from user input for storage in config.
 * Uses URL parsing to handle IPv6 correctly.
 */
function extractHostPort(input: string): string {
  const baseUrl = formatWorkerBaseUrl(input);
  const url = new URL(baseUrl);
  return url.host; // Returns host:port (with brackets for IPv6)
}

async function promptForAgent(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('');
  console.log('No agent configured and no local agent running.');
  console.log('');

  const hostname = await new Promise<string>((resolve) => {
    rl.question('Enter agent hostname (e.g., myserver.local or 192.168.1.100): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!hostname) {
    throw new Error('No hostname provided');
  }

  const agentHost = extractHostPort(hostname);

  console.log(`Checking connection to ${agentHost}...`);
  const reachable = await checkAgentReachable(agentHost);
  if (!reachable) {
    console.error(`Could not connect to agent at ${agentHost}`);
    console.error('Make sure the agent is running: perry agent run');
    throw new Error('Agent not reachable');
  }

  await setAgent(agentHost);
  console.log(`Agent configured: ${agentHost}`);
  console.log('');
  return agentHost;
}

async function createClient(timeoutMs?: number) {
  const agent = await getAgentWithFallback();
  const token = await getToken();
  return createApiClient(agent, undefined, timeoutMs, token || undefined);
}

async function getAgentWithFallback(): Promise<string> {
  let agent = await getAgent();
  if (!agent) {
    const localRunning = await checkLocalAgent();
    if (localRunning) {
      agent = `localhost:${DEFAULT_AGENT_PORT}`;
    } else {
      // Check if TTY is available for interactive prompt
      if (process.stdin.isTTY) {
        agent = await promptForAgent();
      } else {
        console.error('No agent configured and no local agent running.');
        console.error('');
        console.error('Configure an agent with: perry config agent <hostname>');
        console.error('Or start a local agent with: perry agent run');
        process.exit(1);
      }
    }
  }
  return agent;
}

program
  .command('list')
  .alias('ls')
  .description('List all workspaces')
  .action(async () => {
    try {
      const client = await createClient();
      const workspaces = await client.listWorkspaces();

      if (workspaces.length === 0) {
        console.log('No workspaces found.');
        return;
      }

      console.log('');
      for (const ws of workspaces) {
        const status = ws.status === 'running' ? '●' : '○';
        console.log(`  ${status} ${ws.name}`);
        console.log(`    Status: ${ws.status}`);
        if (ws.repo) {
          console.log(`    Repo: ${ws.repo}`);
        }
        console.log(`    SSH Port: ${ws.ports.ssh}`);
        if (ws.tailscale?.status === 'connected' && ws.tailscale.hostname) {
          console.log(`    Tailscale: ${ws.tailscale.hostname}`);
        } else if (ws.tailscale?.status === 'failed') {
          console.log(`    Tailscale: failed (${ws.tailscale.error || 'unknown error'})`);
        }
        console.log(`    Created: ${new Date(ws.created).toLocaleString()}`);
        console.log('');
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('start <name>')
  .description('Start a workspace (creates it if it does not exist)')
  .option('--clone <url>', 'Git repository URL to clone (when creating)')
  .action(async (name, options) => {
    try {
      const client = await createClient();
      console.log(`Starting workspace '${name}'...`);

      let workspace;
      // Check if workspace exists first - only treat NOT_FOUND as "doesn't exist"
      let existingWorkspace = null;
      try {
        existingWorkspace = await client.getWorkspace(name);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'NOT_FOUND') {
          // Workspace doesn't exist, which is fine - we'll create it
        } else {
          // Network errors, timeouts, etc. should be re-thrown
          throw err;
        }
      }

      if (!existingWorkspace) {
        // Workspace doesn't exist - use createWorkspace (same as web UI)
        workspace = await client.createWorkspace({ name, clone: options.clone });
      } else {
        // Workspace exists - just start it (clone option is ignored for existing workspaces)
        if (options.clone) {
          console.warn(
            `Warning: --clone option is ignored because workspace '${name}' already exists.`
          );
        }
        workspace = await client.startWorkspace(name);
      }

      console.log(`Workspace '${workspace.name}' started.`);
      console.log(`  Status: ${workspace.status}`);
      console.log(`  SSH Port: ${workspace.ports.ssh}`);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('stop <name>')
  .description('Stop a running workspace')
  .action(async (name) => {
    try {
      const client = await createClient();
      console.log(`Stopping workspace '${name}'...`);

      const workspace = await client.stopWorkspace(name);

      console.log(`Workspace '${workspace.name}' stopped.`);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('delete <name>')
  .alias('rm')
  .description('Delete a workspace')
  .action(async (name) => {
    try {
      const client = await createClient();
      console.log(`Deleting workspace '${name}'...`);

      await client.deleteWorkspace(name);

      console.log(`Workspace '${name}' deleted.`);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('clone <source> <clone-name>')
  .description('Clone an existing workspace')
  .action(async (source, cloneName) => {
    try {
      const client = await createClient();
      console.log(`Cloning workspace '${source}' to '${cloneName}'...`);
      console.log('This may take a while for large workspaces.');

      const workspace = await client.cloneWorkspace(source, cloneName);

      console.log(`Workspace '${cloneName}' created.`);
      console.log(`  Status: ${workspace.status}`);
      console.log(`  SSH Port: ${workspace.ports.ssh}`);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('info [name]')
  .description('Show workspace or agent info')
  .action(async (name) => {
    try {
      const client = await createClient();

      if (name) {
        const workspace = await client.getWorkspace(name);
        console.log(`Workspace: ${workspace.name}`);
        console.log(`  Status: ${workspace.status}`);
        console.log(`  Container ID: ${workspace.containerId.slice(0, 12)}`);
        if (workspace.repo) {
          console.log(`  Repo: ${workspace.repo}`);
        }
        console.log(`  SSH Port: ${workspace.ports.ssh}`);
        console.log(`  Created: ${new Date(workspace.created).toLocaleString()}`);
      } else {
        const info = await client.info();
        console.log(`Agent Info:`);
        console.log(`  Hostname: ${info.hostname}`);
        console.log(`  Uptime: ${formatUptime(info.uptime)}`);
        console.log(`  Workspaces: ${info.workspacesCount}`);
        console.log(`  Docker: ${info.dockerVersion}`);
        if (info.tailscale?.running) {
          console.log(`  Tailscale: ${info.tailscale.dnsName}`);
          if (info.tailscale.httpsUrl) {
            console.log(`  HTTPS URL: ${info.tailscale.httpsUrl}`);
          }
        }
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('logs <name>')
  .description('Show workspace logs')
  .option('-n, --tail <lines>', 'Number of lines to show', '100')
  .action(async (name, options) => {
    try {
      const client = await createClient();
      const logs = await client.getLogs(name, parseInt(options.tail, 10));
      console.log(logs);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('sync [name]')
  .description('Sync credentials and files to workspaces')
  .option('-a, --all', 'Sync all running workspaces')
  .action(async (name, options) => {
    try {
      const client = await createClient(5 * 60 * 1000);

      if (options.all) {
        console.log('Syncing all running workspaces...');
        const result = await client.syncAllWorkspaces();

        if (result.results.length === 0) {
          console.log('No running workspaces to sync.');
          return;
        }

        for (const r of result.results) {
          if (r.success) {
            console.log(`  ✓ ${r.name}`);
          } else {
            console.log(`  ✗ ${r.name}: ${r.error}`);
          }
        }

        console.log('');
        console.log(`Synced: ${result.synced}, Failed: ${result.failed}`);
        return;
      }

      if (!name) {
        console.error('Error: workspace name required (or use --all)');
        process.exit(1);
      }

      console.log(`Syncing credentials to workspace '${name}'...`);
      await client.syncWorkspace(name);
      console.log(`Workspace '${name}' synced.`);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('shell <name>')
  .description('Open interactive terminal to workspace')
  .action(async (name) => {
    try {
      const agentHost = await getAgentWithFallback();
      const client = await createClient();

      const workspace = await client.getWorkspace(name);
      if (workspace.status !== 'running') {
        console.error(`Workspace '${name}' is not running (status: ${workspace.status})`);
        process.exit(1);
      }

      const tailscaleHostname = workspace.tailscale?.hostname;
      const tailscaleConnected = workspace.tailscale?.status === 'connected';

      if (tailscaleConnected && tailscaleHostname) {
        await openTailscaleSSH({
          hostname: tailscaleHostname,
          onError: (err) => {
            console.error(`\nConnection error: ${err.message}`);
          },
        });
      } else if (isLocalWorker(agentHost)) {
        const containerName = getContainerName(name);
        await openDockerExec({
          containerName,
          onError: (err) => {
            console.error(`\nConnection error: ${err.message}`);
          },
        });
      } else {
        const wsUrl = getTerminalWSUrl(agentHost, name);
        await openWSShell({
          url: wsUrl,
          onError: (err) => {
            console.error(`\nConnection error: ${err.message}`);
          },
        });
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('proxy <name> [ports...]')
  .description('Forward ports from workspace to local machine')
  .action(async (name, ports: string[]) => {
    try {
      const agentHost = await getAgentWithFallback();
      const client = await createClient();

      const workspace = await client.getWorkspace(name);
      if (workspace.status !== 'running') {
        console.error(`Workspace '${name}' is not running (status: ${workspace.status})`);
        process.exit(1);
      }

      let effectivePorts = ports;
      if (ports.length === 0) {
        const configuredForwards = workspace.ports.forwards || [];
        if (configuredForwards.length === 0) {
          console.log(`No ports configured for workspace '${name}'.`);
          console.log('');
          console.log('Configure ports with: perry ports <name> <port> [<port>...]');
          console.log('  Example: perry ports ' + name + ' 3000 8080:5173');
          console.log('');
          console.log('Or specify ports directly: perry proxy <name> <port> [<port>...]');
          console.log('  Example: perry proxy ' + name + ' 3000 8080:5173');
          return;
        }
        effectivePorts = configuredForwards.map((p) =>
          p.host === p.container ? String(p.container) : `${p.host}:${p.container}`
        );
        const formatted = effectivePorts.join(', ');
        console.log(`Using configured ports: ${formatted}`);
      }

      if (isLocalWorker(agentHost)) {
        const containerName = getContainerName(name);
        const containerIp = await getContainerIp(containerName);
        if (!containerIp) {
          console.error(`Could not get IP for container '${containerName}'`);
          process.exit(1);
        }

        const forwards = effectivePorts.map(parseDockerPortForward);
        console.log(`Forwarding ports: ${formatDockerPortForwards(forwards)}`);
        console.log(`Container IP: ${containerIp}`);
        console.log('Press Ctrl+C to stop.');
        console.log('');

        const cleanup = await startDockerProxy({
          containerIp,
          forwards,
          onConnect: (port) => {
            console.log(`Listening on 0.0.0.0:${port}`);
          },
          onError: (err) => {
            console.error(`Proxy error: ${err.message}`);
          },
        });

        const handleSignal = () => {
          console.log('\nStopping proxy...');
          cleanup();
          process.exit(0);
        };
        process.on('SIGINT', handleSignal);
        process.on('SIGTERM', handleSignal);

        await new Promise(() => {});
      } else {
        const forwards = effectivePorts.map(parsePortForward);

        console.log(`Forwarding ports: ${formatPortForwards(forwards)}`);
        console.log('Press Ctrl+C to stop.');
        console.log('');

        await startProxy({
          worker: agentHost,
          sshPort: workspace.ports.ssh,
          forwards,
          onConnect: () => {
            console.log('Connected. Ports are now forwarded.');
          },
          onDisconnect: (code) => {
            console.log(`\nDisconnected (exit code: ${code})`);
          },
          onError: (err) => {
            console.error(`\nConnection error: ${err.message}`);
          },
        });
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('ports <name> [ports...]')
  .description('Configure port mappings for a workspace (e.g. 3000, 8080:3000)')
  .action(async (name, ports: string[]) => {
    try {
      const client = await createClient();

      const workspace = await client.getWorkspace(name);
      if (!workspace) {
        console.error(`Workspace '${name}' not found`);
        process.exit(1);
      }

      if (ports.length === 0) {
        const currentPorts = workspace.ports.forwards || [];
        if (currentPorts.length === 0) {
          console.log(`No ports configured for workspace '${name}'.`);
          console.log('');
          console.log('Usage: perry ports <name> <port> [<port>...]');
          console.log('  Format: <port> or <host>:<container>');
          console.log('  Example: perry ports ' + name + ' 3000 8080:5173');
        } else {
          const formatted = currentPorts.map((p) =>
            p.host === p.container ? String(p.container) : `${p.host}:${p.container}`
          );
          console.log(`Ports configured for '${name}': ${formatted.join(', ')}`);
        }
        return;
      }

      const portMappings = ports.map((spec) => {
        const mapping = parsePortForward(spec);
        return { host: mapping.localPort, container: mapping.remotePort };
      });

      await client.setPortForwards(name, portMappings);
      const formatted = portMappings.map((p) =>
        p.host === p.container ? String(p.container) : `${p.host}:${p.container}`
      );
      console.log(`Ports configured for '${name}': ${formatted.join(', ')}`);
      console.log('');
      console.log(`Run 'perry proxy ${name}' to start forwarding.`);
    } catch (err) {
      handleError(err);
    }
  });

// Client configuration commands
const configCmd = program
  .command('config')
  .description('Manage client configuration')
  .action(async () => {
    // Show current config by default
    const clientConfig = await loadClientConfig();
    const configDir = getConfigDir();

    console.log('Client Configuration:');
    console.log(`  Config Dir: ${configDir}`);
    console.log(`  Agent: ${clientConfig?.agent || '(not set)'}`);
    if (clientConfig?.token) {
      const masked = clientConfig.token.slice(0, 10) + '...' + clientConfig.token.slice(-4);
      console.log(`  Token: ${masked}`);
    } else {
      console.log(`  Token: (not set)`);
    }
    console.log('');
    console.log('To configure the agent connection: perry config agent <hostname>');
    console.log('To configure the auth token: perry config token <token>');
  });

configCmd
  .command('show')
  .description('Show current client configuration')
  .action(async () => {
    const clientConfig = await loadClientConfig();
    const configDir = getConfigDir();

    console.log('Client Configuration:');
    console.log(`  Config Dir: ${configDir}`);
    console.log(`  Agent: ${clientConfig?.agent || '(not set)'}`);
    if (clientConfig?.token) {
      const masked = clientConfig.token.slice(0, 10) + '...' + clientConfig.token.slice(-4);
      console.log(`  Token: ${masked}`);
    } else {
      console.log(`  Token: (not set)`);
    }
  });

configCmd
  .command('agent [hostname]')
  .description('Get or set the agent hostname')
  .action(async (hostname) => {
    if (hostname) {
      const agentHost = extractHostPort(hostname);

      console.log(`Checking connection to ${agentHost}...`);
      const reachable = await checkAgentReachable(agentHost);
      if (!reachable) {
        console.error(`Could not connect to agent at ${agentHost}`);
        console.error('Make sure the agent is running: perry agent run');
        process.exit(1);
      }

      await setAgent(agentHost);
      console.log(`Agent configured: ${agentHost}`);
    } else {
      const agent = await getAgent();
      if (agent) {
        console.log(agent);
      } else {
        console.log('No agent configured.');
        console.log('');
        console.log('Usage: perry config agent <hostname>');
        console.log('Example: perry config agent myserver.local');
      }
    }
  });

// Keep 'worker' as hidden alias for backwards compatibility
configCmd
  .command('worker [hostname]', { hidden: true })
  .description('Alias for "agent" (deprecated)')
  .action(async (hostname) => {
    if (hostname) {
      const agentHost = extractHostPort(hostname);
      await setAgent(agentHost);
      console.log(`Agent set to: ${agentHost}`);
      console.log('Note: "perry config worker" is deprecated, use "perry config agent" instead.');
    } else {
      const agent = await getAgent();
      if (agent) {
        console.log(agent);
      } else {
        console.log('No agent configured.');
      }
    }
  });

configCmd
  .command('token [token]')
  .description('Get or set the auth token for API requests')
  .option('--show', 'Show full token (default shows masked)')
  .action(async (token, options) => {
    if (token) {
      await setToken(token);
      console.log('Token saved');
    } else {
      const currentToken = await getToken();
      if (currentToken) {
        if (options.show) {
          console.log(currentToken);
        } else {
          const masked = currentToken.slice(0, 10) + '...' + currentToken.slice(-4);
          console.log(`Token: ${masked}`);
        }
      } else {
        console.log('No token configured');
        console.log('');
        console.log('Usage: perry config token <token>');
      }
    }
  });

// Agent configuration command (moved under 'perry agent config')
agentCmd
  .command('config')
  .description('Configure the agent (AI assistants, SSH keys, etc.)')
  .action(async () => {
    const { runSetupWizard } = await import('./cli/setup-wizard');
    await runSetupWizard();
  });

agentCmd
  .command('show-config')
  .description('Show current agent configuration')
  .action(async () => {
    const configDir = getConfigDir();
    await ensureConfigDir(configDir);
    const config = await loadAgentConfig(configDir);

    console.log('Agent Configuration:');
    console.log(`  Port: ${config.port}`);
    console.log(`  Environment Variables: ${Object.keys(config.credentials.env).length}`);
    for (const key of Object.keys(config.credentials.env)) {
      console.log(`    - ${key}`);
    }
    console.log(`  Credential Files: ${Object.keys(config.credentials.files).length}`);
    for (const [dest, src] of Object.entries(config.credentials.files)) {
      console.log(`    - ${dest} <- ${src}`);
    }
    const scripts = config.scripts.post_start;
    if (scripts && scripts.length > 0) {
      console.log(`  Post-start Scripts: ${scripts.length}`);
      for (const script of scripts) {
        console.log(`    - ${script}`);
      }
    }
    if (config.scripts.fail_on_error) {
      console.log(`  Scripts Fail on Error: enabled`);
    }
  });

agentCmd
  .command('show-token')
  .description('Show the auth token for connecting clients')
  .action(async () => {
    const configDir = getConfigDir();
    await ensureConfigDir(configDir);
    const config = await loadAgentConfig(configDir);

    if (!config.auth?.token) {
      console.log('No auth token configured.');
      console.log('Run `perry auth init` to generate one.');
      process.exit(1);
    }

    console.log(config.auth.token);
  });

const authCmd = program.command('auth').description('Manage authentication');

authCmd
  .command('init')
  .description('Generate auth token for the agent')
  .action(async () => {
    const { authInit } = await import('./commands/auth');
    await authInit();
  });

const sshCmd = program.command('ssh').description('Manage SSH keys for workspaces');

sshCmd
  .command('list')
  .description('List detected SSH keys on host')
  .action(async () => {
    const keys = await discoverSSHKeys();

    if (keys.length === 0) {
      console.log('No SSH keys found in ~/.ssh/');
      return;
    }

    console.log('');
    console.log('Detected SSH keys:');
    console.log('');
    for (const key of keys) {
      const privStatus = key.hasPrivateKey ? '✓' : '✗';
      console.log(`  ${key.name}`);
      console.log(`    Type: ${key.type.toUpperCase()}`);
      console.log(`    Fingerprint: ${key.fingerprint}`);
      console.log(`    Private key: ${privStatus}`);
      console.log(`    Path: ${key.path}`);
      console.log('');
    }
  });

sshCmd
  .command('show')
  .description('Show current SSH configuration')
  .action(async () => {
    try {
      const client = await createClient();
      const ssh = await client.getSSHSettings();

      console.log('');
      console.log('SSH Configuration:');
      console.log(`  Auto-authorize host keys: ${ssh.autoAuthorizeHostKeys ? 'yes' : 'no'}`);
      console.log('');

      console.log('  Keys to copy (global):');
      if (ssh.global.copy.length === 0) {
        console.log('    (none)');
      } else {
        for (const key of ssh.global.copy) {
          console.log(`    - ${key}`);
        }
      }
      console.log('');

      console.log('  Keys to authorize (global):');
      if (ssh.global.authorize.length === 0) {
        console.log('    (none)');
      } else {
        for (const key of ssh.global.authorize) {
          console.log(`    - ${key}`);
        }
      }

      if (Object.keys(ssh.workspaces).length > 0) {
        console.log('');
        console.log('  Per-workspace overrides:');
        for (const [ws, wsConfig] of Object.entries(ssh.workspaces)) {
          console.log(`    ${ws}:`);
          if (wsConfig.copy) {
            console.log(`      copy: ${wsConfig.copy.join(', ')}`);
          }
          if (wsConfig.authorize) {
            console.log(`      authorize: ${wsConfig.authorize.join(', ')}`);
          }
        }
      }
      console.log('');
    } catch (err) {
      handleError(err);
    }
  });

sshCmd
  .command('auto-authorize [toggle]')
  .description('Toggle auto-authorization of host keys (on/off)')
  .action(async (toggle?: string) => {
    try {
      const client = await createClient();
      const settings = await client.getSSHSettings();

      if (!toggle) {
        console.log(`Auto-authorize host keys: ${settings.autoAuthorizeHostKeys ? 'on' : 'off'}`);
        return;
      }

      if (toggle !== 'on' && toggle !== 'off') {
        console.error('Usage: perry ssh auto-authorize [on|off]');
        process.exit(1);
      }

      settings.autoAuthorizeHostKeys = toggle === 'on';
      await client.updateSSHSettings(settings);
      console.log(`Auto-authorize host keys: ${toggle}`);
    } catch (err) {
      handleError(err);
    }
  });

sshCmd
  .command('copy <key-path>')
  .description('Add SSH key to copy list (for git, etc)')
  .option('-w, --workspace <name>', 'Apply to specific workspace only')
  .action(async (keyPath: string, options: { workspace?: string }) => {
    try {
      const client = await createClient();
      const settings = await client.getSSHSettings();

      const normalizedPath = keyPath.replace(/\.pub$/, '');

      if (options.workspace) {
        if (!settings.workspaces[options.workspace]) {
          settings.workspaces[options.workspace] = {};
        }
        const ws = settings.workspaces[options.workspace];
        if (!ws.copy) {
          ws.copy = [...settings.global.copy];
        }
        if (!ws.copy.includes(normalizedPath)) {
          ws.copy.push(normalizedPath);
        }
        console.log(`Added ${normalizedPath} to copy list for workspace '${options.workspace}'`);
      } else {
        if (!settings.global.copy.includes(normalizedPath)) {
          settings.global.copy.push(normalizedPath);
        }
        console.log(`Added ${normalizedPath} to global copy list`);
      }

      await client.updateSSHSettings(settings);
    } catch (err) {
      handleError(err);
    }
  });

sshCmd
  .command('authorize <key-path>')
  .description('Add SSH key to authorized_keys list')
  .option('-w, --workspace <name>', 'Apply to specific workspace only')
  .action(async (keyPath: string, options: { workspace?: string }) => {
    try {
      const client = await createClient();
      const settings = await client.getSSHSettings();

      if (options.workspace) {
        if (!settings.workspaces[options.workspace]) {
          settings.workspaces[options.workspace] = {};
        }
        const ws = settings.workspaces[options.workspace];
        if (!ws.authorize) {
          ws.authorize = [...settings.global.authorize];
        }
        if (!ws.authorize.includes(keyPath)) {
          ws.authorize.push(keyPath);
        }
        console.log(`Added ${keyPath} to authorize list for workspace '${options.workspace}'`);
      } else {
        if (!settings.global.authorize.includes(keyPath)) {
          settings.global.authorize.push(keyPath);
        }
        console.log(`Added ${keyPath} to global authorize list`);
      }

      await client.updateSSHSettings(settings);
    } catch (err) {
      handleError(err);
    }
  });

sshCmd
  .command('remove <key-path>')
  .description('Remove SSH key from copy or authorize list')
  .option('-w, --workspace <name>', 'Remove from specific workspace only')
  .option('--copy', 'Remove from copy list')
  .option('--authorize', 'Remove from authorize list')
  .action(
    async (
      keyPath: string,
      options: { workspace?: string; copy?: boolean; authorize?: boolean }
    ) => {
      try {
        const client = await createClient();
        const settings = await client.getSSHSettings();

        const normalizedPath = keyPath.replace(/\.pub$/, '');
        const removeFromCopy = options.copy || (!options.copy && !options.authorize);
        const removeFromAuthorize = options.authorize || (!options.copy && !options.authorize);

        if (options.workspace) {
          const ws = settings.workspaces[options.workspace];
          if (ws) {
            if (removeFromCopy && ws.copy) {
              ws.copy = ws.copy.filter((k) => k !== normalizedPath && k !== keyPath);
            }
            if (removeFromAuthorize && ws.authorize) {
              ws.authorize = ws.authorize.filter((k) => k !== normalizedPath && k !== keyPath);
            }
          }
          console.log(`Removed ${keyPath} from workspace '${options.workspace}'`);
        } else {
          if (removeFromCopy) {
            settings.global.copy = settings.global.copy.filter(
              (k) => k !== normalizedPath && k !== keyPath
            );
          }
          if (removeFromAuthorize) {
            settings.global.authorize = settings.global.authorize.filter(
              (k) => k !== normalizedPath && k !== keyPath
            );
          }
          console.log(`Removed ${keyPath} from global config`);
        }

        await client.updateSSHSettings(settings);
      } catch (err) {
        handleError(err);
      }
    }
  );

program
  .command('update')
  .description('Update Perry to the latest version')
  .option('-f, --force', 'Force update even if already on latest version')
  .action(async (options) => {
    const { fetchLatestVersionWithDetails, compareVersions } = await import('./update-checker.js');
    const currentVersion = pkg.version;

    console.log(`Current version: ${currentVersion}`);
    console.log('Checking for updates...');

    const result = await fetchLatestVersionWithDetails();

    if (!result.version) {
      // Only show detailed error messages in interactive mode (TTY)
      if (process.stderr.isTTY) {
        if (result.status === 504) {
          console.error(
            'GitHub API returned 504 Gateway Timeout. This is usually a temporary issue.'
          );
          console.error('Please try again in a few moments.');
        } else if (result.status === 403) {
          console.error('GitHub API rate limit exceeded. Please try again later.');
        } else if (result.error) {
          console.error(`Failed to fetch latest version: ${result.error}`);
        } else {
          console.error('Failed to fetch latest version. Please try again later.');
        }
      }
      process.exit(1);
    }

    const latestVersion = result.version;
    console.log(`Latest version: ${latestVersion}`);

    if (compareVersions(currentVersion, latestVersion) <= 0 && !options.force) {
      console.log('Already up to date.');
      process.exit(0);
    }

    const configDir = getConfigDir();
    const agentConfig = await loadAgentConfig(configDir);
    const agentPort = agentConfig.port || DEFAULT_AGENT_PORT;

    async function checkAgentRunning(): Promise<boolean> {
      try {
        const response = await fetch(`http://localhost:${agentPort}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }

    async function waitForAgentReady(timeoutMs = 15000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await checkAgentRunning()) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    }

    async function runProcess(command: string, args: string[], inherit = true): Promise<number> {
      const proc = spawn(command, args, { stdio: inherit ? 'inherit' : 'ignore' });
      return await new Promise<number>((resolve) => proc.on('close', (code) => resolve(code ?? 0)));
    }

    const serviceStatus = await getServiceStatus();
    const wasSystemdRunning = serviceStatus.running;
    const wasAgentRunning = wasSystemdRunning ? true : await checkAgentRunning();

    if (wasAgentRunning) {
      console.log('');
      console.log('Agent is running; update will restart it.');
      console.log('');

      if (wasSystemdRunning) {
        const stopCode = await runProcess('systemctl', ['--user', 'stop', 'perry-agent']);
        if (stopCode !== 0) {
          console.error('Failed to stop agent service.');
          process.exit(stopCode);
        }
      } else {
        await runProcess('pkill', ['-f', 'perry.*agent.*run']);
        await new Promise((r) => setTimeout(r, 500));
        const stillRunning = await checkAgentRunning();
        if (stillRunning) {
          await runProcess('pkill', ['-9', '-f', 'perry.*agent.*run']);
        }
      }
    }

    console.log(`Updating Perry from ${currentVersion} to ${latestVersion}...`);

    const updateExitCode = await runProcess('bash', [
      '-c',
      'curl -fsSL https://raw.githubusercontent.com/gricha/perry/main/install.sh | bash',
    ]);

    if (updateExitCode !== 0) {
      process.exit(updateExitCode);
    }

    if (wasSystemdRunning) {
      const startCode = await runProcess('systemctl', ['--user', 'start', 'perry-agent']);
      if (startCode !== 0) {
        console.error('Updated perry, but failed to start agent service.');
        process.exit(startCode);
      }
    } else if (wasAgentRunning) {
      const proc = spawn(
        'perry',
        ['agent', 'run', '--port', String(agentPort), '--config-dir', configDir],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
      proc.unref();
    }

    if (!wasAgentRunning) {
      console.log('');
      console.log('Agent was not running; skipping workspace sync.');
      console.log('To update running workspaces, start the agent and run:');
      console.log('  perry sync --all');
      process.exit(0);
    }

    const agentReady = await waitForAgentReady();
    if (!agentReady) {
      console.log('');
      console.error('Updated perry, but agent did not become ready in time.');
      if (wasSystemdRunning) {
        console.error('Check logs with:');
        console.error('  journalctl --user -u perry-agent -f');
      }
      console.error('Then sync workspaces with:');
      console.error('  perry sync --all');
      process.exit(1);
    }

    try {
      console.log('');
      console.log('Syncing all running workspaces...');

      const client = createApiClient(`localhost:${agentPort}`, undefined, 5 * 60 * 1000);
      const result = await client.syncAllWorkspaces();

      if (result.results.length === 0) {
        console.log('No running workspaces to sync.');
        process.exit(0);
      }

      for (const r of result.results) {
        if (r.success) {
          console.log(`  ✓ ${r.name}`);
        } else {
          console.log(`  ✗ ${r.name}: ${r.error}`);
        }
      }

      console.log('');
      console.log(`Synced: ${result.synced}, Failed: ${result.failed}`);
    } catch (err) {
      console.error('');
      console.error('Updated perry, but workspace sync failed.');
      if (err instanceof ApiClientError) {
        console.error(err.message);
      } else if (err instanceof Error) {
        console.error(err.message);
      } else {
        console.error(String(err));
      }
      console.error('Run `perry sync --all` after the agent is reachable.');
    }

    process.exit(0);
  });

program
  .command('build')
  .description('Build the workspace Docker image')
  .option('--no-cache', 'Build without cache')
  .action(async (options) => {
    const buildContext = './perry';

    console.log(`Building workspace image ${WORKSPACE_IMAGE_LOCAL}...`);

    try {
      await buildImage(WORKSPACE_IMAGE_LOCAL, buildContext, {
        noCache: options.noCache === false ? false : !options.cache,
      });
      console.log('Build complete.');
    } catch (err) {
      console.error('Build failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

const workerCmd = program
  .command('worker')
  .description('Worker mode commands (for use inside containers)');

workerCmd
  .command('sessions')
  .argument('<subcommand>', 'Subcommand: list, messages, or delete')
  .argument('[sessionId]', 'Session ID (required for messages and delete)')
  .description('Manage OpenCode sessions')
  .action(async (subcommand: string, sessionId?: string) => {
    const { listOpencodeSessions, getOpencodeSessionMessages, deleteOpencodeSession } =
      await import('./sessions/agents/opencode-storage');

    if (subcommand === 'list') {
      const sessions = await listOpencodeSessions();
      console.log(JSON.stringify(sessions));
    } else if (subcommand === 'messages') {
      if (!sessionId) {
        console.error('Usage: perry worker sessions messages <session_id>');
        process.exit(1);
      }
      const result = await getOpencodeSessionMessages(sessionId);
      console.log(JSON.stringify(result));
    } else if (subcommand === 'delete') {
      if (!sessionId) {
        console.error('Usage: perry worker sessions delete <session_id>');
        process.exit(1);
      }
      const result = await deleteOpencodeSession(sessionId);
      console.log(JSON.stringify(result));
    } else {
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error('Available: list, messages, delete');
      process.exit(1);
    }
  });

workerCmd
  .command('serve')
  .option('--port <port>', 'Port to listen on', '7392')
  .description('Start worker API server')
  .action(async (opts) => {
    const { startWorkerServer } = await import('./worker/server');
    await startWorkerServer({ port: parseInt(opts.port, 10) });
  });

function handleError(err: unknown): never {
  if (err instanceof ApiClientError) {
    console.error(`Error: ${err.message}`);
    if (err.code === 'CONNECTION_FAILED') {
      console.error('Make sure the agent is running and accessible.');
    }
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else if (err && typeof err === 'object') {
    const errObj = err as Record<string, unknown>;
    if ('message' in errObj && typeof errObj.message === 'string') {
      console.error(`Error: ${errObj.message}`);
    } else if ('code' in errObj) {
      console.error(`Error: ${String(errObj.code)}`);
    } else {
      console.error(`Error: ${JSON.stringify(err)}`);
    }
  } else if (err !== undefined && err !== null) {
    console.error('Error:', err);
  } else {
    console.error('An unknown error occurred');
  }
  process.exit(1);
}

const isWorkerCommand = process.argv[2] === 'worker';
if (!isWorkerCommand) {
  checkForUpdates(pkg.version).catch(() => {});
}

program.parse();
