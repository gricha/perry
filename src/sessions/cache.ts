import { promises as fs } from 'fs';
import path from 'path';

export interface RecentSession {
  workspaceName: string;
  sessionId: string;
  agentType: 'claude-code' | 'opencode' | 'codex' | 'pi';
  lastAccessed: string;
}

interface SessionsCache {
  recent: RecentSession[];
}

const CACHE_FILE = 'recent-sessions.json';
const MAX_RECENT = 20;

export class SessionsCacheManager {
  private cachePath: string;
  private cache: SessionsCache | null = null;

  constructor(configDir: string) {
    this.cachePath = path.join(configDir, CACHE_FILE);
  }

  private async load(): Promise<SessionsCache> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const content = await fs.readFile(this.cachePath, 'utf-8');
      this.cache = JSON.parse(content);
      return this.cache!;
    } catch {
      this.cache = { recent: [] };
      return this.cache;
    }
  }

  private async save(): Promise<void> {
    if (!this.cache) return;
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  async getRecent(limit = 10): Promise<RecentSession[]> {
    const cache = await this.load();
    return cache.recent.slice(0, limit);
  }

  async recordAccess(
    workspaceName: string,
    sessionId: string,
    agentType: 'claude-code' | 'opencode' | 'codex' | 'pi'
  ): Promise<void> {
    const cache = await this.load();

    cache.recent = cache.recent.filter(
      (s) => !(s.workspaceName === workspaceName && s.sessionId === sessionId)
    );

    cache.recent.unshift({
      workspaceName,
      sessionId,
      agentType,
      lastAccessed: new Date().toISOString(),
    });

    cache.recent = cache.recent.slice(0, MAX_RECENT);

    await this.save();
  }

  async removeForWorkspace(workspaceName: string): Promise<void> {
    const cache = await this.load();
    cache.recent = cache.recent.filter((s) => s.workspaceName !== workspaceName);
    await this.save();
  }

  async removeSession(workspaceName: string, sessionId: string): Promise<void> {
    const cache = await this.load();
    cache.recent = cache.recent.filter(
      (s) => !(s.workspaceName === workspaceName && s.sessionId === sessionId)
    );
    await this.save();
  }
}
