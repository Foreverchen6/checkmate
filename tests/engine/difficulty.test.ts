import { describe, expect, it } from 'vitest';
import {
  DIFFICULTIES,
  selectEngineMove,
} from '../../src/engine/difficulty.ts';
import type { SearchResult } from '../../src/engine/pikafish.ts';

function result(cp: number, file: number): SearchResult {
  return {
    move: { from: { file, rank: 0 }, to: { file, rank: 1 } },
    scoreCp: cp,
    mateIn: null,
    pv: [],
    cp,
  };
}

describe('难度与选着', () => {
  it('三档难度参数固定', () => {
    expect(DIFFICULTIES[1]).toMatchObject({ name: 'beginner', nodes: 1000, multiPv: 4 });
    expect(DIFFICULTIES[2]).toMatchObject({ name: 'entry', nodes: 5000, multiPv: 3 });
    expect(DIFFICULTIES[3]).toMatchObject({ name: 'intermediate', nodes: 40000, multiPv: 1 });
  });

  it('非新手档直接选最佳着法', () => {
    const results = [result(100, 0), result(50, 1), result(0, 2)];
    expect(selectEngineMove(results, false)).toBe(results[0]);
  });

  it('新手档按评分加权仍可能选到非最佳着法', () => {
    const results = [result(100, 0), result(90, 1), result(80, 2)];
    const picked = selectEngineMove(results, true, () => 0.999);
    expect(results).toContain(picked);
  });

  it('空候选抛出错误', () => {
    expect(() => selectEngineMove([], true)).toThrow(/没有可选/);
  });
});