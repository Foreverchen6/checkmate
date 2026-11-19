import { describe, expect, it } from 'vitest';
import { parseFen } from '../../src/rules/board.ts';
import {
  hasAnyLegalMove,
  isCheckmate,
  isMoveLimitDraw,
  isStalemate,
} from '../../src/rules/status.ts';

describe('终局判定', () => {
  it('识别将死', () => {
    const pos = parseFen('4k4/4R4/9/9/9/9/9/9/9/K2RRR3 b - - 0 1');
    expect(isCheckmate(pos)).toBe(true);
    expect(isStalemate(pos)).toBe(false);
  });

  it('识别困毙', () => {
    const pos = parseFen('4k4/9/6N2/9/9/9/9/9/9/K2R5 b - - 0 1');
    expect(isStalemate(pos)).toBe(true);
    expect(isCheckmate(pos)).toBe(false);
  });

  it('普通局面既非将死也非困毙', () => {
    const pos = parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
    expect(hasAnyLegalMove(pos)).toBe(true);
    expect(isCheckmate(pos)).toBe(false);
    expect(isStalemate(pos)).toBe(false);
  });

  it('无吃子达到 120 个半回合判和', () => {
    const pos = parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 120 61');
    expect(isMoveLimitDraw(pos)).toBe(true);
  });
});