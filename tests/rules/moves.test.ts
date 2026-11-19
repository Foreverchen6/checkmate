import { describe, expect, it } from 'vitest';
import type { PieceType, Position, Side } from '../../src/types.ts';
import { initialPosition, parseFen } from '../../src/rules/board.ts';
import {
  applyMove,
  generateLegalMoves,
  generatePseudoMoves,
  generalsFace,
  isInCheck,
} from '../../src/rules/moves.ts';

interface Placement {
  type: PieceType;
  side: Side;
  file: number;
  rank: number;
}

function positionWith(pieces: Placement[], sideToMove: Side = 'red'): Position {
  const board: ({ type: PieceType; side: Side } | null)[][] = Array.from(
    { length: 10 },
    () => Array(9).fill(null),
  );
  board[0][3] = { type: 'K', side: 'red' };
  board[9][5] = { type: 'K', side: 'black' };
  for (const p of pieces) board[p.rank][p.file] = { type: p.type, side: p.side };
  return { board, sideToMove, halfmoveClock: 0, fullmoveNumber: 1 };
}

describe('初始局面', () => {
  it('红方有 44 个合法着法', () => {
    expect(generateLegalMoves(initialPosition())).toHaveLength(44);
  });
});

describe('棋子走法', () => {
  it('车在空棋盘中心有 17 个走法', () => {
    const pos = positionWith([{ type: 'R', side: 'red', file: 4, rank: 4 }]);
    expect(generatePseudoMoves(pos, { file: 4, rank: 4 })).toHaveLength(17);
  });

  it('炮必须有炮架才能吃子，且不能越过炮架落空点', () => {
    const pos = positionWith([
      { type: 'C', side: 'red', file: 4, rank: 4 },
      { type: 'P', side: 'red', file: 4, rank: 5 },
      { type: 'P', side: 'black', file: 4, rank: 7 },
    ]);
    const moves = generatePseudoMoves(pos, { file: 4, rank: 4 });
    expect(moves.some((m) => m.to.file === 4 && m.to.rank === 7)).toBe(true);
    expect(moves.some((m) => m.to.file === 4 && m.to.rank === 6)).toBe(false);
  });

  it('马腿被堵时不能走对应方向', () => {
    const pos = positionWith([
      { type: 'N', side: 'red', file: 4, rank: 4 },
      { type: 'P', side: 'red', file: 4, rank: 5 },
    ]);
    const moves = generatePseudoMoves(pos, { file: 4, rank: 4 });
    expect(moves.some((m) => m.to.file === 5 && m.to.rank === 6)).toBe(false);
    expect(moves.some((m) => m.to.file === 6 && m.to.rank === 5)).toBe(true);
  });

  it('象眼被堵时不能走，且红象不能过河', () => {
    const blocked = positionWith([
      { type: 'B', side: 'red', file: 4, rank: 2 },
      { type: 'P', side: 'red', file: 3, rank: 3 },
    ]);
    const blockedMoves = generatePseudoMoves(blocked, { file: 4, rank: 2 });
    expect(blockedMoves.some((m) => m.to.file === 2 && m.to.rank === 4)).toBe(false);

    const river = positionWith([{ type: 'B', side: 'red', file: 4, rank: 4 }]);
    const riverMoves = generatePseudoMoves(river, { file: 4, rank: 4 });
    expect(riverMoves.some((m) => m.to.rank === 6)).toBe(false);
    expect(riverMoves.some((m) => m.to.rank === 2)).toBe(true);
  });

  it('士和将不能走出九宫', () => {
    const advisor = positionWith([{ type: 'A', side: 'red', file: 3, rank: 0 }]);
    const advisorMoves = generatePseudoMoves(advisor, { file: 3, rank: 0 });
    expect(advisorMoves).toHaveLength(1);
    expect(advisorMoves[0].to).toEqual({ file: 4, rank: 1 });

    const king = positionWith([{ type: 'K', side: 'red', file: 3, rank: 0 }]);
    const kingMoves = generatePseudoMoves(king, { file: 3, rank: 0 });
    expect(kingMoves.some((m) => m.to.file === 2)).toBe(false);
  });

  it('兵未过河只能前进，过河后可以横走', () => {
    const before = positionWith([{ type: 'P', side: 'red', file: 4, rank: 3 }]);
    expect(generatePseudoMoves(before, { file: 4, rank: 3 })).toHaveLength(1);

    const after = positionWith([{ type: 'P', side: 'red', file: 4, rank: 6 }]);
    const moves = generatePseudoMoves(after, { file: 4, rank: 6 });
    expect(moves).toHaveLength(3);
    expect(moves.some((m) => m.to.rank === 5)).toBe(false);
  });
});

describe('将帅与将军', () => {
  it('将帅照面被识别', () => {
    const pos = parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    expect(generalsFace(pos)).toBe(true);
  });

  it('移开挡住将帅的棋子属于非法着法', () => {
    const pos = parseFen('3k5/9/9/9/9/3R5/9/9/9/3K5 w - - 0 1');
    const moves = generateLegalMoves(pos);
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 4 && m.to.file === 2)).toBe(
      false,
    );
  });

  it('车沿直线攻击将帅时判定为将军', () => {
    const pos = parseFen('3k5/9/9/9/9/3r5/9/9/9/3K5 w - - 0 1');
    expect(isInCheck(pos, 'red')).toBe(true);
  });

  it('被牵制的棋子不能走出导致己方被将军的着法', () => {
    const pos = parseFen('5k3/3r5/9/9/9/3R5/9/9/9/3K5 w - - 0 1');
    const moves = generateLegalMoves(pos);
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 4 && m.to.file === 4)).toBe(
      false,
    );
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 4 && m.to.rank === 5)).toBe(
      true,
    );
  });

  it('applyMove 会切换行棋方并处理吃子计数', () => {
    const pos = initialPosition();
    const next = applyMove(pos, {
      from: { file: 1, rank: 0 },
      to: { file: 2, rank: 2 },
    });
    expect(next.sideToMove).toBe('black');
    expect(next.halfmoveClock).toBe(1);
  });
});