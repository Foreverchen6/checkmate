import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline';
import type { Move, Side } from './types.ts';
import { loadConfig, parseArgs } from './config.ts';
import { Game, IllegalMoveError } from './game/game.ts';
import {
  EngineTimeoutError,
  PikafishEngine,
  type EngineConfig,
  type SearchResult,
} from './engine/pikafish.ts';
import { DIFFICULTIES, selectEngineMove } from './engine/difficulty.ts';
import { renderBoard } from './render/board.ts';
import { parseUciMove, toUciMove } from './notation/coords.ts';
import { chineseNotation, parseChineseMove } from './notation/chinese.ts';
import { reviewGame, type ReviewReport } from './review/review.ts';
import { buildRecord, saveRecord } from './storage/records.ts';

const LABEL_NAMES = {
  good: '好棋',
  ok: '可接受',
  mistake: '失误',
  blunder: '漏着',
} as const;

function resultText(game: Game, humanSide: Side): string {
  if (game.result === 'draw') return '和棋';
  if (game.result === 'aborted') return '对局中止';
  const humanWon = game.result === (humanSide === 'red' ? 'red_win' : 'black_win');
  return humanWon ? '你赢了' : '你输了';
}

function printReview(report: ReviewReport): void {
  console.log('\n===== 复盘报告 =====');
  for (const move of report.moves) {
    console.log(
      `第 ${move.ply} 手 ${move.side === 'red' ? '红' : '黑'} ${move.chinese}：` +
        `损失 ${move.loss}cp（${LABEL_NAMES[move.label]}），推荐 ${move.bestChinese}`,
    );
    if (move.pvChinese) console.log(`    变化：${move.pvChinese}`);
  }
  console.log(
    `汇总：失误 ${report.mistakes}，漏着 ${report.blunders}，平均损失 ${report.acpl}cp`,
  );
  if (report.worst.length > 0) {
    console.log('重点改进：');
    for (const move of report.worst) {
      console.log(
        `  第 ${move.ply} 手 ${move.chinese} → ${move.bestChinese}（损失 ${move.loss}cp）`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  const pending: Array<(line: string | null) => void> = [];
  let inputClosed = false;

  rl.on('line', (line) => {
    const resolve = pending.shift();
    if (resolve) resolve(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    while (pending.length > 0) pending.shift()!(null);
  });

  const ask = (question: string): Promise<string | null> => {
    output.write(question);
    if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => pending.push(resolve));
  };

  const humanSide = args.side;
  const difficulty = DIFFICULTIES[args.level];
  const startedAt = new Date();
  const game = new Game();

  let engine: PikafishEngine;
  try {
    engine = await PikafishEngine.start(config);
  } catch (error) {
    console.error(
      '无法启动 Pikafish：',
      error instanceof Error ? error.message : error,
    );
    console.error(`引擎路径：${config.pikafishPath}`);
    console.error(`权重路径：${config.evalFile}`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  const restart = async (engineConfig: EngineConfig) => {
    await engine.quit().catch(() => undefined);
    engine = await PikafishEngine.start(engineConfig);
  };

  const persist = () => {
    if (!game.result) return;
    const record = buildRecord(game, humanSide, difficulty.name, startedAt);
    try {
      const path = saveRecord(record);
      console.log(`棋谱已保存：${path}`);
    } catch (error) {
      console.error(
        '棋谱写入失败，以下为完整 JSON：',
        error instanceof Error ? error.message : error,
      );
      console.log(JSON.stringify(record, null, 2));
    }
  };

  try {
    console.log(
      `Pikafish 已就绪。你执${humanSide === 'red' ? '红' : '黑'}，难度：${difficulty.name}`,
    );
    console.log('命令：着法（如 h2e2 或 炮二平五）、hint、undo、resign、quit');

    while (!game.result) {
      console.log('');
      console.log(renderBoard(game.position));

      if (game.position.sideToMove === humanSide) {
        const line = await ask(
          `${humanSide === 'red' ? '红方' : '黑方'}走棋（着法 / hint / undo / resign / quit）> `,
        );
        if (line === null) {
          game.abort();
          break;
        }
        const answer = line.trim();

        if (!answer) continue;
        if (answer === 'quit') {
          game.abort();
          break;
        }
        if (answer === 'resign') {
          game.resign(humanSide);
          break;
        }
        if (answer === 'undo') {
          const undone = game.undo(2);
          console.log(undone > 0 ? `已回退 ${undone} 步` : '没有可回退的着法');
          continue;
        }
        if (answer === 'hint') {
          const [best] = await engine.search(game.fen(), 200000, 1);
          console.log(
            `建议：${chineseNotation(game.position, best.move)}（${toUciMove(best.move)}）`,
          );
          continue;
        }

        let move: Move | null = parseUciMove(answer);
        if (!move) move = parseChineseMove(game.position, answer);
        if (!move) {
          console.log('无法识别的着法，请重试');
          continue;
        }

        try {
          const entry = game.move(move);
          console.log(`你走了：${entry.chinese}`);
        } catch (error) {
          if (error instanceof IllegalMoveError) {
            console.log(`非法着法：${error.message}`);
            continue;
          }
          throw error;
        }
      } else {
        let results: SearchResult[];
        try {
          results = await engine.search(
            game.fen(),
            difficulty.nodes,
            difficulty.multiPv,
          );
        } catch (error) {
          if (!(error instanceof EngineTimeoutError)) throw error;
          const reply = await ask('引擎超时，是否重试？(y/N) ');
          if (reply === null || reply.trim().toLowerCase() !== 'y') {
            game.abort();
            break;
          }
          await restart(config);
          results = await engine.search(
            game.fen(),
            difficulty.nodes,
            difficulty.multiPv,
          );
        }

        const chosen = selectEngineMove(results, difficulty.weighted);
        const entry = game.move(chosen.move);
        console.log(`AI 走了：${entry.chinese}`);
      }
    }

    console.log('');
    console.log(renderBoard(game.position));
    console.log(`结果：${resultText(game, humanSide)}（${game.endReason ?? '未结束'}）`);

    if (
      args.review &&
      game.result &&
      game.result !== 'aborted' &&
      game.history.some((entry) => entry.side === humanSide)
    ) {
      const answer = (await ask('是否复盘？(Y/n) '))?.trim().toLowerCase() ?? 'n';
      if (answer !== 'n') {
        console.log('正在复盘，每手需要两次引擎搜索，请稍候……');
        const report = await reviewGame(engine, game, humanSide);
        printReview(report);
      }
    }

    persist();
  } catch (error) {
    if (error instanceof EngineTimeoutError) {
      console.error('引擎计算超时，对局中止');
    } else {
      console.error('运行出错：', error instanceof Error ? error.message : error);
    }
    if (!game.result) game.abort();
    persist();
    process.exitCode = 1;
  } finally {
    await engine.quit().catch(() => undefined);
    rl.close();
  }
}

void main();