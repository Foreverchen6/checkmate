import { describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../src/config.ts';

describe('CLI 参数', () => {
  it('解析默认值', () => {
    const args = parseArgs([]);
    expect(args.side).toBe('red');
    expect(args.level).toBe(2);
    expect(args.review).toBe(true);
  });

  it('解析显式参数', () => {
    const args = parseArgs(['--side', 'black', '--level', '3', '--no-review']);
    expect(args.side).toBe('black');
    expect(args.level).toBe(3);
    expect(args.review).toBe(false);
  });

  it('拒绝非法参数', () => {
    expect(() => parseArgs(['--level', '9'])).toThrow(/1、2、3/);
    expect(() => parseArgs(['--side', 'blue'])).toThrow(/red 或 black/);
    expect(() => parseArgs(['--unknown'])).toThrow(/未知参数/);
  });
});

describe('配置加载', () => {
  it('默认指向项目根目录的引擎与 NNUE', () => {
    const config = loadConfig(parseArgs([]), process.cwd(), {});
    expect(config.pikafishPath.endsWith('Pikafish-Windows-x86-64-universal.exe')).toBe(true);
    expect(config.evalFile.endsWith('pikafish.nnue')).toBe(true);
  });

  it('环境变量覆盖路径', () => {
    const config = loadConfig(parseArgs([]), process.cwd(), {
      PIKAFISH_PATH: 'D:/engines/test-engine.exe',
      PIKAFISH_EVAL_FILE: 'D:/engines/test.nnue',
    });
    expect(config.pikafishPath.endsWith('test-engine.exe')).toBe(true);
    expect(config.evalFile.endsWith('test.nnue')).toBe(true);
  });
});