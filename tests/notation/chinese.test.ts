import { describe, expect, it } from 'vitest';
import { initialPosition } from '../../src/rules/board.ts';
import { generateLegalMoves } from '../../src/rules/moves.ts';
import {
  chineseNotation,
  generateChineseMoves,
  parseChineseMove,
} from '../../src/notation/chinese.ts';
import { parseUciMove } from '../../src/notation/coords.ts';

describe('中文记谱', () => {
  const pos = initialPosition();

  it('生成红方开局着法', () => {
    expect(chineseNotation(pos, parseUciMove('h2e2')!)).toBe('炮二平五');
    expect(chineseNotation(pos, parseUciMove('b0c2')!)).toBe('马八进七');
  });

  it('生成黑方开局着法', () => {
    expect(chineseNotation(pos, parseUciMove('h7e7')!)).toBe('炮8平5');
    expect(chineseNotation(pos, parseUciMove('h9g7')!)).toBe('马8进7');
  });

  it('所有初始合法着法都能生成并匹配回原着法', () => {
    for (const move of generateLegalMoves(pos)) {
      const text = chineseNotation(pos, move);
      expect(parseChineseMove(pos, text)).toEqual(move);
    }
  });

  it('同列同子使用前后区分', () => {
    const twoRooks = {
      board: Array.from({ length: 10 }, () => Array(9).fill(null)),
      sideToMove: 'red' as const,
      halfmoveClock: 0,
      fullmoveNumber: 1,
    };
    twoRooks.board[9][4] = { type: 'K', side: 'black' };
    twoRooks.board[5][0] = { type: 'R', side: 'red' };
    twoRooks.board[0][0] = { type: 'R', side: 'red' };
    twoRooks.board[0][4] = { type: 'K', side: 'red' };

    expect(chineseNotation(twoRooks, parseUciMove('a5a6')!)).toBe('前车进一');
    expect(chineseNotation(twoRooks, parseUciMove('a0a1')!)).toBe('后车进一');
  });

  it('红方输入可以用阿拉伯数字', () => {
    expect(parseChineseMove(pos, '炮2平5')).toEqual(parseUciMove('h2e2'));
  });

  it('生成着法列表与合法着法数量一致', () => {
    expect(generateChineseMoves(pos)).toHaveLength(44);
  });
});