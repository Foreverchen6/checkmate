import { describe, expect, it } from 'vitest';
import { initialPosition } from '../../src/rules/board.ts';
import { renderBoard } from '../../src/render/board.ts';

describe('棋盘渲染', () => {
  const text = renderBoard(initialPosition());

  it('包含双方棋子汉字', () => {
    for (const glyph of ['帅', '将', '车', '马', '炮', '兵', '卒', '相', '象', '仕', '士']) {
      expect(text).toContain(glyph);
    }
  });

  it('包含列标和行号', () => {
    expect(text).toContain('a  b  c  d  e  f  g  h  i');
    expect(text).toContain('9  ');
    expect(text).toContain('0  ');
  });

  it('渲染为 12 行', () => {
    expect(text.split('\n')).toHaveLength(12);
  });
});