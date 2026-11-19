import { describe, expect, it } from 'vitest';
import {
  INITIAL_FEN,
  initialPosition,
  parseFen,
  positionKey,
  toFen,
} from '../../src/rules/board.ts';

describe('FEN', () => {
  it('初始局面可以原样往返', () => {
    const pos = parseFen(INITIAL_FEN);
    expect(toFen(pos)).toBe(INITIAL_FEN);
  });

  it('黑将位于 e9，红帅位于 e0', () => {
    const pos = initialPosition();
    expect(pos.board[9][4]).toEqual({ type: 'K', side: 'black' });
    expect(pos.board[0][4]).toEqual({ type: 'K', side: 'red' });
  });

  it('马和象使用 N/B 字母', () => {
    const pos = initialPosition();
    expect(pos.board[0][1]).toEqual({ type: 'N', side: 'red' });
    expect(pos.board[0][2]).toEqual({ type: 'B', side: 'red' });
  });

  it('行数不足时抛出明确错误', () => {
    expect(() => parseFen('9/9 w - - 0 1')).toThrow(/10 行/);
  });

  it('局面键不包含回合计数', () => {
    expect(positionKey(initialPosition())).toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
    );
  });
});