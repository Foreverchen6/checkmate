import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import {
  MAX_MOVES,
  PROTOCOL_VERSION,
  STEP_MS,
  TOTAL_MS,
  parseInvite,
  validateGuestAction,
  validateSnapshot,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: PROTOCOL_VERSION,
    rev: 1,
    phase: 'playing',
    hostSide: 'red',
    initialFen: INITIAL_FEN,
    moves: [],
    result: null,
    endReason: null,
    clock: {
      redMs: TOTAL_MS,
      blackMs: TOTAL_MS,
      stepMs: STEP_MS,
      turn: 'red',
      running: true,
    },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

describe('邀请 URL', () => {
  it('解析 https 隧道地址与 fragment 令牌', () => {
    expect(parseInvite(`https://abc.loca.lt/#${TOKEN}`)).toEqual({
      origin: 'https://abc.loca.lt',
      token: TOKEN,
    });
  });

  it('允许本机 http，供集成测试与冒烟使用', () => {
    expect(parseInvite(`http://127.0.0.1:4321/#${TOKEN}`)).toEqual({
      origin: 'http://127.0.0.1:4321',
      token: TOKEN,
    });
  });

  it('拒绝公网 http、错误协议、路径、查询串与错误令牌', () => {
    expect(() => parseInvite(`http://abc.loca.lt/#${TOKEN}`)).toThrow();
    expect(() => parseInvite(`javascript:alert(1)`)).toThrow();
    expect(() => parseInvite(`https://abc.loca.lt/path#${TOKEN}`)).toThrow();
    expect(() => parseInvite(`https://abc.loca.lt/?x=1#${TOKEN}`)).toThrow();
    expect(() => parseInvite('https://abc.loca.lt/#short')).toThrow();
    expect(() => parseInvite('https://abc.loca.lt/')).toThrow();
  });
});

describe('快照校验', () => {
  it('返回字段完整的快照副本', () => {
    const raw = snapshot();
    expect(validateSnapshot(raw)).toEqual(raw);
    expect(validateSnapshot(raw)).not.toBe(raw);
  });

  it('拒绝非法 revision、阶段与结束原因', () => {
    expect(() => validateSnapshot({ ...snapshot(), rev: 0 })).toThrow();
    expect(() => validateSnapshot({ ...snapshot(), phase: 'waiting' })).toThrow();
    expect(() => validateSnapshot({ ...snapshot(), endReason: 'timeout' })).toThrow();
  });

  it('拒绝非法着法与超长棋谱', () => {
    expect(() => validateSnapshot(snapshot({ moves: ['h2e2', 'bad'] }))).toThrow();
    expect(() =>
      validateSnapshot(snapshot({ moves: Array.from({ length: MAX_MOVES + 1 }, () => 'h2e2') })),
    ).toThrow();
  });

  it('校验棋钟与 pending 请求', () => {
    expect(() =>
      validateSnapshot(snapshot({ clock: { ...snapshot().clock, redMs: -1 } })),
    ).toThrow();
    expect(() =>
      validateSnapshot(snapshot({ pending: { kind: 'draw', by: 'green' as never } })),
    ).toThrow();
    expect(validateSnapshot(snapshot({ pending: { kind: 'undo', by: 'black' } })).pending).toEqual({
      kind: 'undo',
      by: 'black',
    });
  });
});

describe('客人动作校验', () => {
  it('接受白名单动作', () => {
    expect(validateGuestAction({ type: 'move', uci: 'h2e2' })).toEqual({
      type: 'move',
      uci: 'h2e2',
    });
    expect(validateGuestAction({ type: 'undo-response', accept: true })).toEqual({
      type: 'undo-response',
      accept: true,
    });
    expect(validateGuestAction({ type: 'resign' })).toEqual({ type: 'resign' });
  });

  it('拒绝未知类型、多余字段与错误类型', () => {
    expect(() => validateGuestAction({ type: 'chat', text: 'hi' })).toThrow();
    expect(() => validateGuestAction({ type: 'move', uci: 'h2e2', extra: 1 })).toThrow();
    expect(() => validateGuestAction({ type: 'draw-response', accept: 'yes' })).toThrow();
    expect(() => validateGuestAction(null)).toThrow();
  });
});