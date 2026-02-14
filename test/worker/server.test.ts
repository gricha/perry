import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestAgent, execInWorkspace, type TestAgent } from '../helpers/agent';
import { getContainerIp } from '../../src/docker';

const WORKER_PORT = 7392;

describe('Worker Server Integration', () => {
  let agent: TestAgent;
  let workspaceName: string;
  let containerName: string;
  let workerUrl: string;

  beforeAll(async () => {
    agent = await startTestAgent();
    workspaceName = agent.generateWorkspaceName();
    containerName = `workspace-${workspaceName}`;

    await agent.api.createWorkspace({ name: workspaceName });
    await agent.api.startWorkspace(workspaceName);

    await execInWorkspace(
      containerName,
      'mkdir -p ~/.claude/projects/test-project && echo \'{"type":"user","message":{"content":[{"type":"text","text":"Hello from test"}]}}\' > ~/.claude/projects/test-project/test-session.jsonl',
      { user: 'workspace' }
    );

    const verifyResult = await execInWorkspace(
      containerName,
      'cat ~/.claude/projects/test-project/test-session.jsonl',
      { user: 'workspace' }
    );
    if (!verifyResult.stdout.includes('Hello from test')) {
      throw new Error(`Session file not created properly: ${verifyResult.stdout}`);
    }

    await new Promise((r) => setTimeout(r, 1000));

    const ip = await getContainerIp(containerName);
    workerUrl = `http://${ip}:${WORKER_PORT}`;
  }, 60000);

  afterAll(async () => {
    if (agent) {
      await agent.cleanup();
    }
  });

  it('responds to health check', async () => {
    const response = await fetch(`${workerUrl}/health`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(typeof data.sessionCount).toBe('number');
  });

  it('lists sessions', async () => {
    const response = await fetch(`${workerUrl}/sessions`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it('extracts title from Claude session first message', async () => {
    const refreshResponse = await fetch(`${workerUrl}/refresh`, { method: 'POST' });
    expect(refreshResponse.ok).toBe(true);

    const listResponse = await fetch(`${workerUrl}/sessions`);
    const listData = await listResponse.json();

    const claudeSession = listData.sessions.find(
      (s: { agentType: string }) => s.agentType === 'claude'
    );
    expect(claudeSession).toBeDefined();
    expect(claudeSession.title).toBe('Hello from test');
    expect(claudeSession.firstPrompt).toBe('Hello from test');
  });

  it('counts messages in Claude sessions', async () => {
    await execInWorkspace(
      containerName,
      `cat >> ~/.claude/projects/test-project/test-session.jsonl << 'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there!"}]}}
{"type":"user","message":{"content":[{"type":"text","text":"Second message"}]}}
EOF`,
      { user: 'workspace' }
    );

    const refreshResponse = await fetch(`${workerUrl}/refresh`, { method: 'POST' });
    expect(refreshResponse.ok).toBe(true);

    const listResponse = await fetch(`${workerUrl}/sessions`);
    const listData = await listResponse.json();

    const claudeSession = listData.sessions.find(
      (s: { agentType: string; id: string }) => s.agentType === 'claude' && s.id === 'test-session'
    );
    expect(claudeSession).toBeDefined();
    expect(claudeSession.messageCount).toBe(3);
  });

  it('discovers OpenCode sessions with message counts', async () => {
    const sessionId = 'ses_test123';
    const now = Date.now();
    const seedScript = `
      const{Database}=require("bun:sqlite");
      const db=new Database(process.env.HOME+"/.local/share/opencode/opencode.db");
      db.run("CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER)");
      db.run("CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
      db.query("INSERT INTO session VALUES(?,?,?,?,?)").run("${sessionId}","Test OpenCode Session","/home/workspace",${now},${now});
      db.query("INSERT INTO message VALUES(?,?,?,?,?)").run("msg_1","${sessionId}",${now},${now},JSON.stringify({role:"user"}));
      db.query("INSERT INTO message VALUES(?,?,?,?,?)").run("msg_2","${sessionId}",${now + 1},${now + 1},JSON.stringify({role:"assistant"}));
      db.close();
    `.replace(/\n\s*/g, '');
    await execInWorkspace(
      containerName,
      `mkdir -p ~/.local/share/opencode && bun -e '${seedScript}'`,
      { user: 'workspace' }
    );

    const refreshResponse = await fetch(`${workerUrl}/refresh`, { method: 'POST' });
    expect(refreshResponse.ok).toBe(true);

    const listResponse = await fetch(`${workerUrl}/sessions`);
    const listData = await listResponse.json();

    const opencodeSession = listData.sessions.find(
      (s: { agentType: string; id: string }) => s.agentType === 'opencode' && s.id === sessionId
    );
    expect(opencodeSession).toBeDefined();
    expect(opencodeSession.title).toBe('Test OpenCode Session');
    expect(opencodeSession.messageCount).toBe(2);
  });

  it('gets single session', async () => {
    const listResponse = await fetch(`${workerUrl}/sessions`);
    const listData = await listResponse.json();

    if (listData.sessions.length > 0) {
      const sessionId = listData.sessions[0].id;
      const response = await fetch(`${workerUrl}/sessions/${sessionId}`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.session).toBeDefined();
      expect(data.session.id).toBe(sessionId);
    }
  });

  it('returns 404 for unknown session', async () => {
    const response = await fetch(`${workerUrl}/sessions/nonexistent-session-id`);
    expect(response.status).toBe(404);
  });

  it('gets session messages with pagination', async () => {
    const listResponse = await fetch(`${workerUrl}/sessions`);
    const listData = await listResponse.json();

    if (listData.sessions.length > 0) {
      const sessionId = listData.sessions[0].id;
      const response = await fetch(`${workerUrl}/sessions/${sessionId}/messages?limit=10&offset=0`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.id).toBe(sessionId);
      expect(Array.isArray(data.messages)).toBe(true);
      expect(typeof data.total).toBe('number');
    }
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${workerUrl}/unknown-route`);
    expect(response.status).toBe(404);
  });
});
