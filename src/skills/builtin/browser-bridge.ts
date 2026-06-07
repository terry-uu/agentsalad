/**
 * BrowserBridge — WebSocket 서버로 Chrome Extension과 통신
 *
 * Extension이 ws://host:port/ws/browser로 연결하면 커맨드를 중계한다.
 * Tool에서 sendCommand()로 요청하면 correlationId 기반 request-response 패턴으로
 * Extension 응답을 Promise로 반환.
 *
 * 단일 Extension 연결만 지원 (멀티 Extension은 추후 확장).
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

import { logger } from '../../logger.js';

const PING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BrowserBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idCounter = 0;

  /**
   * HTTP 서버의 upgrade 이벤트에서 호출.
   * /ws/browser 경로만 여기로 라우팅해야 한다.
   */
  init(): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true });
    logger.info('BrowserBridge WebSocket server initialized');
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws);
    });
  }

  private onConnection(ws: WebSocket): void {
    if (this.client) {
      logger.warn('New extension connection replacing existing one');
      this.client.close(1000, 'replaced');
    }

    this.client = ws;
    logger.info('Browser extension connected');

    ws.on('message', (raw) => {
      this.onMessage(raw.toString());
    });

    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null;
        this.rejectAll('Extension disconnected');
        logger.info('Browser extension disconnected');
      }
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'Extension WebSocket error');
    });

    this.startPing();
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // heartbeat
    if (msg.type === 'ping') {
      this.client?.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // response to a pending request
    const id = msg.id as string;
    if (!id) return;

    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    clearTimeout(req.timer);

    if (msg.success) {
      logger.info(
        {
          id,
          dataKeys: msg.data
            ? Object.keys(msg.data as Record<string, unknown>)
            : [],
        },
        'Extension command success',
      );
      req.resolve(msg.data);
    } else {
      logger.warn({ id, error: msg.error }, 'Extension command failed');
      req.reject(
        new Error((msg.error as string) || 'Extension command failed'),
      );
    }
  }

  /**
   * Extension에 명령을 보내고 응답을 기다린다.
   * Tool의 execute()에서 사용.
   */
  async sendCommand(
    action: string,
    params: Record<string, unknown> = {},
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Browser extension not connected. Install the Agent Salad extension and connect to this server.',
      );
    }
    logger.info({ action, params }, 'Sending command to extension');

    const id = `r${++this.idCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Extension command timeout: ${action} (${timeout}ms)`),
        );
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      this.client!.send(JSON.stringify({ id, action, params }));
    });
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  shutdown(): void {
    this.stopPing();
    this.rejectAll('Server shutting down');
    if (this.client) {
      this.client.close(1000, 'shutdown');
      this.client = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private rejectAll(reason: string): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.ping();
      }
    }, PING_INTERVAL_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const browserBridge = new BrowserBridge();
