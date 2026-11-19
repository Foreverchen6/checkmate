import { opposite, type Position, type Side } from '../types.ts';
import { parseFen } from './board.ts';
import {
  findKing,
  generateLegalMoves,
  generalsFace,
  isInCheck,
} from './moves.ts';

function inPalace(file: number, rank: number, side: Side): boolean {
  if (file < 3 || file > 5) return false;
  return side === 'red' ? rank >= 0 && rank <= 2 : rank >= 7 && rank <= 9;
}

export function validateFen(fen: string): Position {
  if (typeof fen !== 'string' || fen.trim() === '') {
    throw new Error('FEN 不能为空');
  }

  const position = parseFen(fen);

  let redKings = 0;
  let blackKings = 0;
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = position.board[rank][file];
      if (piece?.type !== 'K') continue;
      if (piece.side === 'red') redKings += 1;
      else blackKings += 1;
    }
  }
  if (redKings !== 1) throw new Error('局面必须恰好有一个红帅');
  if (blackKings !== 1) throw new Error('局面必须恰好有一个黑将');

  const redKing = findKing(position, 'red');
  const blackKing = findKing(position, 'black');
  if (!inPalace(redKing.file, redKing.rank, 'red')) throw new Error('红帅不在九宫内');
  if (!inPalace(blackKing.file, blackKing.rank, 'black')) throw new Error('黑将不在九宫内');

  if (generalsFace(position)) throw new Error('将帅照面，局面非法');
  if (isInCheck(position, opposite(position.sideToMove))) {
    throw new Error('非行棋方正在被将军，局面非法');
  }
  if (generateLegalMoves(position).length === 0) {
    throw new Error('该局面行棋方无合法着法');
  }

  return {
    ...position,
    halfmoveClock:
      Number.isInteger(position.halfmoveClock) && position.halfmoveClock >= 0
        ? position.halfmoveClock
        : 0,
    fullmoveNumber:
      Number.isInteger(position.fullmoveNumber) && position.fullmoveNumber >= 1
        ? position.fullmoveNumber
        : 1,
  };
}
