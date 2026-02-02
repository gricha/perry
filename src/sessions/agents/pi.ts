import type { SessionMessage } from '../types';
import type { RawSession, SessionListItem, ExecInContainer, AgentSessionProvider } from './types';
import { extractContent } from './utils';

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant';
  content?: unknown;
  sessionId?: string;
}

function parsePiMessages(content: string): {
  sessionId: string | null;
  messages: SessionMessage[];
} {
  const lines = content.split('\n').filter(Boolean);
  let sessionId: string | null = null;
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as PiEntry;

      if (!sessionId && entry.type === 'header' && entry.id) {
        sessionId = entry.id;
      }
      if (!sessionId && entry.sessionId) {
        sessionId = entry.sessionId;
      }

      if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
        const textContent = extractContent(entry.content);
        messages.push({
          type: entry.role,
          content: textContent || undefined,
          timestamp: entry.timestamp,
        });
      }
    } catch {
      continue;
    }
  }

  return { sessionId, messages };
}

export async function findPiSessionFile(
  baseDir: string,
  sessionId: string,
  exec?: ExecInContainer,
  containerName?: string
): Promise<string | null> {
  if (!exec || !containerName) return null;

  const result = await exec(
    containerName,
    ['bash', '-c', `find ${baseDir} -name "*.jsonl" -type f 2>/dev/null`],
    { user: 'workspace' }
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }

  const files = result.stdout.trim().split('\n').filter(Boolean);

  for (const file of files) {
    const basename = file.split('/').pop()?.replace('.jsonl', '') || '';
    if (basename.includes(sessionId)) {
      return file;
    }

    const headResult = await exec(containerName, ['head', '-1', file], {
      user: 'workspace',
    });
    if (headResult.exitCode === 0) {
      try {
        const header = JSON.parse(headResult.stdout) as PiEntry;
        if (header.id === sessionId) {
          return file;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

export const piProvider: AgentSessionProvider = {
  async discoverSessions(containerName: string, exec: ExecInContainer): Promise<RawSession[]> {
    const result = await exec(
      containerName,
      [
        'sh',
        '-c',
        'find /home/workspace/.pi/agent/sessions -name "*.jsonl" -type f -printf "%p\\t%T@\\t" -exec wc -l {} \\; 2>/dev/null || true',
      ],
      { user: 'workspace' }
    );

    const sessions: RawSession[] = [];

    if (result.exitCode === 0 && result.stdout.trim()) {
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const file = parts[0];
          const mtime = Math.floor(parseFloat(parts[1]) || 0);

          const basename = file.split('/').pop()?.replace('.jsonl', '') || '';
          const idParts = basename.split('_');
          const id = idParts.length > 1 ? idParts[idParts.length - 1] : basename;

          const projPath = file
            .replace('/home/workspace/.pi/agent/sessions/', '')
            .replace(/\/[^/]+$/, '');

          sessions.push({
            id,
            agentType: 'pi',
            projectPath: projPath,
            mtime,
            filePath: file,
          });
        }
      }
    }

    return sessions;
  },

  async getSessionDetails(
    containerName: string,
    rawSession: RawSession,
    exec: ExecInContainer
  ): Promise<SessionListItem | null> {
    const catResult = await exec(containerName, ['cat', rawSession.filePath], {
      user: 'workspace',
    });

    if (catResult.exitCode !== 0) {
      return null;
    }

    const { sessionId, messages } = parsePiMessages(catResult.stdout);

    const firstPrompt = messages.find(
      (msg) => msg.type === 'user' && msg.content && msg.content.trim().length > 0
    )?.content;

    if (messages.length === 0) {
      return null;
    }

    return {
      id: sessionId || rawSession.id,
      name: null,
      agentType: rawSession.agentType,
      projectPath: rawSession.projectPath,
      messageCount: messages.length,
      lastActivity: new Date(rawSession.mtime * 1000).toISOString(),
      firstPrompt: firstPrompt ? firstPrompt.slice(0, 200) : null,
    };
  },

  async getSessionMessages(
    containerName: string,
    sessionId: string,
    exec: ExecInContainer,
    _projectPath?: string
  ): Promise<{ id: string; messages: SessionMessage[] } | null> {
    const findResult = await exec(
      containerName,
      ['bash', '-c', 'find /home/workspace/.pi/agent/sessions -name "*.jsonl" -type f 2>/dev/null'],
      { user: 'workspace' }
    );

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return null;
    }

    const files = findResult.stdout.trim().split('\n').filter(Boolean);

    for (const file of files) {
      const catResult = await exec(containerName, ['cat', file], {
        user: 'workspace',
      });
      if (catResult.exitCode !== 0) continue;

      const { sessionId: parsedId, messages } = parsePiMessages(catResult.stdout);
      const basename = file.split('/').pop()?.replace('.jsonl', '') || '';

      if (parsedId === sessionId || basename.includes(sessionId)) {
        return { id: parsedId || sessionId, messages };
      }
    }

    return null;
  },

  async deleteSession(
    containerName: string,
    sessionId: string,
    exec: ExecInContainer
  ): Promise<{ success: boolean; error?: string }> {
    const findResult = await exec(
      containerName,
      ['bash', '-c', 'find /home/workspace/.pi/agent/sessions -name "*.jsonl" -type f 2>/dev/null'],
      { user: 'workspace' }
    );

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return { success: false, error: 'No session files found' };
    }

    const files = findResult.stdout.trim().split('\n').filter(Boolean);

    for (const file of files) {
      const basename = file.split('/').pop()?.replace('.jsonl', '') || '';

      if (basename.includes(sessionId)) {
        const rmResult = await exec(containerName, ['rm', '-f', file], {
          user: 'workspace',
        });
        if (rmResult.exitCode !== 0) {
          return { success: false, error: rmResult.stderr || 'Failed to delete session file' };
        }
        return { success: true };
      }

      const headResult = await exec(containerName, ['head', '-1', file], {
        user: 'workspace',
      });
      if (headResult.exitCode === 0) {
        try {
          const header = JSON.parse(headResult.stdout) as PiEntry;
          if (header.id === sessionId) {
            const rmResult = await exec(containerName, ['rm', '-f', file], {
              user: 'workspace',
            });
            if (rmResult.exitCode !== 0) {
              return { success: false, error: rmResult.stderr || 'Failed to delete session file' };
            }
            return { success: true };
          }
        } catch {
          continue;
        }
      }
    }

    return { success: false, error: 'Session not found' };
  },
};
