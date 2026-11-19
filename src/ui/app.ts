import { BoardView, type PieceView } from './board.ts';
import { api, type EngineStatus } from './api.ts';
import { Game } from '../game/game.ts';
import { DIFFICULTIES, selectEngineMove, type Level } from '../engine/difficulty.ts';
import {
  reviewGame,
  type ReviewReport,
  type Searcher,
} from '../review/review.ts';
import {
  labelForLoss,
  scoreLoss,
  type MoveLabel,
} from '../scoring.ts';
import {
  formatEval,
  formatEvalDetail,
  redCpOf,
  redMateOf,
} from './evalText.ts';
import {
  buildRecord,
  buildSavedGame,
  type ArchiveSummary,
  type SavedGame,
} from '../storage/recordData.ts';
import { restoreGame } from '../game/restore.ts';
import { chineseNotation } from '../notation/chinese.ts';
import { parseFen, pieceAt, toFen } from '../rules/board.ts';
import { validateFen } from '../rules/fenImport.ts';
import { findKing, isInCheck } from '../rules/moves.ts';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  eventMatches,
  sanitizeShortcuts,
  shortcutConflict,
  shortcutLabel,
  type ShortcutAction,
  type ShortcutMap,
} from '../shortcuts.ts';
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
const LEVEL_TEXT: Record<Level, string> = { 1: '入门', 2: '进阶', 3: '高手' };
const LEVEL_FROM_NAME: Record<string, Level> = {
  beginner: 1,
  entry: 2,
  intermediate: 3,
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
const simulateEl = byId<HTMLButtonElement>('simulate');
const simPrevEl = byId<HTMLButtonElement>('sim-prev');
const simNextEl = byId<HTMLButtonElement>('sim-next');
const saveEl = byId<HTMLButtonElement>('save');
const loadEl = byId<HTMLButtonElement>('load');
const importFenEl = byId<HTMLButtonElement>('import-fen');
const exportEl = byId<HTMLButtonElement>('export-game');
const importFileEl = byId<HTMLButtonElement>('import-file');
const archivePanelEl = byId<HTMLDetailsElement>('archive-panel');
const archiveListEl = byId('archive-list');
const shortcutListEl = byId('shortcut-list');
const resetShortcutsEl = byId<HTMLButtonElement>('reset-shortcuts');
const fenModalEl = byId<HTMLDivElement>('fen-modal');
const fenInputEl = byId<HTMLTextAreaElement>('fen-input');
const fenErrorEl = byId('fen-error');
const fenCancelEl = byId<HTMLButtonElement>('fen-cancel');
const fenConfirmEl = byId<HTMLButtonElement>('fen-confirm');

const SHORTCUT_BUTTONS: Record<ShortcutAction, HTMLButtonElement> = {
  newGame: newGameEl,
  undo: undoEl,
  hint: hintEl,
  resign: resignEl,
  review: reviewEl,
  simulate: simulateEl,
  save: saveEl,
  load: loadEl,
  export: exportEl,
  importFile: importFileEl,
  importFen: importFenEl,
  menu: togglePanelEl,
  retry: retryEl,
  restartEngine: restartEl,
};

const EVAL_NODES = 120000;

interface EvalState {
  fen: string;
  redCp: number;
  redMate: number | null;
}

interface EvalUi {
  score: string;
  title: string;
  qualityText: string;
  qualityClass: string;
  qualityTitle: string;
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

let simulating = false;
let realGame: Game | null = null;
let realSnapshots: PieceView[][] | null = null;
let realEval: EvalState | null = null;
let realEvalUi: EvalUi | null = null;
let realReview: ReviewReport | null = null;
let realSavedPath: string | null = null;

let shortcuts: ShortcutMap = sanitizeShortcuts({});
let capturing: ShortcutAction | null = null;
let simBasePlies = 0;
let simRedo: Move[] = [];

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

function advancePieces(current: PieceView[], move: Move): PieceView[] {
  const pieces = current.map((piece) => ({ ...piece }));
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
  return pieces;
}

function rebuildSnapshots(source: Game): PieceView[][] {
  const rows: PieceView[][] = [snapshot(parseFen(source.initialFen))];
  for (const entry of source.history) {
    rows.push(advancePieces(rows[rows.length - 1], entry.move));
  }
  return rows;
}

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
  evalQualityEl.title = loss === null ? '' : `本步丢分 ${loss.toFixed(1)}`;
}

function captureEvalUi(): EvalUi {
  return {
    score: evalScoreEl.textContent ?? '',
    title: evalEl.title,
    qualityText: evalQualityEl.textContent ?? '',
    qualityClass: evalQualityEl.className,
    qualityTitle: evalQualityEl.title,
  };
}

function applyEvalUi(ui: EvalUi): void {
  evalScoreEl.textContent = ui.score;
  evalEl.title = ui.title;
  evalQualityEl.textContent = ui.qualityText;
  evalQualityEl.className = ui.qualityClass;
  evalQualityEl.title = ui.qualityTitle;
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

    if (mover === null) return;
    if (!simulating && mover !== humanSide) return;

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
      const loss = scoreLoss(beforeRed, state.redCp, mover);
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
    turnEl.textContent = simulating
      ? `推演·${RESULT_TEXT[game.result]}`
      : `结束 · ${RESULT_TEXT[game.result]}`;
    turnEl.className = simulating ? 'turn sim' : 'turn';
    turnEl.title = simulating ? '推演模式：替双方走子，随时返回对局' : '';
  } else if (simulating) {
    turnEl.textContent = `推演·${SIDE_TEXT[sideToMove]}`;
    turnEl.className = 'turn sim';
    turnEl.title = '推演模式：替双方走子，随时返回对局';
  } else {
    const waiting = sideToMove === humanSide;
    const suffix = waiting ? '你' : thinking ? 'AI思考' : 'AI';
    turnEl.textContent = `${SIDE_TEXT[sideToMove]} · ${suffix}`;
    turnEl.className = `turn ${sideToMove}`;
    turnEl.title = '';
  }

  renderMoves();
  renderButtons();
}

function renderButtons(): void {
  const busy = thinking || reviewing;
  undoEl.hidden = simulating;
  undoEl.disabled = busy || game.history.length === 0;
  simPrevEl.hidden = !simulating;
  simNextEl.hidden = !simulating;
  simPrevEl.disabled = busy || !simulating || game.history.length <= simBasePlies;
  simNextEl.disabled = busy || !simulating || simRedo.length === 0;
  hintEl.disabled =
    busy || !!game.result || (!simulating && game.position.sideToMove !== humanSide);
  resignEl.disabled = busy || !!game.result || simulating;
  reviewEl.disabled = busy || game.history.length === 0 || simulating;
  retryEl.hidden =
    simulating || !(!game.result && !busy && game.position.sideToMove !== humanSide);
  simulateEl.disabled = thinking || reviewing || (!!game.result && !simulating);
  simulateEl.textContent = simulating ? '返回对局' : '推演';
  simulateEl.classList.toggle('active', simulating);
  simulateEl.title = simulating ? '返回当前对局' : '进入推演：可替红黑双方走子';

  const canArchive = !busy && !simulating;
  saveEl.disabled = !canArchive;
  loadEl.disabled = !canArchive;
  importFenEl.disabled = !canArchive;
  exportEl.disabled = !canArchive;
  importFileEl.disabled = !canArchive;
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
  summary.textContent = `平均丢分 ${review.avgLoss.toFixed(1)} · 失误 ${review.mistakes} · 漏着 ${review.blunders}`;
  reviewBodyEl.appendChild(summary);

  for (const move of review.moves) {
    const row = document.createElement('div');
    row.className = `review-row lbl-${move.label}`;

    const head = document.createElement('div');
    head.className = 'review-head';
    head.textContent = `第 ${move.ply} 手 ${move.chinese} · ${LABEL_TEXT[move.label]} · 丢分 ${move.loss.toFixed(1)}`;

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

  if (simulating) simRedo = [];
  const pieces = advancePieces(piecesNow(), move);
  snapshots.push(pieces);
  selected = null;
  hintMoves = [];
  if (simulating || mover === humanSide) showQuality(null, null);
  render();
  void evaluatePosition(before, mover, beforeFen);
  afterMove();
}

function afterMove(): void {
  if (simulating) {
    if (game.result) {
      const reason = game.endReason ? REASON_TEXT[game.endReason] : '';
      setMessage(`推演结束：${RESULT_TEXT[game.result]}${reason ? `（${reason}）` : ''}`);
      render();
      return;
    }
    setMessage(`推演中：轮到${SIDE_TEXT[game.position.sideToMove]}`);
    render();
    return;
  }
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function archiveDescription(item: ArchiveSummary): string {
  const difficulty = LEVEL_FROM_NAME[item.difficulty];
  const levelText = difficulty ? LEVEL_TEXT[difficulty] : item.difficulty;
  const status = item.result ? RESULT_TEXT[item.result] : '未完成';
  return `${formatTime(item.savedAt)} · ${SIDE_TEXT[item.humanSide]} · ${levelText} · ${item.moveCount} 步 · ${status}`;
}

function renderArchives(items: ArchiveSummary[]): void {
  archiveListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '暂无存档';
    archiveListEl.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'archive-row';
    row.textContent = archiveDescription(item);
    row.title = item.file;
    row.addEventListener('click', () => void loadArchived(item.file));
    archiveListEl.appendChild(row);
  }
}

async function refreshArchives(): Promise<void> {
  try {
    renderArchives(await api().listArchives());
  } catch (error) {
    setMessage(`读取存档失败：${describe(error)}`);
  }
}

function showArchivePanel(): void {
  cancelCapture();
  document.body.classList.add('show-panel');
  archivePanelEl.open = true;
  void refreshArchives();
}

async function loadArchived(file: string): Promise<void> {
  try {
    const saved = await api().loadArchive(file);
    applySavedGame(saved, `已载入存档：${formatTime(saved.savedAt)}`);
    archivePanelEl.open = false;
    closePanel();
  } catch (error) {
    setMessage(`载入失败：${describe(error)}`);
  }
}

async function quickSave(): Promise<void> {
  if (simulating) {
    setMessage('推演中不能保存，请先返回对局');
    return;
  }
  try {
    const archive = buildSavedGame(game, humanSide, DIFFICULTIES[level].name, startedAt);
    await api().saveArchive(archive);
    setMessage(`已保存（${archive.moves.length} 步）`);
    void refreshArchives();
  } catch (error) {
    setMessage(`保存失败：${describe(error)}`);
  }
}

async function exportCurrentGame(): Promise<void> {
  if (simulating) {
    setMessage('推演中不能导出，请先返回对局');
    return;
  }
  try {
    const archive = buildSavedGame(game, humanSide, DIFFICULTIES[level].name, startedAt);
    const path = await api().exportArchive(archive);
    setMessage(path ? `已导出：${path}` : '已取消导出');
  } catch (error) {
    setMessage(`导出失败：${describe(error)}`);
  }
}

async function importFromFile(): Promise<void> {
  try {
    const imported = await api().importArchive();
    if (!imported) {
      setMessage('已取消载入');
      return;
    }
    applySavedGame(imported.archive, `已从文件载入：${imported.path}`);
    closePanel();
  } catch (error) {
    setMessage(`载入失败：${describe(error)}`);
  }
}

function clearSimulationState(): void {
  simulating = false;
  realGame = null;
  realSnapshots = null;
  realEval = null;
  realEvalUi = null;
  realReview = null;
  realSavedPath = null;
  simBasePlies = 0;
  simRedo = [];
}

function applySavedGame(saved: SavedGame, note: string): void {
  const restored = restoreGame(saved);

  generation += 1;
  clearSimulationState();
  humanSide = saved.humanSide;
  const restoredLevel = LEVEL_FROM_NAME[saved.difficulty];
  if (restoredLevel) level = restoredLevel;
  sideSelect.value = humanSide;
  levelSelect.value = String(level);
  game = restored;
  startedAt = new Date(saved.startedAt);
  nextPieceId = 1;
  snapshots = rebuildSnapshots(game);
  selected = null;
  hintMoves = [];
  clearEvaluation();
  review = null;
  savedPath = null;
  thinking = false;
  reviewing = false;
  recordEl.textContent = `已载入存档 · ${saved.moves.length} 步`;

  board.setOrientation(humanSide);
  board.reset(piecesNow());
  renderReview();
  render();
  setMessage(note);
  void evaluatePosition(null, null);
  if (!game.result && game.position.sideToMove !== humanSide) void aiTurn();
}

function startFromFen(fen: string): void {
  const position = validateFen(fen);
  const normalized = toFen(position);

  generation += 1;
  clearSimulationState();
  humanSide = sideSelect.value === 'black' ? 'black' : 'red';
  level = (Number(levelSelect.value) as Level) || 2;
  startedAt = new Date();
  nextPieceId = 1;
  game = new Game(normalized);
  snapshots = [snapshot(game.position)];
  selected = null;
  hintMoves = [];
  clearEvaluation();
  review = null;
  savedPath = null;
  thinking = false;
  reviewing = false;
  recordEl.textContent = '';
  archivePanelEl.open = false;

  board.setOrientation(humanSide);
  board.reset(piecesNow());
  renderReview();
  render();
  setMessage(`已导入局面，${SIDE_TEXT[game.position.sideToMove]}行棋`);
  void evaluatePosition(null, null);
  if (game.position.sideToMove !== humanSide) void aiTurn();
}

function openFenModal(): void {
  if (thinking || reviewing || simulating) return;
  fenInputEl.value = '';
  fenErrorEl.textContent = '';
  fenModalEl.hidden = false;
  closePanel();
  fenInputEl.focus();
}

function closeFenModal(): void {
  fenModalEl.hidden = true;
  fenErrorEl.textContent = '';
}

function confirmFen(): void {
  try {
    startFromFen(fenInputEl.value);
    closeFenModal();
  } catch (error) {
    fenErrorEl.textContent = describe(error);
  }
}

function renderShortcuts(): void {
  shortcutListEl.replaceChildren();
  for (const action of SHORTCUT_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';

    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = action.label;

    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'shortcut-key';
    key.dataset.action = action.id;
    key.textContent =
      capturing === action.id ? '按下 Ctrl+…' : shortcuts[action.id] || '未设置';
    key.classList.toggle('capturing', capturing === action.id);
    key.addEventListener('click', () => {
      capturing = capturing === action.id ? null : action.id;
      renderShortcuts();
    });

    row.append(label, key);
    shortcutListEl.appendChild(row);
  }
}

async function persistShortcuts(): Promise<void> {
  try {
    await api().saveSettings({ shortcuts });
  } catch (error) {
    setMessage(`保存快捷键失败：${describe(error)}`);
  }
}

function resetShortcuts(): void {
  shortcuts = { ...DEFAULT_SHORTCUTS };
  capturing = null;
  renderShortcuts();
  void persistShortcuts();
  setMessage('已恢复默认快捷键');
}

async function loadShortcutSettings(): Promise<void> {
  try {
    const settings = await api().getSettings();
    shortcuts = sanitizeShortcuts(settings.shortcuts);
  } catch {
    shortcuts = sanitizeShortcuts({});
  }
  renderShortcuts();
}

function handleShortcutKey(event: KeyboardEvent): void {
  if (!fenModalEl.hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFenModal();
    }
    return;
  }

  if (capturing) {
    if (event.key === 'Escape') {
      event.preventDefault();
      capturing = null;
      renderShortcuts();
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      const action = capturing;
      capturing = null;
      shortcuts = { ...shortcuts, [action]: '' };
      renderShortcuts();
      void persistShortcuts();
      setMessage(`已清除「${shortcutLabel(action)}」的快捷键`);
      return;
    }

    const combo = comboFromEvent(event);
    if (!combo) {
      if (event.ctrlKey) setMessage('请按 Ctrl+字母或数字');
      return;
    }
    event.preventDefault();
    const action = capturing;
    const conflict = shortcutConflict(shortcuts, combo, action);
    if (conflict) {
      setMessage(`${combo} 已被「${shortcutLabel(conflict)}」占用`);
      return;
    }
    capturing = null;
    shortcuts = { ...shortcuts, [action]: combo };
    renderShortcuts();
    void persistShortcuts();
    setMessage(`「${shortcutLabel(action)}」已设为 ${combo}`);
    return;
  }

  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  ) {
    return;
  }

  for (const action of SHORTCUT_ACTIONS) {
    if (!eventMatches(event, shortcuts[action.id])) continue;
    event.preventDefault();
    const button = SHORTCUT_BUTTONS[action.id];
    if (!button.disabled && !button.hidden) button.click();
    return;
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
    const chosen = selectEngineMove(results, config.weighted, Math.random, config.temperature);
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
  const sideToMove = game.position.sideToMove;
  if (!simulating && sideToMove !== humanSide) return;

  if (selected) {
    const move = targetsFor(selected).find((candidate) => sameSquare(candidate.to, sq));
    if (move) {
      commitMove(move);
      return;
    }
  }

  const piece = pieceAt(game.position, sq);
  const movable = simulating ? piece?.side === sideToMove : piece?.side === humanSide;
  if (piece && movable) {
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
  if (!simulating && game.position.sideToMove !== humanSide) return;

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

function toggleHint(): void {
  if (hintMoves.length > 0) {
    hintMoves = [];
    render();
    setMessage('已关闭提示');
    return;
  }
  void showHint();
}

function undo(): void {
  if (thinking || reviewing) return;
  if (game.history.length === 0) {
    setMessage('还没有可以回退的着法');
    return;
  }
  if (simulating) {
    stepSimulationBack();
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
  if (thinking || reviewing || simulating || game.result) return;
  game.resign(humanSide);
  finishGame();
}

async function runReview(): Promise<void> {
  if (thinking || reviewing || simulating) return;
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
      `复盘完成：平均丢分 ${report.avgLoss.toFixed(1)} · 失误 ${report.mistakes} · 漏着 ${report.blunders}`,
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
  clearSimulationState();
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

function enterSimulation(): void {
  if (simulating || thinking || reviewing) return;
  if (game.result) {
    setMessage('对局已结束，无法推演');
    return;
  }

  generation += 1;
  simBasePlies = game.history.length;
  simRedo = [];
  realGame = game;
  realSnapshots = snapshots;
  realEval = evalState;
  realEvalUi = captureEvalUi();
  realReview = review;
  realSavedPath = savedPath;

  game = game.clone();
  snapshots = snapshots.map((row) => row.map((piece) => ({ ...piece })));
  simulating = true;
  selected = null;
  hintMoves = [];
  review = null;
  savedPath = null;
  reviewPanelEl.open = false;
  renderReview();
  setMessage('推演模式：替红黑双方走子，随时返回对局');
  render();
  void evaluatePosition(null, null);
}

function exitSimulation(): void {
  if (!simulating) return;

  generation += 1;
  simulating = false;
  game = realGame ?? new Game();
  snapshots = realSnapshots ?? [snapshot(game.position)];
  evalState = realEval;
  review = realReview;
  savedPath = realSavedPath;

  const ui = realEvalUi;
  realGame = null;
  realSnapshots = null;
  realEval = null;
  realEvalUi = null;
  realReview = null;
  realSavedPath = null;
  simBasePlies = 0;
  simRedo = [];

  selected = null;
  hintMoves = [];
  if (evalState && ui && ui.score && ui.score !== '评估中') {
    applyEvalUi(ui);
  } else {
    clearEvaluation();
  }
  renderReview();
  setMessage('已返回对局');
  render();
  void evaluatePosition(null, null);
}

function toggleSimulation(): void {
  if (simulating) exitSimulation();
  else enterSimulation();
}

function stepSimulationBack(): void {
  if (!simulating || thinking || reviewing) return;
  if (game.history.length <= simBasePlies) return;

  const last = game.history[game.history.length - 1];
  generation += 1;
  game.undo(1);
  snapshots.pop();
  simRedo.push(last.move);
  selected = null;
  hintMoves = [];
  clearEvaluation();
  setMessage('推演上一步');
  render();
  void evaluatePosition(null, null);
}

function stepSimulationForward(): void {
  if (!simulating || thinking || reviewing) return;
  const move = simRedo.pop();
  if (!move) return;

  generation += 1;
  const mover = game.position.sideToMove;
  const beforeFen = game.fen();
  const before = evalState && evalState.fen === beforeFen ? evalState : null;

  try {
    game.move(move);
  } catch (error) {
    simRedo.push(move);
    setMessage(`推演无法前进：${describe(error)}`);
    render();
    return;
  }

  snapshots.push(advancePieces(piecesNow(), move));
  selected = null;
  hintMoves = [];
  if (game.result) {
    const reason = game.endReason ? REASON_TEXT[game.endReason] : '';
    setMessage(`推演结束：${RESULT_TEXT[game.result]}${reason ? `（${reason}）` : ''}`);
  } else {
    setMessage(`推演中：轮到${SIDE_TEXT[game.position.sideToMove]}`);
  }
  render();
  void evaluatePosition(before, mover, beforeFen);
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
  cancelCapture();
};

function cancelCapture(): void {
  if (!capturing) return;
  capturing = null;
  renderShortcuts();
}

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
  toggleHint();
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
  const showing = document.body.classList.toggle('show-panel');
  if (!showing) cancelCapture();
});
restartEl.addEventListener('click', () => {
  closePanel();
  setMessage('正在重启引擎…');
  void api()
    .restartEngine()
    .then(applyEngineStatus)
    .catch((error) => setMessage(`重启失败：${describe(error)}`));
});
simulateEl.addEventListener('click', () => {
  toggleSimulation();
  closePanel();
});
simPrevEl.addEventListener('click', stepSimulationBack);
simNextEl.addEventListener('click', stepSimulationForward);
saveEl.addEventListener('click', () => {
  closePanel();
  void quickSave();
});
loadEl.addEventListener('click', showArchivePanel);
importFenEl.addEventListener('click', openFenModal);
exportEl.addEventListener('click', () => {
  closePanel();
  void exportCurrentGame();
});
importFileEl.addEventListener('click', () => {
  closePanel();
  void importFromFile();
});
resetShortcutsEl.addEventListener('click', resetShortcuts);
archivePanelEl.addEventListener('toggle', () => {
  if (archivePanelEl.open) void refreshArchives();
});

fenCancelEl.addEventListener('click', closeFenModal);
fenConfirmEl.addEventListener('click', confirmFen);
fenModalEl.addEventListener('click', (event) => {
  if (event.target === fenModalEl) closeFenModal();
});
fenInputEl.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    confirmFen();
  }
});

window.addEventListener('keydown', handleShortcutKey);

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

renderShortcuts();
void loadShortcutSettings();
startNewGame();