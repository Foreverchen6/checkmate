import type { Move, PieceType, Position, Side } from '../types.ts';
import { generateLegalMoves } from '../rules/moves.ts';
import { pieceAt } from '../rules/board.ts';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

const PIECE_NAMES: Record<Side, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};

export function fileNumber(side: Side, file: number): number {
  return side === 'red' ? 9 - file : file + 1;
}

function formatNumber(side: Side, value: number): string {
  return side === 'red' ? CN_DIGITS[value] : String(value);
}

function prefixLabel(index: number, count: number): string {
  if (count === 2) return index === 0 ? '前' : '后';
  if (count === 3) return ['前', '中', '后'][index];
  if (index === 0) return '前';
  if (index === count - 1) return '后';
  return CN_DIGITS[index + 1];
}

export function chineseNotation(pos: Position, move: Move): string {
  const piece = pieceAt(pos, move.from);
  if (!piece) throw new Error('起点没有棋子');

  const sameFile: number[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    const other = pos.board[rank][move.from.file];
    if (other && other.side === piece.side && other.type === piece.type) {
      sameFile.push(rank);
    }
  }

  let prefix = '';
  if (sameFile.length > 1) {
    sameFile.sort((a, b) => (piece.side === 'red' ? b - a : a - b));
    const index = sameFile.indexOf(move.from.rank);
    prefix = prefixLabel(index, sameFile.length);
  }

  const names = PIECE_NAMES[piece.side];
  const head = prefix
    ? `${prefix}${names[piece.type]}`
    : `${names[piece.type]}${formatNumber(piece.side, fileNumber(piece.side, move.from.file))}`;

  if (move.from.rank === move.to.rank) {
    return `${head}平${formatNumber(piece.side, fileNumber(piece.side, move.to.file))}`;
  }

  const isForward =
    piece.side === 'red' ? move.to.rank > move.from.rank : move.to.rank < move.from.rank;
  const action = isForward ? '进' : '退';
  const isDiagonalMover = piece.type === 'N' || piece.type === 'B' || piece.type === 'A';
  const amount = isDiagonalMover
    ? fileNumber(piece.side, move.to.file)
    : Math.abs(move.to.rank - move.from.rank);

  return `${head}${action}${formatNumber(piece.side, amount)}`;
}

export function generateChineseMoves(
  pos: Position,
): Array<{ move: Move; text: string }> {
  return generateLegalMoves(pos).map((move) => ({
    move,
    text: chineseNotation(pos, move),
  }));
}

const DIGIT_MAP: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

function normalizeChinese(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[一二三四五六七八九]/g, (ch) => DIGIT_MAP[ch]);
}

export function parseChineseMove(pos: Position, input: string): Move | null {
  const normalized = normalizeChinese(input);
  for (const candidate of generateChineseMoves(pos)) {
    if (normalizeChinese(candidate.text) === normalized) return candidate.move;
  }
  return null;
}