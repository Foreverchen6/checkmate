import type { Piece, Position, Side } from '../types.ts';

export const INITIAL_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

const PIECE_FROM_CHAR: Record<string, Piece> = {
  K: { type: 'K', side: 'red' },
  A: { type: 'A', side: 'red' },
  B: { type: 'B', side: 'red' },
  N: { type: 'N', side: 'red' },
  R: { type: 'R', side: 'red' },
  C: { type: 'C', side: 'red' },
  P: { type: 'P', side: 'red' },
  k: { type: 'K', side: 'black' },
  a: { type: 'A', side: 'black' },
  b: { type: 'B', side: 'black' },
  n: { type: 'N', side: 'black' },
  r: { type: 'R', side: 'black' },
  c: { type: 'C', side: 'black' },
  p: { type: 'P', side: 'black' },
};

const CHAR_FROM_PIECE: Record<string, string> = {
  'red:K': 'K',
  'red:A': 'A',
  'red:B': 'B',
  'red:N': 'N',
  'red:R': 'R',
  'red:C': 'C',
  'red:P': 'P',
  'black:K': 'k',
  'black:A': 'a',
  'black:B': 'b',
  'black:N': 'n',
  'black:R': 'r',
  'black:C': 'c',
  'black:P': 'p',
};

function parseSide(value: string): Side {
  if (value === 'w') return 'red';
  if (value === 'b') return 'black';
  throw new Error(`无效行棋方：${value}`);
}

export function parseFen(fen: string): Position {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`无效 FEN：${fen}`);

  const rows = parts[0].split('/');
  if (rows.length !== 10) {
    throw new Error(`FEN 必须有 10 行，实际 ${rows.length} 行`);
  }

  const board: (Piece | null)[][] = Array.from({ length: 10 }, () =>
    Array<Piece | null>(9).fill(null),
  );

  rows.forEach((row, index) => {
    const rank = 9 - index;
    let file = 0;
    for (const ch of row) {
      if (/[1-9]/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const piece = PIECE_FROM_CHAR[ch];
      if (!piece) throw new Error(`FEN 含未知棋子字符：${ch}`);
      if (file > 8) throw new Error(`FEN 第 ${index + 1} 行超出 9 列`);
      board[rank][file] = { ...piece };
      file += 1;
    }
    if (file !== 9) {
      throw new Error(`FEN 第 ${index + 1} 行必须有 9 列，实际 ${file}`);
    }
  });

  return {
    board,
    sideToMove: parseSide(parts[1]),
    halfmoveClock: parts[4] ? Number(parts[4]) : 0,
    fullmoveNumber: parts[5] ? Number(parts[5]) : 1,
  };
}

export function toFen(pos: Position): string {
  const rows: string[] = [];
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += CHAR_FROM_PIECE[`${piece.side}:${piece.type}`];
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  const side = pos.sideToMove === 'red' ? 'w' : 'b';
  return `${rows.join('/')} ${side} - - ${pos.halfmoveClock} ${pos.fullmoveNumber}`;
}

export function initialPosition(): Position {
  return parseFen(INITIAL_FEN);
}

export function pieceAt(
  pos: Position,
  sq: { file: number; rank: number },
): Piece | null {
  if (sq.file < 0 || sq.file > 8 || sq.rank < 0 || sq.rank > 9) return null;
  return pos.board[sq.rank][sq.file];
}

export function positionKey(pos: Position): string {
  return toFen({ ...pos, halfmoveClock: 0, fullmoveNumber: 1 })
    .split(' ')
    .slice(0, 2)
    .join(' ');
}