import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  GuestOnlineSession,
  HostOnlineSession,
} from '../../electron/online/session.ts';
import type { TunnelFactory, TunnelHandle } from '../../electron/online/tunnel.ts';
import {
  parseInvite,
  type OnlineEvent,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(rev: number, overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev,
    phase: 'playing',
    hostSide: 'red',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [],
    result: null,
    endReason: null,
    clock: { redMs: 1_200_000, blackMs: 1_200_000, stepMs: 150_000, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待状态超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function fakeTunnel(url = 'https://demo.loca.lt'): TunnelHandle & {
  closeCount: number;
  notifyClosed: (reason: string) => void;
  notifyError: (reason: string) => void;
} {
  const listeners: Array<(reason: string) => void> = [];
  const handle = {
    url,
    closeCount: 0,
    close(): void {
      handle.closeCount += 1;
    },
    onClosed(callback: (reason: string) => void): void {
      listeners.push(callback);
    },
    notifyClosed(reason: string): void {
      for (const listener of listeners) listener(reason);
    },
    notifyError(reason: string): void {
      for (const listener of listeners) listener(reason);
    },
  };
  return handle;
}

/** 在给定端口上重新监听，验证原服务已彻底释放端口。 */
async function expectPortReleased(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

describe('联机会话生命周期', () => {
  it('本地冒烟模式跳过穿透，stop 幂等且只通知一次', async () => {
    let opened = 0;
    const factory: TunnelFactory = {
      open: async () => {
        opened += 1;
        throw new Error('本地模式不应启动穿透');
      },
    };
    const events: OnlineEvent[] = [];
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      tunnelFactory: factory,
      events: (event) => events.push(event),
    });
    expect(opened).toBe(0);
    expect(session.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.inviteUrl).toBe(`${session.localUrl}/#${TOKEN}`);

    await Promise.all([session.stop('test'), session.stop('test')]);
    await session.stop('test');
    expect(events.filter((event) => event.type === 'closed')).toEqual([
      { type: 'closed', reason: 'test' },
    ]);
  });

  it('穿透句柄在停止时恰好关闭一次', async () => {
    const tunnel = fakeTunnel();
    const factory: TunnelFactory = { open: async () => tunnel };
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      tunnelFactory: factory,
      events: () => undefined,
    });
    expect(session.inviteUrl).toBe(`https://demo.loca.lt/#${TOKEN}`);

    await session.stop('first');
    await session.stop('second');
    expect(tunnel.closeCount).toBe(1);
  });

  it('创建时事件回调抛错会关闭隧道与本地服务端口', async () => {
    const tunnel = fakeTunnel();
    const ports: number[] = [];
    const factory: TunnelFactory = {
      open: async (port) => {
        ports.push(port);
        return tunnel;
      },
    };
    const failure = new Error('IPC 通道已销毁');
    let emits = 0;

    await expect(
      HostOnlineSession.create({
        hostSide: 'red',
        token: TOKEN,
        tunnelFactory: factory,
        events: () => {
          emits += 1;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    // 调用方拿不到 session，只能由 create 的失败路径释放穿透与服务端口。
    expect(emits).toBe(1);
    expect(tunnel.closeCount).toBe(1);
    expect(ports).toHaveLength(1);
    await expectPortReleased(ports[0]);
  });

  it('穿透错误立即结束会话', async () => {
    const tunnel = fakeTunnel();
    const factory: TunnelFactory = { open: async () => tunnel };
    const events: OnlineEvent[] = [];
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      tunnelFactory: factory,
      events: (event) => events.push(event),
    });

    tunnel.notifyError('穿透连接中断');
    await waitFor(() => events.some((event) => event.type === 'closed'));
    expect(events.filter((event) => event.type === 'closed')).toEqual([
      { type: 'closed', reason: '穿透连接中断' },
    ]);
    expect(tunnel.closeCount).toBe(1);
  });

  it('房主同意后客人收到快照并可提交动作', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      events: (event) => hostEvents.push(event),
    });
    const guest = GuestOnlineSession.create({
      invite: parseInvite(host.inviteUrl ?? ''),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
      events: (event) => guestEvents.push(event),
    });

    try {
      const joining = guest.start();
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      host.approve();
      await joining;
      expect(host.status().approved).toBe(true);
      expect(host.status().guestConnected).toBe(true);

      host.publish(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      const sending = guest.send({ type: 'move', uci: 'h7e7' });
      await waitFor(() => hostEvents.some((event) => event.type === 'host-action'));
      const action = hostEvents.find(
        (event): event is Extract<OnlineEvent, { type: 'host-action' }> =>
          event.type === 'host-action',
      );
      expect(action?.action).toEqual({ type: 'move', uci: 'h7e7' });
      host.reply(action?.actionId ?? '', true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] }));

      const result = await sending;
      expect(result.snapshot?.rev).toBe(2);
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 2),
      );
    } finally {
      await guest.stop('leave');
      await host.stop('test');
    }
  });

  it('房主拒绝加入时客人 start 失败，房间保持空闲', async () => {
    const hostEvents: OnlineEvent[] = [];
    const host = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      events: (event) => hostEvents.push(event),
    });
    const guest = GuestOnlineSession.create({
      invite: parseInvite(host.inviteUrl ?? ''),
      pollHoldMs: 50,
      pingIntervalMs: 1000,
      retryDelayMs: 20,
      events: () => undefined,
    });

    try {
      const joining = guest.start();
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      host.reject();
      await expect(joining).rejects.toMatchObject({ status: 403, code: 'rejected' });
      expect(host.status().approved).toBe(false);
      expect(host.status().guestConnected).toBe(false);
    } finally {
      await guest.stop('leave');
      await host.stop('test');
    }
  });

  it('房主结束联机后客人收到关闭事件', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      events: (event) => hostEvents.push(event),
    });
    const guest = GuestOnlineSession.create({
      invite: parseInvite(host.inviteUrl ?? ''),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
      events: (event) => guestEvents.push(event),
    });

    try {
      const joining = guest.start();
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      host.approve();
      await joining;
      host.publish(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      // 等客人的下一次长轮询真正挂到房主上再关闭，确保关闭裁决的 410 写在真实等待者上。
      // 依赖 server.status.pendingPolls 而不是固定 sleep，避免负载变化时偶发失败。
      await waitFor(() => host.pendingPolls >= 1);
      await host.stop('host-stop');
      await waitFor(() => guestEvents.some((event) => event.type === 'closed'));
      expect(guestEvents.filter((event) => event.type === 'closed')).toEqual([
        { type: 'closed', reason: '房间已关闭' },
      ]);
    } finally {
      await guest.stop('test');
    }
  });
});