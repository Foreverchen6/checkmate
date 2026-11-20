import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import { STEP_MS, TOTAL_MS, type OnlineSnapshot } from '../../src/net/protocol.ts';
import { gameFromSnapshot } from '../../src/net/snapshotGame.ts';

function snapshot(overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev: 1,
    phase: 'playing',
    hostSide: 'red',
    initialFen: INITIAL_FEN,
    moves: ['h2e2', 'h7e7'],
    result: null,
    endReason: null,
    clock: { redMs: TOTAL_MS, blackMs: TOTAL_MS, stepMs: STEP_MS, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

describe('快照重建', () => {
  it('按着法重建棋局并生成中文记谱', () => {
    const game = gameFromSnapshot(snapshot());
    expect(game.history).toHaveLength(2);
    expect(game.history[0].chinese).toBe('炮二平五');
    expect(game.history[1].chinese).toBe('炮8平5');
    expect(game.fen()).toBe('rnbakabnr/9/1c2c4/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR w - - 2 2');
  });

  it('快照结果覆盖回放无法推导的超时结果', () => {
    const game = gameFromSnapshot(
      snapshot({ result: 'black_win', endReason: 'timeout_step', phase: 'ended' }),
    );
    expect(game.result).toBe('black_win');
    expect(game.endReason).toBe('timeout_step');
  });

  it('拒绝非法着法', () => {
    expect(() => gameFromSnapshot(snapshot({ moves: ['h2e2', 'h2e2'] }))).toThrow(
      /第 2 手/,
    );
  });

  it('非终局快照不写入结果', () => {
    const game = gameFromSnapshot(snapshot());
    expect(game.result).toBeNull();
    expect(game.endReason).toBeNull();
  });

  it('快照无结果时保留回放推导的将死结果', () => {
    // 黑将 d9 的 e9 与退路 d8 分别被红车 i1 进 i9、红兵 d7 控制，i1i9 一步成杀。
    const mateFen = '3k5/9/3P5/9/9/9/9/9/8R/4K4 w - - 0 1';
    const game = gameFromSnapshot(
      snapshot({
        initialFen: mateFen,
        moves: ['i1i9'],
        phase: 'ended',
        result: null,
        endReason: null,
      }),
    );
    expect(game.fen()).toBe('3k4R/9/3P5/9/9/9/9/9/9/4K4 b - - 1 1');
    expect(game.result).toBe('red_win');
    expect(game.endReason).toBe('checkmate');
  });

  it('拒绝无效坐标', () => {
    expect(() => gameFromSnapshot(snapshot({ moves: ['z2e2'] }))).toThrow(/第 1 手坐标无效/);
  });
});