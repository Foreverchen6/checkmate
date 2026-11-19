import { describe, expect, it } from 'vitest';
import {
  formatEval,
  formatEvalDetail,
  redCpOf,
  redMateOf,
} from '../../src/ui/evalText.ts';

describe('实时评估文本', () => {
  it('把引擎视角的分数换算成红方视角', () => {
    expect(redCpOf(50, 'red')).toBe(50);
    expect(redCpOf(50, 'black')).toBe(-50);
  });

  it('换算将杀步数', () => {
    expect(redMateOf(3, 'red')).toBe(3);
    expect(redMateOf(3, 'black')).toBe(-3);
    expect(redMateOf(null, 'black')).toBeNull();
  });

  it('显示总分为 200 的双方分数', () => {
    expect(formatEval(0)).toBe('红 100.0 · 黑 100.0');
    expect(formatEval(500)).toBe('红 117.3 · 黑 82.7');
    expect(formatEval(-120)).toBe('红 95.8 · 黑 104.2');
  });

  it('将杀时显示满分为一方所有', () => {
    expect(formatEval(99800, 3)).toBe('红 200 · 黑 0');
    expect(formatEval(-99800, -2)).toBe('红 0 · 黑 200');
  });

  it('详细文本同时包含双方分数与节点数', () => {
    expect(formatEvalDetail(40, null, 120000)).toBe(
      '红 101.4 · 黑 98.6 · 红方 +0.40 · 黑方 -0.40 · 引擎 120000 节点',
    );
    expect(formatEvalDetail(-45, null, 120000)).toBe(
      '红 98.4 · 黑 101.6 · 红方 -0.45 · 黑方 +0.45 · 引擎 120000 节点',
    );
    expect(formatEvalDetail(0, 3, 120000)).toBe(
      '红 200 · 黑 0 · 红杀3 · 引擎 120000 节点',
    );
  });
});