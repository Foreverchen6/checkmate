import { randomBytes } from 'node:crypto';
import type { Side } from '../../src/types.ts';
import {
  ACTION_TIMEOUT_MS,
  parseInvite,
  type ActionReply,
  type GuestAction,
  type InviteInfo,
  type OnlineEvent,
  type OnlinePhase,
  type OnlineRole,
  type OnlineSnapshot,
  type OnlineStatus,
} from '../../src/net/protocol.ts';
import { GuestClient, GuestHttpError, type GuestLinkStatus } from './client.ts';
import { HostServer } from './hostServer.ts';
import { localTunnelFactory, type TunnelFactory, type TunnelHandle } from './tunnel.ts';

type EventSink = (event: OnlineEvent) => void;

export interface OnlineSession {
  readonly role: OnlineRole;
  readonly inviteUrl: string | null;
  readonly localUrl: string | null;
  status(): OnlineStatus;
  stop(reason: string): Promise<void>;
}

export interface HostSessionOptions {
  hostSide: Side;
  events: EventSink;
  tunnelFactory?: TunnelFactory;
  token?: string;
  localOnly?: boolean;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
  now?: () => number;
}

export interface GuestSessionOptions {
  invite: InviteInfo;
  events: EventSink;
  pollHoldMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
}

interface PendingAction {
  resolve: (reply: ActionReply) => void;
  timer: NodeJS.Timeout;
}

export class HostOnlineSession implements OnlineSession {
  readonly role = 'host' as const;
  readonly hostSide: Side;
  readonly inviteUrl: string | null;
  readonly localUrl: string | null;

  private readonly emit: EventSink;
  private readonly server: HostServer;
  private readonly tunnel: TunnelHandle | null;
  private readonly actionTimeoutMs: number;
  private readonly pendingActions = new Map<string, PendingAction>();
  private phase: OnlinePhase = 'lobby';
  private stopPromise: Promise<void> | null = null;
  private closedEmitted = false;

  private constructor(
    hostSide: Side,
    inviteUrl: string | null,
    localUrl: string | null,
    server: HostServer,
    tunnel: TunnelHandle | null,
    actionTimeoutMs: number,
    emit: EventSink,
  ) {
    this.hostSide = hostSide;
    this.inviteUrl = inviteUrl;
    this.localUrl = localUrl;
    this.server = server;
    this.tunnel = tunnel;
    this.actionTimeoutMs = actionTimeoutMs;
    this.emit = emit;
  }

  static async create(options: HostSessionOptions): Promise<HostOnlineSession> {
    const token = options.token ?? randomBytes(32).toString('base64url');
    const actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    const holder: { session: HostOnlineSession | null } = { session: null };
    const stopFromServer = (reason: string): void => {
      const session = holder.session;
      if (!session) return;
      // stop 的拒绝不能变成主进程的未处理拒绝（例如关闭时套接字已异常）。
      session.stop(reason).catch(() => undefined);
    };
    const server = new HostServer({
      token,
      pollHoldMs: options.pollHoldMs,
      actionTimeoutMs,
      now: options.now,
      onAction: (actionId, action) => holder.session?.forwardAction(actionId, action) ?? Promise.resolve({
        accepted: false,
        message: '房间已关闭',
        snapshot: null,
      }),
      onGuestJoined: () => options.events({ type: 'host-guest-joined' }),
      onGuestDisconnected: () => options.events({ type: 'host-guest-disconnected' }),
      onGuestReconnected: () => options.events({ type: 'host-guest-reconnected' }),
      onGuestTimeout: () => options.events({ type: 'host-guest-timeout' }),
      onIdle: () => stopFromServer('房间空闲已关闭'),
      onError: () => stopFromServer('本地服务异常'),
    });

    let port: number;
    try {
      port = await server.listen();
    } catch (error) {
      await server.close();
      throw error;
    }

    let tunnel: TunnelHandle | null = null;
    try {
      let inviteUrl: string;
      let localUrl: string | null = null;
      if (options.localOnly) {
        localUrl = `http://127.0.0.1:${port}`;
        inviteUrl = `${localUrl}/#${token}`;
      } else {
        tunnel = await (options.tunnelFactory ?? localTunnelFactory).open(port);
        inviteUrl = `${tunnel.url.replace(/\/+$/, '')}/#${token}`;
      }

      const session = new HostOnlineSession(
        options.hostSide,
        inviteUrl,
        localUrl,
        server,
        tunnel,
        actionTimeoutMs,
        options.events,
      );
      holder.session = session;
      if (tunnel) tunnel.onClosed((reason) => stopFromServer(reason));
      // 这里有可能会话已经建立但事件回调抛错（例如窗口已销毁导致 IPC 发送失败）：
      // 此时 create 会拒绝，调用方拿不到 session，必须由这里释放隧道与服务端口。
      session.emitStatus();
      return session;
    } catch (error) {
      holder.session = null;
      const orphan = tunnel;
      if (orphan) {
        try {
          orphan.close();
        } catch {
          // 隧道已关闭时继续释放本地服务。
        }
      }
      await server.close();
      throw error;
    }
  }

  approve(): void {
    if (this.stopPromise) return;
    if (!this.server.approve()) return;
    this.emitStatus();
  }

  reject(): void {
    if (this.stopPromise) return;
    if (!this.server.reject()) return;
    this.emitStatus();
  }

  publish(snapshot: OnlineSnapshot): void {
    if (this.stopPromise) return;
    this.server.publish(snapshot);
    this.phase = snapshot.phase;
    this.emitStatus();
  }

  reply(
    actionId: string,
    accepted: boolean,
    message: string | null,
    snapshot: OnlineSnapshot,
  ): void {
    const pending = this.pendingActions.get(actionId);
    if (!pending) return;
    this.pendingActions.delete(actionId);
    clearTimeout(pending.timer);
    pending.resolve({ accepted, message, snapshot });
  }

  status(): OnlineStatus {
    const state = this.server.status;
    return {
      role: 'host',
      phase: this.phase,
      inviteUrl: this.inviteUrl,
      guestConnected: state.approved && !state.disconnected,
      approved: state.approved,
      error: null,
    };
  }

  /** 当前挂起的客人长轮询数量，供测试与生命周期观测使用。 */
  get pendingPolls(): number {
    return this.server.status.pendingPolls;
  }

  stop(reason: string): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private forwardAction(actionId: string, action: GuestAction): Promise<ActionReply> {
    if (this.stopPromise) {
      return Promise.resolve({ accepted: false, message: '房间已关闭', snapshot: null });
    }
    return new Promise<ActionReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(actionId);
      }, this.actionTimeoutMs + 1_000);
      timer.unref?.();
      this.pendingActions.set(actionId, { resolve, timer });
      this.emit({ type: 'host-action', actionId, action });
    });
  }

  private async doStop(reason: string): Promise<void> {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, message: '房间已关闭', snapshot: null });
    }
    this.pendingActions.clear();
    // 先同步释放穿透，避免 HTTP 服务关闭迟迟不完成时公网隧道仍可访问。
    if (this.tunnel) {
      try {
        this.tunnel.close();
      } catch {
        // 穿透已关闭时继续关闭本地服务。
      }
    }
    try {
      await this.server.close();
    } catch {
      // 服务已关闭时继续通知渲染进程。
    }
    this.emitClosed(reason);
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }

  private emitClosed(reason: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: 'closed', reason });
  }
}

export class GuestOnlineSession implements OnlineSession {
  readonly role = 'guest' as const;
  readonly inviteUrl = null;
  readonly localUrl = null;

  private readonly client: GuestClient;
  private readonly emit: EventSink;
  private phase: OnlinePhase = 'lobby';
  private link: GuestLinkStatus = 'connecting';
  private joined = false;
  private stopPromise: Promise<void> | null = null;
  private closedEmitted = false;

  private constructor(options: GuestSessionOptions) {
    this.emit = options.events;
    this.client = new GuestClient(
      options.invite.origin,
      options.invite.token,
      {
        onSnapshot: (snapshot) => {
          this.phase = snapshot.phase;
          this.emit({ type: 'snapshot', snapshot });
          this.emitStatus();
        },
        onStatus: (status) => {
          this.link = status;
          this.emitStatus();
        },
        onClosed: (reason) => this.emitClosed(reason),
      },
      {
        pollHoldMs: options.pollHoldMs,
        pingIntervalMs: options.pingIntervalMs,
        retryDelayMs: options.retryDelayMs,
      },
    );
  }

  static create(options: GuestSessionOptions): GuestOnlineSession {
    return new GuestOnlineSession(options);
  }

  async start(): Promise<OnlinePhase> {
    if (this.stopPromise) throw new GuestHttpError(0, 'closed', '会话已关闭');
    const phase = await this.client.join();
    this.joined = true;
    this.phase = phase;
    this.client.start();
    this.emitStatus();
    return phase;
  }

  async send(action: GuestAction): Promise<ActionReply> {
    if (this.stopPromise) throw new GuestHttpError(0, 'closed', '会话已关闭');
    const reply = await this.client.action(action);
    if (reply.snapshot) {
      this.phase = reply.snapshot.phase;
      this.emit({ type: 'snapshot', snapshot: reply.snapshot });
      this.emitStatus();
    }
    return reply;
  }

  status(): OnlineStatus {
    return {
      role: 'guest',
      phase: this.phase,
      inviteUrl: null,
      guestConnected: this.joined && this.link !== 'closed',
      approved: this.joined,
      error: null,
    };
  }

  stop(reason: string): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        this.client.stop();
        this.emitClosed(reason);
      })();
    }
    return this.stopPromise;
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }

  private emitClosed(reason: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: 'closed', reason });
  }
}

export function inviteFor(url: string): InviteInfo {
  return parseInvite(url);
}