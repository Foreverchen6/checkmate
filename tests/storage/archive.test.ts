import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import {
  archiveFileName,
  listArchives,
  loadArchive,
  readArchiveFile,
  sanitizeSavedGame,
  saveArchive,
  writeArchiveFile,
} from '../../src/storage/archive.ts';
import {
  buildRecord,
  buildSavedGame,
  type SavedGame,
} from '../../src/storage/recordData.ts';

const tmpDir = join(process.cwd(), 'tests', '.tmp-archive');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sample(overrides: Partial<SavedGame> = {}): SavedGame {
  const game = new Game();
  const move = parseUciMove('b0c2');
  if (!move) throw new Error('bad move');
  game.move(move);
  return {
    ...buildSavedGame(
      game,
      'red',
      'entry',
      new Date('2026-11-19T02:30:45Z'),
      new Date('2026-11-19T02:31:00Z'),
    ),
    ...overrides,
  };
}

describe('存档存储', () => {
  it('保存、列出并载入未完成对局', () => {
    const archive = sample();
    expect(archive.result).toBeNull();

    const path = saveArchive(archive, tmpDir);
    const list = listArchives(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      file: path.split(/[\\/]/).at(-1),
      humanSide: 'red',
      difficulty: 'entry',
      moveCount: 1,
      result: null,
    });

    const loaded = loadArchive(list[0].file, tmpDir);
    expect(loaded.moves).toEqual(archive.moves);
    expect(loaded.savedAt).toBe(archive.savedAt);
  });

  it('同一秒保存多份不会覆盖', () => {
    const archive = sample();
    const first = saveArchive(archive, tmpDir);
    const second = saveArchive(archive, tmpDir);
    expect(second).not.toBe(first);
    expect(listArchives(tmpDir)).toHaveLength(2);
  });

  it('按保存时间倒序列出并跳过损坏文件', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'broken.json'), '{ not json', 'utf8');

    saveArchive(
      sample({
        savedAt: '2026-11-19T02:00:00Z',
      }),
      tmpDir,
    );
    saveArchive(
      sample({
        savedAt: '2026-11-19T03:00:00Z',
      }),
      tmpDir,
    );

    const list = listArchives(tmpDir);
    expect(list).toHaveLength(2);
    expect(list[0].savedAt).toBe('2026-11-19T03:00:00.000Z');
    expect(list[1].savedAt).toBe('2026-11-19T02:00:00.000Z');
  });

  it('拒绝越权文件名', () => {
    expect(() => loadArchive('../outside.json', tmpDir)).toThrow(/文件名/);
    expect(() => loadArchive('sub/inside.json', tmpDir)).toThrow(/文件名/);
  });

  it('拒绝不一致的结果与结束原因', () => {
    expect(() =>
      sanitizeSavedGame({ ...sample(), result: 'red_win', endReason: null }),
    ).toThrow(/不匹配/);
  });

  it('拒绝非法着法坐标', () => {
    const archive = sample();
    archive.moves[0].uci = 'z9z9';
    expect(() => sanitizeSavedGame(archive)).toThrow(/坐标/);
  });

  it('兼容自动保存的已结束棋谱', () => {
    const game = new Game();
    game.resign('red');
    const record = buildRecord(game, 'red', 'entry', new Date('2026-11-19T02:30:45Z'));
    const sanitized = sanitizeSavedGame(record);
    expect(sanitized.result).toBe('black_win');
    expect(sanitized.kind).toBe('xiangqi-save');
  });

  it('可导出到任意路径并读回', () => {
    const path = join(tmpDir, 'exported.json');
    mkdirSync(tmpDir, { recursive: true });
    const archive = sample();
    writeArchiveFile(path, archive);
    expect(readArchiveFile(path)).toEqual(archive);
  });

  it('文件名包含日期与时间', () => {
    expect(archiveFileName(new Date(2026, 10, 19, 9, 5, 7))).toBe('20261119-090507.json');
  });
});
