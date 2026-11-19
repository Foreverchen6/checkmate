import type { EndReason, GameResult, Move, Position, Side } from '../types.ts';
import { opposite, sameMove } from '../types.ts';
import { INITIAL_FEN, parseFen, positionKey, toFen } from '../rules/board.ts';
import { applyMove, generateLegalMoves } from '../rules/moves.ts';
import { isCheckmate, isMoveLimitDraw, isStalemate } from '../rules/status.ts';
import { chineseNotation } from '../notation/chinese.ts';

export class IllegalMoveError extends Error {}

export interface HistoryEntry {
  readonly positionBefore: Position;
  readonly move: Move;
  readonly side: Side;
  readonly ply: number;
  readonly chinese: string;
}

export class Game {
  readonly initialFen: string;
  private readonly states: Position[];
  private readonly entries: HistoryEntry[] = [];
  result: GameResult | null = null;
  endReason: EndReason | null = null;

  constructor(fen: string = INITIAL_FEN) {
    this.initialFen = fen;
    this.states = [parseFen(fen)];
  }

  get position(): Position {
    return this.states[this.states.length - 1];
  }

  get history(): readonly HistoryEntry[] {
    return this.entries;
  }

  legalMoves(): Move[] {
    return generateLegalMoves(this.position);
  }

  isLegal(move: Move): boolean {
    return this.legalMoves().some((candidate) => sameMove(candidate, move));
  }

  move(move: Move): HistoryEntry {
    if (this.result) throw new IllegalMoveError('对局已结束');
    if (!this.isLegal(move)) throw new IllegalMoveError('非法着法');

    const before = this.position;
    const chinese = chineseNotation(before, move);
    const after = applyMove(before, move);
    const entry: HistoryEntry = {
      positionBefore: before,
      move,
      side: before.sideToMove,
      ply: this.entries.length + 1,
      chinese,
    };

    this.states.push(after);
    this.entries.push(entry);
    this.updateOutcome(after);
    return entry;
  }

  undo(plies = 2): number {
    if (this.entries.length === 0) return 0;
    const count = Math.min(plies, this.entries.length);
    this.entries.splice(this.entries.length - count, count);
    this.states.splice(this.states.length - count, count);
    this.result = null;
    this.endReason = null;
    return count;
  }

  resign(loser: Side): void {
    if (this.result) return;
    this.result = loser === 'red' ? 'black_win' : 'red_win';
    this.endReason = 'resign';
  }

  abort(): void {
    if (this.result) return;
    this.result = 'aborted';
    this.endReason = 'aborted';
  }

  fen(): string {
    return toFen(this.position);
  }

  private updateOutcome(after: Position): void {
    const winner = opposite(after.sideToMove);

    if (isCheckmate(after)) {
      this.result = winner === 'red' ? 'red_win' : 'black_win';
      this.endReason = 'checkmate';
      return;
    }

    if (isStalemate(after)) {
      this.result = winner === 'red' ? 'red_win' : 'black_win';
      this.endReason = 'stalemate';
      return;
    }

    if (isMoveLimitDraw(after)) {
      this.result = 'draw';
      this.endReason = 'move_limit';
      return;
    }

    const key = positionKey(after);
    const occurrences = this.states.filter((state) => positionKey(state) === key).length;
    if (occurrences >= 3) {
      this.result = 'draw';
      this.endReason = 'repetition';
    }
  }
}