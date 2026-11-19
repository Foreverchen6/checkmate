import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Writable } from 'node:stream';
import type { Move } from '../types.ts';
import { parseUciMove } from '../notation/coords.ts';
import {
  infoToCp,
  parseBestMove,
  parseInfoLine,
  type SearchInfo,
} from './uci.ts';

export interface EngineConfig {
  pikafishPath: string;
  evalFile: string;
  threads: number;
  hashMb: number;
}

export interface SearchResult {
  move: Move;
  scoreCp: number | null;
  mateIn: number | null;
  pv: Move[];
  cp: number;
}

export class EngineTimeoutError extends Error {}

export class PikafishEngine {
  private readonly config: EngineConfig;
  private readonly proc: ChildProcess;
  private readonly stdin: Writable;
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  private exited = false;

  private constructor(
    config: EngineConfig,
    proc: ChildProcess,
    stdin: Writable,
    rl: Interface,
  ) {
    this.config = config;
    this.proc = proc;
    this.stdin = stdin;
    this.rl = rl;

    this.rl.on('line', (line) => this.onLine(line));
    this.proc.on('exit', () => {
      this.exited = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()!('__EXIT__');
      }
    });
  }

  static async start(config: EngineConfig): Promise<PikafishEngine> {
    const exe = resolve(config.pikafishPath);
    const proc = spawn(exe, [], {
      cwd: dirname(exe),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdin = proc.stdin;
    const stdout = proc.stdout;
    if (!stdin || !stdout) {
      proc.kill();
      throw new Error('无法建立引擎管道');
    }

    const rl = createInterface({ input: stdout });
    const engine = new PikafishEngine(config, proc, stdin, rl);

    try {
      engine.send('uci');
      const handshake: string[] = [];
      await engine.readUntil(
        (line) => line === 'uciok',
        5000,
        (line) => handshake.push(line),
      );
      if (!handshake.some((line) => line.startsWith('option name EvalFile'))) {
        throw new Error('当前引擎不支持 EvalFile 选项');
      }

      engine.send(`setoption name EvalFile value ${resolve(config.evalFile)}`);
      engine.send(`setoption name Threads value ${config.threads}`);
      engine.send(`setoption name Hash value ${config.hashMb}`);
      engine.send('isready');
      await engine.readUntil((line) => line === 'readyok', 20000);
      return engine;
    } catch (error) {
      engine.kill();
      rl.close();
      throw error;
    }
  }

  async search(
    fen: string,
    nodes: number,
    multiPv = 1,
    timeoutMs = 15000,
  ): Promise<SearchResult[]> {
    this.send(`setoption name MultiPV value ${multiPv}`);
    this.send(`position fen ${fen}`);
    this.send(`go nodes ${nodes}`);

    const infos = new Map<number, SearchInfo>();
    const bestLine = await this.readUntil(
      (line) => line.startsWith('bestmove'),
      timeoutMs,
      (line) => {
        const info = parseInfoLine(line);
        if (info) infos.set(info.multipv, info);
      },
    );

    const bestUci = parseBestMove(bestLine);
    if (!bestUci) throw new Error('引擎未返回合法着法');

    const results: SearchResult[] = [];
    const ordered = [...infos.entries()].sort((a, b) => a[0] - b[0]);
    for (const [multipv, info] of ordered) {
      const pv = info.pv
        .map((token) => parseUciMove(token))
        .filter((move): move is Move => move !== null);
      const move = pv[0] ?? (multipv === 1 ? parseUciMove(bestUci) : null);
      if (!move) continue;
      results.push({
        move,
        scoreCp: info.scoreCp,
        mateIn: info.mateIn,
        pv,
        cp: infoToCp(info),
      });
    }

    if (results.length === 0) {
      const fallback = parseUciMove(bestUci);
      if (!fallback) throw new Error('无法解析引擎着法');
      results.push({
        move: fallback,
        scoreCp: null,
        mateIn: null,
        pv: [fallback],
        cp: 0,
      });
    }

    return results;
  }

  async quit(): Promise<void> {
    if (this.exited) {
      this.rl.close();
      return;
    }
    this.send('quit');
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.kill();
        resolvePromise();
      }, 2000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    this.rl.close();
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }

  private send(command: string): void {
    if (this.exited) throw new Error('引擎进程已退出');
    this.stdin.write(`${command}\n`);
  }

  private onLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  private async nextLine(deadline: number): Promise<string> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.exited) throw new Error('引擎进程已退出');

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.kill();
      throw new EngineTimeoutError('引擎计算超时');
    }

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.kill();
        rejectPromise(new EngineTimeoutError('引擎计算超时'));
      }, remaining);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolvePromise(line);
      });
    });
  }

  private async readUntil(
    isEnd: (line: string) => boolean,
    timeoutMs: number,
    onLine?: (line: string) => void,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const line = await this.nextLine(deadline);
      if (line === '__EXIT__') throw new Error('引擎进程已退出');
      if (isEnd(line)) return line;
      onLine?.(line);
    }
  }
}