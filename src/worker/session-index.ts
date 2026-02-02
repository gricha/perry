import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { watch, type FSWatcher } from 'node:fs';

export interface IndexedSession {
  id: string;
  agentType: 'claude' | 'opencode' | 'pi';
  title: string;
  directory: string;
  filePath: string;
  messageCount: number;
  firstPrompt: string | null;
  lastActivity: number;
}

interface WatcherEntry {
  watcher: FSWatcher;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

class SessionIndex {
  private sessions = new Map<string, IndexedSession>();
  private watchers: WatcherEntry[] = [];
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await Promise.all([
      this.discoverClaudeSessions(),
      this.discoverOpencodeSessions(),
      this.discoverPiSessions(),
    ]);

    this.initialized = true;
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.discoverClaudeSessions(),
      this.discoverOpencodeSessions(),
      this.discoverPiSessions(),
    ]);
  }

  startWatchers(): void {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const opencodeDir = path.join(
      os.homedir(),
      '.local',
      'share',
      'opencode',
      'storage',
      'session'
    );
    const piDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');

    this.watchDirectory(claudeDir, 'claude');
    this.watchDirectory(opencodeDir, 'opencode');
    this.watchDirectory(piDir, 'pi');
  }

  stopWatchers(): void {
    for (const entry of this.watchers) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      entry.watcher.close();
    }
    this.watchers = [];
  }

  list(): IndexedSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(id: string): IndexedSession | undefined {
    return this.sessions.get(id);
  }

  async getMessages(
    id: string,
    opts: { limit: number; offset: number }
  ): Promise<{ id: string; messages: Message[]; total: number }> {
    const session = this.sessions.get(id);
    if (!session) {
      return { id, messages: [], total: 0 };
    }

    if (session.agentType === 'claude') {
      return this.getClaudeMessages(session, opts);
    } else if (session.agentType === 'pi') {
      return this.getPiMessages(session, opts);
    } else {
      return this.getOpencodeMessages(session, opts);
    }
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    try {
      if (session.agentType === 'claude') {
        await fs.unlink(session.filePath);
      } else if (session.agentType === 'pi') {
        await fs.unlink(session.filePath);
      } else {
        const { deleteOpencodeSession } = await import('../sessions/agents/opencode-storage');
        const result = await deleteOpencodeSession(id);
        if (!result.success) {
          return result;
        }
      }

      this.sessions.delete(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  private async discoverClaudeSessions(): Promise<void> {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');

    try {
      const projectDirs = await fs.readdir(claudeDir, { withFileTypes: true });

      await Promise.all(
        projectDirs.map(async (projectDir) => {
          if (!projectDir.isDirectory()) return;

          const projectPath = path.join(claudeDir, projectDir.name);
          try {
            const files = await fs.readdir(projectPath);

            await Promise.all(
              files.map(async (file) => {
                if (!file.endsWith('.jsonl') || file.startsWith('agent-')) return;

                const filePath = path.join(projectPath, file);
                await this.indexClaudeSession(filePath, projectDir.name);
              })
            );
          } catch {
            // Project directory may have been removed
          }
        })
      );
    } catch {
      // Claude directory doesn't exist
    }
  }

  private async discoverOpencodeSessions(): Promise<void> {
    try {
      const { listOpencodeSessions } = await import('../sessions/agents/opencode-storage');
      const sessions = await listOpencodeSessions();

      for (const session of sessions) {
        this.sessions.set(session.id, {
          id: session.id,
          agentType: 'opencode',
          title: session.title,
          directory: session.directory,
          filePath: session.file,
          messageCount: session.messageCount,
          firstPrompt: session.title || null,
          lastActivity: session.mtime,
        });
      }
    } catch {
      // OpenCode storage doesn't exist
    }
  }

  private async indexClaudeSession(filePath: string, projectName: string): Promise<void> {
    try {
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      if (lines.length === 0) return;

      const sessionId = path.basename(filePath, '.jsonl');
      let firstPrompt: string | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' || entry.type === 'human') {
            if (typeof entry.message?.content === 'string' && entry.message.content.trim()) {
              firstPrompt = entry.message.content.slice(0, 200);
              break;
            } else if (Array.isArray(entry.message?.content)) {
              const textContent = entry.message.content.find(
                (c: { type: string }) => c.type === 'text'
              );
              if (textContent?.text) {
                firstPrompt = textContent.text.slice(0, 200);
                break;
              }
            } else if (typeof entry.content === 'string' && entry.content.trim()) {
              firstPrompt = entry.content.slice(0, 200);
              break;
            }
          }
        } catch {
          continue;
        }
      }

      this.sessions.set(sessionId, {
        id: sessionId,
        agentType: 'claude',
        title: firstPrompt || projectName,
        directory: projectName,
        filePath,
        messageCount: lines.length,
        firstPrompt,
        lastActivity: stat.mtimeMs,
      });
    } catch {
      // File may have been removed or is invalid
    }
  }

  private watchDirectory(dir: string, agentType: 'claude' | 'opencode' | 'pi'): void {
    try {
      const watcher = watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;

        const entry = this.watchers.find((w) => w.watcher === watcher);
        if (entry?.debounceTimer) {
          clearTimeout(entry.debounceTimer);
        }

        const timer = setTimeout(() => {
          this.handleFileChange(dir, filename, agentType).catch((err) => {
            console.error('[session-index] Error handling file change:', err);
          });
        }, 100);

        if (entry) {
          entry.debounceTimer = timer;
        }
      });

      this.watchers.push({ watcher });
    } catch {
      // Directory doesn't exist, skip watching
    }
  }

  private async handleFileChange(
    baseDir: string,
    filename: string,
    agentType: 'claude' | 'opencode' | 'pi'
  ): Promise<void> {
    const filePath = path.join(baseDir, filename);

    if (agentType === 'claude') {
      if (!filename.endsWith('.jsonl') || filename.includes('agent-')) return;

      try {
        await fs.access(filePath);
        const projectName = path.dirname(filename);
        await this.indexClaudeSession(filePath, projectName);
      } catch {
        const sessionId = path.basename(filename, '.jsonl');
        this.sessions.delete(sessionId);
      }
    } else if (agentType === 'pi') {
      if (!filename.endsWith('.jsonl')) return;

      try {
        await fs.access(filePath);
        const dirName = path.dirname(filename);
        await this.indexPiSession(filePath, dirName);
      } catch {
        const basename = path.basename(filename, '.jsonl');
        const idParts = basename.split('_');
        const sessionId = idParts.length > 1 ? idParts[idParts.length - 1] : basename;
        this.sessions.delete(sessionId);
      }
    } else {
      if (!filename.endsWith('.json') || !filename.includes('ses_')) return;

      try {
        await this.discoverOpencodeSessions();
      } catch {
        // Re-discovery failed
      }
    }
  }

  private async getClaudeMessages(
    session: IndexedSession,
    opts: { limit: number; offset: number }
  ): Promise<{ id: string; messages: Message[]; total: number }> {
    try {
      const content = await fs.readFile(session.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const total = lines.length;

      const startIndex = Math.max(0, total - opts.offset - opts.limit);
      const endIndex = total - opts.offset;
      const slice = lines.slice(startIndex, endIndex);

      const messages: Message[] = [];
      for (const line of slice) {
        try {
          const entry = JSON.parse(line);
          const converted = this.convertClaudeEntry(entry);
          if (converted) {
            messages.push(...converted);
          }
        } catch {
          continue;
        }
      }

      return { id: session.id, messages, total };
    } catch {
      return { id: session.id, messages: [], total: 0 };
    }
  }

  private convertClaudeEntry(entry: ClaudeLogEntry): Message[] | null {
    if (entry.type === 'user' || entry.type === 'human') {
      const content = entry.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return [
          {
            type: 'user',
            content: content,
            timestamp: entry.timestamp,
          },
        ];
      } else if (Array.isArray(content)) {
        const textContent = content.find((c) => c.type === 'text');
        if (textContent?.text) {
          return [
            {
              type: 'user',
              content: textContent.text,
              timestamp: entry.timestamp,
            },
          ];
        }
      }
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) return null;

      const messages: Message[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          messages.push({
            type: 'assistant',
            content: block.text,
            timestamp: entry.timestamp,
          });
        } else if (block.type === 'tool_use') {
          messages.push({
            type: 'tool_use',
            toolName: block.name,
            toolId: block.id,
            toolInput: JSON.stringify(block.input),
            timestamp: entry.timestamp,
          });
        }
      }
      return messages.length > 0 ? messages : null;
    }

    if (entry.type === 'tool_result') {
      return [
        {
          type: 'tool_result',
          content:
            typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
          toolId: entry.tool_use_id,
          timestamp: entry.timestamp,
        },
      ];
    }

    return null;
  }

  private async getOpencodeMessages(
    session: IndexedSession,
    opts: { limit: number; offset: number }
  ): Promise<{ id: string; messages: Message[]; total: number }> {
    try {
      const { getOpencodeSessionMessages } = await import('../sessions/agents/opencode-storage');
      const result = await getOpencodeSessionMessages(session.id);

      const total = result.messages.length;
      const startIndex = Math.max(0, total - opts.offset - opts.limit);
      const endIndex = total - opts.offset;
      const slice = result.messages.slice(startIndex, endIndex);

      const messages: Message[] = slice.map((m) => ({
        type: m.type as Message['type'],
        content: m.content,
        toolName: m.toolName,
        toolId: m.toolId,
        toolInput: m.toolInput,
        timestamp: m.timestamp,
      }));

      return { id: session.id, messages, total };
    } catch {
      return { id: session.id, messages: [], total: 0 };
    }
  }

  private async discoverPiSessions(): Promise<void> {
    const piDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');

    try {
      await this.scanPiDirectory(piDir);
    } catch {
      // Pi directory doesn't exist
    }
  }

  private async scanPiDirectory(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      await Promise.all(
        entries.map(async (entry) => {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await this.scanPiDirectory(entryPath);
          } else if (entry.name.endsWith('.jsonl')) {
            const dirName = path.basename(dir);
            await this.indexPiSession(entryPath, dirName);
          }
        })
      );
    } catch {
      // Directory may not exist
    }
  }

  private async indexPiSession(filePath: string, dirName: string): Promise<void> {
    try {
      const fileStat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      if (lines.length === 0) return;

      const basename = path.basename(filePath, '.jsonl');
      const idParts = basename.split('_');
      let sessionId = idParts.length > 1 ? idParts[idParts.length - 1] : basename;
      let firstPrompt: string | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PiLogEntry;
          if (entry.type === 'header' && entry.id) {
            sessionId = entry.id;
          }
          if (entry.type === 'message' && entry.role === 'user' && !firstPrompt) {
            if (typeof entry.content === 'string' && entry.content.trim()) {
              firstPrompt = entry.content.slice(0, 200);
            } else if (Array.isArray(entry.content)) {
              const textContent = entry.content.find((c: { type: string }) => c.type === 'text');
              if (textContent?.text) {
                firstPrompt = textContent.text.slice(0, 200);
              }
            }
          }
        } catch {
          continue;
        }
      }

      const messageCount = lines.filter((line) => {
        try {
          const entry = JSON.parse(line) as PiLogEntry;
          return entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant');
        } catch {
          return false;
        }
      }).length;

      this.sessions.set(sessionId, {
        id: sessionId,
        agentType: 'pi',
        title: firstPrompt || dirName,
        directory: dirName,
        filePath,
        messageCount,
        firstPrompt,
        lastActivity: fileStat.mtimeMs,
      });
    } catch {
      // File may have been removed or is invalid
    }
  }

  private async getPiMessages(
    session: IndexedSession,
    opts: { limit: number; offset: number }
  ): Promise<{ id: string; messages: Message[]; total: number }> {
    try {
      const content = await fs.readFile(session.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const messages: Message[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PiLogEntry;
          if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
            let textContent: string | undefined;
            if (typeof entry.content === 'string') {
              textContent = entry.content;
            } else if (Array.isArray(entry.content)) {
              const text = entry.content.find((c: { type: string }) => c.type === 'text');
              textContent = text?.text;
            }
            if (textContent) {
              messages.push({
                type: entry.role,
                content: textContent,
                timestamp: entry.timestamp,
              });
            }
          }
        } catch {
          continue;
        }
      }

      const total = messages.length;
      const startIndex = Math.max(0, total - opts.offset - opts.limit);
      const endIndex = total - opts.offset;
      const slice = messages.slice(startIndex, endIndex);

      return { id: session.id, messages: slice, total };
    } catch {
      return { id: session.id, messages: [], total: 0 };
    }
  }
}

interface PiLogEntry {
  type: string;
  id?: string;
  role?: 'user' | 'assistant';
  content?: string | Array<{ type: string; text?: string }>;
  timestamp?: string;
}

export interface Message {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  timestamp?: string;
}

interface ClaudeLogEntry {
  type: string;
  timestamp?: string;
  message?: {
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          name?: string;
          id?: string;
          input?: unknown;
        }>;
  };
  content?: unknown;
  tool_use_id?: string;
}

export const sessionIndex = new SessionIndex();
export { SessionIndex };
