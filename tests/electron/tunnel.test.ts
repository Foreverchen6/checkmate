import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import {
  createPinggyTunnelFactory,
  findTunnelUrls,
  stripTerminalNoise,
} from '../../electron/online/tunnel.ts';

interface FakeShellStream extends PassThrough {
  stderr: PassThrough;
}

class FakeClient extends EventEmitter {
  readonly shellStream: FakeShellStream;
  endCalls = 0;
  destroyCalls = 0;
  forwarded: Array<[string, number]> = [];

  constructor() {
    super();
    this.shellStream = Object.assign(new PassThrough(), { stderr: new PassThrough() });
  }

  connect(): void {
    queueMicrotask(() => this.emit('ready'));
  }

  end(): void {
    this.endCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  forwardIn(
    bindAddr: string,
    bindPort: number,
    callback: (error: Error | undefined, assignedPort: number) => void,
  ): void {
    this.forwarded.push([bindAddr, bindPort]);
    callback(undefined, 7);
  }

  shell(
    _options: unknown,
    callback: (error: Error | undefined, stream: FakeShellStream) => void,
  ): void {
    callback(undefined, this.shellStream);
  }
}

function asClient(fake: FakeClient): Client {
  return fake as unknown as Client;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('测试环境未就绪');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('隧道地址解析', () => {
  it('去掉 ANSI 与制表符，只保留非站点域名的 https 地址', () => {
    const raw =
      '\x1b[1;32m┃  Tunnel:\x1b[0m https://kxiqa-141-11-146-74.free.pinggy.net ┃\r\n' +
      '\x1b[2mhttps://dashboard.pinggy.io\x1b[0m https://pinggy.io/docs ';
    expect(stripTerminalNoise(raw)).not.toContain('\x1b');
    expect(findTunnelUrls(raw)).toEqual(['https://kxiqa-141-11-146-74.free.pinggy.net']);
  });

  it('跨分片拼接同一地址并去重', () => {
    const buffer =
      'https://abcd-1-2-3-4.free.pinggy.net https://abcd-1-2-3-4.free.pinggy.net ' +
      'https://abcd-1-2-3-4.run.pinggy-free.link';
    expect(findTunnelUrls(buffer)).toEqual([
      'https://abcd-1-2-3-4.free.pinggy.net',
      'https://abcd-1-2-3-4.run.pinggy-free.link',
    ]);
  });

  it('丢弃服务站点与非法地址', () => {
    const buffer =
      'https://docs.pinggy.io https://www.pinggy.io https://admin.localhost.run https://not a url';
    expect(findTunnelUrls(buffer)).toEqual([]);
  });
});

describe('pinggy 隧道封装', () => {
  it('15 秒内拿不到可用地址按超时失败并断开连接', async () => {
    vi.useFakeTimers();
    const fake = new FakeClient();
    fake.connect = () => undefined;
    const factory = createPinggyTunnelFactory({
      createClient: () => asClient(fake),
      verifyUrl: async () => true,
    });

    const opening = factory.open(4321);
    const failed = expect(opening).rejects.toThrow('内网穿透不可用（启动超时）');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.endCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(fake.endCalls).toBe(1);
  });

  it('抓到地址并自检通过后返回句柄，close 幂等并上报关闭原因', async () => {
    const fake = new FakeClient();
    const verified: string[] = [];
    const factory = createPinggyTunnelFactory({
      createClient: () => asClient(fake),
      verifyUrl: async (url) => {
        verified.push(url);
        return true;
      },
    });

    const opening = factory.open(4321);
    await until(() => fake.shellStream.listenerCount('data') > 0);
    fake.shellStream.write('\x1b[2mhttps://dashboard.pinggy.io\x1b[0m\r\n');
    fake.shellStream.write('Tunnel: https://abcd-1-2-');
    fake.shellStream.write('3-4.free.pinggy.net\r\n');
    const handle = await opening;

    expect(handle.url).toBe('https://abcd-1-2-3-4.free.pinggy.net');
    expect(verified).toEqual(['https://abcd-1-2-3-4.free.pinggy.net']);
    expect(fake.forwarded).toEqual([['localhost', 0]]);

    const reasons: string[] = [];
    handle.onClosed((reason) => reasons.push(reason));
    fake.emit('close');
    expect(reasons).toEqual(['穿透连接已关闭']);
    expect(fake.endCalls).toBe(1);

    handle.close();
    handle.close();
    expect(fake.endCalls).toBe(1);
  });

  it('自检失败的候选地址会被跳过，改用下一个可用的', async () => {
    const fake = new FakeClient();
    const tried: string[] = [];
    const factory = createPinggyTunnelFactory({
      createClient: () => asClient(fake),
      verifyUrl: async (url) => {
        tried.push(url);
        return url.includes('second');
      },
    });

    const opening = factory.open(4321);
    await until(() => fake.shellStream.listenerCount('data') > 0);
    fake.shellStream.write(
      'https://first-1-2-3-4.free.pinggy.net https://second-1-2-3-4.free.pinggy.net\r\n',
    );
    const handle = await opening;

    expect(handle.url).toBe('https://second-1-2-3-4.free.pinggy.net');
    expect(tried).toEqual([
      'https://first-1-2-3-4.free.pinggy.net',
      'https://second-1-2-3-4.free.pinggy.net',
    ]);
  });

  it('打开后的连接错误转成关闭原因并释放连接', async () => {
    const fake = new FakeClient();
    const factory = createPinggyTunnelFactory({
      createClient: () => asClient(fake),
      verifyUrl: async () => true,
    });

    const opening = factory.open(4321);
    await until(() => fake.shellStream.listenerCount('data') > 0);
    fake.shellStream.write('https://abcd-1-2-3-4.free.pinggy.net\r\n');
    const handle = await opening;

    const reasons: string[] = [];
    handle.onClosed((reason) => reasons.push(reason));
    fake.emit('error', new Error('连接被重置'));
    expect(reasons).toEqual(['穿透连接中断：连接被重置']);
    expect(fake.endCalls).toBe(1);
  });
});
