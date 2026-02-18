import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_CONFIG_DIR, CONFIG_FILE, type AgentConfig } from '../shared/types';
import { DEFAULT_AGENT_PORT } from '../shared/constants';
import { expandPath } from '../shared/path-utils';

export { expandPath };

export function getConfigDir(configDir?: string): string {
  return configDir || process.env.WS_CONFIG_DIR || DEFAULT_CONFIG_DIR;
}

export async function ensureConfigDir(configDir?: string): Promise<void> {
  const dir = getConfigDir(configDir);
  await fs.mkdir(dir, { recursive: true });
}

export function createDefaultAgentConfig(): AgentConfig {
  return {
    port: DEFAULT_AGENT_PORT,
    host: '0.0.0.0',
    credentials: {
      env: {},
      files: {},
    },
    scripts: {
      post_start: ['~/.perry/userscripts'],
      fail_on_error: false,
    },
    agents: {
      opencode: {
        server: {
          // Default to binding on all interfaces for Tailscale/remote access.
          // Users can override to 127.0.0.1 if they want local-only.
          hostname: '0.0.0.0',
        },
      },
    },
    skills: [],
    mcpServers: [],
    allowHostAccess: true,
    ssh: {
      autoAuthorizeHostKeys: true,
      global: {
        copy: [],
        authorize: [],
      },
      workspaces: {},
    },
  };
}

function migratePostStart(value: unknown): string[] {
  if (!value) {
    return ['~/.perry/userscripts'];
  }
  if (typeof value === 'string') {
    return [value, '~/.perry/userscripts'];
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value : ['~/.perry/userscripts'];
  }
  return ['~/.perry/userscripts'];
}

export async function loadAgentConfig(configDir?: string): Promise<AgentConfig> {
  const dir = getConfigDir(configDir);
  const configPath = path.join(dir, CONFIG_FILE);

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    const envTailscaleAuthKey = process.env.PERRY_TAILSCALE_AUTH_KEY;
    const tailscale = envTailscaleAuthKey
      ? {
          ...config.tailscale,
          enabled: true,
          authKey: envTailscaleAuthKey,
        }
      : config.tailscale;
    return {
      port: config.port || DEFAULT_AGENT_PORT,
      host: config.host || '0.0.0.0',
      credentials: {
        env: config.credentials?.env || {},
        files: config.credentials?.files || {},
      },
      scripts: {
        post_start: migratePostStart(config.scripts?.post_start),
        fail_on_error: config.scripts?.fail_on_error ?? false,
      },
      agents: {
        ...config.agents,
        opencode: {
          ...config.agents?.opencode,
          server: {
            hostname: config.agents?.opencode?.server?.hostname || '0.0.0.0',
            username: config.agents?.opencode?.server?.username,
            password: config.agents?.opencode?.server?.password,
          },
        },
      },
      skills: Array.isArray(config.skills) ? config.skills : [],
      mcpServers: Array.isArray(config.mcpServers) ? config.mcpServers : [],
      runtime: config.runtime || 'docker',
      allowHostAccess: config.allowHostAccess ?? true,
      ssh: {
        autoAuthorizeHostKeys: config.ssh?.autoAuthorizeHostKeys ?? true,
        global: {
          copy: config.ssh?.global?.copy || [],
          authorize: config.ssh?.global?.authorize || [],
        },
        workspaces: config.ssh?.workspaces || {},
      },
      tailscale,
      auth: config.auth,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultAgentConfig();
    }
    throw err;
  }
}

export async function saveAgentConfig(config: AgentConfig, configDir?: string): Promise<void> {
  const dir = getConfigDir(configDir);
  await ensureConfigDir(dir);
  const configPath = path.join(dir, CONFIG_FILE);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
