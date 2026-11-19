import type { Side } from '../types.ts';

export function redCpOf(cp: number, side: Side): number {
  return side === 'red' ? cp : -cp;
}

export function redMateOf(mateIn: number | null, side: Side): number | null {
  if (mateIn === null) return null;
  return side === 'red' ? mateIn : -mateIn;
}

export function cpLoss(beforeRed: number, afterRed: number, mover: Side): number {
  const before = mover === 'red' ? beforeRed : -beforeRed;
  const after = mover === 'red' ? afterRed : -afterRed;
  return Math.max(0, before - after);
}

export function formatEval(redCp: number, redMate: number | null = null): string {
  if (redMate !== null) {
    return `${redMate > 0 ? '红' : '黑'}杀${Math.abs(redMate)}`;
  }
  if (Math.abs(redCp) < 15) return '均势';
  const points = (Math.abs(redCp) / 100).toFixed(1);
  return redCp > 0 ? `红+${points} 黑-${points}` : `红-${points} 黑+${points}`;
}

export function formatEvalDetail(
  redCp: number,
  redMate: number | null,
  nodes: number,
): string {
  const head =
    redMate !== null
      ? `${formatEval(redCp, redMate)}`
      : `红方 ${redCp >= 0 ? '+' : ''}${(redCp / 100).toFixed(2)} · 黑方 ${-redCp >= 0 ? '+' : ''}${(-redCp / 100).toFixed(2)}`;
  return `${head} · 引擎 ${nodes} 节点`;
}