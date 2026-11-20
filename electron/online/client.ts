import {
  POLL_HOLD_MS,
  RECONNECT_WINDOW_MS,
  validateSnapshot,
  type ActionReply,
  type GuestAction,
  type OnlinePhase,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const POLL_GRACE_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type GuestLinkStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface GuestClientHandlers {
  onSnapshot: (snapshot: OnlineSnapshot) => void;
  onStatus: (status: GuestLinkStatus) => void;
  onClosed: (reason: string) => void;
}

export interface GuestClientOptions {
  pollHoldMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  reconnectWindowMs?: number;
}

export class GuestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuestHttpError';
  }
}

interface RawResponse {
  status: number;
  body: unknown;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class GuestClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly handlers: GuestClientHandlers;
  private readonly pollHoldMs: number;
  private readonly pingIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectWindowMs: number;
  private revision = 0;
  private stopped = false;
  private started = false;
  private closedNotified = false;
  /**
   * 客户端生命周期级 controller：构造时创建，随每个请求一起传给 fetch，
   * 因此 stop() 能中止在途的 join/action/poll/ping，而不依赖 start()。
   */
  private readonly lifetime = new AbortController();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    origin: string,
    token: string,
    handlers: GuestClientHandlers,
    options: GuestClientOptions = {},
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.token = token;
    this.handlers = handlers;
    this.pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
  }

  /**
   * 加入房间。房主会把请求挂起直到批准或拒绝，因此这里不施加请求超时：
   * join() 一直等待，直到房主裁决或被 stop() 中止。
   */
  async join(): Promise<OnlinePhase> {
    const response = await this.request('POST', '/xq/v1/join', {}, undefined, null);
    const body = response.body as Record<string, unknown> | null;
    const phase = body?.phase;
    if (phase !== 'lobby' && phase !== 'playing' && phase !== 'ended') {
      throw new GuestHttpError(0, 'bad_request', '加入响应格式不正确');
    }
    return phase;
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.pollLoop(this.lifetime.signal);
    this.heartbeat = setInterval(() => {
      void this.ping().catch((error: unknown) => {
        if (this.stopped) return;
        if (this.terminal(error)) return;
        this.handlers.onStatus('reconnecting');
      });
    }, this.pingIntervalMs);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  async poll(rev: number, signal?: AbortSignal): Promise<OnlineSnapshot | null> {
    const response = await this.request(
      'GET',
      `/xq/v1/poll?rev=${rev}`,
      undefined,
      signal,
      this.pollHoldMs + POLL_GRACE_MS,
    );
    if (response.status === 204) return null;
    return validateSnapshot(response.body);
  }

  async ping(): Promise<void> {
    // request() 会自动组合 lifetime signal，stop() 因而能中止在途心跳并释放连接。
    await this.request('POST', '/xq/v1/ping', {});
  }

  async action(action: GuestAction): Promise<ActionReply> {
    const response = await this.request('POST', '/xq/v1/action', action);
    const body = response.body as Record<string, unknown> | null;
    if (!body || typeof body.accepted !== 'boolean') {
      throw new GuestHttpError(0, 'bad_request', '动作响应格式不正确');
    }
    const message = typeof body.message === 'string' ? body.message : null;
    const snapshot =
      body.snapshot === null || body.snapshot === undefined
        ? null
        : validateSnapshot(body.snapshot);
    return { accepted: body.accepted, message, snapshot };
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let first = true;
    let failures = 0;
    let firstFailureAt: number | null = null;
    while (!this.stopped && !signal.aborted) {
      try {
        const snapshot = await this.poll(this.revision, signal);
        if (this.stopped || signal.aborted) return;
        if (snapshot && snapshot.rev > this.revision) {
          this.revision = snapshot.rev;
          this.handlers.onSnapshot(snapshot);
        }
        if (first || failures > 0) {
          first = false;
          failures = 0;
          firstFailureAt = null;
          this.handlers.onStatus('connected');
        }
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        if (this.terminal(error)) return;
        failures += 1;
        firstFailureAt ??= Date.now();
        // 规格 10/15：房主在重连窗口内不回来，就把本地对局标记中止并回到本地模式。
        if (Date.now() - firstFailureAt >= this.reconnectWindowMs) {
          this.notifyClosed('与房主失去连接');
          return;
        }
        this.handlers.onStatus('reconnecting');
        await delay(this.retryDelayMs, signal);
      }
    }
  }

  private terminal(error: unknown): boolean {
    if (!(error instanceof GuestHttpError)) return false;
    let reason: string;
    if (error.code === 'host_unavailable') {
      reason = '与房主失去连接';
    } else if (error.code === 'closed') {
      reason = '房间已关闭';
    } else if (error.code === 'unauthorized') {
      reason = '邀请无效或房间已关闭';
    } else if (error.code === 'rejected') {
      reason = '房主拒绝加入';
    } else {
      return false;
    }
    this.notifyClosed(reason);
    return true;
  }

  private notifyClosed(reason: string): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.handlers.onClosed(reason);
    this.stop();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<RawResponse> {
    if (this.stopped) throw new GuestHttpError(0, 'closed', '连接已关闭');
    const lifetime = this.lifetime.signal;
    const signals: AbortSignal[] = [lifetime];
    if (signal) signals.push(signal);
    if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs));
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'user-agent': 'Xiangqi/0.1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (lifetime.aborted) throw new GuestHttpError(0, 'closed', '连接已关闭');
      if (signal?.aborted) throw error;
      throw new GuestHttpError(0, 'network', '无法连接房主');
    }

    if (response.status === 204) return { status: 204, body: null };
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GuestHttpError(response.status, 'bad_request', '响应不是合法 JSON');
      }
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof error?.code === 'string' ? error.code : 'bad_request';
      const message =
        typeof error?.message === 'string' ? error.message : `请求失败（${response.status}）`;
      throw new GuestHttpError(response.status, code, message);
    }
    return { status: response.status, body: parsed };
  }
}