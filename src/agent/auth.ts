import { timingSafeEqual } from 'crypto';
import type { AgentConfig } from '../shared/types';
import { getTailscaleIdentity } from '../tailscale';

function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface AuthResult {
  ok: boolean;
  identity?: { type: 'token' | 'tailscale'; user?: string };
}

const PUBLIC_PATHS = ['/health'];

const WEB_UI_PATTERNS = [/^\/$/, /^\/index\.html$/, /^\/assets\//, /^\/favicon\.ico$/];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }
  return WEB_UI_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function checkAuth(req: Request, config: AgentConfig): AuthResult {
  const url = new URL(req.url);

  if (isPublicPath(url.pathname)) {
    return { ok: true };
  }

  if (!config.auth?.token) {
    return { ok: true };
  }

  const tsIdentity = getTailscaleIdentity(req);
  if (tsIdentity) {
    return { ok: true, identity: { type: 'tailscale', user: tsIdentity.email } };
  }

  const isWebSocketUpgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const isTerminalWebSocket = url.pathname.startsWith('/rpc/terminal/');
  if (isWebSocketUpgrade && isTerminalWebSocket) {
    const token = url.searchParams.get('token');
    if (token && secureCompare(token, config.auth.token)) {
      return { ok: true, identity: { type: 'token' } };
    }
  }

  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (secureCompare(token, config.auth.token)) {
      return { ok: true, identity: { type: 'token' } };
    }
  }

  return { ok: false };
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Bearer',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
