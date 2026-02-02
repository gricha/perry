import type { ChatMessage } from '../chat/types';
import type {
  SessionInfo,
  SessionStatus,
  SessionClient,
  StartSessionOptions,
  AgentAdapter,
  AgentType,
  BufferedMessage,
} from './types';
import { RingBuffer } from './ring-buffer';
import { ClaudeCodeAdapter } from './adapters/claude';
import { OpenCodeAdapter } from './adapters/opencode';
import { getContainerName } from '../docker';
import { HOST_WORKSPACE_NAME } from '../shared/client-types';
import * as registry from '../sessions/registry';

const DEFAULT_BUFFER_SIZE = 1000;

interface ManagedSession {
  info: SessionInfo;
  adapter: AgentAdapter;
  buffer: RingBuffer<BufferedMessage>;
  clients: Map<string, SessionClient>;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private clientIdCounter = 0;
  private stateDir: string | null = null;

  init(stateDir: string): void {
    this.stateDir = stateDir;
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private generateClientId(): string {
    return `client-${++this.clientIdCounter}`;
  }

  private createAdapter(agentType: AgentType): AgentAdapter {
    switch (agentType) {
      case 'claude':
        return new ClaudeCodeAdapter();
      case 'opencode':
        return new OpenCodeAdapter();
      case 'codex':
        throw new Error('Codex adapter not yet implemented');
      case 'pi':
        throw new Error('Pi adapter not yet implemented');
    }
  }

  async startSession(options: StartSessionOptions): Promise<string> {
    const sessionId = options.sessionId || this.generateSessionId();

    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Update model if a different one was requested
      if (options.model && options.model !== existing.info.model) {
        existing.info.model = options.model;
        existing.adapter.setModel(options.model);
      }
      return sessionId;
    }

    const adapter = this.createAdapter(options.agentType);
    const buffer = new RingBuffer<BufferedMessage>(DEFAULT_BUFFER_SIZE);

    const info: SessionInfo = {
      id: sessionId,
      workspaceName: options.workspaceName,
      agentType: options.agentType,
      status: 'idle',
      agentSessionId: options.agentSessionId,
      model: options.model,
      startedAt: new Date(),
      lastActivity: new Date(),
    };

    const session: ManagedSession = {
      info,
      adapter,
      buffer,
      clients: new Map(),
    };

    adapter.onMessage((message) => {
      this.handleAdapterMessage(sessionId, message);
    });

    adapter.onStatusChange((status) => {
      this.handleStatusChange(sessionId, status);
    });

    adapter.onError((error) => {
      this.handleAdapterError(sessionId, error);
    });

    const isHost = options.workspaceName === HOST_WORKSPACE_NAME;
    const containerName = isHost ? undefined : getContainerName(options.workspaceName);

    if (this.stateDir) {
      await registry.createSession(this.stateDir, {
        perrySessionId: sessionId,
        workspaceName: options.workspaceName,
        agentType: options.agentType,
        agentSessionId: options.agentSessionId ?? null,
        projectPath: options.projectPath ?? null,
      });
    }

    await adapter.start({
      workspaceName: options.workspaceName,
      containerName,
      agentSessionId: options.agentSessionId,
      model: options.model,
      projectPath: options.projectPath,
      isHost,
      configDir: this.stateDir || undefined,
    });

    this.sessions.set(sessionId, session);

    return sessionId;
  }

  private handleAdapterMessage(sessionId: string, message: ChatMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.info.lastActivity = new Date();

    const bufferedMessage: BufferedMessage = {
      id: session.buffer.getLatestId() + 1,
      message,
      timestamp: Date.now(),
    };
    session.buffer.push(bufferedMessage);

    for (const client of session.clients.values()) {
      try {
        client.send(message);
      } catch {
        // Client send failed, will be cleaned up on disconnect
      }
    }
  }

  private handleStatusChange(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.info.status = status;
    session.info.lastActivity = new Date();

    const previousAgentSessionId = session.info.agentSessionId;
    const currentAgentSessionId = session.adapter.getAgentSessionId();

    if (currentAgentSessionId !== undefined && previousAgentSessionId !== currentAgentSessionId) {
      session.info.agentSessionId = currentAgentSessionId;

      if (this.stateDir) {
        registry.linkAgentSession(this.stateDir, sessionId, currentAgentSessionId).catch((err) => {
          this.handleAdapterError(
            sessionId,
            new Error(`Failed to link agent session: ${err.message}`)
          );
        });
      }

      const updateMessage: ChatMessage = {
        type: 'system',
        content: JSON.stringify({ agentSessionId: currentAgentSessionId }),
        timestamp: new Date().toISOString(),
      };

      for (const client of session.clients.values()) {
        try {
          client.send(updateMessage);
        } catch {
          // Client send failed
        }
      }
    }
  }

  private handleAdapterError(sessionId: string, error: Error): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.info.status = 'error';
    session.info.error = error.message;
    session.info.lastActivity = new Date();

    const errorMessage: ChatMessage = {
      type: 'error',
      content: error.message,
      timestamp: new Date().toISOString(),
    };

    for (const client of session.clients.values()) {
      try {
        client.send(errorMessage);
      } catch {
        // Client send failed
      }
    }
  }

  connectClient(
    sessionId: string,
    sendFn: (message: ChatMessage) => void,
    options?: { resumeFromId?: number }
  ): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const clientId = this.generateClientId();

    const client: SessionClient = {
      id: clientId,
      send: sendFn,
    };

    session.clients.set(clientId, client);

    if (options?.resumeFromId !== undefined) {
      const missedMessages = session.buffer.getSince(options.resumeFromId);
      for (const buffered of missedMessages) {
        try {
          sendFn(buffered.message);
        } catch {
          // Failed to send buffered message
        }
      }
    } else {
      const allMessages = session.buffer.getAll();
      for (const buffered of allMessages) {
        try {
          sendFn(buffered.message);
        } catch {
          // Failed to send buffered message
        }
      }
    }

    const statusMessage: ChatMessage = {
      type: 'system',
      content: `Connected to session (status: ${session.info.status})`,
      timestamp: new Date().toISOString(),
    };
    try {
      sendFn(statusMessage);
    } catch {
      // Failed to send status
    }

    return clientId;
  }

  disconnectClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const client = session.clients.get(clientId);
    if (client?.onDisconnect) {
      client.onDisconnect();
    }
    session.clients.delete(clientId);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.info.status === 'running') {
      throw new Error('Session is already processing a message');
    }

    session.info.status = 'running';
    session.info.lastActivity = new Date();

    const userMessage: ChatMessage = {
      type: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    this.handleAdapterMessage(sessionId, userMessage);

    await session.adapter.sendMessage(message);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.adapter.interrupt();
    session.info.status = 'interrupted';
    session.info.lastActivity = new Date();
  }

  getSession(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session?.info ?? null;
  }

  async findSession(
    id: string,
    options?: { projectPath?: string }
  ): Promise<{ sessionId: string; info: SessionInfo } | null> {
    // First try direct lookup by internal sessionId (in-memory cache)
    const direct = this.sessions.get(id);
    if (direct) {
      return { sessionId: id, info: direct.info };
    }

    // Then search by agentSessionId in memory
    for (const [sessionId, session] of this.sessions) {
      if (session.info.agentSessionId === id) {
        return { sessionId, info: session.info };
      }
    }

    // Not in memory - check disk registry
    if (this.stateDir) {
      // Try lookup by perrySessionId first
      let record = await registry.getSession(this.stateDir, id);

      // Then try by agentSessionId
      if (!record) {
        record = await registry.findByAgentSessionId(this.stateDir, id);
      }

      // Found on disk - restore the session
      if (record) {
        const restoredId = await this.startSession({
          sessionId: record.perrySessionId,
          workspaceName: record.workspaceName,
          agentType: record.agentType,
          agentSessionId: record.agentSessionId ?? undefined,
          projectPath: options?.projectPath ?? record.projectPath ?? undefined,
        });
        const restored = this.sessions.get(restoredId);
        if (restored) {
          return { sessionId: restoredId, info: restored.info };
        }
      }
    }

    return null;
  }

  getSessionStatus(sessionId: string): SessionStatus | null {
    const session = this.sessions.get(sessionId);
    return session?.info.status ?? null;
  }

  listActiveSessions(workspaceName?: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (!workspaceName || session.info.workspaceName === workspaceName) {
        sessions.push(session.info);
      }
    }
    return sessions;
  }

  getBufferedMessages(sessionId: string, sinceId?: number): BufferedMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    if (sinceId !== undefined) {
      return session.buffer.getSince(sinceId);
    }
    return session.buffer.getAll();
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const client of session.clients.values()) {
      if (client.onDisconnect) {
        client.onDisconnect();
      }
    }
    session.clients.clear();

    await session.adapter.dispose();
    this.sessions.delete(sessionId);
  }

  async disposeWorkspaceSessions(workspaceName: string): Promise<void> {
    const toDispose: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.info.workspaceName === workspaceName) {
        toDispose.push(id);
      }
    }

    await Promise.all(toDispose.map((id) => this.disposeSession(id)));
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.disposeSession(id)));
  }

  setModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.adapter.setModel(model);
    session.info.model = model;
    session.info.lastActivity = new Date();
  }

  hasActiveClients(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.clients.size > 0 : false;
  }

  getClientCount(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session?.clients.size ?? 0;
  }
}

export const sessionManager = new SessionManager();
