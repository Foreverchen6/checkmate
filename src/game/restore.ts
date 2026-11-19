import { Game } from './game.ts';
import { parseUciMove } from '../notation/coords.ts';
import type { SavedGame } from '../storage/recordData.ts';

export function restoreGame(saved: SavedGame): Game {
  const game = new Game(saved.initialFen);

  saved.moves.forEach((recorded, index) => {
    const move = parseUciMove(recorded.uci);
    if (!move) throw new Error(`第 ${index + 1} 手坐标无效：${recorded.uci}`);
    try {
      game.move(move);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`第 ${index + 1} 手无法重放（${recorded.uci}）：${detail}`);
    }
  });

  if (game.fen() !== saved.finalFen) {
    throw new Error('重放局面与存档终局不一致');
  }

  if (saved.result !== null) {
    if (game.result !== null) {
      if (game.result !== saved.result || game.endReason !== saved.endReason) {
        throw new Error('存档结果与重放结果不一致');
      }
    } else {
      if (saved.endReason !== 'resign' && saved.endReason !== 'aborted') {
        throw new Error('存档结果与重放结果不一致');
      }
      game.result = saved.result;
      game.endReason = saved.endReason;
    }
  } else if (game.result !== null) {
    throw new Error('存档未记录结果，但重放已经分出胜负');
  }

  return game;
}
