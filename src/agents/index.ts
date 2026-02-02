import fs from 'fs/promises';
import type { AgentType } from '../sessions/types';
import type { AgentConfig } from '../shared/types';
import type { Agent, AgentSyncProvider, SyncContext, SyncResult } from './types';
import type { FileCopier } from './sync/types';
import { claudeProvider, opencodeProvider, codexProvider, piProvider } from '../sessions/agents';
import { claudeCodeSync } from './sync/claude-code';
import { opencodeSync } from './sync/opencode';
import { codexSync } from './sync/codex';
import { piSync } from './sync/pi';
import { createDockerFileCopier } from './sync/copier';
import { expandPath } from '../config/loader';
import * as docker from '../docker';

export const agents: Record<AgentType, Agent> = {
  'claude-code': {
    agentType: 'claude-code',
    sync: claudeCodeSync,
    sessions: claudeProvider,
  },
  opencode: {
    agentType: 'opencode',
    sync: opencodeSync,
    sessions: opencodeProvider,
  },
  codex: {
    agentType: 'codex',
    sync: codexSync,
    sessions: codexProvider,
  },
  pi: {
    agentType: 'pi',
    sync: piSync,
    sessions: piProvider,
  },
};

export function createSyncContext(containerName: string, agentConfig: AgentConfig): SyncContext {
  return {
    containerName,
    agentConfig,

    async hostFileExists(filePath: string): Promise<boolean> {
      try {
        const expanded = expandPath(filePath);
        const stat = await fs.stat(expanded);
        return stat.isFile();
      } catch {
        return false;
      }
    },

    async hostDirExists(dirPath: string): Promise<boolean> {
      try {
        const expanded = expandPath(dirPath);
        const stat = await fs.stat(expanded);
        return stat.isDirectory();
      } catch {
        return false;
      }
    },

    async readHostFile(filePath: string): Promise<string | null> {
      try {
        const expanded = expandPath(filePath);
        return await fs.readFile(expanded, 'utf-8');
      } catch {
        return null;
      }
    },

    async readContainerFile(filePath: string): Promise<string | null> {
      try {
        const result = await docker.execInContainer(containerName, ['cat', filePath], {
          user: 'workspace',
        });
        if (result.exitCode !== 0) {
          return null;
        }
        return result.stdout;
      } catch {
        return null;
      }
    },
  };
}

export async function syncAgent(
  provider: AgentSyncProvider,
  context: SyncContext,
  copier: FileCopier
): Promise<SyncResult> {
  const result: SyncResult = {
    copied: [],
    generated: [],
    skipped: [],
    errors: [],
  };

  for (const dir of provider.getRequiredDirs()) {
    try {
      await copier.ensureDir(context.containerName, dir);
    } catch (err) {
      result.errors.push({ path: dir, error: String(err) });
    }
  }

  const files = await provider.getFilesToSync(context);
  for (const file of files) {
    const exists = await context.hostFileExists(file.source);
    if (!exists) {
      if (file.optional) {
        result.skipped.push(file.source);
      } else {
        result.errors.push({ path: file.source, error: 'File not found' });
      }
      continue;
    }

    try {
      await copier.copyFile(context.containerName, file);
      result.copied.push(file.source);
    } catch (err) {
      result.errors.push({ path: file.source, error: String(err) });
    }
  }

  const directories = await provider.getDirectoriesToSync(context);
  for (const dir of directories) {
    const exists = await context.hostDirExists(dir.source);
    if (!exists) {
      if (dir.optional) {
        result.skipped.push(dir.source);
      } else {
        result.errors.push({ path: dir.source, error: 'Directory not found' });
      }
      continue;
    }

    try {
      await copier.copyDirectory(context.containerName, dir);
      result.copied.push(dir.source);
    } catch (err) {
      result.errors.push({ path: dir.source, error: String(err) });
    }
  }

  const configs = await provider.getGeneratedConfigs(context);
  for (const config of configs) {
    try {
      await copier.writeConfig(context.containerName, config);
      result.generated.push(config.dest);
    } catch (err) {
      result.errors.push({ path: config.dest, error: String(err) });
    }
  }

  return result;
}

export async function syncAllAgents(
  containerName: string,
  agentConfig: AgentConfig,
  copier?: FileCopier
): Promise<Record<AgentType, SyncResult>> {
  const actualCopier = copier || createDockerFileCopier();
  const context = createSyncContext(containerName, agentConfig);

  const results: Record<AgentType, SyncResult> = {
    'claude-code': { copied: [], generated: [], skipped: [], errors: [] },
    opencode: { copied: [], generated: [], skipped: [], errors: [] },
    codex: { copied: [], generated: [], skipped: [], errors: [] },
    pi: { copied: [], generated: [], skipped: [], errors: [] },
  };

  for (const [agentType, agent] of Object.entries(agents)) {
    results[agentType as AgentType] = await syncAgent(agent.sync, context, actualCopier);
  }

  return results;
}

export function getCredentialFilePaths(): string[] {
  return [
    '~/.claude/.credentials.json',
    '~/.codex/auth.json',
    '~/.local/share/opencode/auth.json',
    '~/.local/share/opencode/mcp-auth.json',
    '~/.pi/agent/auth.json',
  ];
}

export type {
  Agent,
  AgentSyncProvider,
  SyncFile,
  SyncDirectory,
  SyncResult,
  SyncContext,
} from './types';
export type { FileCopier } from './sync/types';
export { createDockerFileCopier, createMockFileCopier } from './sync/copier';
