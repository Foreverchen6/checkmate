import { describe, expect, it } from 'vitest';
import {
  infoToCp,
  parseBestMove,
  parseInfoLine,
} from '../../src/engine/uci.ts';

describe('UCI 输出解析', () => {
  it('解析真实引擎的 multipv info 行', () => {
    const line =
      'info depth 3 seldepth 5 multipv 2 score cp 21 wdl 61 939 0 nodes 1003 nps 501500 hashfull 0 tbhits 0 time 2 pv h0g2 b7e7 b2e2';
    expect(parseInfoLine(line)).toEqual({
      multipv: 2,
      scoreCp: 21,
      mateIn: null,
      pv: ['h0g2', 'b7e7', 'b2e2'],
    });
  });

  it('解析将杀分', () => {
    const line =
      'info depth 4 multipv 1 score mate 3 nodes 1234 pv e0e1 e9d9';
    expect(parseInfoLine(line)).toEqual({
      multipv: 1,
      scoreCp: null,
      mateIn: 3,
      pv: ['e0e1', 'e9d9'],
    });
  });

  it('忽略不含评分的 info 行', () => {
    expect(parseInfoLine('info string NNUE evaluation using pikafish.nnue')).toBeNull();
  });

  it('解析 bestmove 与 (none)', () => {
    expect(parseBestMove('bestmove h2e2 ponder h9g7')).toBe('h2e2');
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 1')).toBeNull();
  });

  it('将杀分换算成可比较的 cp', () => {
    expect(infoToCp({ multipv: 1, scoreCp: null, mateIn: 3, pv: [] })).toBe(99700);
    expect(infoToCp({ multipv: 1, scoreCp: null, mateIn: -2, pv: [] })).toBe(-99800);
    expect(infoToCp({ multipv: 1, scoreCp: 35, mateIn: null, pv: [] })).toBe(35);
  });
});