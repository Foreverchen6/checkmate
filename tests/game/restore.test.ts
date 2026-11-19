import { describe, expect, it } from 'vitest';
import { Game } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { restoreGame } from '../../src/game/restore.ts';
import { buildSavedGame } from '../../src/storage/recordData.ts';
import type { SavedGame } from '../../src/storage/recordData.ts';

function play(game: Game, uci: string): void {
  const move = parseUciMove(uci);
  if (!move) throw new Error(`bad uci: ${uci}`);
  game.move(move);
}

function snapshot(game: Game): SavedGame {
  return buildSavedGame(game, 'red', 'entry', new Date('2026-11-19T02:30:45Z'));
}

describe('存档重放', () => {
  it('重放未完成对局', () => {
    const game = new Game();
    play(game, 'h2e2');
    play(game, 'h9g7');

    const restored = restoreGame(snapshot(game));
    expect(restored.fen()).toBe(game.fen());
    expect(restored.history).toHaveLength(2);
    expect(restored.history[1].chinese).toBe(game.history[1].chinese);
    expect(restored.result).toBeNull();
  });

  it('重放认输对局并恢复结果', () => {
    const game = new Game();
    play(game, 'b0c2');
    game.resign('red');

    const restored = restoreGame(snapshot(game));
    expect(restored.result).toBe('black_win');
    expect(restored.endReason).toBe('resign');
    expect(restored.history).toHaveLength(1);
  });

  it('重放三方重复判和', () => {
    const game = new Game();
    for (let index = 0; index < 2; index += 1) {
      for (const uci of ['b0c2', 'b9c7', 'c2b0', 'c7b9']) play(game, uci);
    }
    expect(game.result).toBe('draw');

    const restored = restoreGame(snapshot(game));
    expect(restored.result).toBe('draw');
    expect(restored.endReason).toBe('repetition');
  });

  it('终局 FEN 不一致时拒绝载入', () => {
    const game = new Game();
    play(game, 'h2e2');
    const saved = { ...snapshot(game), finalFen: game.initialFen };
    expect(() => restoreGame(saved)).toThrow(/终局/);
  });

  it('非法着法报告具体手数', () => {
    const game = new Game();
    play(game, 'h2e2');
    const saved = snapshot(game);
    saved.moves[0].uci = 'a0a5';
    expect(() => restoreGame(saved)).toThrow(/第 1 手/);
  });

  it('结果不一致时拒绝载入', () => {
    const game = new Game();
    for (let index = 0; index < 2; index += 1) {
      for (const uci of ['b0c2', 'b9c7', 'c2b0', 'c7b9']) play(game, uci);
    }
    const saved = { ...snapshot(game), result: 'red_win' as const };
    expect(() => restoreGame(saved)).toThrow(/结果/);
  });

  it('未记录结果的已结束对局拒绝载入', () => {
    const game = new Game();
    for (let index = 0; index < 2; index += 1) {
      for (const uci of ['b0c2', 'b9c7', 'c2b0', 'c7b9']) play(game, uci);
    }
    const saved = { ...snapshot(game), result: null, endReason: null };
    expect(() => restoreGame(saved)).toThrow(/未记录结果/);
  });
});
