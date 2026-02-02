import { describe, it, expect } from 'vitest';
import { syncAgent, syncAllAgents, getCredentialFilePaths, createSyncContext } from '../index';
import { createMockFileCopier } from '../sync/copier';
import { piSync } from '../sync/pi';
import type { AgentSyncProvider, SyncContext } from '../types';

function createMockContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    containerName: 'test-container',
    agentConfig: {
      port: 7777,
      credentials: { env: {}, files: {} },
      scripts: {},
    },
    hostFileExists: async () => false,
    hostDirExists: async () => false,
    readHostFile: async () => null,
    readContainerFile: async () => null,
    ...overrides,
  };
}

describe('syncAgent', () => {
  it('creates required directories', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => ['/home/workspace/.test'],
      getFilesToSync: async () => [],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [],
    };

    const context = createMockContext();
    const copier = createMockFileCopier();

    await syncAgent(provider, context, copier);

    expect(copier.calls).toContainEqual({
      method: 'ensureDir',
      args: ['test-container', '/home/workspace/.test'],
    });
  });

  it('copies files that exist', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => [],
      getFilesToSync: async () => [
        {
          source: '~/.test/file.json',
          dest: '/home/workspace/.test/file.json',
          category: 'credential',
          permissions: '600',
        },
      ],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [],
    };

    const context = createMockContext({
      hostFileExists: async (path) => path === '~/.test/file.json',
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(copier.calls).toContainEqual({
      method: 'copyFile',
      args: [
        'test-container',
        {
          source: '~/.test/file.json',
          dest: '/home/workspace/.test/file.json',
          category: 'credential',
          permissions: '600',
        },
      ],
    });
    expect(result.copied).toContain('~/.test/file.json');
  });

  it('skips optional files that do not exist', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => [],
      getFilesToSync: async () => [
        {
          source: '~/.test/optional.json',
          dest: '/home/workspace/.test/optional.json',
          category: 'preference',
          optional: true,
        },
      ],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [],
    };

    const context = createMockContext({
      hostFileExists: async () => false,
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(result.skipped).toContain('~/.test/optional.json');
    expect(result.errors).toHaveLength(0);
    expect(copier.calls.filter((c) => c.method === 'copyFile')).toHaveLength(0);
  });

  it('reports errors for missing required files', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => [],
      getFilesToSync: async () => [
        {
          source: '~/.test/required.json',
          dest: '/home/workspace/.test/required.json',
          category: 'credential',
          optional: false,
        },
      ],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [],
    };

    const context = createMockContext({
      hostFileExists: async () => false,
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(result.errors).toContainEqual({
      path: '~/.test/required.json',
      error: 'File not found',
    });
  });

  it('copies directories that exist', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => [],
      getFilesToSync: async () => [],
      getDirectoriesToSync: async () => [
        {
          source: '~/.test/dir',
          dest: '/home/workspace/.test/dir',
          category: 'preference',
        },
      ],
      getGeneratedConfigs: async () => [],
    };

    const context = createMockContext({
      hostDirExists: async (path) => path === '~/.test/dir',
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(copier.calls).toContainEqual({
      method: 'copyDirectory',
      args: [
        'test-container',
        {
          source: '~/.test/dir',
          dest: '/home/workspace/.test/dir',
          category: 'preference',
        },
      ],
    });
    expect(result.copied).toContain('~/.test/dir');
  });

  it('generates configs', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => [],
      getFilesToSync: async () => [],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [
        {
          dest: '/home/workspace/.test/config.json',
          content: '{"key": "value"}',
          permissions: '644',
          category: 'preference',
        },
      ],
    };

    const context = createMockContext();
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(copier.calls).toContainEqual({
      method: 'writeConfig',
      args: [
        'test-container',
        {
          dest: '/home/workspace/.test/config.json',
          content: '{"key": "value"}',
          permissions: '644',
          category: 'preference',
        },
      ],
    });
    expect(result.generated).toContain('/home/workspace/.test/config.json');
  });

  it('tracks all results correctly', async () => {
    const provider: AgentSyncProvider = {
      getRequiredDirs: () => ['/home/workspace/.test'],
      getFilesToSync: async () => [
        {
          source: '~/.test/exists.json',
          dest: '/home/workspace/.test/exists.json',
          category: 'credential',
        },
        {
          source: '~/.test/optional.json',
          dest: '/home/workspace/.test/optional.json',
          category: 'preference',
          optional: true,
        },
      ],
      getDirectoriesToSync: async () => [],
      getGeneratedConfigs: async () => [
        {
          dest: '/home/workspace/.test/generated.json',
          content: '{}',
          category: 'preference',
        },
      ],
    };

    const context = createMockContext({
      hostFileExists: async (path) => path === '~/.test/exists.json',
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(provider, context, copier);

    expect(result.copied).toEqual(['~/.test/exists.json']);
    expect(result.skipped).toEqual(['~/.test/optional.json']);
    expect(result.generated).toEqual(['/home/workspace/.test/generated.json']);
    expect(result.errors).toHaveLength(0);
  });
});

describe('syncAllAgents', () => {
  it('syncs all agents', async () => {
    const copier = createMockFileCopier();

    const results = await syncAllAgents(
      'test-container',
      {
        port: 7777,
        credentials: { env: {}, files: {} },
        scripts: {},
      },
      copier
    );

    expect(results['claude-code']).toBeDefined();
    expect(results['opencode']).toBeDefined();
    expect(results['codex']).toBeDefined();
    expect(results['pi']).toBeDefined();
  });

  it('returns results per agent', async () => {
    const copier = createMockFileCopier();

    const results = await syncAllAgents(
      'test-container',
      {
        port: 7777,
        credentials: { env: {}, files: {} },
        scripts: {},
      },
      copier
    );

    for (const agentType of ['claude-code', 'opencode', 'codex', 'pi'] as const) {
      const result = results[agentType];
      expect(result).toHaveProperty('copied');
      expect(result).toHaveProperty('generated');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('errors');
    }
  });
});

describe('getCredentialFilePaths', () => {
  it('returns credential files from providers', () => {
    const paths = getCredentialFilePaths();

    expect(paths).toContain('~/.claude/.credentials.json');
    expect(paths).toContain('~/.codex/auth.json');
    expect(paths).toContain('~/.local/share/opencode/auth.json');
    expect(paths).toContain('~/.local/share/opencode/mcp-auth.json');
    expect(paths).toContain('~/.pi/agent/auth.json');
  });

  it('does not include preference-only files', () => {
    const paths = getCredentialFilePaths();

    expect(paths).not.toContain('~/.claude/settings.json');
    expect(paths).not.toContain('~/.codex/config.toml');
    expect(paths).not.toContain('~/.pi/agent/settings.json');
    expect(paths).not.toContain('~/.pi/agent/models.json');
  });
});

describe('createSyncContext', () => {
  it('creates context with correct container name', () => {
    const context = createSyncContext('my-container', {
      port: 7777,
      credentials: { env: {}, files: {} },
      scripts: {},
    });

    expect(context.containerName).toBe('my-container');
  });

  it('creates context with agent config', () => {
    const config = {
      port: 7777,
      credentials: { env: {}, files: {} },
      scripts: {},
      agents: { opencode: { server: { hostname: '0.0.0.0' } } },
    };

    const context = createSyncContext('my-container', config);

    expect(context.agentConfig).toBe(config);
  });
});

describe('piSync', () => {
  it('requires .pi/agent directory', () => {
    const dirs = piSync.getRequiredDirs();
    expect(dirs).toContain('/home/workspace/.pi/agent');
  });

  it('syncs auth.json as credential', async () => {
    const context = createMockContext();
    const files = await piSync.getFilesToSync(context);

    const authFile = files.find((f) => f.source === '~/.pi/agent/auth.json');
    expect(authFile).toBeDefined();
    expect(authFile!.category).toBe('credential');
    expect(authFile!.permissions).toBe('600');
    expect(authFile!.optional).toBe(true);
  });

  it('syncs settings.json as preference', async () => {
    const context = createMockContext();
    const files = await piSync.getFilesToSync(context);

    const settingsFile = files.find((f) => f.source === '~/.pi/agent/settings.json');
    expect(settingsFile).toBeDefined();
    expect(settingsFile!.category).toBe('preference');
    expect(settingsFile!.permissions).toBe('644');
  });

  it('syncs models.json as preference', async () => {
    const context = createMockContext();
    const files = await piSync.getFilesToSync(context);

    const modelsFile = files.find((f) => f.source === '~/.pi/agent/models.json');
    expect(modelsFile).toBeDefined();
    expect(modelsFile!.category).toBe('preference');
    expect(modelsFile!.permissions).toBe('644');
  });

  it('has no directories to sync', async () => {
    const context = createMockContext();
    const dirs = await piSync.getDirectoriesToSync(context);
    expect(dirs).toHaveLength(0);
  });

  it('has no generated configs', async () => {
    const context = createMockContext();
    const configs = await piSync.getGeneratedConfigs(context);
    expect(configs).toHaveLength(0);
  });

  it('copies auth when file exists on host', async () => {
    const context = createMockContext({
      hostFileExists: async (path) => path === '~/.pi/agent/auth.json',
    });
    const copier = createMockFileCopier();

    const result = await syncAgent(piSync, context, copier);

    expect(result.copied).toContain('~/.pi/agent/auth.json');
    expect(result.skipped).toContain('~/.pi/agent/settings.json');
    expect(result.skipped).toContain('~/.pi/agent/models.json');
    expect(result.errors).toHaveLength(0);
  });
});
