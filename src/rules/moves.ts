import type { Move, Piece, Position, Side, Square } from '../types.ts';
import { opposite, sameSquare, square } from '../types.ts';
import { pieceAt } from './board.ts';

const ORTHO = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;

const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const HORSE = [
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0],
] as const;

function inBounds(sq: Square): boolean {
  return sq.file >= 0 && sq.file <= 8 && sq.rank >= 0 && sq.rank <= 9;
}

function inPalace(sq: Square, side: Side): boolean {
  if (sq.file < 3 || sq.file > 5) return false;
  return side === 'red' ? sq.rank >= 0 && sq.rank <= 2 : sq.rank >= 7 && sq.rank <= 9;
}

function addIfAvailable(
  pos: Position,
  moves: Move[],
  from: Square,
  file: number,
  rank: number,
  side: Side,
): void {
  const to = square(file, rank);
  if (!inBounds(to)) return;
  const target = pos.board[rank][file];
  if (target && target.side === side) return;
  moves.push({ from, to });
}

export function generatePseudoMoves(pos: Position, from: Square): Move[] {
  const piece = pieceAt(pos, from);
  if (!piece) return [];
  const moves: Move[] = [];

  switch (piece.type) {
    case 'R': {
      for (const [df, dr] of ORTHO) {
        let file = from.file + df;
        let rank = from.rank + dr;
        while (true) {
          const to = square(file, rank);
          if (!inBounds(to)) break;
          const target = pos.board[rank][file];
          if (!target) {
            moves.push({ from, to });
          } else {
            if (target.side !== piece.side) moves.push({ from, to });
            break;
          }
          file += df;
          rank += dr;
        }
      }
      break;
    }
    case 'C': {
      for (const [df, dr] of ORTHO) {
        let file = from.file + df;
        let rank = from.rank + dr;
        let hasScreen = false;
        while (true) {
          const to = square(file, rank);
          if (!inBounds(to)) break;
          const target = pos.board[rank][file];
          if (!hasScreen) {
            if (!target) moves.push({ from, to });
            else hasScreen = true;
          } else if (target) {
            if (target.side !== piece.side) moves.push({ from, to });
            break;
          }
          file += df;
          rank += dr;
        }
      }
      break;
    }
    case 'N': {
      for (const [df, dr, lf, lr] of HORSE) {
        const leg = square(from.file + lf, from.rank + lr);
        if (!inBounds(leg) || pieceAt(pos, leg)) continue;
        addIfAvailable(pos, moves, from, from.file + df, from.rank + dr, piece.side);
      }
      break;
    }
    case 'B': {
      for (const [df, dr] of DIAG) {
        const to = square(from.file + df * 2, from.rank + dr * 2);
        if (!inBounds(to)) continue;
        if (pieceAt(pos, square(from.file + df, from.rank + dr))) continue;
        if (piece.side === 'red' ? to.rank > 4 : to.rank < 5) continue;
        const target = pos.board[to.rank][to.file];
        if (target && target.side === piece.side) continue;
        moves.push({ from, to });
      }
      break;
    }
    case 'A': {
      for (const [df, dr] of DIAG) {
        const to = square(from.file + df, from.rank + dr);
        if (!inPalace(to, piece.side)) continue;
        addIfAvailable(pos, moves, from, to.file, to.rank, piece.side);
      }
      break;
    }
    case 'K': {
      for (const [df, dr] of ORTHO) {
        const to = square(from.file + df, from.rank + dr);
        if (!inPalace(to, piece.side)) continue;
        addIfAvailable(pos, moves, from, to.file, to.rank, piece.side);
      }
      break;
    }
    case 'P': {
      const forward = piece.side === 'red' ? 1 : -1;
      addIfAvailable(pos, moves, from, from.file, from.rank + forward, piece.side);
      const crossed = piece.side === 'red' ? from.rank >= 5 : from.rank <= 4;
      if (crossed) {
        addIfAvailable(pos, moves, from, from.file - 1, from.rank, piece.side);
        addIfAvailable(pos, moves, from, from.file + 1, from.rank, piece.side);
      }
      break;
    }
  }

  return moves;
}

export function applyMove(pos: Position, move: Move): Position {
  const piece = pieceAt(pos, move.from);
  if (!piece) throw new Error('起点没有棋子');

  const board = pos.board.map((row) => row.slice());
  const captured = board[move.to.rank][move.to.file];
  board[move.from.rank][move.from.file] = null;
  board[move.to.rank][move.to.file] = piece;

  return {
    board,
    sideToMove: opposite(pos.sideToMove),
    halfmoveClock: captured ? 0 : pos.halfmoveClock + 1,
    fullmoveNumber:
      pos.sideToMove === 'black' ? pos.fullmoveNumber + 1 : pos.fullmoveNumber,
  };
}

export function findKing(pos: Position, side: Side): Square {
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (piece && piece.type === 'K' && piece.side === side) {
        return square(file, rank);
      }
    }
  }
  throw new Error(`找不到${side === 'red' ? '红帅' : '黑将'}`);
}

export function generalsFace(pos: Position): boolean {
  const red = findKing(pos, 'red');
  const black = findKing(pos, 'black');
  if (red.file !== black.file) return false;

  const start = Math.min(red.rank, black.rank) + 1;
  const end = Math.max(red.rank, black.rank) - 1;
  for (let rank = start; rank <= end; rank += 1) {
    if (pos.board[rank][red.file]) return false;
  }
  return true;
}

export function isInCheck(pos: Position, side: Side): boolean {
  const king = findKing(pos, side);
  const enemy = opposite(side);
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (!piece || piece.side !== enemy) continue;
      const attacks = generatePseudoMoves(pos, square(file, rank));
      if (attacks.some((move) => sameSquare(move.to, king))) return true;
    }
  }
  return false;
}

export function generateLegalMoves(pos: Position): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece: Piece | null = pos.board[rank][file];
      if (!piece || piece.side !== pos.sideToMove) continue;
      for (const move of generatePseudoMoves(pos, square(file, rank))) {
        if (pos.board[move.to.rank][move.to.file]?.type === 'K') continue;
        const next = applyMove(pos, move);
        if (!isInCheck(next, piece.side) && !generalsFace(next)) {
          moves.push(move);
        }
      }
    }
  }
  return moves;
}