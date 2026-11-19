import { describe, expect, it } from 'vitest';
import { Game } from '../../src/game/game.ts';
import { PikafishEngine } from '../../src/engine/pikafish.ts';
import { loadConfig, parseArgs } from '../../src/config.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { reviewGame } from '../../src/review/review.ts';
import { labelForLoss } from '../../src/scoring.ts';

describe('复盘分级', () => {
  it('按丢分分级', () => {
    expect(labelForLoss(0)).toBe('good');
    expect(labelForLoss(2.9)).toBe('good');
    expect(labelForLoss(3)).toBe('ok');
    expect(labelForLoss(7.9)).toBe('ok');
    expect(labelForLoss(8)).toBe('mistake');
    expect(labelForLoss(19.9)).toBe('mistake');
    expect(labelForLoss(20)).toBe('blunder');
  });
});

describe('真实引擎复盘', () => {
  it(
    '对人类的每一手生成分析',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const game = new Game();
        for (const uci of ['b0c2', 'b9c7', 'h0g2', 'h9g7']) {
          const move = parseUciMove(uci);
          if (!move) throw new Error(`bad uci: ${uci}`);
          game.move(move);
        }

        const report = await reviewGame(engine, game, 'red', 2000);
        expect(report.moves).toHaveLength(2);
        expect(report.avgLoss).toBeGreaterThanOrEqual(0);
        expect(report.worst.length).toBeLessThanOrEqual(3);

        for (const move of report.moves) {
          expect(move.chinese.length).toBeGreaterThan(0);
          expect(move.bestChinese.length).toBeGreaterThan(0);
          expect(['good', 'ok', 'mistake', 'blunder']).toContain(move.label);
        }
      } finally {
        await engine.quit();
      }
    },
    30000,
  );
});