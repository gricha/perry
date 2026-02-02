import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import lockfile from 'proper-lockfile';

export type AgentType = 'claude' | 'opencode' | 'codex' | 'pi';

export interface SessionRecord {
  perrySessionId: string;
  workspaceName: string;
  agentType: AgentType;
  agentSessionId: string | null;
  projectPath: string | null;
  createdAt: string;
  lastActivity: string;
}

export interface SessionRegistry {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

function getStorePath(stateDir: string): string {
  return join(stateDir, 'session-registry.json');
}

function getLockPath(stateDir: string): string {
  return join(stateDir, '.session-registry.lock');
}

async function ensureLockfile(stateDir: string): Promise<void> {
  const lockPath = getLockPath(stateDir);
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '', { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

async function withLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  await ensureLockfile(stateDir);
  const lockPath = getLockPath(stateDir);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    });
    return await fn();
  } finally {
    if (release) {
      await release();
    }
  }
}

async function loadRegistry(stateDir: string): Promise<SessionRegistry> {
  const storePath = getStorePath(stateDir);
  try {
    const content = await readFile(storePath, 'utf-8');
    return JSON.parse(content) as SessionRegistry;
  } catch {
    return { version: 1, sessions: {} };
  }
}

async function saveRegistry(stateDir: string, registry: SessionRegistry): Promise<void> {
  const storePath = getStorePath(stateDir);
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(registry, null, 2));
}

/**
 * Create a new session record. Called when first message is sent.
 * agentSessionId will be null until agent responds.
 */
export async function createSession(
  stateDir: string,
  session: {
    perrySessionId: string;
    workspaceName: string;
    agentType: AgentType;
    agentSessionId?: string | null;
    projectPath?: string | null;
  }
): Promise<SessionRecord> {
  return withLock(stateDir, async () => {
    const registry = await loadRegistry(stateDir);
    const now = new Date().toISOString();

    const record: SessionRecord = {
      perrySessionId: session.perrySessionId,
      workspaceName: session.workspaceName,
      agentType: session.agentType,
      agentSessionId: session.agentSessionId ?? null,
      projectPath: session.projectPath ?? null,
      createdAt: now,
      lastActivity: now,
    };

    registry.sessions[session.perrySessionId] = record;
    await saveRegistry(stateDir, registry);

    return record;
  });
}

/**
 * Link an agent session ID to an existing Perry session.
 * Called when agent responds and provides its session ID.
 */
export async function linkAgentSession(
  stateDir: string,
  perrySessionId: string,
  agentSessionId: string
): Promise<SessionRecord | null> {
  return withLock(stateDir, async () => {
    const registry = await loadRegistry(stateDir);
    const record = registry.sessions[perrySessionId];

    if (!record) {
      return null;
    }

    record.agentSessionId = agentSessionId;
    record.lastActivity = new Date().toISOString();

    await saveRegistry(stateDir, registry);
    return record;
  });
}

/**
 * Get all sessions for a workspace.
 */
export async function getSessionsForWorkspace(
  stateDir: string,
  workspaceName: string
): Promise<SessionRecord[]> {
  const registry = await loadRegistry(stateDir);

  return Object.values(registry.sessions)
    .filter((record) => record.workspaceName === workspaceName)
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

/**
 * Get a specific session by perrySessionId.
 */
export async function getSession(
  stateDir: string,
  perrySessionId: string
): Promise<SessionRecord | null> {
  const registry = await loadRegistry(stateDir);
  return registry.sessions[perrySessionId] ?? null;
}

/**
 * Find a session by agentSessionId.
 */
export async function findByAgentSessionId(
  stateDir: string,
  agentSessionId: string
): Promise<SessionRecord | null> {
  const registry = await loadRegistry(stateDir);
  for (const record of Object.values(registry.sessions)) {
    if (record.agentSessionId === agentSessionId) {
      return record;
    }
  }
  return null;
}

/**
 * Import an external session (discovered from agent storage).
 * Creates a Perry session record for a session that wasn't started through Perry.
 */
export async function importExternalSession(
  stateDir: string,
  session: {
    perrySessionId: string;
    workspaceName: string;
    agentType: AgentType;
    agentSessionId: string;
    projectPath?: string | null;
    createdAt?: string;
    lastActivity?: string;
  }
): Promise<SessionRecord> {
  return withLock(stateDir, async () => {
    const registry = await loadRegistry(stateDir);

    // Check if already imported (inside lock to prevent race)
    for (const record of Object.values(registry.sessions)) {
      if (
        record.agentType === session.agentType &&
        record.agentSessionId === session.agentSessionId
      ) {
        return record;
      }
    }

    const now = new Date().toISOString();

    const record: SessionRecord = {
      perrySessionId: session.perrySessionId,
      workspaceName: session.workspaceName,
      agentType: session.agentType,
      agentSessionId: session.agentSessionId,
      projectPath: session.projectPath ?? null,
      createdAt: session.createdAt ?? now,
      lastActivity: session.lastActivity ?? now,
    };

    registry.sessions[session.perrySessionId] = record;
    await saveRegistry(stateDir, registry);

    return record;
  });
}
