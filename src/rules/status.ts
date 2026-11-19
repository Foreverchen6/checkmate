import type { Position } from '../types.ts';
import { generateLegalMoves, isInCheck } from './moves.ts';

export function hasAnyLegalMove(pos: Position): boolean {
  return generateLegalMoves(pos).length > 0;
}

export function isCheckmate(pos: Position): boolean {
  return isInCheck(pos, pos.sideToMove) && !hasAnyLegalMove(pos);
}

export function isStalemate(pos: Position): boolean {
  return !isInCheck(pos, pos.sideToMove) && !hasAnyLegalMove(pos);
}

export function isMoveLimitDraw(pos: Position): boolean {
  return pos.halfmoveClock >= 120;
}