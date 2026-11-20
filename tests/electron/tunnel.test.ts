import { afterEach, describe, expect, it, vi } from 'vitest';

const tunnels = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('localtunnel', () => ({ default: tunnels.open }));

import { localTunnelFactory } from '../../electron/online/tunnel.ts';

interface FakeTunnel {
  url: string;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

function fakeTunnel(url = 'https://demo.loca.lt'): FakeTunnel {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const tunnel: FakeTunnel = {
    url,
    close: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return tunnel;
    }),
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        (listener as unknown as (...values: unknown[]) => void)(...args);
      }
    },
  };
  return tunnel;
}

afterEach(() => {
  vi.useRealTimers();
  tunnels.open.mockReset();
});

describe('内网穿透封装', () => {
  it('启动超过 15 秒按超时失败，并关闭迟到的隧道', async () => {
    vi.useFakeTimers();
    let settle: (tunnel: FakeTunnel) => void = () => undefined;
    tunnels.open.mockImplementation(
      () =>
        new Promise<FakeTunnel>((resolve) => {
          settle = resolve;
        }),
    );

    const opening = localTunnelFactory.open(4321);
    const failed = expect(opening).rejects.toThrow('内网穿透不可用（启动超时）');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(tunnels.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await failed;

    const late = fakeTunnel();
    settle(late);
    await Promise.resolve();
    // 迟到的隧道先挂上空 'error' 监听，teardown 错误不会变成未捕获异常。
    expect(late.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => late.emit('error', new Error('teardown 失败'))).not.toThrow();
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it('成功启动后把关闭与错误事件转成关闭原因，close 只释放一次', async () => {
    const tunnel = fakeTunnel();
    tunnels.open.mockResolvedValue(tunnel);

    const handle = await localTunnelFactory.open(4321);
    expect(handle.url).toBe('https://demo.loca.lt');
    const reasons: string[] = [];
    handle.onClosed((reason) => reasons.push(reason));

    tunnel.emit('close');
    tunnel.emit('error', new Error('连接被重置'));
    handle.close();
    handle.close();
    expect(reasons).toEqual(['穿透连接已关闭', '穿透连接中断：连接被重置']);
    expect(tunnel.close).toHaveBeenCalledTimes(1);
  });
});