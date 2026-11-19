import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Side } from './types.ts';
import type { Level } from './engine/difficulty.ts';

export interface AppConfig {
  pikafishPath: string;
  evalFile: string;
  threads: number;
  hashMb: number;
}

export interface CliArgs {
  side: Side;
  level: Level;
  configPath: string | null;
  review: boolean;
}

const DEFAULTS: AppConfig = {
  pikafishPath: './Pikafish-Windows-x86-64-universal.exe',
  evalFile: './pikafish.nnue',
  threads: 1,
  hashMb: 64,
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    side: 'red',
    level: 2,
    configPath: null,
    review: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--side') {
      const value = argv[index + 1];
      if (value !== 'red' && value !== 'black') {
        throw new Error('--side 只能是 red 或 black');
      }
      args.side = value;
      index += 1;
    } else if (token === '--level') {
      const value = Number(argv[index + 1]);
      if (value !== 1 && value !== 2 && value !== 3) {
        throw new Error('--level 只能是 1、2、3');
      }
      args.level = value as Level;
      index += 1;
    } else if (token === '--config') {
      args.configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--no-review') {
      args.review = false;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }

  return args;
}

export function loadConfig(
  args: CliArgs,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const file = args.configPath
    ? resolve(cwd, args.configPath)
    : resolve(cwd, 'config.json');

  let fromFile: Partial<AppConfig> = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
  }

  const merged: AppConfig = { ...DEFAULTS, ...fromFile };
  if (env.PIKAFISH_PATH) merged.pikafishPath = env.PIKAFISH_PATH;
  if (env.PIKAFISH_EVAL_FILE) merged.evalFile = env.PIKAFISH_EVAL_FILE;

  return {
    pikafishPath: resolve(cwd, merged.pikafishPath),
    evalFile: resolve(cwd, merged.evalFile),
    threads: Number(merged.threads),
    hashMb: Number(merged.hashMb),
  };
}