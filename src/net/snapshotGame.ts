import { Game } from '../game/game.ts';
import { parseUciMove } from '../notation/coords.ts';
import type { OnlineSnapshot } from './protocol.ts';

export function gameFromSnapshot(snapshot: OnlineSnapshot): Game {
  const game = new Game(snapshot.initialFen);

  snapshot.moves.forEach((uci, index) => {
    const move = parseUciMove(uci);
    if (!move) throw new Error(`第 ${index + 1} 手坐标无效：${uci}`);
    try {
      game.move(move);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`第 ${index + 1} 手无法重放（${uci}）：${detail}`);
    }
  });

  if (snapshot.result !== null) {
    game.result = snapshot.result;
    game.endReason = snapshot.endReason;
  }

  return game;
}