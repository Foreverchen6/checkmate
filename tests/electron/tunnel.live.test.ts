import { describe, expect, it } from 'vitest';
import { HostOnlineSession } from '../../electron/online/session.ts';
import { parseInvite } from '../../src/net/protocol.ts';

const enabled = process.env.XIANGQI_ONLINE_TUNNEL === '1';

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
        'bypass-tunnel-reminder': 'true',
        'user-agent': 'Xiangqi/0.1',
      };
      try {
        const response = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        expect([200, 204]).toContain(response.status);
      } finally {
        await session.stop('live-test');
      }

      const status = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
        .then((response) => response.status)
        .catch(() => 0);
      expect([200, 204]).not.toContain(status);
    },
    60_000,
  );
});