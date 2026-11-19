import type { Side } from './types.ts';

export const TOTAL_POINTS = 200;
export const WIN_SCALE = 0.0007;
export const MISTAKE_LOSS = 8;
export const BLUNDER_LOSS = 20;

export type MoveLabel = 'good' | 'ok' | 'mistake' | 'blunder';

export interface Allocation {
  red: number;
  black: number;
}

export function winProbability(cp: number): number {
  return 1 / (1 + Math.exp(-WIN_SCALE * cp));
}

// cp 取自某一方的视角，返回该方在 200 分总分中的得分。
export function pointsFor(cp: number): number {
  return TOTAL_POINTS * winProbability(cp);
}

export function allocationOf(redCp: number): Allocation {
  const red = pointsFor(redCp);
  return { red, black: TOTAL_POINTS - red };
}

export function lossBetween(beforeCp: number, afterCp: number): number {
  return Math.max(0, pointsFor(beforeCp) - pointsFor(afterCp));
}

export function scoreLoss(beforeRed: number, afterRed: number, mover: Side): number {
  const before = mover === 'red' ? beforeRed : -beforeRed;
  const after = mover === 'red' ? afterRed : -afterRed;
  return lossBetween(before, after);
}

export function labelForLoss(loss: number): MoveLabel {
  if (loss < 3) return 'good';
  if (loss < MISTAKE_LOSS) return 'ok';
  if (loss < BLUNDER_LOSS) return 'mistake';
  return 'blunder';
}
