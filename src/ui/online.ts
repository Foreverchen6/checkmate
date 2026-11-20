import type { OnlinePhase, OnlineRole, PendingRequest } from '../net/protocol.ts';
import type { Side } from '../types.ts';

export interface OnlinePanelHooks {
  hostStart(hostSide: Side): Promise<void>;
  hostStop(): Promise<void>;
  hostDecision(accept: boolean): void;
  guestJoin(url: string): Promise<void>;
  guestLeave(): void;
  undoRequest(): void;
  undoCancel(): void;
  undoResponse(accept: boolean): void;
  drawOffer(): void;
  drawResponse(accept: boolean): void;
  resign(): void;
}

export interface OnlinePanelView {
  role: OnlineRole | null;
  approved: boolean;
  joinRequestPending: boolean;
  phase: OnlinePhase | null;
  inviteUrl: string | null;
  clockText: string;
  message: string;
  pending: PendingRequest | null;
  selfSide: Side | null;
  canAct: boolean;
}

const IDLE_VIEW: OnlinePanelView = {
  role: null,
  approved: false,
  joinRequestPending: false,
  phase: null,
  inviteUrl: null,
  clockText: '',
  message: '创建或加入房间',
  pending: null,
  selfSide: null,
  canAct: false,
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

export class OnlinePanel {
  private readonly hooks: OnlinePanelHooks;
  private readonly modal: HTMLDivElement;
  private readonly hostTab: HTMLButtonElement;
  private readonly guestTab: HTMLButtonElement;
  private readonly hostPane: HTMLElement;
  private readonly guestPane: HTMLElement;
  private readonly hostSide: HTMLSelectElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly urlInput: HTMLInputElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly hostState: HTMLElement;
  private readonly joinRequest: HTMLElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly rejectBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly joinInput: HTMLTextAreaElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly guestState: HTMLElement;
  private readonly gameBox: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly connectionEl: HTMLElement;
  private readonly pendingBox: HTMLElement;
  private readonly pendingText: HTMLElement;
  private readonly pendingAccept: HTMLButtonElement;
  private readonly pendingReject: HTMLButtonElement;
  private readonly pendingCancel: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly drawBtn: HTMLButtonElement;
  private readonly resignBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private view: OnlinePanelView = IDLE_VIEW;
  private tab: 'host' | 'guest' = 'host';
  private busy = false;
  private stopArmed = false;
  private stopTimer: number | null = null;

  constructor(hooks: OnlinePanelHooks) {
    this.hooks = hooks;
    this.modal = byId<HTMLDivElement>('online-modal');
    this.hostTab = byId('online-tab-host');
    this.guestTab = byId('online-tab-guest');
    this.hostPane = byId('online-host-pane');
    this.guestPane = byId('online-guest-pane');
    this.hostSide = byId<HTMLSelectElement>('online-host-side');
    this.createBtn = byId('online-create');
    this.urlInput = byId<HTMLInputElement>('online-url');
    this.copyBtn = byId('online-copy');
    this.hostState = byId('online-host-state');
    this.joinRequest = byId('online-join-request');
    this.acceptBtn = byId('online-accept');
    this.rejectBtn = byId('online-reject');
    this.stopBtn = byId('online-stop');
    this.joinInput = byId<HTMLTextAreaElement>('online-join-url');
    this.joinBtn = byId('online-join');
    this.leaveBtn = byId('online-leave');
    this.guestState = byId('online-guest-state');
    this.gameBox = byId('online-game');
    this.clockEl = byId('online-clock');
    this.connectionEl = byId('online-connection');
    this.pendingBox = byId('online-pending');
    this.pendingText = byId('online-pending-text');
    this.pendingAccept = byId('online-pending-accept');
    this.pendingReject = byId('online-pending-reject');
    this.pendingCancel = byId('online-pending-cancel');
    this.undoBtn = byId('online-undo');
    this.drawBtn = byId('online-draw');
    this.resignBtn = byId('online-resign');
    this.errorEl = byId('online-error');
    this.closeBtn = byId('online-close');
    this.bind();
    this.render(IDLE_VIEW);
  }

  get isOpen(): boolean {
    return !this.modal.hidden;
  }

  open(): void {
    this.setError('');
    this.modal.hidden = false;
    this.render(this.view);
    this.createBtn.focus();
  }

  close(): void {
    this.modal.hidden = true;
    this.resetStopArm();
  }

  setError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.title = text;
  }

  render(view: OnlinePanelView): void {
    this.view = view;
    const active = view.role !== null;
    this.hostTab.classList.toggle('active', this.tab === 'host');
    this.guestTab.classList.toggle('active', this.tab === 'guest');
    this.hostTab.hidden = active;
    this.guestTab.hidden = active;
    this.hostPane.hidden = active ? view.role !== 'host' : this.tab !== 'host';
    this.guestPane.hidden = active ? view.role !== 'guest' : this.tab !== 'guest';

    this.hostSide.disabled = active || this.busy;
    this.createBtn.disabled = active || this.busy;
    this.joinInput.disabled = active || this.busy;
    this.joinBtn.disabled = active || this.busy;
    this.urlInput.value = view.inviteUrl ?? '';
    this.copyBtn.disabled = !view.inviteUrl;
    this.stopBtn.disabled = view.role !== 'host' || this.busy;
    this.leaveBtn.disabled = view.role !== 'guest' || this.busy;
    this.joinRequest.hidden = !view.joinRequestPending;
    this.hostState.textContent = this.hostStatusText(view);
    this.guestState.textContent = this.guestStatusText(view);

    this.gameBox.hidden = !active || view.phase === null;
    this.clockEl.textContent = view.clockText || '等待开始';
    this.connectionEl.textContent = view.message;
    this.pendingBox.hidden = !view.pending;
    if (view.pending) {
      const mine = view.pending.by === view.selfSide;
      const kind = view.pending.kind === 'undo' ? '悔棋' : '求和';
      this.pendingText.textContent = mine ? `已请求${kind}，等待对方回应` : `对方请求${kind}`;
      this.pendingAccept.hidden = mine;
      this.pendingReject.hidden = mine;
      this.pendingCancel.hidden = !mine || view.pending.kind !== 'undo';
    }
    this.undoBtn.disabled = !view.canAct || view.pending !== null;
    this.drawBtn.disabled = !view.canAct || view.pending !== null;
    this.resignBtn.disabled = !view.canAct;
    if (!this.stopArmed) this.stopBtn.textContent = '结束联机';
  }

  private bind(): void {
    this.modal.addEventListener('click', (event) => {
      if (event.target === this.modal) this.close();
    });
    this.closeBtn.addEventListener('click', () => this.close());
    this.hostTab.addEventListener('click', () => {
      this.tab = 'host';
      this.setError('');
      this.render(this.view);
    });
    this.guestTab.addEventListener('click', () => {
      this.tab = 'guest';
      this.setError('');
      this.render(this.view);
    });

    this.createBtn.addEventListener('click', () => {
      const side: Side = this.hostSide.value === 'black' ? 'black' : 'red';
      void this.run(() => this.hooks.hostStart(side));
    });
    this.joinBtn.addEventListener('click', () => {
      const url = this.joinInput.value.trim();
      if (!url) {
        this.setError('请粘贴邀请链接');
        return;
      }
      void this.run(() => this.hooks.guestJoin(url));
    });
    this.copyBtn.addEventListener('click', () => {
      const text = this.view.inviteUrl;
      if (!text) return;
      void copyText(text).then((copied) => {
        this.copyBtn.textContent = copied ? '已复制' : '复制失败';
        window.setTimeout(() => {
          this.copyBtn.textContent = '复制';
        }, 1200);
      });
    });
    this.acceptBtn.addEventListener('click', () => {
      try {
        this.hooks.hostDecision(true);
      } catch (error) {
        this.setError(describeError(error));
      }
    });
    this.rejectBtn.addEventListener('click', () => {
      try {
        this.hooks.hostDecision(false);
      } catch (error) {
        this.setError(describeError(error));
      }
    });
    this.stopBtn.addEventListener('click', () => {
      if (this.view.phase === 'playing' && !this.stopArmed) {
        this.stopArmed = true;
        this.stopBtn.textContent = '再点一次确认';
        if (this.stopTimer !== null) window.clearTimeout(this.stopTimer);
        this.stopTimer = window.setTimeout(() => this.resetStopArm(), 5000);
        return;
      }
      this.resetStopArm();
      void this.run(() => this.hooks.hostStop());
    });
    this.leaveBtn.addEventListener('click', () => this.hooks.guestLeave());

    this.pendingAccept.addEventListener('click', () => {
      const pending = this.view.pending;
      if (!pending || pending.by === this.view.selfSide) return;
      if (pending.kind === 'undo') this.hooks.undoResponse(true);
      else this.hooks.drawResponse(true);
    });
    this.pendingReject.addEventListener('click', () => {
      const pending = this.view.pending;
      if (!pending || pending.by === this.view.selfSide) return;
      if (pending.kind === 'undo') this.hooks.undoResponse(false);
      else this.hooks.drawResponse(false);
    });
    this.pendingCancel.addEventListener('click', () => this.hooks.undoCancel());

    this.undoBtn.addEventListener('click', () => this.hooks.undoRequest());
    this.drawBtn.addEventListener('click', () => this.hooks.drawOffer());
    this.resignBtn.addEventListener('click', () => this.hooks.resign());
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render(this.view);
    try {
      await task();
    } catch (error) {
      this.setError(describeError(error));
    } finally {
      this.busy = false;
      this.render(this.view);
    }
  }

  private resetStopArm(): void {
    this.stopArmed = false;
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.stopBtn.textContent = '结束联机';
  }

  private hostStatusText(view: OnlinePanelView): string {
    if (view.role !== 'host') return '未创建';
    if (view.joinRequestPending) return '有玩家请求加入';
    if (view.phase === 'ended') return '对局已结束';
    if (view.approved) return '对局中';
    if (!view.inviteUrl) return '正在启动联机…';
    return '等待对方加入';
  }

  private guestStatusText(view: OnlinePanelView): string {
    if (view.role !== 'guest') return '未加入';
    if (view.phase === 'ended') return '对局已结束';
    if (!view.approved) return '等待房主同意';
    if (view.phase === 'playing') return '对局中';
    return '等待房主开始';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
