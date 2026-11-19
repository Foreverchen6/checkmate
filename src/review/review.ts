import type { SearchResult } from '../engine/pikafish.ts';
import type { Game } from '../game/game.ts';
import type { Move, Position, Side } from '../types.ts';
import { toFen } from '../rules/board.ts';
import { applyMove } from '../rules/moves.ts';
import { chineseNotation } from '../notation/chinese.ts';
import { toUciMove } from '../notation/coords.ts';
import { BLUNDER_LOSS, labelForLoss, lossBetween, type MoveLabel } from '../scoring.ts';

export interface Searcher {
  search(
    fen: string,
    nodes: number,
    multiPv?: number,
    timeoutMs?: number,
  ): Promise<SearchResult[]>;
}

export interface AnalyzedMove {
  ply: number;
  side: Side;
  uci: string;
  chinese: string;
  bestUci: string;
  bestChinese: string;
  loss: number;
  label: MoveLabel;
  pvChinese: string;
}

export interface ReviewReport {
  moves: AnalyzedMove[];
  mistakes: number;
  blunders: number;
  avgLoss: number;
  worst: AnalyzedMove[];
}

function pvToChinese(start: Position, pv: Move[]): string {
  let position = start;
  const parts: string[] = [];
  for (const move of pv.slice(0, 6)) {
    try {
      parts.push(chineseNotation(position, move));
      position = applyMove(position, move);
    } catch {
      break;
    }
  }
  return parts.join(' ');
}

export async function reviewGame(
  engine: Searcher,
  game: Game,
  humanSide: Side,
  nodes = 300000,
  onProgress?: (done: number, total: number) => void,
): Promise<ReviewReport> {
  const analyzed: AnalyzedMove[] = [];
  const total = game.history.filter((entry) => entry.side === humanSide).length;
  onProgress?.(0, total);

  for (const entry of game.history) {
    if (entry.side !== humanSide) continue;

    const [best] = await engine.search(toFen(entry.positionBefore), nodes, 1);
    const after = applyMove(entry.positionBefore, entry.move);
    const [afterResult] = await engine.search(toFen(after), nodes, 1);

    const bestCp = best.cp;
    const actualCp = -afterResult.cp;
    let loss = lossBetween(bestCp, actualCp);
    let label = labelForLoss(loss);

    const bestIsMate = best.mateIn !== null && best.mateIn > 0;
    const actualAllowsMate = afterResult.mateIn !== null && afterResult.mateIn > 0;
    if ((bestIsMate && actualCp < 90000) || actualAllowsMate) {
      loss = Math.max(loss, BLUNDER_LOSS);
      label = 'blunder';
    }

    analyzed.push({
      ply: entry.ply,
      side: entry.side,
      uci: toUciMove(entry.move),
      chinese: entry.chinese,
      bestUci: toUciMove(best.move),
      bestChinese: chineseNotation(entry.positionBefore, best.move),
      loss,
      label,
      pvChinese: pvToChinese(entry.positionBefore, best.pv),
    });
    onProgress?.(analyzed.length, total);
  }

  const mistakes = analyzed.filter((move) => move.label === 'mistake').length;
  const blunders = analyzed.filter((move) => move.label === 'blunder').length;
  const avgLoss = analyzed.length
    ? analyzed.reduce((sum, move) => sum + move.loss, 0) / analyzed.length
    : 0;
  const worst = [...analyzed].sort((a, b) => b.loss - a.loss).slice(0, 3);

  return { moves: analyzed, mistakes, blunders, avgLoss, worst };
}