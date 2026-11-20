export type Side = 'red' | 'black';
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';

export interface Piece {
  readonly type: PieceType;
  readonly side: Side;
}

export interface Square {
  readonly file: number;
  readonly rank: number;
}

export interface Move {
  readonly from: Square;
  readonly to: Square;
}

export type Board = ReadonlyArray<ReadonlyArray<Piece | null>>;

export interface Position {
  readonly board: Board;
  readonly sideToMove: Side;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
}

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'move_limit'
  | 'repetition'
  | 'resign'
  | 'aborted'
  | 'timeout_step'
  | 'timeout_total'
  | 'disconnect'
  | 'agreement';

export type GameResult = 'red_win' | 'black_win' | 'draw' | 'aborted';

export const opposite = (side: Side): Side => (side === 'red' ? 'black' : 'red');

export const square = (file: number, rank: number): Square => ({ file, rank });

export const sameSquare = (a: Square, b: Square): boolean =>
  a.file === b.file && a.rank === b.rank;

export const sameMove = (a: Move, b: Move): boolean =>
  sameSquare(a.from, b.from) && sameSquare(a.to, b.to);