import { describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../../src/config.ts';
import { PikafishEngine } from '../../src/engine/pikafish.ts';
import { INITIAL_FEN, parseFen } from '../../src/rules/board.ts';
import { generateLegalMoves } from '../../src/rules/moves.ts';
import { sameMove } from '../../src/types.ts';

describe('真实 Pikafish 引擎', () => {
  it(
    '完成握手、加载 NNUE 并返回合法着法',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const results = await engine.search(INITIAL_FEN, 2000, 1);
        expect(results.length).toBeGreaterThan(0);

        const legal = generateLegalMoves(parseFen(INITIAL_FEN));
        const best = results[0];
        expect(legal.some((move) => sameMove(move, best.move))).toBe(true);
        expect(best.pv.length).toBeGreaterThan(0);
      } finally {
        await engine.quit();
      }
    },
    30000,
  );

  it(
    'MultiPV 返回多条候选',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const results = await engine.search(INITIAL_FEN, 2000, 3);
        expect(results.length).toBeGreaterThan(1);
      } finally {
        await engine.quit();
      }
    },
    30000,
  );
});