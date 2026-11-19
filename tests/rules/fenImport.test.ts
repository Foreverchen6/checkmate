import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import { validateFen } from '../../src/rules/fenImport.ts';

const MATE_FEN = 'R3k3R/4R4/9/9/9/9/9/9/9/4K4 b - - 0 1';

describe('FEN 局面导入', () => {
  it('接受初始局面', () => {
    const position = validateFen(INITIAL_FEN);
    expect(position.sideToMove).toBe('red');
  });

  it('接受自定义合法局面并规范化步数', () => {
    const position = validateFen('4k4/9/9/9/9/9/9/9/4A4/4K4 w - - x y');
    expect(position.halfmoveClock).toBe(0);
    expect(position.fullmoveNumber).toBe(1);
  });

  it('拒绝缺少将帅的局面', () => {
    expect(() => validateFen('3k5/9/9/9/9/9/9/9/9/9 w - - 0 1')).toThrow(/红帅/);
    expect(() => validateFen('9/9/9/9/9/9/9/9/9/4K4 w - - 0 1')).toThrow(/黑将/);
  });

  it('拒绝将帅不在九宫', () => {
    expect(() => validateFen('k8/9/9/9/9/9/9/9/9/4K4 w - - 0 1')).toThrow(/九宫/);
  });

  it('拒绝将帅照面', () => {
    expect(() => validateFen('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1')).toThrow(/照面/);
  });

  it('拒绝非行棋方被将军', () => {
    expect(() => validateFen(MATE_FEN.replace(' b ', ' w '))).toThrow(/非行棋方/);
  });

  it('拒绝无合法着法的终局局面', () => {
    expect(() => validateFen(MATE_FEN)).toThrow(/无合法着法/);
  });

  it('拒绝空输入', () => {
    expect(() => validateFen('   ')).toThrow(/不能为空/);
  });
});
