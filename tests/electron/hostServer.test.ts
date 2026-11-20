import { createServer, request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { HostServer, type HostServerOptions } from '../../electron/online/hostServer.ts';
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

interface JsonResponse {
  status: number;
  body: unknown;
}

function call(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function post(
  port: number,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  return call(port, 'POST', path, body, headers);
}

function get(port: number, path: string, headers?: Record<string, string>): Promise<JsonResponse> {
  return call(port, 'GET', path, undefined, headers);
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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

async function approvedServer(
  onAction: HostServerOptions['onAction'],
  extra: Partial<HostServerOptions> = {},
): Promise<{ server: HostServer; port: number }> {
  const server = new HostServer({ token: TOKEN, onAction, ...extra });
  const port = await server.listen();
  const joinPromise = post(port, '/xq/v1/join', {});
  await waitFor(() => server.status.guestPresent);
  server.approve();
  const join = await joinPromise;
  expect(join.status).toBe(200);
  server.publish(snapshot(1));
  return { server, port };
}

describe('房主本地 HTTP 服务', () => {
  it('只绑定回环地址并校验令牌', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      expect(server.address).toBe('127.0.0.1');
      const anonymous = await post(port, '/xq/v1/join', {}, { authorization: '' });
      expect(anonymous.status).toBe(401);
      const wrong = await post(
        port,
        '/xq/v1/join',
        {},
        { authorization: `Bearer ${'b'.repeat(43)}` },
      );
      expect(wrong.status).toBe(401);
      const missing = await get(port, '/xq/v1/poll?rev=0', { authorization: '' });
      expect(missing.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('加入需要房主同意，拒绝后可再次加入', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      const pending = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.status.approved).toBe(false);

      const notYet = await get(port, '/xq/v1/poll?rev=0');
      expect(notYet.status).toBe(403);
      const earlyAction = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(earlyAction.status).toBe(403);

      expect(server.reject()).toBe(true);
      const rejected = await pending;
      expect(rejected.status).toBe(403);
      expect(rejected.body).toMatchObject({ error: { code: 'rejected' } });

      const retry = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.approve()).toBe(true);
      expect((await retry).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('已有客人时再次加入返回 409', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const busy = await post(port, '/xq/v1/join', {});
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ error: { code: 'busy' } });
    } finally {
      await server.close();
    }
  });

  it('长轮询在 rev 落后时立即返回，并在发布后唤醒', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const immediate = await get(port, '/xq/v1/poll?rev=0');
      expect(immediate.status).toBe(200);
      expect((immediate.body as OnlineSnapshot).rev).toBe(1);

      const hanging = get(port, '/xq/v1/poll?rev=1');
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.publish(snapshot(2, { moves: ['h2e2'] }));
      const woken = await hanging;
      expect(woken.status).toBe(200);
      expect(woken.body).toMatchObject({ rev: 2, moves: ['h2e2'] });
    } finally {
      await server.close();
    }
  });

  it('无新快照时长轮询在挂起上限后返回 204', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      pollHoldMs: 30,
    });
    try {
      const timedOut = await get(port, '/xq/v1/poll?rev=1');
      expect(timedOut.status).toBe(204);
      expect(timedOut.body).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('客人动作经 onAction 处理后返回最新快照', async () => {
    const seen: string[] = [];
    const { server, port } = await approvedServer(async (actionId, action) => {
      seen.push(actionId);
      expect(action).toEqual({ type: 'move', uci: 'h7e7' });
      return reply(true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] }));
    });
    try {
      const response = await post(port, '/xq/v1/action', { type: 'move', uci: 'h7e7' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ accepted: true, snapshot: { rev: 2 } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(server.status.rev).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('非法动作返回 400，房主超时返回 504', async () => {
    const { server, port } = await approvedServer(() => new Promise<ActionReply>(() => {}), {
      actionTimeoutMs: 30,
    });
    try {
      const bad = await post(port, '/xq/v1/action', { type: 'move', uci: 'zz' });
      expect(bad.status).toBe(400);
      const slow = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(slow.status).toBe(504);
      expect(slow.body).toMatchObject({ error: { code: 'timeout' } });
    } finally {
      await server.close();
    }
  });

  it('心跳刷新在线状态，离线 12 秒后暂停、2 分钟判超时', async () => {
    let clock = 1000;
    const events: string[] = [];
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      now: () => clock,
      onGuestDisconnected: () => events.push('disconnected'),
      onGuestReconnected: () => events.push('reconnected'),
      onGuestTimeout: () => events.push('timeout'),
    });
    try {
      clock = 14_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected']);

      clock = 14_000;
      const pong = await post(port, '/xq/v1/ping', {});
      expect(pong.status).toBe(204);
      expect(events).toEqual(['disconnected', 'reconnected']);

      clock = 27_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected', 'reconnected', 'disconnected']);

      clock = 147_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected', 'reconnected', 'disconnected', 'timeout']);

      clock = 200_000;
      server.checkLiveness();
      expect(events).toHaveLength(4);
    } finally {
      await server.close();
    }
  });

  it('每令牌每秒超过 20 次请求返回 429', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      now: () => 1000,
    });
    try {
      for (let index = 0; index < 19; index += 1) {
        expect((await post(port, '/xq/v1/ping', {})).status).toBe(204);
      }
      expect((await post(port, '/xq/v1/ping', {})).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('close 幂等、结束挂起轮询并释放端口', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    const hanging = get(port, '/xq/v1/poll?rev=1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await server.close();
    const closed = await hanging;
    expect(closed.status).toBe(410);
    expect(closed.body).toMatchObject({ error: { code: 'closed' } });
    await server.close();
    expect(server.status.listening).toBe(false);

    const rebound = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    expect(rebound).toBe(port);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawPost(port: number, path: string, payload: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('房主本地 HTTP 服务补充覆盖', () => {
  it('请求体超过 16 KB 或非法 JSON 返回 400，未知接口返回 404', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const oversized = await post(port, '/xq/v1/action', {
        type: 'undo-request',
        pad: 'x'.repeat(20 * 1024),
      });
      expect(oversized.status).toBe(400);
      expect(oversized.body).toMatchObject({ error: { code: 'bad_request' } });

      const malformed = await rawPost(port, '/xq/v1/action', 'not-json');
      expect(malformed.status).toBe(400);

      const unknown = await post(port, '/xq/v1/unknown', {});
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ error: { code: 'bad_request' } });
    } finally {
      await server.close();
    }
  });

  it('所有 POST 路由统一 16 KB 上限：/join 与 /ping 超限也返回 400 且连接可继续使用', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const payload = JSON.stringify({ pad: 'x'.repeat(20 * 1024) });

      const joinOversized = await rawPost(port, '/xq/v1/join', payload);
      expect(joinOversized.status).toBe(400);
      expect(joinOversized.body).toMatchObject({ error: { code: 'bad_request' } });

      const pingOversized = await rawPost(port, '/xq/v1/ping', payload);
      expect(pingOversized.status).toBe(400);
      expect(pingOversized.body).toMatchObject({ error: { code: 'bad_request' } });

      const joinMalformed = await rawPost(port, '/xq/v1/join', 'not-json');
      expect(joinMalformed.status).toBe(400);
      const pingMalformed = await rawPost(port, '/xq/v1/ping', 'not-json');
      expect(pingMalformed.status).toBe(400);

      // 拒绝后房间状态与连接都没有被破坏。
      expect(server.status.approved).toBe(true);
      expect((await post(port, '/xq/v1/ping', {})).status).toBe(204);
      expect((await get(port, '/xq/v1/poll?rev=0')).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('POST 路由要求 content-type 为 application/json', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const plain = await post(port, '/xq/v1/ping', {}, { 'content-type': 'text/plain' });
      expect(plain.status).toBe(400);
      expect(plain.body).toMatchObject({ error: { code: 'bad_request' } });

      const form = await post(
        port,
        '/xq/v1/join',
        {},
        { 'content-type': 'application/x-www-form-urlencoded' },
      );
      expect(form.status).toBe(400);
      expect(form.body).toMatchObject({ error: { code: 'bad_request' } });

      const action = await post(
        port,
        '/xq/v1/action',
        { type: 'undo-request' },
        { 'content-type': 'text/plain' },
      );
      expect(action.status).toBe(400);

      // 带参数的标准 JSON 类型仍然接受。
      const accepted = await post(
        port,
        '/xq/v1/ping',
        {},
        { 'content-type': 'application/json; charset=utf-8' },
      );
      expect(accepted.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it('发布会忽略不大于当前 rev 的快照，轮询只在 rev 前进时唤醒', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      server.publish(snapshot(3, { moves: ['h2e2'] }));
      server.publish(snapshot(2, { moves: [] }));
      server.publish(snapshot(3, { moves: [] }));
      expect(server.status.rev).toBe(3);

      let settled = false;
      const held = get(port, '/xq/v1/poll?rev=3');
      held.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await delay(50);
      expect(settled).toBe(false);
      server.publish(snapshot(3, { moves: [] }));
      await delay(20);
      expect(settled).toBe(false);

      server.publish(snapshot(4, { moves: ['h2e2', 'h7e7'] }));
      const woken = await held;
      expect(woken.status).toBe(200);
      expect(woken.body).toMatchObject({ rev: 4 });
    } finally {
      await server.close();
    }
  });

  it('approve 与 reject 只生效一次，无待批准客人时返回 false', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      expect(server.approve()).toBe(false);
      expect(server.reject()).toBe(false);

      const pending = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.approve()).toBe(true);
      expect(server.approve()).toBe(false);
      expect(server.reject()).toBe(false);
      expect((await pending).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('关闭时仍在等待批准的加入请求返回 410 并清空客人状态', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      const pending = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      await server.close();
      const closed = await pending;
      expect(closed.status).toBe(410);
      expect(closed.body).toMatchObject({ error: { code: 'closed' } });
      expect(server.status.guestPresent).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('并发轮询超过上限返回 429，关闭后挂起轮询全部结束', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    const first = get(port, '/xq/v1/poll?rev=1');
    const second = get(port, '/xq/v1/poll?rev=1');
    try {
      await delay(50);
      const third = await get(port, '/xq/v1/poll?rev=1');
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ error: { code: 'busy' } });
    } finally {
      await server.close();
    }
    expect((await first).status).toBe(410);
    expect((await second).status).toBe(410);
  });

  it('关闭时仍在处理的动作请求不会崩溃或泄漏', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: () => new Promise<ActionReply>(() => {}),
      actionTimeoutMs: 30,
    });
    const port = await server.listen();
    try {
      const join = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.approve()).toBe(true);
      expect((await join).status).toBe(200);
      server.publish(snapshot(1));

      const pending = post(port, '/xq/v1/action', { type: 'undo-request' }).catch(() => null);
      await delay(20);
      await server.close();
      const settled = await pending;
      await delay(80);
      // 优雅关闭不再重置在途连接：动作要么在关闭前完成（200）、由关闭裁决（410），
      // 要么照常走到动作超时（504），客户端始终拿到合法响应而不是 socket 错误。
      expect(settled).not.toBeNull();
      expect([200, 410, 504]).toContain(settled?.status);
      expect(server.status.listening).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('关闭时挂起的轮询稳定收到 410 closed（重复 5 次）', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
      try {
        const hanging = get(port, '/xq/v1/poll?rev=1');
        await delay(20);
        await server.close();
        const closed = await hanging;
        expect(closed.status).toBe(410);
        expect(closed.body).toMatchObject({ error: { code: 'closed' } });
      } finally {
        await server.close();
      }
    }
  });

  it('关闭宽限期内到达的请求仍收到 410 closed，宽限期结束后才释放端口', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    const closing = server.close(300);
    // 关闭态已生效：宽限期内落地的请求不应被拒连，而应拿到 410。
    const late = await get(port, '/xq/v1/poll?rev=1');
    expect(late.status).toBe(410);
    expect(late.body).toMatchObject({ error: { code: 'closed' } });
    await closing;
    await expect(get(port, '/xq/v1/poll?rev=1')).rejects.toThrow();
  });

  it('房主返回非法快照时返回 500 而不是 410', async () => {
    let calls = 0;
    const { server, port } = await approvedServer(async () => {
      calls += 1;
      if (calls === 1) {
        return reply(true, null, { ...snapshot(2), rev: 0 } as OnlineSnapshot);
      }
      return reply(true, null, snapshot(2));
    });
    try {
      const bad = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(bad.status).toBe(500);
      expect(bad.body).toMatchObject({ error: { code: 'host_unavailable' } });
      expect(server.status.rev).toBe(1);

      // 房间仍然可用，下一次合法动作正常返回。
      const good = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(good.status).toBe(200);
      expect(good.body).toMatchObject({ snapshot: { rev: 2 } });
      expect(server.status.rev).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('存活检查回调抛错时转交 onError 且不崩溃', async () => {
    const errors: Error[] = [];
    let clock = 1000;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
      now: () => clock,
      onIdle: () => {
        throw new Error('onIdle 失败');
      },
      onError: (error) => errors.push(error),
    });
    try {
      await server.listen();
      clock = 1000 + 30 * 60_000 + 1;
      vi.advanceTimersByTime(1_000);
      expect(errors.map((error) => error.message)).toEqual(['onIdle 失败']);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });
});