import { describe, expect, it } from 'vitest';
import {
  cpLoss,
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

  it('计算走子方损失并归一为非负值', () => {
    expect(cpLoss(30, 10, 'red')).toBe(20);
    expect(cpLoss(-30, -10, 'black')).toBe(20);
    expect(cpLoss(10, 30, 'red')).toBe(0);
    expect(cpLoss(-10, -30, 'black')).toBe(0);
  });

  it('显示双方分数', () => {
    expect(formatEval(0)).toBe('均势');
    expect(formatEval(8)).toBe('均势');
    expect(formatEval(40)).toBe('红+0.4 黑-0.4');
    expect(formatEval(-120)).toBe('红-1.2 黑+1.2');
  });

  it('显示将杀信息', () => {
    expect(formatEval(99800, 3)).toBe('红杀3');
    expect(formatEval(-99800, -2)).toBe('黑杀2');
  });

  it('详细文本同时包含双方分数与节点数', () => {
    expect(formatEvalDetail(40, null, 120000)).toBe(
      '红方 +0.40 · 黑方 -0.40 · 引擎 120000 节点',
    );
    expect(formatEvalDetail(-45, null, 120000)).toBe(
      '红方 -0.45 · 黑方 +0.45 · 引擎 120000 节点',
    );
    expect(formatEvalDetail(0, 3, 120000)).toBe('红杀3 · 引擎 120000 节点');
  });
});