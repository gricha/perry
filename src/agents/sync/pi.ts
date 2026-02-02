import type {
  AgentSyncProvider,
  SyncContext,
  SyncFile,
  SyncDirectory,
  GeneratedConfig,
} from '../types';

export const piSync: AgentSyncProvider = {
  getRequiredDirs(): string[] {
    return ['/home/workspace/.pi/agent'];
  },

  async getFilesToSync(_context: SyncContext): Promise<SyncFile[]> {
    return [
      {
        source: '~/.pi/agent/auth.json',
        dest: '/home/workspace/.pi/agent/auth.json',
        category: 'credential',
        permissions: '600',
        optional: true,
      },
      {
        source: '~/.pi/agent/settings.json',
        dest: '/home/workspace/.pi/agent/settings.json',
        category: 'preference',
        permissions: '644',
        optional: true,
      },
      {
        source: '~/.pi/agent/models.json',
        dest: '/home/workspace/.pi/agent/models.json',
        category: 'preference',
        permissions: '644',
        optional: true,
      },
    ];
  },

  async getDirectoriesToSync(_context: SyncContext): Promise<SyncDirectory[]> {
    return [];
  },

  async getGeneratedConfigs(_context: SyncContext): Promise<GeneratedConfig[]> {
    return [];
  },
};
