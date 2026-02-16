import WebSocket from 'ws';
import { spawn } from 'child_process';
import { ReadStream, WriteStream } from 'tty';
import { DEFAULT_AGENT_PORT } from '../shared/constants';

export interface WSShellOptions {
  url: string;
  onConnect?: () => void;
  onDisconnect?: (code: number) => void;
  onError?: (error: Error) => void;
}

export interface DockerExecOptions {
  containerName: string;
  onConnect?: () => void;
  onDisconnect?: (code: number) => void;
  onError?: (error: Error) => void;
}

export function isLocalWorker(worker: string): boolean {
  const host = worker
    .replace(/^https?:\/\//, '')
    .split(':')[0]
    .toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

export async function openDockerExec(options: DockerExecOptions): Promise<void> {
  const { containerName, onConnect, onDisconnect, onError } = options;

  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '-it',
      '-u',
      'workspace',
      '-e',
      'TERM=xterm-256color',
      containerName,
      '/bin/bash',
      '-l',
    ];

    const proc = spawn('docker', args, {
      stdio: 'inherit',
    });

    let connected = false;

    setTimeout(() => {
      if (proc.exitCode === null) {
        connected = true;
        if (onConnect) onConnect();
      }
    }, 100);

    proc.on('error', (err) => {
      if (!connected) {
        reject(err);
      } else if (onError) {
        onError(err);
      }
    });

    proc.on('close', (code) => {
      if (onDisconnect) onDisconnect(code || 0);
      resolve();
    });
  });
}

export interface TailscaleSSHOptions {
  hostname: string;
  user?: string;
  onConnect?: () => void;
  onDisconnect?: (code: number) => void;
  onError?: (error: Error) => void;
}

export async function openTailscaleSSH(options: TailscaleSSHOptions): Promise<void> {
  const { hostname, user = 'workspace', onConnect, onDisconnect, onError } = options;

  return new Promise((resolve, reject) => {
    const args = [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-t',
      `${user}@${hostname}`,
    ];

    const proc = spawn('ssh', args, {
      stdio: 'inherit',
    });

    let connected = false;

    setTimeout(() => {
      if (proc.exitCode === null) {
        connected = true;
        if (onConnect) onConnect();
      }
    }, 100);

    proc.on('error', (err) => {
      if (!connected) {
        reject(err);
      } else if (onError) {
        onError(err);
      }
    });

    proc.on('close', (code) => {
      if (onDisconnect) onDisconnect(code || 0);
      resolve();
    });
  });
}

export async function openWSShell(options: WSShellOptions): Promise<void> {
  const { url, onConnect, onDisconnect, onError } = options;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let connected = false;
    const stdin = process.stdin as ReadStream;
    const stdout = process.stdout as WriteStream;

    const safeSend = (data: string | Buffer): boolean => {
      if (ws.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    };

    const sendResize = () => {
      if (stdout.columns && stdout.rows) {
        safeSend(JSON.stringify({ type: 'resize', cols: stdout.columns, rows: stdout.rows }));
      }
    };

    ws.on('open', () => {
      connected = true;

      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();

      sendResize();

      if (onConnect) {
        onConnect();
      }
    });

    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString();
      stdout.write(text);
    });

    ws.on('close', (code) => {
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();

      if (onDisconnect) {
        onDisconnect(code);
      }
      resolve();
    });

    ws.on('error', (err) => {
      if (!connected) {
        reject(err);
      } else if (onError) {
        onError(err);
      }
    });

    stdin.on('data', (data: Buffer) => {
      safeSend(data);
    });

    stdout.on('resize', sendResize);

    const cleanup = () => {
      stdout.removeListener('resize', sendResize);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      ws.close();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

export function getTerminalWSUrl(worker: string, workspaceName: string, token?: string): string {
  let base = worker;
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    base = `http://${base}`;
  }
  const wsProtocol = base.startsWith('https://') ? 'wss://' : 'ws://';
  let host = base.replace(/^https?:\/\//, '');
  if (!host.includes(':')) {
    host = `${host}:${DEFAULT_AGENT_PORT}`;
  }
  const url = new URL(`${wsProtocol}${host}/rpc/terminal/${encodeURIComponent(workspaceName)}`);
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}
