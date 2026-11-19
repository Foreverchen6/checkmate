import { describe, expect, it } from 'vitest';
import {
  TOTAL_POINTS,
  allocationOf,
  labelForLoss,
  scoreLoss,
  winProbability,
} from '../src/scoring.ts';

describe('胜率评分', () => {
  it('均势时胜率为一半且两方各 100 分', () => {
    expect(winProbability(0)).toBe(0.5);
    const allocation = allocationOf(0);
    expect(allocation.red).toBeCloseTo(100, 6);
    expect(allocation.black).toBeCloseTo(100, 6);
    expect(allocation.red + allocation.black).toBeCloseTo(TOTAL_POINTS, 6);
  });

  it('红方多一马时约为 163 比 37', () => {
    const allocation = allocationOf(2100);
    expect(allocation.red).toBeCloseTo(162.6, 1);
    expect(allocation.black).toBeCloseTo(37.4, 1);
  });

  it('红方少一车时约为 7 比 193', () => {
    const allocation = allocationOf(-4660);
    expect(allocation.red).toBeCloseTo(7.4, 1);
    expect(allocation.black).toBeCloseTo(192.6, 1);
  });

  it('红黑胜率互补', () => {
    for (const cp of [-5000, -800, 0, 120, 4600]) {
      expect(winProbability(cp) + winProbability(-cp)).toBeCloseTo(1, 9);
    }
  });
});

describe('丢分计算', () => {
  it('从均势丢一马约丢 63 分', () => {
    const loss = scoreLoss(0, -2100, 'red');
    expect(loss).toBeCloseTo(62.6, 1);
    expect(labelForLoss(loss)).toBe('blunder');
  });

  it('劣势局面中的搜索噪声只丢不到 3 分', () => {
    const loss = scoreLoss(-4658, -4682, 'red');
    expect(loss).toBeLessThan(3);
    expect(labelForLoss(loss)).toBe('good');
  });

  it('黑方视角同样按丢分计算', () => {
    const loss = scoreLoss(4658, 4682, 'black');
    expect(loss).toBeLessThan(3);
    expect(labelForLoss(loss)).toBe('good');
  });

  it('走出更好的着法时丢分为零', () => {
    expect(scoreLoss(0, 500, 'red')).toBe(0);
    expect(scoreLoss(-500, -1000, 'black')).toBe(0);
  });
});

describe('质量标签', () => {
  it('按丢分阈值分级', () => {
    expect(labelForLoss(0)).toBe('good');
    expect(labelForLoss(2.9)).toBe('good');
    expect(labelForLoss(3)).toBe('ok');
    expect(labelForLoss(7.9)).toBe('ok');
    expect(labelForLoss(8)).toBe('mistake');
    expect(labelForLoss(19.9)).toBe('mistake');
    expect(labelForLoss(20)).toBe('blunder');
  });
});
