import type { Side } from '../types.ts';
import { allocationOf } from '../scoring.ts';

export function redCpOf(cp: number, side: Side): number {
  return side === 'red' ? cp : -cp;
}

export function redMateOf(mateIn: number | null, side: Side): number | null {
  if (mateIn === null) return null;
  return side === 'red' ? mateIn : -mateIn;
}

export function formatEval(redCp: number, redMate: number | null = null): string {
  if (redMate !== null) {
    return redMate > 0 ? '红 200 · 黑 0' : '红 0 · 黑 200';
  }
  const { red, black } = allocationOf(redCp);
  return `红 ${red.toFixed(1)} · 黑 ${black.toFixed(1)}`;
}

export function formatEvalDetail(
  redCp: number,
  redMate: number | null,
  nodes: number,
): string {
  const head =
    redMate !== null
      ? `${redMate > 0 ? '红' : '黑'}杀${Math.abs(redMate)}`
      : `红方 ${redCp >= 0 ? '+' : ''}${(redCp / 100).toFixed(2)} · 黑方 ${-redCp >= 0 ? '+' : ''}${(-redCp / 100).toFixed(2)}`;
  return `${formatEval(redCp, redMate)} · ${head} · 引擎 ${nodes} 节点`;
}
