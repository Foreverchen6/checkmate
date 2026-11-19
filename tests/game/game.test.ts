import { describe, expect, it } from 'vitest';
import { Game, IllegalMoveError } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { INITIAL_FEN } from '../../src/rules/board.ts';

function play(game: Game, uci: string): void {
  const move = parseUciMove(uci);
  if (!move) throw new Error(`bad uci: ${uci}`);
  game.move(move);
}

describe('对局状态机', () => {
  it('新对局由红方先行，记录中文着法', () => {
    const game = new Game();
    expect(game.position.sideToMove).toBe('red');
    expect(game.legalMoves()).toHaveLength(44);

    const entry = game.move(parseUciMove('h2e2')!);
    expect(entry.chinese).toBe('炮二平五');
    expect(game.position.sideToMove).toBe('black');
  });

  it('非法着法被拒绝且不改变局面', () => {
    const game = new Game();
    expect(() => play(game, 'a0a5')).toThrow(IllegalMoveError);
    expect(game.history).toHaveLength(0);
  });

  it('悔棋退回指定步数', () => {
    const game = new Game();
    play(game, 'h2e2');
    play(game, 'h9g7');
    expect(game.undo(2)).toBe(2);
    expect(game.position.sideToMove).toBe('red');
    expect(game.history).toHaveLength(0);
  });

  it('同一局面第三次出现判和', () => {
    const game = new Game();
    const cycle = ['b0c2', 'b9c7', 'c2b0', 'c7b9'];
    for (let i = 0; i < 2; i += 1) {
      for (const uci of cycle) play(game, uci);
    }
    expect(game.result).toBe('draw');
    expect(game.endReason).toBe('repetition');
  });

  it('无吃子达到 120 半回合判和', () => {
    const fen = INITIAL_FEN.replace(' 0 1', ' 119 1');
    const game = new Game(fen);
    play(game, 'b0c2');
    expect(game.result).toBe('draw');
    expect(game.endReason).toBe('move_limit');
  });

  it('认输记录胜方', () => {
    const game = new Game();
    game.resign('red');
    expect(game.result).toBe('black_win');
    expect(game.endReason).toBe('resign');
  });

  it('中止对局', () => {
    const game = new Game();
    game.abort();
    expect(game.result).toBe('aborted');
    expect(game.endReason).toBe('aborted');
  });

  it('构造局面后可以直接生成 FEN', () => {
    const game = new Game(INITIAL_FEN);
    expect(game.fen()).toBe(INITIAL_FEN);
  });
});