import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OnlineController } from '../../electron/online/ipc.ts';
import type { OnlineSession } from '../../electron/online/session.ts';
import type { TunnelHandle } from '../../electron/online/tunnel.ts';
import type { OnlineEvent, OnlineSnapshot } from '../../src/net/protocol.ts';

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const IDLE = {
  role: null,
  phase: null,
  inviteUrl: null,
  guestConnected: false,
  approved: false,
  error: null,
};

/**
 * 控制器的事件入口是私有实现细节：这里直接按“事件 + 属主会话”调用，
 * 以便在不操纵真实网络时序的前提下验证属主判定。
 */
function eventSeam(controller: OnlineController): {
  handleEvent(session: OnlineSession | null, event: OnlineEvent): void;
} {
  return controller as unknown as {
    handleEvent(session: OnlineSession | null, event: OnlineEvent): void;
  };
}

const IPC_CHANNELS = [
  'online:host-start',
  'online:host-stop',
  'online:host-decision',
  'online:host-snapshot',
  'online:host-reply',
  'online:guest-join',
  'online:guest-action',
  'online:guest-leave',
  'online:status',
];

describe('联机 IPC 控制器', () => {
  it('房主创建后进入大厅，重复创建被拒绝，停止后回到空闲', async () => {
    const events: OnlineEvent[] = [];
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => events.push(event),
    });

    const { url, localUrl } = await controller.hostStart('red');
    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).toBe(`${localUrl}/#${TOKEN}`);
    expect(controller.isActive()).toBe(true);
    expect(controller.status()).toEqual({
      role: 'host',
      phase: 'lobby',
      inviteUrl: url,
      guestConnected: false,
      approved: false,
      error: null,
    });

    await expect(controller.hostStart('red')).rejects.toThrow('已有联机会话');
    await controller.hostStop();
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });

  it('房主快照与动作回复在主进程重新校验', async () => {
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: () => undefined,
    });
    await controller.hostStart('red');
    try {
      await expect(controller.hostSnapshot({ version: 1 })).rejects.toThrow();
      await expect(
        controller.hostReply('short', true, null, snapshot(1)),
      ).rejects.toThrow('无效的动作编号');
      await expect(
        controller.hostReply('a'.repeat(16), true, null, { version: 1 }),
      ).rejects.toThrow();
    } finally {
      await controller.hostStop();
    }
  });

  it('客人加入、动作往返与离开', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => hostEvents.push(event),
    });
    const { url } = await host.hostStart('red');
    const guest = new OnlineController({
      emit: (event) => guestEvents.push(event),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
    });

    try {
      const joining = guest.guestJoin(url);
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      await host.hostDecision(true);
      const { phase } = await joining;
      expect(phase).toBe('lobby');

      await host.hostSnapshot(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      await expect(guest.guestAction({ type: 'move', uci: 'zz' })).rejects.toThrow('着法格式无效');
      await expect(guest.guestAction({ type: 'unknown' })).rejects.toThrow('动作类型无效');

      const sending = guest.guestAction({ type: 'move', uci: 'h7e7' });
      await waitFor(() => hostEvents.some((event) => event.type === 'host-action'));
      const action = hostEvents.find(
        (event): event is Extract<OnlineEvent, { type: 'host-action' }> =>
          event.type === 'host-action',
      );
      await host.hostReply(
        action?.actionId ?? '',
        true,
        null,
        snapshot(2, { moves: ['h2e2', 'h7e7'] }),
      );
      const result = await sending;
      expect(result.snapshot?.rev).toBe(2);

      await guest.guestLeave();
      expect(guest.isActive()).toBe(false);
      expect(guest.status()).toEqual(IDLE);
    } finally {
      await host.hostStop();
    }
  });

  it('同一时间只允许一个联机会话（含并发创建）', async () => {
    const host = new OnlineController({ smokeLocal: true, token: TOKEN, emit: () => undefined });
    const { url } = await host.hostStart('red');
    const guest = new OnlineController({ emit: () => undefined });
    const joining = guest.guestJoin(url);
    const cancelled = expect(joining).rejects.toThrow('已取消加入');
    try {
      await expect(host.hostStart('black')).rejects.toThrow('已有联机会话');
      await expect(host.guestJoin(url)).rejects.toThrow('已有联机会话');
      await expect(guest.hostStart('red')).rejects.toThrow('已有联机会话');
      await guest.guestLeave();
      await cancelled;
    } finally {
      await host.hostStop();
    }

    const racing = new OnlineController({ smokeLocal: true, token: TOKEN, emit: () => undefined });
    const first = racing.hostStart('red');
    await expect(racing.hostStart('red')).rejects.toThrow('已有联机会话');
    await expect(first).resolves.toHaveProperty('url');
    await racing.hostStop();
  });

  it('stop 幂等并清空状态', async () => {
    const events: OnlineEvent[] = [];
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => events.push(event),
    });
    await expect(controller.stop('idle-stop')).resolves.toBeUndefined();
    expect(controller.status()).toEqual(IDLE);

    await controller.hostStart('red');
    await controller.stop('first');
    await controller.stop('second');
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });

  it('isActive 覆盖大厅、对局与结束三个阶段', async () => {
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: () => undefined,
    });
    await controller.hostStart('red');
    try {
      expect(controller.status().phase).toBe('lobby');
      expect(controller.isActive()).toBe(true);
      await controller.hostSnapshot(snapshot(1, { phase: 'playing' }));
      expect(controller.status().phase).toBe('playing');
      expect(controller.isActive()).toBe(true);
      await controller.hostSnapshot(
        snapshot(2, { phase: 'ended', result: 'red_win', endReason: 'checkmate' }),
      );
      expect(controller.status().phase).toBe('ended');
      expect(controller.isActive()).toBe(true);
    } finally {
      await controller.hostStop();
    }
    expect(controller.isActive()).toBe(false);
  });

  it('房主载荷逐字段校验', async () => {
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: () => undefined,
    });
    await controller.hostStart('red');
    try {
      await expect(controller.hostSnapshot(snapshot(1, { moves: ['bad'] }))).rejects.toThrow(
        '着法格式无效',
      );
      await expect(controller.hostSnapshot(snapshot(1, { rev: 0 }))).rejects.toThrow('数值超出范围');
      await expect(
        controller.hostReply('a'.repeat(16), 'yes', null, snapshot(1)),
      ).rejects.toThrow('无效的受理结果');
      await expect(
        controller.hostReply('a'.repeat(16), true, 'x'.repeat(201), snapshot(1)),
      ).rejects.toThrow('无效的提示信息');
    } finally {
      await controller.hostStop();
    }
    await expect(controller.hostSnapshot(snapshot(1))).rejects.toThrow('当前不是房主');
    await expect(controller.hostDecision(true)).rejects.toThrow('当前不是房主');
  });

  it('客人加入链接与动作都重新校验', async () => {
    const guest = new OnlineController({ emit: () => undefined });
    await expect(guest.guestJoin('not-a-url')).rejects.toThrow('邀请链接格式不正确');
    await expect(guest.guestJoin('ftp://example.com/#abc')).rejects.toThrow('邀请链接必须使用 https');
    await expect(guest.guestJoin(`https://example.com/#${'b'.repeat(42)}`)).rejects.toThrow(
      '邀请令牌无效',
    );
    await expect(guest.guestJoin(42)).rejects.toThrow('邀请链接格式不正确');
    await expect(guest.guestJoin('')).rejects.toThrow('邀请链接格式不正确');
    await expect(guest.guestJoin('   ')).rejects.toThrow('邀请链接格式不正确');
    await expect(guest.guestJoin(`https://example.com/#${'b'.repeat(500)}`)).rejects.toThrow(
      '邀请链接格式不正确',
    );
    await expect(guest.guestAction({ type: 'move', uci: 'h7e7' })).rejects.toThrow('当前不是客人');
    expect(guest.isActive()).toBe(false);
    expect(guest.status()).toEqual(IDLE);
  });

  it('事件汇抛出（窗口销毁）不会中断会话', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => {
        hostEvents.push(event);
        throw new Error('Object has been destroyed');
      },
    });
    const guest = new OnlineController({
      emit: (event) => guestEvents.push(event),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
    });
    const started = await host.hostStart('red');
    try {
      const joining = guest.guestJoin(started.url);
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      await host.hostDecision(true);
      await expect(joining).resolves.toEqual({ phase: 'lobby' });
      await host.hostSnapshot(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );
      expect(guestEvents.some((event) => event.type === 'status')).toBe(true);
    } finally {
      await expect(host.hostStop()).resolves.toBeUndefined();
    }
    expect(host.isActive()).toBe(false);
    await guest.guestLeave();
  });

  it('客人取消加入按离开处理，不抛出房间关闭错误', async () => {
    const events: OnlineEvent[] = [];
    const host = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: () => undefined,
    });
    const { url } = await host.hostStart('red');
    const guest = new OnlineController({ emit: (event) => events.push(event) });
    try {
      const joining = guest.guestJoin(url);
      const cancelled = expect(joining).rejects.toThrow('已取消加入');
      await guest.guestLeave();
      await cancelled;
      expect(guest.isActive()).toBe(false);
      expect(guest.status()).toEqual(IDLE);
      const closed = events.filter(
        (event): event is Extract<OnlineEvent, { type: 'closed' }> => event.type === 'closed',
      );
      expect(closed).toHaveLength(1);
      expect(closed[0]?.reason).toBe('guest-leave');
      expect(closed[0]?.reason).not.toBe('房间已关闭');
    } finally {
      await host.hostStop();
    }
  });

  it('客人离开时在途动作按离开处理', async () => {
    const hostEvents: OnlineEvent[] = [];
    const host = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => hostEvents.push(event),
    });
    const { url } = await host.hostStart('red');
    const guest = new OnlineController({
      emit: () => undefined,
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
    });
    try {
      const joining = guest.guestJoin(url);
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      await host.hostDecision(true);
      await joining;

      const acting = guest.guestAction({ type: 'move', uci: 'h7e7' });
      await waitFor(() => hostEvents.some((event) => event.type === 'host-action'));
      await guest.guestLeave();
      await expect(acting).resolves.toEqual({ accepted: false, message: null, snapshot: null });
      expect(guest.isActive()).toBe(false);
    } finally {
      await host.hostStop();
    }
  });

  it('创建房主期间被停止不会遗留会话', async () => {
    const opened = deferred<TunnelHandle>();
    let closes = 0;
    const tunnel: TunnelHandle = {
      url: 'https://demo.loca.lt',
      close: () => {
        closes += 1;
      },
      onClosed: () => undefined,
    };
    const controller = new OnlineController({
      token: TOKEN,
      emit: () => undefined,
      tunnelFactory: { open: () => opened.promise },
    });
    const starting = controller.hostStart('red');
    const failed = expect(starting).rejects.toThrow('联机会话已停止');
    await controller.stop('window-closed');
    opened.resolve(tunnel);
    await failed;
    expect(closes).toBe(1);
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);
  });

  it('停止进行中拒绝新会话，迟到的 closed 不会清空当前会话', async () => {
    let closes = 0;
    let opened = 0;
    const controller = new OnlineController({
      token: TOKEN,
      emit: () => undefined,
      tunnelFactory: {
        open: async () => {
          opened += 1;
          return {
            url: `https://demo-${opened}.loca.lt`,
            close: () => {
              closes += 1;
            },
            onClosed: () => undefined,
          };
        },
      },
    });

    const { url } = await controller.hostStart('red');
    expect(url).toBe(`https://demo-1.loca.lt/#${TOKEN}`);

    // 停止请求已发出、拆解尚未完成：仍然占着会话，不能放第二个会话进来。
    const stopping = controller.stop('first');
    expect(controller.isActive()).toBe(true);
    await expect(controller.hostStart('red')).rejects.toThrow('已有联机会话');
    await expect(controller.guestJoin(url)).rejects.toThrow('已有联机会话');
    await stopping;
    expect(closes).toBe(1);
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);

    // 拆解完成后才能开新会话。
    await controller.hostStart('black');
    expect(controller.isActive()).toBe(true);
    expect(controller.status().role).toBe('host');

    // 前一个会话迟到的 closed 只能清空它自己，不能把当前会话变成僵尸。
    const stale: OnlineSession = {
      role: 'host',
      inviteUrl: null,
      localUrl: null,
      status: () => IDLE,
      stop: () => Promise.resolve(),
    };
    eventSeam(controller).handleEvent(stale, { type: 'closed', reason: 'late-closed' });
    expect(controller.isActive()).toBe(true);
    expect(controller.status().role).toBe('host');

    await controller.hostStop();
    expect(closes).toBe(2);
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);
  });
});

describe('主进程与 preload 接线', () => {
  // 去掉换行与括号后的空白，让多行调用也能按固定片段断言。
  const flatten = (text: string): string => text.replace(/\s+/g, ' ').replace(/\( /g, '(');
  const mainSource = flatten(readFileSync('electron/main.ts', 'utf8'));
  const preloadSource = flatten(readFileSync('electron/preload.ts', 'utf8'));

  it('注册全部联机通道并广播 online:event', () => {
    expect(mainSource).toContain('const online = new OnlineController({');
    for (const channel of IPC_CHANNELS) {
      expect(mainSource, `main.ts 缺少 ${channel}`).toContain(`ipcMain.handle('${channel}'`);
      expect(preloadSource, `preload.ts 缺少 ${channel}`).toContain(
        `ipcRenderer.invoke('${channel}'`,
      );
    }
    expect(mainSource).toContain("win.webContents.send('online:event', event)");
    expect(preloadSource).toContain("ipcRenderer.on('online:event', handler)");
  });

  it('窗口关闭、渲染进程崩溃与退出都会停止会话', () => {
    expect(mainSource).toContain(
      "win.on('closed', () => { void online.stop('window-closed').catch(() => undefined); });",
    );
    expect(mainSource).toContain(
      "win.webContents.on('render-process-gone', () => { void online.stop('render-gone').catch(() => undefined); });",
    );
    expect(mainSource).toContain('app.on(\'before-quit\', (event) => {');
    expect(mainSource).toContain("if (quitting || !online.isActive()) return;");
    expect(mainSource).toContain('event.preventDefault();');
    expect(mainSource).toContain('fallback = setTimeout(resolve, 3000);');
    expect(mainSource).toContain('fallback.unref();');
    expect(mainSource).toContain("Promise.race([online.stop('app-quit'), timeout])");
    expect(mainSource).toContain('.catch(() => undefined)');
    expect(mainSource).toContain('if (fallback !== null) clearTimeout(fallback);');
    expect(mainSource).toContain('app.quit();');
    expect(mainSource).toContain("void online.stop('will-quit').catch(() => undefined);");
  });

  it('广播事件前跳过已销毁窗口并吞掉发送异常', () => {
    expect(mainSource).toContain('if (win.isDestroyed()) continue;');
    expect(mainSource).toContain(
      "try { win.webContents.send('online:event', event); } catch {",
    );
  });

  it('联机进行中拒绝引擎搜索，结束后恢复', () => {
    const start = mainSource.indexOf("ipcMain.handle('engine:search'");
    const end = mainSource.indexOf("ipcMain.handle('record:save'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const search = mainSource.slice(start, end);
    expect(search).toContain("if (online.isActive()) throw new Error('联机对局中不可使用引擎');");
    expect(search.indexOf('online.isActive()')).toBeLessThan(search.indexOf('ensureEngine()'));
  });
});