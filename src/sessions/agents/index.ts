import type { AgentType, SessionMessage } from '../types';
import type { RawSession, SessionListItem, ExecInContainer, AgentSessionProvider } from './types';
import { claudeProvider } from './claude';
import { opencodeProvider } from './opencode';
import { codexProvider } from './codex';
import { piProvider } from './pi';
import {
  discoverSessionsViaWorker,
  getSessionDetailsViaWorker,
  getSessionMessagesViaWorker,
  deleteSessionViaWorker,
} from './worker-provider';

export type { RawSession, SessionListItem, ExecInContainer, AgentSessionProvider } from './types';
export { claudeProvider } from './claude';
export { opencodeProvider } from './opencode';
export { codexProvider } from './codex';
export { piProvider } from './pi';
export { clearWorkerClientCache } from './worker-provider';

const _providers: Record<AgentType, AgentSessionProvider> = {
  'claude-code': claudeProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  pi: piProvider,
};

export async function discoverAllSessions(
  containerName: string,
  _exec: ExecInContainer
): Promise<RawSession[]> {
  return discoverSessionsViaWorker(containerName);
}

export async function getSessionDetails(
  containerName: string,
  rawSession: RawSession,
  _exec: ExecInContainer
): Promise<SessionListItem | null> {
  return getSessionDetailsViaWorker(containerName, rawSession);
}

export async function getSessionMessages(
  containerName: string,
  sessionId: string,
  agentType: AgentType,
  _exec: ExecInContainer,
  _projectPath?: string
): Promise<{ id: string; agentType: AgentType; messages: SessionMessage[] } | null> {
  const result = await getSessionMessagesViaWorker(containerName, sessionId);
  if (!result) return null;
  return { ...result, agentType };
}

export async function findSessionMessages(
  containerName: string,
  sessionId: string,
  _exec: ExecInContainer
): Promise<{ id: string; agentType: AgentType; messages: SessionMessage[] } | null> {
  const { createWorkerClient } = await import('../../worker/client');
  const client = await createWorkerClient(containerName);

  const session = await client.getSession(sessionId);
  if (!session) {
    return null;
  }

  const result = await client.getMessages(sessionId, { limit: 1000, offset: 0 });
  if (!result || result.messages.length === 0) {
    return null;
  }

  const agentType: AgentType = session.agentType === 'claude' ? 'claude-code' : session.agentType;
  const messages: SessionMessage[] = result.messages.map((m) => ({
    type: m.type,
    content: m.content,
    toolName: m.toolName,
    toolId: m.toolId,
    toolInput: m.toolInput,
    timestamp: m.timestamp,
  }));

  return { id: sessionId, agentType, messages };
}

export async function deleteSession(
  containerName: string,
  sessionId: string,
  _agentType: AgentType,
  _exec: ExecInContainer
): Promise<{ success: boolean; error?: string }> {
  return deleteSessionViaWorker(containerName, sessionId);
}

export interface SearchResult {
  sessionId: string;
  agentType: AgentType;
  filePath: string;
  matchCount: number;
}

export async function searchSessions(
  containerName: string,
  query: string,
  exec: ExecInContainer
): Promise<SearchResult[]> {
  const safeQuery = query.replace(/['"\\]/g, '\\$&');

  const searchPaths = [
    '/home/workspace/.claude/projects',
    '/home/workspace/.local/share/opencode/storage',
    '/home/workspace/.codex/sessions',
    '/home/workspace/.pi/agent/sessions',
  ];

  const rgCommand = `rg -l -i --no-messages "${safeQuery}" ${searchPaths.join(' ')} 2>/dev/null | head -100`;

  const result = await exec(containerName, ['bash', '-c', rgCommand], {
    user: 'workspace',
  });

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  const files = result.stdout.trim().split('\n').filter(Boolean);
  const results: SearchResult[] = [];

  for (const file of files) {
    let sessionId: string | null = null;
    let agentType: AgentType | null = null;

    if (file.includes('/.claude/projects/')) {
      const match = file.match(/\/([^/]+)\.jsonl$/);
      if (match && !match[1].startsWith('agent-')) {
        sessionId = match[1];
        agentType = 'claude-code';
      }
    } else if (file.includes('/.local/share/opencode/storage/')) {
      if (file.includes('/session/') && file.endsWith('.json')) {
        const match = file.match(/\/(ses_[^/]+)\.json$/);
        if (match) {
          sessionId = match[1];
          agentType = 'opencode';
        }
      } else if (file.includes('/part/') || file.includes('/message/')) {
        continue;
      }
    } else if (file.includes('/.codex/sessions/')) {
      const match = file.match(/\/([^/]+)\.jsonl$/);
      if (match) {
        sessionId = match[1];
        agentType = 'codex';
      }
    } else if (file.includes('/.pi/agent/sessions/')) {
      const match = file.match(/\/([^/]+)\.jsonl$/);
      if (match) {
        sessionId = match[1];
        agentType = 'pi';
      }
    }

    if (sessionId && agentType) {
      results.push({
        sessionId,
        agentType,
        filePath: file,
        matchCount: 1,
      });
    }
  }

  return results;
}
