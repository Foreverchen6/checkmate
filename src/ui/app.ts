import { BoardView, type PieceView } from './board.ts';
import { api, type EngineStatus } from './api.ts';
import { Game } from '../game/game.ts';
import { DIFFICULTIES, selectEngineMove, type Level } from '../engine/difficulty.ts';
import {
  labelForLoss,
  reviewGame,
  type MoveLabel,
  type ReviewReport,
  type Searcher,
} from '../review/review.ts';
import {
  cpLoss,
  formatEval,
  formatEvalDetail,
  redCpOf,
  redMateOf,
} from './evalText.ts';
import { buildRecord } from '../storage/recordData.ts';
import { chineseNotation } from '../notation/chinese.ts';
import { pieceAt } from '../rules/board.ts';
import { findKing, isInCheck } from '../rules/moves.ts';
import { sameSquare } from '../types.ts';
import type {
  EndReason,
  GameResult,
  Move,
  Position,
  Side,
  Square,
} from '../types.ts';

const SIDE_TEXT: Record<Side, string> = { red: '红方', black: '黑方' };
const RESULT_TEXT: Record<GameResult, string> = {
  red_win: '红方胜',
  black_win: '黑方胜',
  draw: '和棋',
  aborted: '对局中止',
};
const REASON_TEXT: Record<EndReason, string> = {
  checkmate: '将死',
  stalemate: '困毙',
  move_limit: '步数超限',
  repetition: '三次重复',
  resign: '认输',
  aborted: '中止',
};
const LABEL_TEXT: Record<MoveLabel, string> = {
  good: '好棋',
  ok: '可行',
  mistake: '失误',
  blunder: '漏着',
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const svg = document.getElementById('board') as SVGSVGElement | null;
if (!svg) throw new Error('缺少棋盘');

const board = new BoardView(svg);
const sideSelect = byId<HTMLSelectElement>('side');
const levelSelect = byId<HTMLSelectElement>('level');
const turnEl = byId('turn');
const evalEl = byId('eval');
const evalScoreEl = byId('eval-score');
const evalQualityEl = byId('eval-quality');
const engineEl = byId('engine');
const messageEl = byId('message');
const recordEl = byId('record');
const moveListEl = byId('move-list');
const reviewBodyEl = byId('review-body');
const reviewPanelEl = byId<HTMLDetailsElement>('review-panel');
const retryEl = byId<HTMLButtonElement>('retry');
const undoEl = byId<HTMLButtonElement>('undo');
const hintEl = byId<HTMLButtonElement>('hint');
const resignEl = byId<HTMLButtonElement>('resign');
const reviewEl = byId<HTMLButtonElement>('review');
const newGameEl = byId<HTMLButtonElement>('new-game');
const restartEl = byId<HTMLButtonElement>('restart-engine');
const togglePanelEl = byId<HTMLButtonElement>('toggle-panel');

const EVAL_NODES = 120000;

interface EvalState {
  fen: string;
  redCp: number;
  redMate: number | null;
}

let game = new Game();
let humanSide: Side = 'red';
let level: Level = 2;
let startedAt = new Date();
let generation = 0;
let thinking = false;
let reviewing = false;
let selected: Square | null = null;
let hintMoves: Move[] = [];
let evalState: EvalState | null = null;
let snapshots: PieceView[][] = [];
let nextPieceId = 1;
let review: ReviewReport | null = null;
let savedPath: string | null = null;

function snapshot(position: Position): PieceView[] {
  const pieces: PieceView[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = position.board[rank][file];
      if (!piece) continue;
      pieces.push({ id: nextPieceId, type: piece.type, side: piece.side, file, rank });
      nextPieceId += 1;
    }
  }
  return pieces;
}

const piecesNow = (): PieceView[] => snapshots[snapshots.length - 1] ?? [];

function setMessage(text: string): void {
  messageEl.textContent = text;
  messageEl.title = text;
}

function clearEvaluation(): void {
  evalState = null;
  evalScoreEl.textContent = '评估中';
  evalEl.title = '';
  evalQualityEl.textContent = '';
  evalQualityEl.className = 'quality';
}

function showQuality(label: MoveLabel | null, loss: number | null): void {
  evalQualityEl.textContent = label ? `· ${LABEL_TEXT[label]}` : '';
  evalQualityEl.className = label ? `quality ${label}` : 'quality';
  evalQualityEl.title = loss === null ? '' : `本步损失 ${Math.round(loss)} 分`;
}

async function evaluatePosition(
  before: EvalState | null,
  mover: Side | null,
  beforeFen: string | null = null,
): Promise<void> {
  const token = generation;
  const fen = game.fen();
  const side = game.position.sideToMove;

  try {
    const [best] = await api().search({
      fen,
      nodes: EVAL_NODES,
      multiPv: 1,
      timeoutMs: 12000,
    });
    if (!best || token !== generation || game.fen() !== fen) return;

    const state: EvalState = {
      fen,
      redCp: redCpOf(best.cp, side),
      redMate: redMateOf(best.mateIn, side),
    };
    evalState = state;
    evalScoreEl.textContent = formatEval(state.redCp, state.redMate);
    evalEl.title = formatEvalDetail(state.redCp, state.redMate, EVAL_NODES);

    if (mover !== humanSide) return;

    let beforeRed = before?.redCp ?? null;
    if (beforeRed === null && beforeFen && beforeFen !== fen) {
      const [past] = await api().search({
        fen: beforeFen,
        nodes: EVAL_NODES,
        multiPv: 1,
        timeoutMs: 12000,
      });
      if (past) beforeRed = redCpOf(past.cp, mover);
    }
    if (beforeRed !== null && token === generation) {
      const loss = cpLoss(beforeRed, state.redCp, mover);
      showQuality(labelForLoss(loss), loss);
    }
  } catch (error) {
    if (token === generation) evalEl.title = `评估失败：${describe(error)}`;
  }
}

function targetsFor(sq: Square): Move[] {
  return game.legalMoves().filter((move) => sameSquare(move.from, sq));
}

function render(): void {
  board.sync(piecesNow());
  board.setSelected(selected);

  const targets = selected
    ? targetsFor(selected).map((move) => ({
        move,
        capture: pieceAt(game.position, move.to) !== null,
      }))
    : [];
  board.setTargets(targets);

  const lastEntry = game.history[game.history.length - 1];
  board.setLastMove(lastEntry ? lastEntry.move : null);
  board.setHint(hintMoves);

  const sideToMove = game.position.sideToMove;
  const inCheck = !game.result && isInCheck(game.position, sideToMove);
  board.setCheck(inCheck ? findKing(game.position, sideToMove) : null);

  if (game.result) {
    turnEl.textContent = `结束 · ${RESULT_TEXT[game.result]}`;
    turnEl.className = 'turn';
  } else {
    const waiting = sideToMove === humanSide;
    const suffix = waiting ? '你' : thinking ? 'AI思考' : 'AI';
    turnEl.textContent = `${SIDE_TEXT[sideToMove]} · ${suffix}`;
    turnEl.className = `turn ${sideToMove}`;
  }

  renderMoves();
  renderButtons();
}

function renderButtons(): void {
  const busy = thinking || reviewing;
  undoEl.disabled = busy || game.history.length === 0;
  hintEl.disabled = busy || !!game.result || game.position.sideToMove !== humanSide;
  resignEl.disabled = busy || !!game.result;
  reviewEl.disabled = busy || game.history.length === 0;
  retryEl.hidden = !(!game.result && !busy && game.position.sideToMove !== humanSide);
}

function renderMoves(): void {
  moveListEl.replaceChildren();
  const history = game.history;
  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '尚未走子';
    moveListEl.appendChild(empty);
    return;
  }

  for (let index = 0; index < history.length; index += 2) {
    const row = document.createElement('div');
    row.className = 'move-row';

    const number = document.createElement('span');
    number.className = 'move-num';
    number.textContent = `${index / 2 + 1}.`;
    row.appendChild(number);

    for (const entry of [history[index], history[index + 1]]) {
      const cell = document.createElement('span');
      if (entry) {
        cell.textContent = entry.chinese;
        cell.className = entry.side === 'red' ? 'move-red' : 'move-black';
        if (index + (entry === history[index] ? 0 : 1) === history.length - 1) {
          cell.classList.add('last');
        }
      }
      row.appendChild(cell);
    }

    moveListEl.appendChild(row);
  }

  moveListEl.scrollTop = moveListEl.scrollHeight;
}

function renderReview(): void {
  reviewBodyEl.replaceChildren();

  if (reviewing && !review) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = '正在复盘…';
    reviewBodyEl.appendChild(line);
    return;
  }

  if (!review) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = '走完一局后可查看每步评分。';
    reviewBodyEl.appendChild(line);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'review-summary';
  summary.textContent = `ACPL ${review.acpl} · 失误 ${review.mistakes} · 漏着 ${review.blunders}`;
  reviewBodyEl.appendChild(summary);

  for (const move of review.moves) {
    const row = document.createElement('div');
    row.className = `review-row lbl-${move.label}`;

    const head = document.createElement('div');
    head.className = 'review-head';
    head.textContent = `第 ${move.ply} 手 ${move.chinese} · ${LABEL_TEXT[move.label]} · 损失 ${move.loss}`;

    const best = document.createElement('div');
    best.className = 'review-best';
    best.textContent = `建议 ${move.bestChinese}${move.pvChinese ? `（${move.pvChinese}）` : ''}`;

    row.appendChild(head);
    row.appendChild(best);
    reviewBodyEl.appendChild(row);
  }
}

function commitMove(move: Move): void {
  const mover = game.position.sideToMove;
  const beforeFen = game.fen();
  const before = evalState && evalState.fen === beforeFen ? evalState : null;

  try {
    game.move(move);
  } catch (error) {
    setMessage(`无法走棋：${describe(error)}`);
    selected = null;
    render();
    return;
  }

  const pieces = piecesNow().map((piece) => ({ ...piece }));
  const moving = pieces.find(
    (piece) => piece.file === move.from.file && piece.rank === move.from.rank,
  );
  const capturedIndex = pieces.findIndex(
    (piece) => piece.file === move.to.file && piece.rank === move.to.rank,
  );
  if (capturedIndex >= 0) pieces.splice(capturedIndex, 1);
  if (moving) {
    moving.file = move.to.file;
    moving.rank = move.to.rank;
  }

  snapshots.push(pieces);
  selected = null;
  hintMoves = [];
  if (mover === humanSide) showQuality(null, null);
  render();
  void evaluatePosition(before, mover, beforeFen);
  afterMove();
}

function afterMove(): void {
  if (game.result) {
    finishGame();
    return;
  }
  if (game.position.sideToMove !== humanSide) {
    void aiTurn();
    return;
  }
  setMessage('轮到你走棋');
}

function finishGame(): void {
  if (!game.result) return;
  const reason = game.endReason ? REASON_TEXT[game.endReason] : '';
  setMessage(`对局结束：${RESULT_TEXT[game.result]}${reason ? `（${reason}）` : ''}`);
  render();
  if (!savedPath) void saveCurrentRecord();
}

async function saveCurrentRecord(): Promise<void> {
  try {
    const record = buildRecord(game, humanSide, DIFFICULTIES[level].name, startedAt);
    const path = await api().saveRecord(record);
    savedPath = path;
    recordEl.textContent = `棋谱已保存：${path}`;
  } catch (error) {
    setMessage(`保存棋谱失败：${describe(error)}`);
  }
}

async function aiTurn(): Promise<void> {
  if (thinking || reviewing || game.result) return;
  if (game.position.sideToMove === humanSide) return;

  const token = generation;
  thinking = true;
  setMessage('AI 思考中…');
  render();

  try {
    const config = DIFFICULTIES[level];
    const results = await api().search({
      fen: game.fen(),
      nodes: config.nodes,
      multiPv: config.multiPv,
      timeoutMs: 30000,
    });
    if (token !== generation) return;
    if (results.length === 0) throw new Error('引擎没有返回着法');
    const chosen = selectEngineMove(results, config.weighted);
    commitMove(chosen.move);
  } catch (error) {
    if (token === generation) setMessage(`AI 出错：${describe(error)}`);
  } finally {
    if (token === generation) {
      thinking = false;
      render();
    }
  }
}

function handleCell(sq: Square): void {
  if (thinking || reviewing || game.result) return;
  if (game.position.sideToMove !== humanSide) return;

  if (selected) {
    const move = targetsFor(selected).find((candidate) => sameSquare(candidate.to, sq));
    if (move) {
      commitMove(move);
      return;
    }
  }

  const piece = pieceAt(game.position, sq);
  if (piece && piece.side === humanSide) {
    selected = { file: sq.file, rank: sq.rank };
    hintMoves = [];
    render();
    return;
  }

  if (selected) {
    selected = null;
    render();
  }
}

async function showHint(): Promise<void> {
  if (thinking || reviewing || game.result) return;
  if (game.position.sideToMove !== humanSide) return;

  const token = generation;
  thinking = true;
  setMessage('正在计算提示…');
  render();

  try {
    const results = await api().search({
      fen: game.fen(),
      nodes: 120000,
      multiPv: 3,
      timeoutMs: 30000,
    });
    if (token !== generation) return;
    const candidates = results.slice(0, 3);
    if (candidates.length === 0) throw new Error('引擎没有返回着法');
    hintMoves = candidates.map((result) => result.move);
    setMessage(
      `建议：${candidates
        .map((result) => chineseNotation(game.position, result.move))
        .join(' / ')}`,
    );
  } catch (error) {
    if (token === generation) setMessage(`提示失败：${describe(error)}`);
  } finally {
    if (token === generation) {
      thinking = false;
      render();
    }
  }
}

function undo(): void {
  if (thinking || reviewing) return;
  if (game.history.length === 0) {
    setMessage('还没有可以回退的着法');
    return;
  }
  if (humanSide === 'black' && game.history.length <= 1) {
    setMessage('还没有可以回退的着法');
    return;
  }

  generation += 1;
  let undone = 0;
  while (game.history.length > 0 && undone < 2) {
    game.undo(1);
    snapshots.pop();
    undone += 1;
    if (game.position.sideToMove === humanSide) break;
  }

  selected = null;
  hintMoves = [];
  clearEvaluation();
  savedPath = null;
  recordEl.textContent = '';
  if (review) {
    review = null;
    renderReview();
  }

  setMessage(`已回退 ${undone} 步`);
  render();
  void evaluatePosition(null, null);
  if (!game.result && game.position.sideToMove !== humanSide) void aiTurn();
}

function resign(): void {
  if (thinking || reviewing || game.result) return;
  game.resign(humanSide);
  finishGame();
}

async function runReview(): Promise<void> {
  if (thinking || reviewing) return;
  if (game.history.length === 0) {
    setMessage('还没有可以复盘的着法');
    return;
  }

  const token = generation;
  reviewing = true;
  review = null;
  reviewPanelEl.open = true;
  renderReview();
  render();

  try {
    const searcher: Searcher = {
      search: (fen, nodes, multiPv, timeoutMs) =>
        api().search({ fen, nodes, multiPv: multiPv ?? 1, timeoutMs }),
    };
    const report = await reviewGame(searcher, game, humanSide, 120000, (done, total) => {
      if (token === generation) setMessage(`复盘进度 ${done}/${total}`);
    });
    if (token !== generation) return;
    review = report;
    renderReview();
    setMessage(
      `复盘完成：ACPL ${report.acpl} · 失误 ${report.mistakes} · 漏着 ${report.blunders}`,
    );
  } catch (error) {
    if (token === generation) setMessage(`复盘失败：${describe(error)}`);
  } finally {
    if (token === generation) {
      reviewing = false;
      render();
    }
  }
}

function startNewGame(): void {
  generation += 1;
  humanSide = sideSelect.value === 'black' ? 'black' : 'red';
  level = (Number(levelSelect.value) as Level) || 2;
  game = new Game();
  startedAt = new Date();
  nextPieceId = 1;
  snapshots = [snapshot(game.position)];
  selected = null;
  hintMoves = [];
  clearEvaluation();
  review = null;
  savedPath = null;
  thinking = false;
  reviewing = false;
  recordEl.textContent = '';

  board.setOrientation(humanSide);
  board.reset(piecesNow());
  renderReview();
  render();
  setMessage(
    humanSide === 'red' ? '新对局开始，红方先行' : '新对局开始，你执黑，AI 先行',
  );

  void evaluatePosition(null, null);
  if (game.position.sideToMove !== humanSide) void aiTurn();
}

function applyEngineStatus(status: EngineStatus): void {
  engineEl.title = status.ready ? status.enginePath : status.error ?? '';
  engineEl.textContent = status.ready
    ? '就绪'
    : status.error && status.error !== '引擎启动中'
      ? '异常'
      : '启动中';
  engineEl.classList.toggle('ready', status.ready);
  if (!status.ready && status.error && status.error !== '引擎启动中') {
    setMessage(`引擎异常：${status.error}`);
  }
}

board.setCellHandler(handleCell);

const closePanel = (): void => {
  document.body.classList.remove('show-panel');
};

newGameEl.addEventListener('click', () => {
  startNewGame();
  closePanel();
});
undoEl.addEventListener('click', () => {
  undo();
  closePanel();
});
hintEl.addEventListener('click', () => {
  closePanel();
  void showHint();
});
resignEl.addEventListener('click', () => {
  resign();
  closePanel();
});
reviewEl.addEventListener('click', () => void runReview());
retryEl.addEventListener('click', () => {
  closePanel();
  void aiTurn();
});
togglePanelEl.addEventListener('click', () => {
  document.body.classList.toggle('show-panel');
});
restartEl.addEventListener('click', () => {
  closePanel();
  setMessage('正在重启引擎…');
  void api()
    .restartEngine()
    .then(applyEngineStatus)
    .catch((error) => setMessage(`重启失败：${describe(error)}`));
});

api().onEngineStatus(applyEngineStatus);
void api()
  .getStatus()
  .then(applyEngineStatus)
  .catch(() =>
    applyEngineStatus({
      ready: false,
      error: '无法连接主进程',
      enginePath: '',
      evalPath: '',
    }),
  );

startNewGame();