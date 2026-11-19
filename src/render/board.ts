import type { PieceType, Position, Side } from '../types.ts';

const GLYPHS: Record<Side, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '砲', P: '卒' },
};

export function renderBoard(pos: Position): string {
  const lines: string[] = ['   a  b  c  d  e  f  g  h  i'];

  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = `${rank}  `;
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      row += piece ? `${GLYPHS[piece.side][piece.type]} ` : '   ';
    }
    lines.push(row.trimEnd());

    if (rank === 5) {
      lines.push('   ~~~~ 楚河 · 汉界 ~~~~');
    }
  }

  return lines.join('\n');
}