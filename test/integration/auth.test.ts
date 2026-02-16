import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestAgent, type TestAgent } from '../helpers/agent';

const TEST_TOKEN = 'test-auth-token-12345';

describe('Auth Middleware Integration', () => {
  let agent: TestAgent;

  beforeAll(async () => {
    agent = await startTestAgent({
      config: {
        auth: { token: TEST_TOKEN },
      },
    });
  }, 30000);

  afterAll(async () => {
    if (agent) {
      await agent.cleanup();
    }
  });

  describe('HTTP Endpoints', () => {
    it('returns 401 for protected endpoint without auth', async () => {
      const response = await fetch(`${agent.baseUrl}/rpc/info`);

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    });

    it('returns 401 for rpc endpoints without auth', async () => {
      const response = await fetch(`${agent.baseUrl}/rpc/workspaces.list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const response = await fetch(`${agent.baseUrl}/rpc/info`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });

      expect(response.status).toBe(401);
    });

    it('returns 200 with valid Bearer token', async () => {
      const response = await fetch(`${agent.baseUrl}/rpc/info`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
    });

    it('health endpoint is accessible without auth', async () => {
      const response = await fetch(`${agent.baseUrl}/health`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    it('OPTIONS requests are allowed (CORS preflight)', async () => {
      const response = await fetch(`${agent.baseUrl}/rpc/info`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('WebSocket Endpoints', () => {
    it('rejects WebSocket upgrade without auth', async () => {
      const wsUrl = `${agent.baseUrl.replace('http', 'ws')}/rpc/terminal/test-workspace`;

      const result = await new Promise<{ error: Error | null; code?: number }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.on('error', (err) => {
          resolve({ error: err });
        });
        ws.on('unexpected-response', (_, res) => {
          resolve({ error: null, code: res.statusCode });
        });
        ws.on('open', () => {
          ws.close();
          resolve({ error: new Error('WebSocket should not have opened') });
        });
      });

      expect(result.code).toBe(401);
    });

    it('rejects WebSocket upgrade with wrong token', async () => {
      const wsUrl = `${agent.baseUrl.replace('http', 'ws')}/rpc/terminal/test-workspace`;

      const result = await new Promise<{ error: Error | null; code?: number }>((resolve) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: 'Bearer wrong-token' },
        });
        ws.on('error', (err) => {
          resolve({ error: err });
        });
        ws.on('unexpected-response', (_, res) => {
          resolve({ error: null, code: res.statusCode });
        });
        ws.on('open', () => {
          ws.close();
          resolve({ error: new Error('WebSocket should not have opened') });
        });
      });

      expect(result.code).toBe(401);
    });

    it('accepts WebSocket upgrade with valid token (returns 404 for non-existent workspace)', async () => {
      const wsUrl = `${agent.baseUrl.replace('http', 'ws')}/rpc/terminal/nonexistent-workspace`;

      const result = await new Promise<{ error: Error | null; code?: number }>((resolve) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        ws.on('error', (err) => {
          resolve({ error: err });
        });
        ws.on('unexpected-response', (_, res) => {
          resolve({ error: null, code: res.statusCode });
        });
        ws.on('open', () => {
          ws.close();
          resolve({ error: null, code: 200 });
        });
      });

      expect(result.code).toBe(404);
    });

    it('accepts WebSocket upgrade with token in query string (browser-compatible)', async () => {
      const wsUrl = `${agent.baseUrl.replace('http', 'ws')}/rpc/terminal/nonexistent-workspace?token=${TEST_TOKEN}`;

      const result = await new Promise<{ error: Error | null; code?: number }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.on('error', (err) => {
          resolve({ error: err });
        });
        ws.on('unexpected-response', (_, res) => {
          resolve({ error: null, code: res.statusCode });
        });
        ws.on('open', () => {
          ws.close();
          resolve({ error: null, code: 200 });
        });
      });

      expect(result.code).toBe(404);
    });
  });
});

describe('Auth Middleware - No Token Configured', () => {
  let agent: TestAgent;

  beforeAll(async () => {
    agent = await startTestAgent({
      config: {},
    });
  }, 30000);

  afterAll(async () => {
    if (agent) {
      await agent.cleanup();
    }
  });

  it('allows access without auth when no token configured', async () => {
    const response = await fetch(`${agent.baseUrl}/rpc/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
  });

  it('allows WebSocket without auth when no token configured (404 for non-existent)', async () => {
    const wsUrl = `${agent.baseUrl.replace('http', 'ws')}/rpc/terminal/nonexistent`;

    const result = await new Promise<{ error: Error | null; code?: number }>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('error', (err) => {
        resolve({ error: err });
      });
      ws.on('unexpected-response', (_, res) => {
        resolve({ error: null, code: res.statusCode });
      });
      ws.on('open', () => {
        ws.close();
        resolve({ error: null, code: 200 });
      });
    });

    expect(result.code).toBe(404);
  });
});

describe('Auth Token Management', () => {
  let agent: TestAgent;
  const INITIAL_TOKEN = 'initial-test-token';

  beforeAll(async () => {
    agent = await startTestAgent({
      config: {
        auth: { token: INITIAL_TOKEN },
      },
    });
  }, 30000);

  afterAll(async () => {
    if (agent) {
      await agent.cleanup();
    }
  });

  it('can disable authentication', async () => {
    const disableResponse = await fetch(`${agent.baseUrl}/rpc/config/auth/disable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INITIAL_TOKEN}`,
      },
      body: JSON.stringify({}),
    });

    expect(disableResponse.status).toBe(200);
    const disableResult = await disableResponse.json();
    expect(disableResult.json.success).toBe(true);

    const infoResponse = await fetch(`${agent.baseUrl}/rpc/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(infoResponse.status).toBe(200);
  });

  it('auth config shows no token after disabling', async () => {
    const response = await fetch(`${agent.baseUrl}/rpc/config/auth/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.json.hasToken).toBe(false);
    expect(result.json.tokenPreview).toBeUndefined();
  });

  it('can generate a new token after disabling', async () => {
    const generateResponse = await fetch(`${agent.baseUrl}/rpc/config/auth/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(generateResponse.status).toBe(200);
    const result = await generateResponse.json();
    expect(result.json.token).toBeDefined();
    expect(result.json.token.length).toBe(24);

    const infoResponse = await fetch(`${agent.baseUrl}/rpc/info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${result.json.token}`,
      },
      body: JSON.stringify({}),
    });

    expect(infoResponse.status).toBe(200);
  });
});
