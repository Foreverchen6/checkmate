import type { Game } from '../game/game.ts';
import type { EndReason, GameResult, Side } from '../types.ts';
import { toUciMove } from '../notation/coords.ts';

export interface RecordedMove {
  ply: number;
  side: Side;
  uci: string;
  chinese: string;
}

export interface GameRecord {
  version: 1;
  startedAt: string;
  humanSide: Side;
  difficulty: string;
  result: GameResult;
  endReason: EndReason;
  initialFen: string;
  finalFen: string;
  moves: RecordedMove[];
}

export interface SavedGame {
  version: 1;
  kind?: 'xiangqi-save';
  startedAt: string;
  savedAt: string;
  humanSide: Side;
  difficulty: string;
  result: GameResult | null;
  endReason: EndReason | null;
  initialFen: string;
  finalFen: string;
  moves: RecordedMove[];
}

export interface ArchiveSummary {
  file: string;
  savedAt: string;
  humanSide: Side;
  difficulty: string;
  moveCount: number;
  result: GameResult | null;
}

function moveList(game: Game): RecordedMove[] {
  return game.history.map((entry) => ({
    ply: entry.ply,
    side: entry.side,
    uci: toUciMove(entry.move),
    chinese: entry.chinese,
  }));
}

export function buildSavedGame(
  game: Game,
  humanSide: Side,
  difficulty: string,
  startedAt: Date,
  savedAt = new Date(),
): SavedGame {
  return {
    version: 1,
    kind: 'xiangqi-save',
    startedAt: startedAt.toISOString(),
    savedAt: savedAt.toISOString(),
    humanSide,
    difficulty,
    result: game.result,
    endReason: game.endReason,
    initialFen: game.initialFen,
    finalFen: game.fen(),
    moves: moveList(game),
  };
}

export function buildRecord(
  game: Game,
  humanSide: Side,
  difficulty: string,
  startedAt: Date,
): GameRecord {
  if (!game.result || !game.endReason) {
    throw new Error('对局尚未结束，无法生成棋谱');
  }

  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    humanSide,
    difficulty,
    result: game.result,
    endReason: game.endReason,
    initialFen: game.initialFen,
    finalFen: game.fen(),
    moves: moveList(game),
  };
}