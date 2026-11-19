import type { Move, Square } from '../types.ts';

const FILE_CHARS = 'abcdefghi';

export function parseUciMove(text: string): Move | null {
  const normalized = text.trim().toLowerCase().replace(/-/g, '');
  const matched = /^([a-i])([0-9])([a-i])([0-9])$/.exec(normalized);
  if (!matched) return null;

  const from: Square = {
    file: FILE_CHARS.indexOf(matched[1]),
    rank: Number(matched[2]),
  };
  const to: Square = {
    file: FILE_CHARS.indexOf(matched[3]),
    rank: Number(matched[4]),
  };
  return { from, to };
}

export function toUciMove(move: Move): string {
  return `${FILE_CHARS[move.from.file]}${move.from.rank}${FILE_CHARS[move.to.file]}${move.to.rank}`;
}