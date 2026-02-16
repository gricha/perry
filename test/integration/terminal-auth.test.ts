import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestAgent, type TestAgent } from '../helpers/agent';

const TEST_TOKEN = 'test-auth-token-12345';

function waitForOpen(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timer = setTimeout(() => reject(new Error('Timeout waiting for connection')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function collectMessages(ws: WebSocket, durationMs: number): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    const handler = (data: Buffer | string) => {
      output += data.toString();
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(output);
    }, durationMs);
  });
}

describe('Terminal WebSocket - Query Token Auth', () => {
  let agent: TestAgent;
  let workspaceName: string;
  let workspaceCreated = false;

  beforeAll(async () => {
    agent = await startTestAgent({
      config: {
        auth: { token: TEST_TOKEN },
      },
    });
    workspaceName = agent.generateWorkspaceName();
    const result = await agent.api.createWorkspace({ name: workspaceName });
    if (result.status === 201) {
      workspaceCreated = true;
    }
  }, 120000);

  afterAll(async () => {
    if (workspaceCreated) {
      try {
        await agent.api.deleteWorkspace(workspaceName);
      } catch {
        // ignore
      }
    }
    await agent.cleanup();
  });

  it('authenticates WebSocket via token query param and can execute a command', async () => {
    if (!workspaceCreated) {
      return;
    }

    const wsUrl = `ws://127.0.0.1:${agent.port}/rpc/terminal/${workspaceName}?token=${TEST_TOKEN}`;
    const ws = new WebSocket(wsUrl);

    await waitForOpen(ws, 15000);
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 300));

    const outputPromise = collectMessages(ws, 2500);
    ws.send('echo "QUERY_TOKEN_AUTH_OK"\n');

    const output = await outputPromise;
    expect(output).toContain('QUERY_TOKEN_AUTH_OK');

    ws.close();
  }, 30000);
});
