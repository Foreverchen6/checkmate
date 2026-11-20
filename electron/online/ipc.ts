import type { Side } from '../../src/types.ts';
import {
  isActionId,
  parseInvite,
  validateGuestAction,
  validateSnapshot,
  type ActionReply,
  type OnlineEvent,
  type OnlinePhase,
  type OnlineStatus,
} from '../../src/net/protocol.ts';
import { GuestHttpError } from './client.ts';
import { GuestOnlineSession, HostOnlineSession, type OnlineSession } from './session.ts';
import type { TunnelFactory } from './tunnel.ts';

export interface OnlineControllerOptions {
  emit: (event: OnlineEvent) => void;
  smokeLocal?: boolean;
  token?: string;
  tunnelFactory?: TunnelFactory;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
}

const IDLE_STATUS: OnlineStatus = {
  role: null,
  phase: null,
  inviteUrl: null,
  guestConnected: false,
  approved: false,
  error: null,
};

const IDLE_REPLY: ActionReply = { accepted: false, message: null, snapshot: null };

/**
 * `stop()` 主动中止在途请求时 GuestClient 抛出的错误。
 * 这是用户主动离开/停止，不是房间故障，不能当成“房间已关闭”上报。
 */
function abortedByStop(error: unknown): boolean {
  return error instanceof GuestHttpError && error.status === 0 && error.code === 'closed';
}

export class OnlineController {
  private session: OnlineSession | null = null;
  private starting = false;
  /** stop() 递增；创建期间被停止时据此识别并释放迟到的会话。 */
  private epoch = 0;
  /** 正在进行的拆解：完成前仍视为“有会话”，否则新会话会与残留隧道/服务并存。 */
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: OnlineControllerOptions) {}

  isActive(): boolean {
    return this.session !== null || this.starting || this.stopping !== null;
  }

  status(): OnlineStatus {
    return this.session?.status() ?? IDLE_STATUS;
  }

  async hostStart(hostSide: Side): Promise<{ url: string; localUrl?: string }> {
    this.assertIdle();
    this.starting = true;
    const epoch = ++this.epoch;
    // 事件汇必须知道事件属于哪个会话：闭包在会话创建前生成，用 holder 回填属主。
    const holder: { session: HostOnlineSession | null } = { session: null };
    try {
      const session = await HostOnlineSession.create({
        hostSide,
        events: (event) => this.handleEvent(holder.session, event),
        tunnelFactory: this.options.tunnelFactory,
        token: this.options.token,
        localOnly: this.options.smokeLocal,
        pollHoldMs: this.options.pollHoldMs,
        actionTimeoutMs: this.options.actionTimeoutMs,
      });
      holder.session = session;
      if (epoch !== this.epoch) {
        // 创建期间已被 stop()（窗口关闭、退出）：不能把会话留在无人接收事件的状态。
        await session.stop('stopped');
        throw new Error('联机会话已停止');
      }
      this.session = session;
      const result: { url: string; localUrl?: string } = { url: session.inviteUrl ?? '' };
      if (session.localUrl) result.localUrl = session.localUrl;
      return result;
    } finally {
      this.starting = false;
    }
  }

  async hostStop(): Promise<void> {
    await this.stop('host-stop');
  }

  async hostDecision(accept: boolean): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    if (accept) this.session.approve();
    else this.session.reject();
  }

  async hostSnapshot(raw: unknown): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    this.session.publish(validateSnapshot(raw));
  }

  async hostReply(
    actionId: unknown,
    accepted: unknown,
    message: unknown,
    raw: unknown,
  ): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    if (typeof actionId !== 'string' || !isActionId(actionId)) throw new Error('无效的动作编号');
    if (typeof accepted !== 'boolean') throw new Error('无效的受理结果');
    if (message !== null && (typeof message !== 'string' || message.length > 200)) {
      throw new Error('无效的提示信息');
    }
    this.session.reply(actionId, accepted, message, validateSnapshot(raw));
  }

  async guestJoin(url: unknown): Promise<{ phase: OnlinePhase }> {
    this.assertIdle();
    if (typeof url !== 'string' || url.length > 300 || url.trim() === '') {
      throw new Error('邀请链接格式不正确');
    }
    const invite = parseInvite(url);
    this.starting = true;
    const holder: { session: GuestOnlineSession | null } = { session: null };
    const session = GuestOnlineSession.create({
      invite,
      events: (event) => this.handleEvent(holder.session, event),
      pollHoldMs: this.options.pollHoldMs,
      pingIntervalMs: this.options.pingIntervalMs,
      retryDelayMs: this.options.retryDelayMs,
    });
    holder.session = session;
    this.session = session;
    try {
      const phase = await session.start();
      return { phase };
    } catch (error) {
      if (this.session === session) this.session = null;
      await session.stop('join-failed');
      if (abortedByStop(error)) throw new Error('已取消加入');
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async guestAction(raw: unknown): Promise<ActionReply> {
    if (!(this.session instanceof GuestOnlineSession)) throw new Error('当前不是客人');
    const action = validateGuestAction(raw);
    try {
      return await this.session.send(action);
    } catch (error) {
      // 离开时在途动作被本端中止：closed 事件已通知渲染进程，不再提示操作失败。
      if (abortedByStop(error)) return IDLE_REPLY;
      throw error;
    }
  }

  async guestLeave(): Promise<void> {
    await this.stop('guest-leave');
  }

  stop(reason: string): Promise<void> {
    // 已有拆解在途：复用同一个停止（before-quit 会再调一次），不重复拆解、也不提前放行新会话。
    const pending = this.stopping;
    if (pending) return pending;
    this.epoch += 1;
    const session = this.session;
    this.session = null;
    if (!session) return Promise.resolve();
    const teardown = (async (): Promise<void> => {
      try {
        await session.stop(reason);
      } finally {
        this.stopping = null;
      }
    })();
    this.stopping = teardown;
    // 调用方可能丢弃返回值（窗口关闭/退出钩子），拒绝不能变成未处理拒绝。
    teardown.catch(() => undefined);
    return teardown;
  }

  private assertIdle(): void {
    if (this.session || this.starting || this.stopping) throw new Error('已有联机会话');
  }

  /**
   * 会话事件入口，必须带上事件所属会话：迟到的 `closed` 只能清空它自己的会话，
   * 不能把之后新建的会话及其隧道、HTTP 服务丢在无人释放的状态。
   */
  private handleEvent(session: OnlineSession | null, event: OnlineEvent): void {
    if (event.type === 'closed' && session !== null && this.session === session) {
      this.session = null;
    }
    try {
      this.options.emit(event);
    } catch {
      // 渲染进程已销毁时 webContents.send 会抛错；事件发送失败不能中断会话生命周期。
    }
  }
}