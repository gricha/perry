export interface SessionMessage {
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content?: string;
  timestamp?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
}

export type AgentType = 'claude-code' | 'opencode' | 'codex' | 'pi';

export interface SessionMetadata {
  id: string;
  name: string | null;
  agentType: AgentType;
  projectPath: string;
  messageCount: number;
  lastActivity: string;
  firstPrompt: string | null;
  filePath: string;
}

export interface SessionDetail extends SessionMetadata {
  messages: SessionMessage[];
}

export interface AgentSessionsResult {
  agentType: AgentType;
  sessions: SessionMetadata[];
}
