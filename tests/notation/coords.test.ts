import { describe, expect, it } from 'vitest';
import { parseUciMove, toUciMove } from '../../src/notation/coords.ts';

describe('UCI 坐标', () => {
  it('解析 h2e2', () => {
    expect(parseUciMove('h2e2')).toEqual({
      from: { file: 7, rank: 2 },
      to: { file: 4, rank: 2 },
    });
  });

  it('接受 h2-e2 写法', () => {
    expect(parseUciMove('h2-e2')).not.toBeNull();
  });

  it('拒绝非法输入', () => {
    expect(parseUciMove('z9z9')).toBeNull();
    expect(parseUciMove('h10e2')).toBeNull();
  });

  it('可以往返转换', () => {
    const move = { from: { file: 1, rank: 0 }, to: { file: 2, rank: 2 } };
    expect(toUciMove(move)).toBe('b0c2');
    expect(parseUciMove('b0c2')).toEqual(move);
  });
});