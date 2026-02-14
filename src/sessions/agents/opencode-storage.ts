import * as path from 'node:path';
import * as os from 'node:os';
import { Database } from 'bun:sqlite';

export interface OpencodeSessionInfo {
  id: string;
  title: string;
  directory: string;
  mtime: number;
  messageCount: number;
}

export interface OpencodeMessage {
  type: string;
  content?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  timestamp?: string;
}

export interface OpencodeSessionMessages {
  id: string;
  messages: OpencodeMessage[];
}

function getDbPath(homeDir?: string): string {
  const home = homeDir || os.homedir();
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

function withDb<T>(homeDir: string | undefined, readonly: boolean, fn: (db: Database) => T): T {
  const db = new Database(getDbPath(homeDir), { readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function listOpencodeSessions(homeDir?: string): OpencodeSessionInfo[] {
  try {
    return withDb(homeDir, true, (db) => {
      const rows = db
        .query<
          {
            id: string;
            title: string;
            directory: string;
            time_updated: number;
            message_count: number;
          },
          []
        >(
          `SELECT s.id, s.title, s.directory, s.time_updated,
                  COUNT(m.id) as message_count
           FROM session s
           LEFT JOIN message m ON m.session_id = s.id
           GROUP BY s.id`
        )
        .all();

      return rows.map((row) => ({
        id: row.id,
        title: row.title || '',
        directory: row.directory || '',
        mtime: row.time_updated || 0,
        messageCount: row.message_count,
      }));
    });
  } catch {
    return [];
  }
}

export function getOpencodeSessionMessages(
  sessionId: string,
  homeDir?: string
): OpencodeSessionMessages {
  try {
    return withDb(homeDir, true, (db) => {
      const msgRows = db
        .query<{ id: string; data: string; time_created: number }, [string]>(
          `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created`
        )
        .all(sessionId);

      const partRows = db
        .query<{ message_id: string; data: string }, [string]>(
          `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id`
        )
        .all(sessionId);

      const partsByMessage = new Map<string, string[]>();
      for (const part of partRows) {
        const list = partsByMessage.get(part.message_id);
        if (list) {
          list.push(part.data);
        } else {
          partsByMessage.set(part.message_id, [part.data]);
        }
      }

      const messages: OpencodeMessage[] = [];

      for (const msg of msgRows) {
        const msgData = safeParse<{ role?: string }>(msg.data);
        if (!msgData) continue;
        if (msgData.role !== 'user' && msgData.role !== 'assistant') continue;

        const role = msgData.role;
        const timestamp = msg.time_created ? new Date(msg.time_created).toISOString() : undefined;

        const partDataList = partsByMessage.get(msg.id) ?? [];
        for (const raw of partDataList) {
          const parsed = safeParse<PartData>(raw);
          if (!parsed) continue;
          messages.push(...convertPart(parsed, role, timestamp));
        }
      }

      return { id: sessionId, messages };
    });
  } catch {
    return { id: sessionId, messages: [] };
  }
}

export function deleteOpencodeSession(
  sessionId: string,
  homeDir?: string
): { success: boolean; error?: string } {
  try {
    withDb(homeDir, false, (db) => {
      db.run('PRAGMA foreign_keys = ON');
      db.query(`DELETE FROM session WHERE id = ?`).run(sessionId);
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to delete session: ${message}` };
  }
}

interface PartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  id?: string;
  state?: { title?: string; input?: unknown; output?: string };
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function convertPart(part: PartData, role: string, timestamp?: string): OpencodeMessage[] {
  if (part.type === 'text' && part.text) {
    return [{ type: role, content: part.text, timestamp }];
  }

  if (part.type !== 'tool') return [];

  const toolName = part.state?.title || part.tool || '';
  const toolId = part.callID || part.id || '';
  const messages: OpencodeMessage[] = [
    {
      type: 'tool_use',
      toolName,
      toolId,
      toolInput: part.state?.input ? JSON.stringify(part.state.input) : '',
      timestamp,
    },
  ];

  if (part.state?.output) {
    messages.push({
      type: 'tool_result',
      content: part.state.output,
      toolId,
      timestamp,
    });
  }

  return messages;
}
