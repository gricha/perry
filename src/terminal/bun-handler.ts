import type { ServerWebSocket } from 'bun';
import { createTerminalSession, TerminalSession } from './handler';
import { createHostTerminalSession, HostTerminalSession } from './host-handler';
import { isControlMessage, isAuthMessage } from './types';
import { secureCompare } from '../agent/auth';
import { HOST_WORKSPACE_NAME } from '../shared/client-types';

type AnyTerminalSession = TerminalSession | HostTerminalSession;

interface TerminalConnection {
  ws: ServerWebSocket<unknown>;
  session: AnyTerminalSession | null;
  workspaceName: string;
  started: boolean;
  authenticated: boolean;
}

export interface TerminalHandlerOptions {
  getContainerName: (workspaceName: string) => string;
  isWorkspaceRunning: (workspaceName: string) => Promise<boolean>;
  isHostAccessAllowed?: () => boolean;
  getPreferredShell?: () => string | undefined;
  getAuthToken?: () => string | undefined;
}

export class TerminalHandler {
  private connections: Map<ServerWebSocket<unknown>, TerminalConnection> = new Map();
  private getContainerName: (workspaceName: string) => string;
  private isHostAccessAllowed: () => boolean;
  private getPreferredShell: () => string | undefined;
  private getAuthToken: () => string | undefined;

  constructor(options: TerminalHandlerOptions) {
    this.getContainerName = options.getContainerName;
    this.isHostAccessAllowed = options.isHostAccessAllowed || (() => false);
    this.getPreferredShell = options.getPreferredShell || (() => undefined);
    this.getAuthToken = options.getAuthToken || (() => undefined);
  }

  handleOpen(ws: ServerWebSocket<unknown>, workspaceName: string, authenticated = true): void {
    const isHostMode = workspaceName === HOST_WORKSPACE_NAME;

    if (isHostMode && !this.isHostAccessAllowed()) {
      ws.close(4003, 'Host access is disabled');
      return;
    }

    const authToken = this.getAuthToken();
    const isAuthenticated = authenticated || !authToken;

    const connection: TerminalConnection = {
      ws,
      session: null,
      workspaceName,
      started: false,
      authenticated: isAuthenticated,
    };
    this.connections.set(ws, connection);
  }

  handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const connection = this.connections.get(ws);
    if (!connection) return;

    if (!connection.authenticated) {
      try {
        const message = JSON.parse(data);
        if (isAuthMessage(message)) {
          const authToken = this.getAuthToken();
          if (authToken && secureCompare(message.token, authToken)) {
            connection.authenticated = true;
            return;
          }
        }
      } catch {
        // invalid JSON, reject
      }
      ws.close(4001, 'Authentication failed');
      this.connections.delete(ws);
      return;
    }

    if (data.startsWith('{')) {
      try {
        const message = JSON.parse(data);
        if (isControlMessage(message)) {
          if (!connection.started) {
            this.startSession(connection, message.cols, message.rows);
          } else if (connection.session) {
            connection.session.resize({ cols: message.cols, rows: message.rows });
          }
          return;
        }
      } catch {
        // Not valid JSON control message, pass through as input
      }
    }

    if (connection.session) {
      connection.session.write(data);
    }
  }

  handleClose(ws: ServerWebSocket<unknown>, _code: number, _reason: string): void {
    const connection = this.connections.get(ws);
    if (connection?.session) {
      connection.session.kill();
    }
    this.connections.delete(ws);
  }

  handleError(ws: ServerWebSocket<unknown>, error: Error): void {
    console.error('WebSocket error:', error);
    const connection = this.connections.get(ws);
    if (connection?.session) {
      connection.session.kill();
    }
    this.connections.delete(ws);
  }

  private startSession(connection: TerminalConnection, cols: number, rows: number): void {
    if (connection.started) return;
    connection.started = true;

    const { ws, workspaceName } = connection;
    const isHostMode = workspaceName === HOST_WORKSPACE_NAME;
    const preferredShell = this.getPreferredShell();

    let session: AnyTerminalSession;

    if (isHostMode) {
      session = createHostTerminalSession({
        size: { cols, rows },
        shell: preferredShell,
      });
    } else {
      const containerName = this.getContainerName(workspaceName);
      session = createTerminalSession({
        containerName,
        user: 'workspace',
        size: { cols, rows },
        shell: preferredShell,
      });
    }

    connection.session = session;

    session.setOnData((data) => {
      try {
        ws.send(data);
      } catch {
        // WebSocket might be closed
      }
    });

    session.setOnExit((code) => {
      try {
        ws.close(1000, `Process exited with code ${code}`);
      } catch {
        // WebSocket might be closed
      }
      this.connections.delete(ws);
    });

    try {
      session.start();
    } catch (err) {
      console.error('Failed to start terminal session:', err);
      ws.close(1011, 'Failed to start terminal');
      this.connections.delete(ws);
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getConnectionsForWorkspace(workspaceName: string): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.workspaceName === workspaceName) {
        count++;
      }
    }
    return count;
  }

  closeConnectionsForWorkspace(workspaceName: string): void {
    for (const [ws, conn] of this.connections.entries()) {
      if (conn.workspaceName === workspaceName) {
        if (conn.session) {
          conn.session.kill();
        }
        ws.close(1001, 'Workspace stopped');
        this.connections.delete(ws);
      }
    }
  }

  close(): void {
    for (const [ws, conn] of this.connections.entries()) {
      if (conn.session) {
        conn.session.kill();
      }
      ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
  }
}
