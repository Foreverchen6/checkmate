import { describe, expect, it } from 'vitest';
import { GuestOnlineSession, HostOnlineSession } from '../../electron/online/session.ts';
import { parseInvite, type OnlineEvent } from '../../src/net/protocol.ts';

const enabled = process.env.XIANGQI_ONLINE_TUNNEL === '1';

async function waitFor(check: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

describe.skipIf(!enabled)('真实内网穿透', () => {
  it(
    '公网邀请地址可访问，关闭后不再可用',
    async () => {
      const token = 'b'.repeat(43);
      const session = await HostOnlineSession.create({
        hostSide: 'red',
        // HostSessionOptions.events 是必填项：create() 内部会立即 emitStatus()。
        events: () => undefined,
        token,
        pollHoldMs: 100,
      });
      const invite = parseInvite(session.inviteUrl ?? '');
      const headers = {
        authorization: `Bearer ${invite.token}`,
        'user-agent': 'Xiangqi/0.1',
      };
      try {
        const response = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        // 未加入的客人轮询应被房主服务拒绝：403 busy 证明请求已穿过公网隧道打到本机服务。
        const body = (await response.json()) as { error?: { code?: string } };
        expect(response.status).toBe(403);
        expect(body.error?.code).toBe('busy');
      } finally {
        await session.stop('live-test');
      }

      const status = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
        .then((response) => response.status)
        .catch(() => 0);
      expect([200, 204, 403]).not.toContain(status);
    },
    60_000,
  );

  it(
    '房主结束联机后客人及时收到关闭事件',
    async () => {
      const hostEvents: OnlineEvent[] = [];
      const guestEvents: OnlineEvent[] = [];
      const host = await HostOnlineSession.create({
        hostSide: 'red',
        token: 'c'.repeat(43),
        events: (event) => hostEvents.push(event),
      });
      const guest = GuestOnlineSession.create({
        invite: parseInvite(host.inviteUrl ?? ''),
        pingIntervalMs: 1_000,
        retryDelayMs: 100,
        events: (event) => guestEvents.push(event),
      });
      try {
        const joining = guest.start();
        await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'), '客人加入', 20_000);
        host.approve();
        await joining;
        await waitFor(() => host.pendingPolls >= 1, '客人长轮询挂起', 20_000);
        // 让长轮询稳定挂住一段时间，确认经过公网中继的挂起请求不会因超时侧被回收。
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const stoppedAt = Date.now();
        await host.stop('host-stop');
        await waitFor(() => guestEvents.some((event) => event.type === 'closed'), '客人收到关闭', 15_000);
        console.log('客人收到关闭耗时：', Date.now() - stoppedAt, 'ms');
        expect(guestEvents.find((event) => event.type === 'closed')).toEqual({
          type: 'closed',
          reason: '房间已关闭',
        });
      } finally {
        await guest.stop('test');
      }
    },
    90_000,
  );
});