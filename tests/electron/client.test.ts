import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  GuestClient,
  GuestHttpError,
  type GuestClientHandlers,
  type GuestLinkStatus,
} from '../../electron/online/client.ts';
import { HostServer } from '../../electron/online/hostServer.ts';
import type { ActionReply, OnlineSnapshot } from '../../src/net/protocol.ts';

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

function reply(accepted: boolean, message: string | null, snap: OnlineSnapshot): ActionReply {
  return { accepted, message, snapshot: snap };
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

interface Proxy {
  port: number;
  /** 房主返回给客人的上游状态码，用于确认重连并非由 429 限流噪声触发。 */
  statuses: number[];
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

function startProxy(targetPort: number): Promise<Proxy> {
  let paused = false;
  const statuses: number[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (paused) {
      req.socket.destroy();
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        statuses.push(upstreamRes.statusCode ?? 502);
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(502);
        res.end();
      }
    });
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        statuses,
        pause: () => {
          paused = true;
          for (const socket of sockets) socket.destroy();
        },
        resume: () => {
          paused = false;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function startHost(onAction: (actionId: string, action: unknown) => Promise<ActionReply>) {
  const server = new HostServer({
    token: TOKEN,
    onAction: async (actionId, action) => onAction(actionId, action),
    pollHoldMs: 50,
  });
  const port = await server.listen();
  return { server, port };
}

async function joinApproved(client: GuestClient, server: HostServer): Promise<void> {
  const joining = client.join();
  await waitFor(() => server.status.guestPresent);
  server.approve();
  await joining;
}

/**
 * 启动后的客户端会同时跑长轮询与心跳，房主每 1 秒最多接受 20 个请求。
 * 200 ms 长轮询（约 5/s）与 250 ms 心跳（约 4/s）远低于该上限，
 * 避免测试自身的 429 busy 污染 onStatus('reconnecting') 观测。
 */
const LIVE_OPTIONS = { pollHoldMs: 200, pingIntervalMs: 250, retryDelayMs: 20 } as const;

describe('客人 HTTP 客户端', () => {
  it('加入、轮询快照并提交动作', async () => {
    const { server, port } = await startHost(async () =>
      reply(true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] })),
    );
    const snapshots: OnlineSnapshot[] = [];
    const statuses: GuestLinkStatus[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: (value) => statuses.push(value),
        onClosed: (reason) => statuses.push(`closed:${reason}` as GuestLinkStatus),
      },
      LIVE_OPTIONS,
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);
      expect(snapshots[0].rev).toBe(1);

      const result = await client.action({ type: 'move', uci: 'h7e7' });
      expect(result.accepted).toBe(true);
      expect(result.snapshot?.rev).toBe(2);
      await waitFor(() => snapshots.length === 2);
      expect(snapshots[1].moves).toEqual(['h2e2', 'h7e7']);
      expect(statuses).toContain('connected');
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('忽略不比本地新的快照', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const snapshots: OnlineSnapshot[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: () => undefined,
        onClosed: () => undefined,
      },
      LIVE_OPTIONS,
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);
      await client.poll(1);
      server.publish(snapshot(2, { moves: ['h2e2'] }));
      await waitFor(() => snapshots.length === 2);
      expect(snapshots.map((item) => item.rev)).toEqual([1, 2]);
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('动作被拒绝时原样返回原因', async () => {
    const { server, port } = await startHost(async () =>
      reply(false, '还没轮到你走子', snapshot(1)),
    );
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: () => undefined },
      { pollHoldMs: 50, pingIntervalMs: 100, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      const result = await client.action({ type: 'move', uci: 'h7e7' });
      expect(result.accepted).toBe(false);
      expect(result.message).toBe('还没轮到你走子');
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('网络中断后持续重试并在恢复时回到 connected', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const proxy = await startProxy(port);
    const snapshots: OnlineSnapshot[] = [];
    const statuses: GuestLinkStatus[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${proxy.port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: (value) => statuses.push(value),
        onClosed: () => undefined,
      },
      { ...LIVE_OPTIONS, retryDelayMs: 50 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);
      // 停顿之前必须一直是 connected：若是限流噪声导致的 reconnecting 会在这里暴露。
      expect(statuses).not.toContain('reconnecting');

      proxy.pause();
      await waitFor(() => statuses.includes('reconnecting'));
      // 重连只能来自代理断开，房主侧从未返回 429 busy。
      expect(proxy.statuses.filter((code) => code === 429)).toEqual([]);
      proxy.resume();
      await waitFor(() => {
        const index = statuses.indexOf('reconnecting');
        return index !== -1 && statuses.slice(index + 1).includes('connected');
      });
      expect(proxy.statuses.filter((code) => code === 429)).toEqual([]);
    } finally {
      client.stop();
      await proxy.close();
      await server.close();
    }
  });

  it('房主关闭房间后通知客人并停止重试', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const closed: string[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: (reason) => closed.push(reason) },
      LIVE_OPTIONS,
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => server.status.rev === 1);
      // 关闭前必须有一次已挂起的长轮询，否则客户端只会看到连接被拒绝。
      await waitFor(() => server.status.pendingPolls > 0);
      await server.close();
      await waitFor(() => closed.length === 1);
      expect(closed[0]).toBe('房间已关闭');
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('房主持续不可达超过重连窗口后只通知一次失去连接', async () => {
    // 先占用再释放一个本地端口，得到一个确定无人监听的地址。
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await new Promise<void>((done) => probe.close(() => done()));

    const closed: string[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: () => undefined,
        onStatus: () => undefined,
        onClosed: (reason) => closed.push(reason),
      },
      { pollHoldMs: 100, pingIntervalMs: 50, retryDelayMs: 20, reconnectWindowMs: 150 },
    );
    try {
      const startedAt = Date.now();
      client.start();
      await waitFor(() => closed.length > 0, 2000);
      expect(closed).toEqual(['与房主失去连接']);
      // 重连窗口到期才收尾，而不是第一次失败就放弃。
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);

      // 再次 start()/轮询不得重复通知（closedNotified 幂等）。
      client.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(closed).toEqual(['与房主失去连接']);
    } finally {
      client.stop();
    }
  });
});

function silentHandlers(): GuestClientHandlers {
  return { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: () => undefined };
}

async function expectGuestError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<GuestHttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuestHttpError);
    const failure = error as GuestHttpError;
    expect(failure.name).toBe('GuestHttpError');
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
    return failure;
  }
  throw new Error(`预期抛出 GuestHttpError(${status}, ${code})`);
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TapProxy {
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function startTapProxy(targetPort: number): Promise<TapProxy> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: { ...req.headers },
        body: body.toString('utf8'),
      });
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.writableEnded) {
          res.writeHead(502);
          res.end();
        }
      });
      upstream.end(body);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

interface Gate {
  port: number;
  paths: string[];
  openSockets: () => number;
  close(): Promise<void>;
}

function startGate(): Promise<Gate> {
  const paths: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req) => {
    paths.push(req.url ?? '');
    req.resume();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        paths,
        openSockets: () => sockets.size,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('客人 HTTP 客户端（补充）', () => {
  it('每个请求都带上鉴权与识别头，POST 使用 JSON 请求体', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const tap = await startTapProxy(port);
    const client = new GuestClient(`http://127.0.0.1:${tap.port}`, TOKEN, silentHandlers(), {
      pollHoldMs: 50,
      pingIntervalMs: 100,
      retryDelayMs: 20,
    });
    try {
      const joining = client.join();
      await waitFor(() => server.status.guestPresent);
      server.approve();
      await expect(joining).resolves.toBe('lobby');
      await client.ping();
      const result = await client.action({ type: 'resign' });
      expect(result.accepted).toBe(true);

      const join = tap.requests.find((item) => item.path === '/xq/v1/join');
      expect(join).toBeDefined();
      expect(join?.method).toBe('POST');
      expect(join?.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(join?.headers.accept).toBe('application/json');
      expect(join?.headers['user-agent']).toBe('Xiangqi/0.1');
      expect(join?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(join?.body ?? 'null')).toEqual({});

      const ping = tap.requests.find((item) => item.path === '/xq/v1/ping');
      expect(ping?.method).toBe('POST');
      expect(ping?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(ping?.body ?? 'null')).toEqual({});

      const action = tap.requests.find((item) => item.path === '/xq/v1/action');
      expect(action?.method).toBe('POST');
      expect(action?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(action?.body ?? 'null')).toEqual({ type: 'resign' });
    } finally {
      client.stop();
      await tap.close();
      await server.close();
    }
  });

  it('把 HTTP 错误映射为带状态码与错误码的 GuestHttpError', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    try {
      const wrongToken = new GuestClient(
        `http://127.0.0.1:${port}`,
        'b'.repeat(43),
        silentHandlers(),
        { pollHoldMs: 50, pingIntervalMs: 100, retryDelayMs: 20 },
      );
      await expectGuestError(wrongToken.join(), 401, 'unauthorized');

      const rejected = new GuestClient(
        `http://127.0.0.1:${port}`,
        TOKEN,
        silentHandlers(),
        { pollHoldMs: 50, pingIntervalMs: 100, retryDelayMs: 20 },
      );
      const joining = rejected.join();
      await waitFor(() => server.status.guestPresent);
      server.reject();
      await expectGuestError(joining, 403, 'rejected');

      const approved = new GuestClient(
        `http://127.0.0.1:${port}`,
        TOKEN,
        silentHandlers(),
        { pollHoldMs: 50, pingIntervalMs: 100, retryDelayMs: 20 },
      );
      try {
        await joinApproved(approved, server);
        await expectGuestError(approved.poll(-1), 400, 'bad_request');
      } finally {
        approved.stop();
      }
    } finally {
      await server.close();
    }
  });

  it('网络不可达时映射为 network 错误', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    await server.close();
    const client = new GuestClient(`http://127.0.0.1:${port}`, TOKEN, silentHandlers(), {
      pollHoldMs: 50,
      pingIntervalMs: 100,
      retryDelayMs: 20,
    });
    try {
      await expectGuestError(client.join(), 0, 'network');
    } finally {
      client.stop();
    }
  });

  it('轮询在 204 时返回 null，在 200 时返回校验后的快照', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const client = new GuestClient(`http://127.0.0.1:${port}`, TOKEN, silentHandlers(), {
      pollHoldMs: 50,
      pingIntervalMs: 100,
      retryDelayMs: 20,
    });
    try {
      await joinApproved(client, server);
      await expect(client.poll(0)).resolves.toBeNull();
      server.publish(snapshot(3, { moves: ['h2e2'] }));
      const received = await client.poll(0);
      expect(received?.rev).toBe(3);
      expect(received?.moves).toEqual(['h2e2']);
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('start() 重复调用只启动一条轮询', async () => {
    const gate = await startGate();
    const client = new GuestClient(`http://127.0.0.1:${gate.port}`, TOKEN, silentHandlers(), {
      pollHoldMs: 50,
      pingIntervalMs: 100,
      retryDelayMs: 20,
      requestTimeoutMs: 5_000,
    });
    try {
      client.start();
      client.start();
      await waitFor(() => gate.paths.some((path) => path.startsWith('/xq/v1/poll')));
      await waitFor(() => gate.paths.some((path) => path.startsWith('/xq/v1/ping')));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const polls = gate.paths.filter((path) => path.startsWith('/xq/v1/poll'));
      expect(polls).toHaveLength(1);
    } finally {
      client.stop();
      await gate.close();
    }
  });

  it('stop() 中止在途轮询与心跳、清理计时器且可重复调用', async () => {
    const gate = await startGate();
    const closed: string[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${gate.port}`,
      TOKEN,
      { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: (reason) => closed.push(reason) },
      { pollHoldMs: 50, pingIntervalMs: 100, retryDelayMs: 20, requestTimeoutMs: 5_000 },
    );
    try {
      client.start();
      await waitFor(() => gate.paths.some((path) => path.startsWith('/xq/v1/poll')));
      await waitFor(() => gate.paths.some((path) => path.startsWith('/xq/v1/ping')));
      client.stop();
      client.stop();
      await waitFor(() => gate.openSockets() === 0);
      const settled = gate.paths.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(gate.paths.length).toBe(settled);
      expect(closed).toEqual([]);
    } finally {
      client.stop();
      await gate.close();
    }
  });
});

describe('客人 HTTP 客户端（取消与超时）', () => {
  it('join() 不套用请求超时：房主慢批准后仍返回阶段', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const statuses: GuestLinkStatus[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: () => undefined,
        onStatus: (value) => statuses.push(value),
        onClosed: () => undefined,
      },
      { requestTimeoutMs: 50 },
    );
    let settled = false;
    try {
      const joining = client.join();
      joining.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitFor(() => server.status.guestPresent);
      // 远超 50 ms 的请求超时：join 仍应挂起，房主也仍持有该客人。
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);
      expect(server.status.guestPresent).toBe(true);
      expect(server.status.approved).toBe(false);
      expect(statuses).toEqual([]);

      server.approve();
      await expect(joining).resolves.toBe('lobby');
      expect(server.status.approved).toBe(true);
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('stop() 中止挂起的 join，房主释放客人后可以重新加入', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      silentHandlers(),
      { requestTimeoutMs: 10_000 },
    );
    try {
      const joining = client.join();
      await waitFor(() => server.status.guestPresent);
      expect(server.status.approved).toBe(false);

      const startedAt = Date.now();
      client.stop();
      await expectGuestError(joining, 0, 'closed');
      // 中止必须立刻生效，而不是等到 10 s 请求超时。
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      // 房主经由 socket 关闭感知到客人离开，不再把它当成占用中的玩家。
      await waitFor(() => !server.status.guestPresent);

      const next = new GuestClient(`http://127.0.0.1:${port}`, TOKEN, silentHandlers(), {
        requestTimeoutMs: 10_000,
      });
      try {
        const rejoining = next.join();
        await waitFor(() => server.status.guestPresent);
        server.approve();
        await expect(rejoining).resolves.toBe('lobby');
      } finally {
        next.stop();
      }
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('stop() 中止在途 action', async () => {
    const gate = await startGate();
    const client = new GuestClient(`http://127.0.0.1:${gate.port}`, TOKEN, silentHandlers(), {
      requestTimeoutMs: 10_000,
    });
    try {
      const acting = client.action({ type: 'resign' });
      await waitFor(() => gate.paths.some((path) => path.startsWith('/xq/v1/action')));
      const startedAt = Date.now();
      client.stop();
      await expectGuestError(acting, 0, 'closed');
      // 中止立即生效，而不是等满 10 s 请求超时。
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await waitFor(() => gate.openSockets() === 0);
    } finally {
      client.stop();
      await gate.close();
    }
  });

  it('action() 仍然受请求超时约束', async () => {
    const { server, port } = await startHost(
      () => new Promise<ActionReply>(() => undefined),
    );
    const client = new GuestClient(`http://127.0.0.1:${port}`, TOKEN, silentHandlers(), {
      pollHoldMs: 50,
      pingIntervalMs: 100,
      retryDelayMs: 20,
      requestTimeoutMs: 100,
    });
    try {
      await joinApproved(client, server);
      const startedAt = Date.now();
      await expectGuestError(client.action({ type: 'resign' }), 0, 'network');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      client.stop();
      await server.close();
    }
  });
});