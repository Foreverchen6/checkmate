import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { buildRecord, saveRecord } from '../../src/storage/records.ts';

const tmpDir = join(process.cwd(), 'tests', '.tmp-records');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('棋谱存储', () => {
  it('未结束的对局不能生成棋谱', () => {
    const game = new Game();
    expect(() => buildRecord(game, 'red', 'entry', new Date())).toThrow(/尚未结束/);
  });

  it('认输后生成并写入棋谱', () => {
    const game = new Game();
    game.move(parseUciMove('b0c2')!);
    game.resign('red');

    const record = buildRecord(game, 'red', 'entry', new Date('2026-11-19T10:30:45+08:00'));
    expect(record.result).toBe('black_win');
    expect(record.endReason).toBe('resign');
    expect(record.moves).toHaveLength(1);
    expect(record.moves[0]).toMatchObject({
      ply: 1,
      side: 'red',
      uci: 'b0c2',
      chinese: '马八进七',
    });

    const path = saveRecord(record, tmpDir);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.initialFen).toBe(record.initialFen);
    expect(saved.finalFen).toBe(record.finalFen);
    expect(saved.moves).toEqual(record.moves);
  });

  it('同一秒内连续保存不会覆盖', () => {
    const game = new Game();
    game.resign('red');
    const record = buildRecord(game, 'red', 'entry', new Date('2026-11-19T10:30:45+08:00'));
    const first = saveRecord(record, tmpDir);
    const second = saveRecord(record, tmpDir);
    expect(second).not.toBe(first);
  });
});