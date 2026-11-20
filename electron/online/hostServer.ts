import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACTION_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  ENDED_IDLE_MS,
  LOBBY_IDLE_MS,
  POLL_HOLD_MS,
  RECONNECT_WINDOW_MS,
  validateGuestAction,
  validateSnapshot,
  type ActionReply,
  type GuestAction,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const BODY_LIMIT = 16 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1_000;
const JOIN_RATE_LIMIT = 30;
const JOIN_RATE_WINDOW_MS = 60_000;
const MAX_WAITERS = 2;
/** 关闭时留给已写出响应刷出的时间，随后才强制断开剩余连接。 */
const CLOSE_FLUSH_MS = 200;
const CONNECTION_CLOSE = { connection: 'close' } as const;

export type HostServerErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'busy'
  | 'rejected'
  | 'timeout'
  | 'host_unavailable'
  | 'closed';

export interface HostServerOptions {
  token: string;
  onAction: (actionId: string, action: GuestAction) => Promise<ActionReply>;
  onGuestJoined?: () => void;
  onGuestDisconnected?: () => void;
  onGuestReconnected?: () => void;
  onGuestTimeout?: () => void;
  onIdle?: (reason: 'lobby-idle' | 'ended-idle') => void;
  onError?: (error: Error) => void;
  now?: () => number;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
}

export interface HostServerStatus {
  listening: boolean;
  guestPresent: boolean;
  approved: boolean;
  disconnected: boolean;
  timedOut: boolean;
  rev: number;
  /** 当前挂起的长轮询数量，供测试与生命周期观测使用。 */
  pendingPolls: number;
}

interface GuestState {
  sessionId: string;
  lastSeen: number;
  approved: boolean;
  disconnected: boolean;
  disconnectedAt: number;
  timedOut: boolean;
}

interface JoinWaiter {
  res: ServerResponse;
  sessionId: string;
}

interface PollWaiter {
  rev: number;
  res: ServerResponse;
  timer: NodeJS.Timeout | null;
}

class TimeoutError extends Error {}

function errorBody(code: HostServerErrorCode, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.writableEnded) return;
  res.writeHead(status);
  res.end();
}

interface BodyRead {
  ok: boolean;
  value?: unknown;
}

function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type'];
  if (typeof header !== 'string') return false;
  return /^application\/json\s*(;|$)/i.test(header.trim());
}

function drain(req: IncomingMessage): void {
  try {
    req.resume();
  } catch {
    // 连接已断开时忽略。
  }
}

/**
 * 统一读取 POST 请求体：超过 16 KB 或不是合法 JSON 时返回 `ok: false`。
 * 超限后不再累积数据，但继续消费剩余字节，避免连接因半途销毁而丢响应。
 */
function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onData(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT) {
        finish({ ok: false });
        drain(req);
        return;
      }
      chunks.push(buffer);
    }
    function onEnd(): void {
      if (size === 0) {
        finish({ ok: true, value: null });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ ok: false });
      }
    }
    function onError(): void {
      finish({ ok: false });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('响应超时')), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class HostServer {
  private readonly options: HostServerOptions;
  private readonly server;
  private readonly tokenBuffer: Buffer;
  private readonly pollHoldMs: number;
  private readonly actionTimeoutMs: number;
  private readonly createdAt: number;
  private portNumber = 0;
  private listening = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private latest: OnlineSnapshot | null = null;
  private guest: GuestState | null = null;
  private joinWaiter: JoinWaiter | null = null;
  private waiters: PollWaiter[] = [];
  private livenessTimer: NodeJS.Timeout | null = null;
  private rateWindowStart = 0;
  private rateCount = 0;
  private joinWindowStart = 0;
  private joinCount = 0;
  private endedAt: number | null = null;
  private idleReported = false;

  constructor(options: HostServerOptions) {
    this.options = options;
    this.tokenBuffer = Buffer.from(options.token);
    this.pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.createdAt = this.now();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        sendJson(res, 500, errorBody('host_unavailable', '服务内部错误'));
      });
    });
  }

  get port(): number {
    return this.portNumber;
  }

  get address(): string | null {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.address : null;
  }

  get status(): HostServerStatus {
    return {
      listening: this.listening,
      guestPresent: this.guest !== null,
      approved: this.guest?.approved ?? false,
      disconnected: this.guest?.disconnected ?? false,
      timedOut: this.guest?.timedOut ?? false,
      rev: this.latest?.rev ?? 0,
      pendingPolls: this.waiters.length,
    };
  }

  async listen(port = 0): Promise<number> {
    if (this.closed) throw new Error('房间已关闭');
    if (this.listening) return this.portNumber;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    this.portNumber = typeof address === 'object' && address ? address.port : 0;
    this.listening = true;
    this.server.on('error', (error) => this.options.onError?.(error));
    this.livenessTimer = setInterval(() => {
      try {
        this.checkLiveness();
      } catch (error) {
        try {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // onError 自身抛错时也不能让计时器回调崩溃主进程。
        }
      }
    }, 1_000);
    this.livenessTimer.unref?.();
    return this.portNumber;
  }

  approve(): boolean {
    const guest = this.guest;
    const waiter = this.joinWaiter;
    if (!guest || guest.approved || !waiter) return false;
    guest.approved = true;
    guest.lastSeen = this.now();
    this.joinWaiter = null;
    sendJson(waiter.res, 200, { phase: this.latest?.phase ?? 'lobby' });
    return true;
  }

  reject(): boolean {
    const guest = this.guest;
    const waiter = this.joinWaiter;
    if (!guest || guest.approved || !waiter) return false;
    this.guest = null;
    this.joinWaiter = null;
    sendJson(waiter.res, 403, errorBody('rejected', '房主拒绝加入'));
    return true;
  }

  publish(raw: OnlineSnapshot): void {
    if (this.closed) return;
    const snapshot = validateSnapshot(raw);
    if (this.latest && snapshot.rev <= this.latest.rev) return;
    this.latest = snapshot;
    if (snapshot.phase === 'ended' && this.endedAt === null) {
      this.endedAt = this.now();
    }
    for (const waiter of [...this.waiters]) {
      if (snapshot.rev > waiter.rev) this.finishWaiter(waiter, snapshot);
    }
  }

  checkLiveness(now = this.now()): void {
    if (this.closed) return;
    const guest = this.guest;
    if (guest && guest.approved && !guest.timedOut) {
      if (!guest.disconnected && now - guest.lastSeen > DISCONNECT_GRACE_MS) {
        guest.disconnected = true;
        guest.disconnectedAt = now;
        this.options.onGuestDisconnected?.();
      } else if (guest.disconnected && now - guest.disconnectedAt >= RECONNECT_WINDOW_MS) {
        guest.timedOut = true;
        this.options.onGuestTimeout?.();
      }
    }
    if (this.idleReported) return;
    if (!guest && now - this.createdAt >= LOBBY_IDLE_MS) {
      this.idleReported = true;
      this.options.onIdle?.('lobby-idle');
      return;
    }
    if (this.endedAt !== null && now - this.endedAt >= ENDED_IDLE_MS) {
      this.idleReported = true;
      this.options.onIdle?.('ended-idle');
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.listening = false;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    const joinWaiter = this.joinWaiter;
    this.joinWaiter = null;
    this.guest = null;
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }

    // 先把 410 写给所有挂起的轮询/加入，并带上 connection: close 让响应刷出后自然收尾。
    const closedBody = errorBody('closed', '房间已关闭');
    for (const waiter of waiters) {
      sendJson(waiter.res, 410, closedBody, CONNECTION_CLOSE);
    }
    if (joinWaiter) sendJson(joinWaiter.res, 410, closedBody, CONNECTION_CLOSE);

    // 停止接受新连接；已在处理的请求仍可以完成并在结束后关闭。
    const stopped = new Promise<void>((resolve) => {
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    // 已空闲（含刚写完 410）的连接优雅关闭，保证响应刷出而不是被重置。
    try {
      this.server.closeIdleConnections?.();
    } catch {
      // 老版本 Node 没有该方法时依赖 server.close 自己回收空闲连接。
    }

    // 最后手段：仍有连接滞留（例如在途动作永不返回）时强制断开。
    const forceTimer = setTimeout(() => {
      try {
        this.server.closeAllConnections();
      } catch {
        // 老版本 Node 没有该方法时继续保持等待。
      }
    }, CLOSE_FLUSH_MS);
    forceTimer.unref?.();

    await stopped;
    clearTimeout(forceTimer);
    this.portNumber = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) {
      sendJson(res, 410, errorBody('closed', '房间已关闭'), CONNECTION_CLOSE);
      return;
    }
    const now = this.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? '';
    const route = `${method} ${url.pathname}`;

    if (route === 'POST /xq/v1/join' && !this.allowJoin(now)) {
      sendJson(res, 429, errorBody('busy', '请求过于频繁'));
      return;
    }
    if (!this.authorized(req)) {
      sendJson(res, 401, errorBody('unauthorized', '邀请无效或房间已关闭'));
      return;
    }
    if (!this.allowRequest(now)) {
      sendJson(res, 429, errorBody('busy', '请求过于频繁'));
      return;
    }

    // 所有 POST 路由统一：只接受 application/json，请求体上限 16 KB。
    let body: unknown = null;
    if (method === 'POST') {
      if (!isJsonContentType(req)) {
        drain(req);
        sendJson(res, 400, errorBody('bad_request', '请求体必须是 JSON'));
        return;
      }
      const read = await readBody(req);
      if (!read.ok) {
        sendJson(res, 400, errorBody('bad_request', '请求体过大或不是合法 JSON'));
        return;
      }
      body = read.value;
    }

    switch (route) {
      case 'POST /xq/v1/join':
        this.handleJoin(res, now);
        return;
      case 'GET /xq/v1/poll':
        this.handlePoll(res, url, now);
        return;
      case 'POST /xq/v1/ping':
        this.handlePing(res, now);
        return;
      case 'POST /xq/v1/action':
        await this.handleAction(body, res, now);
        return;
      default:
        sendJson(res, 404, errorBody('bad_request', '接口不存在'));
    }
  }

  private handleJoin(res: ServerResponse, now: number): void {
    if (this.guest) {
      sendJson(res, 409, errorBody('busy', '房间已有玩家'));
      return;
    }
    const guest: GuestState = {
      sessionId: randomBytes(16).toString('base64url'),
      lastSeen: now,
      approved: false,
      disconnected: false,
      disconnectedAt: 0,
      timedOut: false,
    };
    this.guest = guest;
    const waiter: JoinWaiter = { res, sessionId: guest.sessionId };
    this.joinWaiter = waiter;
    res.on('close', () => {
      if (this.joinWaiter === waiter && !res.writableEnded) {
        this.joinWaiter = null;
        this.guest = null;
      }
    });
    this.options.onGuestJoined?.();
  }

  private handlePoll(res: ServerResponse, url: URL, now: number): void {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    const rev = Number(url.searchParams.get('rev') ?? '');
    if (!Number.isInteger(rev) || rev < 0) {
      sendJson(res, 400, errorBody('bad_request', 'rev 无效'));
      return;
    }
    this.touch(guest, now);
    if (this.latest && this.latest.rev > rev) {
      sendJson(res, 200, this.latest);
      return;
    }
    if (this.waiters.length >= MAX_WAITERS) {
      sendJson(res, 429, errorBody('busy', '轮询过多'));
      return;
    }
    const waiter: PollWaiter = { rev, res, timer: null };
    waiter.timer = setTimeout(() => this.finishWaiter(waiter, null), this.pollHoldMs);
    waiter.timer.unref?.();
    this.waiters.push(waiter);
    res.on('close', () => this.removeWaiter(waiter));
  }

  private handlePing(res: ServerResponse, now: number): void {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    this.touch(guest, now);
    sendEmpty(res, 204);
  }

  private async handleAction(body: unknown, res: ServerResponse, now: number): Promise<void> {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    if (guest.timedOut) {
      sendJson(res, 410, errorBody('host_unavailable', '对局已结束'));
      return;
    }
    this.touch(guest, now);

    let action: GuestAction;
    try {
      action = validateGuestAction(body);
    } catch {
      sendJson(res, 400, errorBody('bad_request', '动作格式无效'));
      return;
    }

    const actionId = randomBytes(16).toString('base64url');
    let reply: ActionReply;
    try {
      reply = await withTimeout(this.options.onAction(actionId, action), this.actionTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        sendJson(res, 504, errorBody('timeout', '房主响应超时'));
        return;
      }
      sendJson(res, 410, errorBody('host_unavailable', '房主不可用'));
      return;
    }
    // 房主快照校验失败是房主端缺陷，不是“房间已结束”，因此返回 500 而不是 410。
    if (reply.snapshot) {
      try {
        this.publish(reply.snapshot);
      } catch {
        sendJson(res, 500, errorBody('host_unavailable', '房主快照无效'));
        return;
      }
    }
    sendJson(res, 200, {
      accepted: reply.accepted,
      message: reply.message,
      snapshot: reply.snapshot ?? this.latest,
    });
  }

  private finishWaiter(waiter: PollWaiter, snapshot: OnlineSnapshot | null): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (snapshot) sendJson(waiter.res, 200, snapshot);
    else sendEmpty(waiter.res, 204);
  }

  private removeWaiter(waiter: PollWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
  }

  private touch(guest: GuestState, now: number): void {
    guest.lastSeen = now;
    if (guest.disconnected && !guest.timedOut) {
      guest.disconnected = false;
      guest.disconnectedAt = 0;
      this.options.onGuestReconnected?.();
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    return (
      provided.length === this.tokenBuffer.length && timingSafeEqual(provided, this.tokenBuffer)
    );
  }

  private allowRequest(now: number): boolean {
    if (now - this.rateWindowStart >= RATE_WINDOW_MS) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    return this.rateCount <= RATE_LIMIT;
  }

  private allowJoin(now: number): boolean {
    if (now - this.joinWindowStart >= JOIN_RATE_WINDOW_MS) {
      this.joinWindowStart = now;
      this.joinCount = 0;
    }
    this.joinCount += 1;
    return this.joinCount <= JOIN_RATE_LIMIT;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}