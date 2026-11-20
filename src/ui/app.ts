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
import { opposite, sameSquare } from '../types.ts';
import type {
  EndReason,
  GameResult,
  Move,
  Position,
  Side,
  Square,
} from '../types.ts';
import { OnlineGame } from '../net/onlineGame.ts';
import { gameFromSnapshot } from '../net/snapshotGame.ts';
import {
  parseInvite,
  type ActionReply,
  type ClockSnapshot,
  type GuestAction,
  type OnlineEvent,
  type OnlinePhase,
  type OnlineRole,
  type OnlineSnapshot,
} from '../net/protocol.ts';
import { toUciMove } from '../notation/coords.ts';
import { OnlinePanel, type OnlinePanelView } from './online.ts';

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
  timeout_step: '单步超时',
  timeout_total: '总时耗尽',
  disconnect: '断线',
  agreement: '和棋协议',
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
const onlineEl = byId<HTMLButtonElement>('online');
const onlineBarEl = byId<HTMLDivElement>('online-bar');
const onlineBarTextEl = byId('online-bar-text');
const onlineBarClockEl = byId('online-bar-clock');

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

interface OnlineUiState {
  role: OnlineRole | null;
  phase: OnlinePhase | null;
  selfSide: Side | null;
  inviteUrl: string | null;
  joinRequestPending: boolean;
  approved: boolean;
  message: string;
  snapshot: OnlineSnapshot | null;
  snapshotAt: number;
  hostGame: OnlineGame | null;
  ended: boolean;
}

const idleOnline = (): OnlineUiState => ({
  role: null,
  phase: null,
  selfSide: null,
  inviteUrl: null,
  joinRequestPending: false,
  approved: false,
  message: '',
  snapshot: null,
  snapshotAt: 0,
  hostGame: null,
  ended: false,
});

let online: OnlineUiState = idleOnline();
let onlinePanel: OnlinePanel | null = null;
let clockTimer: number | null = null;
let clockTicking = false;
let startingOnline = false;
let decidingGuest = false;
let startingEvents: OnlineEvent[] = [];

function snapshot(position: Position): PieceView[] {
  const pieces: PieceView[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = position.board[rank][file];
      if (!piece) continue;
      // id 由棋子起点格位推导：同一局无论重建多少次，每枚棋子都得到相同 id，
      // 客人收到快照重绘时能复用 DOM 节点，CSS 过渡才会把走子渲染成平滑位移。
      pieces.push({ id: rank * 9 + file, type: piece.type, side: piece.side, file, rank });
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

const ONLINE_OFF_TEXT = '联机模式已关闭评估';

function onlineActive(): boolean {
  return online.role !== null;
}

function onlineSelfSide(): Side | null {
  return online.role === null ? null : online.selfSide;
}

function onlineCanAct(): boolean {
  if (!onlineActive() || !online.approved || online.phase !== 'playing') return false;
  if (online.ended || online.snapshot?.paused) return false;
  return true;
}

function showOnlineEvalOff(): void {
  evalState = null;
  evalScoreEl.textContent = ONLINE_OFF_TEXT;
  evalEl.title = '';
  evalQualityEl.textContent = '';
  evalQualityEl.className = 'quality';
}

function formatMs(ms: number): string {
  const remaining = Math.max(0, ms);
  // 规格 8.4：不足 20 秒时显示到 0.1 秒，便于收尾阶段读数。
  if (remaining < 20_000) return (remaining / 1000).toFixed(1);
  const total = Math.ceil(remaining / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function currentOnlineClock(): ClockSnapshot | null {
  if (online.role === 'host') return online.hostGame?.clockNow(Date.now()) ?? null;
  if (online.role !== 'guest' || !online.snapshot) return null;
  const snap = online.snapshot;
  const clock = snap.clock;
  if (!clock.running || snap.paused || snap.phase !== 'playing') return clock;
  const elapsed = Math.max(0, Date.now() - online.snapshotAt);
  return {
    redMs: Math.max(0, clock.redMs - (clock.turn === 'red' ? elapsed : 0)),
    blackMs: Math.max(0, clock.blackMs - (clock.turn === 'black' ? elapsed : 0)),
    stepMs: Math.max(0, clock.stepMs - elapsed),
    turn: clock.turn,
    running: clock.running,
  };
}

function onlineClockText(): string {
  const clock = currentOnlineClock();
  if (!clock) return '';
  const self = onlineSelfSide();
  if (!self) {
    return `红 ${formatMs(clock.redMs)} · 黑 ${formatMs(clock.blackMs)} · 本步 ${formatMs(clock.stepMs)}`;
  }
  const mine = self === 'red' ? clock.redMs : clock.blackMs;
  const theirs = self === 'red' ? clock.blackMs : clock.redMs;
  return `你 ${formatMs(mine)} · 对方 ${formatMs(theirs)} · 本步 ${formatMs(clock.stepMs)}`;
}

function onlineMessageText(): string {
  if (online.snapshot?.paused) return '对方断线，棋钟已暂停';
  if (online.phase === 'ended') return '对局已结束';
  return online.snapshot?.message ?? online.message;
}

function onlineView(): OnlinePanelView {
  return {
    role: online.role,
    approved: online.approved,
    joinRequestPending: online.joinRequestPending,
    phase: online.phase,
    inviteUrl: online.inviteUrl,
    clockText: online.approved ? onlineClockText() : '',
    message: onlineMessageText(),
    pending: online.snapshot?.pending ?? null,
    selfSide: onlineSelfSide(),
    canAct: onlineCanAct(),
  };
}

function updateOnlineBar(): void {
  if (!onlineActive()) {
    onlineBarEl.hidden = true;
    return;
  }
  onlineBarEl.hidden = false;
  const role = online.role === 'host' ? '房主' : '客人';
  const phase = online.ended ? '已结束' : online.approved ? '对局中' : '等待加入';
  onlineBarTextEl.textContent = `${role} · ${phase}`;
  onlineBarClockEl.textContent = online.approved ? onlineClockText() : '';
}

function updateOnlineUi(): void {
  onlinePanel?.render(onlineView());
  updateOnlineBar();
}

function stopClockTimer(): void {
  if (clockTimer === null) return;
  window.clearInterval(clockTimer);
  clockTimer = null;
}

async function tickHostClock(): Promise<void> {
  if (clockTicking || !online.hostGame) return;
  clockTicking = true;
  try {
    const snap = online.hostGame.checkTimeout(Date.now());
    updateOnlineUi();
    if (snap) {
      await api()
        .hostSnapshot(snap)
        .catch((error) => setMessage(`同步失败：${describe(error)}`));
      applyHostSnapshotState(snap);
    }
  } finally {
    clockTicking = false;
  }
}

function ensureClockTimer(): void {
  if (clockTimer !== null) return;
  clockTimer = window.setInterval(() => {
    if (!onlineActive()) return;
    if (online.role === 'host' && online.phase === 'playing' && !online.ended) {
      void tickHostClock();
      return;
    }
    updateOnlineUi();
  }, 250);
}

function resetLocalForOnline(): void {
  generation += 1;
  clearSimulationState();
  thinking = false;
  reviewing = false;
  humanSide = 'red';
  selected = null;
  hintMoves = [];
  game = new Game();
  startedAt = new Date();
  snapshots = [snapshot(game.position)];
  review = null;
  savedPath = null;
  recordEl.textContent = '';
  reviewPanelEl.open = false;
  showOnlineEvalOff();
  renderReview();
  board.setOrientation('red');
  board.reset(piecesNow());
  render();
}

function flushStartingEvents(): void {
  startingOnline = false;
  const buffered = startingEvents.splice(0);
  for (const event of buffered) handleOnlineEvent(event);
}

function applyHostSnapshotState(snap: OnlineSnapshot): void {
  if (online.role !== 'host') return;
  if (online.snapshot && snap.rev < online.snapshot.rev) return;
  online.snapshot = snap;
  online.phase = snap.phase;
  online.approved = snap.phase !== 'lobby';
  online.message = snap.message ?? (snap.paused ? '对方断线，等待重连' : '');
  if (snap.phase === 'ended') online.ended = true;
  updateOnlineUi();
  render();
  if (snap.phase === 'ended') finishOnlineGame();
}

function finishOnlineGame(): void {
  if (!game.result) return;
  if (game.result === 'aborted') {
    setMessage(`对局结束：${RESULT_TEXT.aborted}`);
    render();
  } else {
    finishGame();
  }
  updateOnlineUi();
}

function applyGuestSnapshot(snap: OnlineSnapshot): void {
  if (online.role !== 'guest') return;
  if (online.snapshot && snap.rev <= online.snapshot.rev) return;
  const previous = online.snapshot;
  online.snapshot = snap;
  online.snapshotAt = Date.now();
  online.phase = snap.phase;
  online.approved = snap.phase !== 'lobby';
  online.message = snap.message ?? '';
  if (snap.phase === 'ended') online.ended = true;

  const self = opposite(snap.hostSide);
  if (online.selfSide !== self) {
    online.selfSide = self;
    humanSide = self;
    board.setOrientation(self);
  }

  const sameMoves =
    previous !== null &&
    previous.moves.length === snap.moves.length &&
    previous.moves.every((uci, index) => uci === snap.moves[index]);
  if (!sameMoves) {
    try {
      game = gameFromSnapshot(snap);
    } catch (error) {
      setMessage(`联机数据异常：${describe(error)}`);
      void api().guestLeave().catch(() => undefined);
      finishOnlineSession('联机已结束：数据异常');
      return;
    }
    snapshots = rebuildSnapshots(game);
    selected = null;
    hintMoves = [];
  } else if (snap.result !== null) {
    game.result = snap.result;
    game.endReason = snap.endReason;
  }

  updateOnlineUi();
  render();
  if (snap.phase === 'ended') finishOnlineGame();
}

async function publishHostSnapshot(snap: OnlineSnapshot, rebuild: boolean): Promise<void> {
  if (rebuild) snapshots = rebuildSnapshots(game);
  selected = null;
  hintMoves = [];
  render();
  await api()
    .hostSnapshot(snap)
    .catch((error) => setMessage(`同步失败：${describe(error)}`));
  applyHostSnapshotState(snap);
}

async function handleHostControlReply(reply: ActionReply, rebuild: boolean): Promise<void> {
  if (!reply.snapshot) return;
  if (!reply.accepted) setMessage(reply.message ?? '操作被拒绝');
  await publishHostSnapshot(reply.snapshot, rebuild);
}

async function handleHostAction(actionId: string, action: GuestAction): Promise<void> {
  const hostGame = online.hostGame;
  if (!hostGame) return;
  const reply = hostGame.applyGuestAction(actionId, action, Date.now());
  if (!reply.snapshot) return;
  if (!reply.accepted && reply.message) setMessage(reply.message);
  if (reply.accepted && action.type === 'move' && game.history.length === snapshots.length) {
    const entry = game.history[game.history.length - 1];
    if (entry) snapshots.push(advancePieces(piecesNow(), entry.move));
  } else if (reply.accepted) {
    snapshots = rebuildSnapshots(game);
  }
  selected = null;
  hintMoves = [];
  render();
  await api()
    .hostReply(actionId, reply.accepted, reply.message, reply.snapshot)
    .catch((error) => setMessage(`同步失败：${describe(error)}`));
  applyHostSnapshotState(reply.snapshot);
}

async function sendGuestAction(action: GuestAction): Promise<void> {
  try {
    const reply = await api().guestAction(action);
    if (!reply.accepted && reply.message) setMessage(reply.message);
    if (reply.snapshot) applyGuestSnapshot(reply.snapshot);
  } catch (error) {
    setMessage(`联机操作失败：${describe(error)}`);
  }
}

async function sendOnlineMove(move: Move): Promise<void> {
  if (online.role === 'host' && online.hostGame) {
    const reply = online.hostGame.applyHostMove(move, Date.now());
    if (!reply.accepted && reply.message) setMessage(reply.message);
    if (!reply.snapshot) {
      selected = null;
      render();
      return;
    }
    if (reply.accepted) {
      const entry = game.history[game.history.length - 1];
      if (entry) snapshots.push(advancePieces(piecesNow(), entry.move));
    }
    selected = null;
    hintMoves = [];
    render();
    await api()
      .hostSnapshot(reply.snapshot)
      .catch((error) => setMessage(`同步失败：${describe(error)}`));
    applyHostSnapshotState(reply.snapshot);
    return;
  }
  if (online.role === 'guest') {
    await sendGuestAction({ type: 'move', uci: toUciMove(move) });
  }
}

function handleOnlineCell(sq: Square): void {
  if (!onlineCanAct() || game.result) return;
  if (online.snapshot?.pending?.kind === 'undo') return;
  const self = onlineSelfSide();
  if (!self || game.position.sideToMove !== self) return;
  if (selected) {
    const move = targetsFor(selected).find((candidate) => sameSquare(candidate.to, sq));
    if (move) {
      void sendOnlineMove(move);
      return;
    }
  }
  const piece = pieceAt(game.position, sq);
  if (piece && piece.side === self) {
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

function requestOnlineUndo(): void {
  if (!onlineCanAct() || online.snapshot?.pending) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostUndoRequest(Date.now()), false);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'undo-request' });
}

function respondOnlineUndo(accept: boolean): void {
  const pending = online.snapshot?.pending;
  if (!onlineCanAct() || !pending || pending.kind !== 'undo') return;
  if (pending.by === onlineSelfSide()) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostUndoResponse(accept, Date.now()), true);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'undo-response', accept });
}

function cancelOnlineUndo(): void {
  const pending = online.snapshot?.pending;
  if (!onlineCanAct() || !pending || pending.kind !== 'undo') return;
  if (pending.by !== onlineSelfSide()) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostUndoCancel(Date.now()), false);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'undo-cancel' });
}

function offerOnlineDraw(): void {
  if (!onlineCanAct() || online.snapshot?.pending) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostDrawOffer(Date.now()), false);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'draw-offer' });
}

function respondOnlineDraw(accept: boolean): void {
  const pending = online.snapshot?.pending;
  if (!onlineCanAct() || !pending || pending.kind !== 'draw') return;
  if (pending.by === onlineSelfSide()) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostDrawResponse(accept, Date.now()), false);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'draw-response', accept });
}

function resignOnline(): void {
  if (!onlineCanAct()) return;
  if (online.role === 'host' && online.hostGame) {
    void handleHostControlReply(online.hostGame.hostResign(Date.now()), false);
    return;
  }
  if (online.role === 'guest') void sendGuestAction({ type: 'resign' });
}

async function startHosting(hostSide: Side): Promise<void> {
  if (onlineActive()) throw new Error('已有联机会话');
  if (game.history.length > 0 && !window.confirm('联机对战会替换当前棋局，继续？')) return;

  startingOnline = true;
  let result: { url: string; localUrl?: string };
  try {
    result = await api().hostStart(hostSide);
  } catch (error) {
    startingOnline = false;
    startingEvents.length = 0;
    throw error;
  }

  resetLocalForOnline();
  const hostGame = new OnlineGame(hostSide, Date.now());
  online = {
    role: 'host',
    phase: 'lobby',
    selfSide: hostSide,
    inviteUrl: result.url,
    joinRequestPending: false,
    approved: false,
    message: '等待对方加入',
    snapshot: null,
    snapshotAt: 0,
    hostGame,
    ended: false,
  };
  humanSide = hostSide;
  game = hostGame.game;
  snapshots = [snapshot(game.position)];
  board.setOrientation(hostSide);
  board.reset(piecesNow());
  ensureClockTimer();
  updateOnlineUi();
  render();
  setMessage('联机房间已创建，等待对方加入');
  flushStartingEvents();
}

function joinRoom(url: string): Promise<void> {
  if (onlineActive()) throw new Error('已有联机会话');
  parseInvite(url); // 非法链接必须在清空本地棋局之前报错
  if (game.history.length > 0 && !window.confirm('联机对战会替换当前棋局，继续？')) {
    return Promise.resolve();
  }

  // 主进程的 join() 会一直挂起到房主裁决（electron/online/client.ts），
  // 因此客人状态必须先在渲染进程落地：否则等待期间面板仍是“未加入”，
  // 离开按钮也不可用，房主不裁决就会把客人卡死。
  resetLocalForOnline();
  online = {
    role: 'guest',
    phase: 'lobby',
    selfSide: null,
    inviteUrl: null,
    joinRequestPending: false,
    approved: false,
    message: '等待房主同意',
    snapshot: null,
    snapshotAt: 0,
    hostGame: null,
    ended: false,
  };
  ensureClockTimer();
  updateOnlineUi();
  render();
  setMessage('已加入房间，等待房主同意');

  void api()
    .guestJoin(url)
    .then((joined) => {
      if (online.role !== 'guest') return;
      online.phase = joined.phase;
      updateOnlineUi();
      render();
      if (joined.phase !== 'lobby') setMessage('房主已同意');
    })
    .catch((error) => {
      // 等待期间主动离开：closed 事件已收尾，这里不再提示。
      if (online.role !== 'guest') return;
      onlinePanel?.setError(describe(error));
      finishOnlineSession(`加入失败：${describe(error)}`);
    });
  return Promise.resolve();
}

function decideGuest(accept: boolean): void {
  if (online.role !== 'host' || !online.hostGame || decidingGuest) return;
  decidingGuest = true;
  void (async () => {
    try {
      await api().hostDecision(accept);
      online.joinRequestPending = false;
      if (accept) {
        const status = await api().getOnlineStatus();
        if (!status.approved) {
          onlinePanel?.setError('加入请求已失效，请让客人重新加入');
          updateOnlineUi();
          return;
        }
        const snap = online.hostGame?.begin(Date.now());
        if (!snap) return;
        await api()
          .hostSnapshot(snap)
          .catch((error) => setMessage(`同步失败：${describe(error)}`));
        applyHostSnapshotState(snap);
        setMessage('对方已加入，对局开始');
      } else {
        updateOnlineUi();
        setMessage('已拒绝加入请求');
      }
    } catch (error) {
      onlinePanel?.setError(describe(error));
    } finally {
      decidingGuest = false;
    }
  })();
}

async function stopHosting(): Promise<void> {
  if (online.role !== 'host') return;
  if (!online.ended && online.hostGame && online.phase === 'playing') {
    const snap = online.hostGame.endByHostAbort(Date.now());
    await api().hostSnapshot(snap).catch(() => undefined);
  }
  await api().hostStop().catch(() => undefined);
  finishOnlineSession('联机已结束');
}

async function leaveRoom(): Promise<void> {
  if (online.role !== 'guest') return;
  if (onlineCanAct()) {
    let timer: number | null = null;
    const capped = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, 5000);
    });
    await Promise.race([sendGuestAction({ type: 'resign' }), capped]);
    if (timer !== null) window.clearTimeout(timer);
  }
  await api().guestLeave().catch(() => undefined);
  finishOnlineSession('已离开房间');
}

function finishOnlineSession(note: string): void {
  if (!onlineActive()) return;
  const result = game.result;
  const self = online.selfSide;
  online = idleOnline();
  startingOnline = false;
  decidingGuest = false;
  startingEvents.length = 0;
  stopClockTimer();
  selected = null;
  hintMoves = [];
  if (!result && self !== null) humanSide = game.position.sideToMove;
  sideSelect.value = humanSide;
  board.setOrientation(humanSide);
  clearEvaluation();
  updateOnlineUi();
  render();
  setMessage(result ? `${note}；${RESULT_TEXT[result]}` : note);
  void evaluatePosition(null, null);
}

const CLOSED_TEXT: Record<string, string> = {
  'guest-leave': '客人已离开',
  'host-stop': '房主已结束联机',
  'join-failed': '加入失败',
  'window-closed': '联机已结束',
  'render-gone': '联机已结束',
  'app-quit': '联机已结束',
  'will-quit': '联机已结束',
  stopped: '联机已结束',
  '房间空闲已关闭': '房间空闲，联机已结束',
};

function closedText(reason: string): string {
  const known = CLOSED_TEXT[reason];
  if (known) return known;
  if (reason.startsWith('穿透')) return reason;
  return '房间已关闭';
}

function handleOnlineEvent(event: OnlineEvent): void {
  if (!onlineActive()) {
    if (startingOnline) startingEvents.push(event);
    return;
  }
  switch (event.type) {
    case 'status': {
      if (event.status.inviteUrl) online.inviteUrl = event.status.inviteUrl;
      if (online.role === 'host') online.approved = event.status.approved;
      updateOnlineUi();
      return;
    }
    case 'host-guest-joined': {
      if (online.role !== 'host') return;
      online.joinRequestPending = true;
      updateOnlineUi();
      setMessage('有玩家请求加入联机对局');
      return;
    }
    case 'host-guest-closed': {
      online.joinRequestPending = false;
      updateOnlineUi();
      return;
    }
    case 'host-action': {
      if (online.role === 'host') void handleHostAction(event.actionId, event.action);
      return;
    }
    case 'host-guest-disconnected': {
      if (online.role !== 'host' || !online.hostGame) return;
      const snap = online.hostGame.onGuestDisconnected(Date.now());
      setMessage('对方断线，棋钟已暂停');
      void api().hostSnapshot(snap).catch(() => undefined);
      applyHostSnapshotState(snap);
      return;
    }
    case 'host-guest-reconnected': {
      if (online.role !== 'host' || !online.hostGame) return;
      const snap = online.hostGame.onGuestReconnected(Date.now());
      setMessage('对方已重连');
      void api().hostSnapshot(snap).catch(() => undefined);
      applyHostSnapshotState(snap);
      return;
    }
    case 'host-guest-timeout': {
      if (online.role !== 'host' || !online.hostGame) return;
      const snap = online.hostGame.onGuestTimeout(Date.now());
      void api().hostSnapshot(snap).catch(() => undefined);
      applyHostSnapshotState(snap);
      return;
    }
    case 'snapshot': {
      if (online.role === 'guest') applyGuestSnapshot(event.snapshot);
      return;
    }
    case 'closed': {
      const selfLeft = online.role === 'guest' && event.reason === 'guest-leave';
      const hostLost =
        online.role === 'guest' && event.reason === '与房主失去连接' && !game.result;
      if (hostLost && game.history.length > 0) {
        game.result = 'aborted';
        game.endReason = 'aborted';
      }
      finishOnlineSession(selfLeft ? '已离开房间' : `联机已结束：${closedText(event.reason)}`);
      return;
    }
  }
}

async function evaluatePosition(
  before: EvalState | null,
  mover: Side | null,
  beforeFen: string | null = null,
): Promise<void> {
  if (onlineActive()) {
    showOnlineEvalOff();
    return;
  }
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
  } else if (onlineActive()) {
    const self = onlineSelfSide();
    const suffix = self === null ? '等待' : sideToMove === self ? '你' : '对方';
    turnEl.textContent = `${SIDE_TEXT[sideToMove]} · ${suffix}`;
    turnEl.className = `turn ${sideToMove}`;
    turnEl.title = online.snapshot?.paused ? '对方断线，棋钟已暂停' : '';
  } else {
    const waiting = sideToMove === humanSide;
    const suffix = waiting ? '你' : thinking ? 'AI思考' : 'AI';
    turnEl.textContent = `${SIDE_TEXT[sideToMove]} · ${suffix}`;
    turnEl.className = `turn ${sideToMove}`;
    turnEl.title = '';
  }

  renderMoves();
  renderButtons();
  updateOnlineBar();
}

function renderButtons(): void {
  const busy = thinking || reviewing;
  const onlineNow = onlineActive();
  const onlineReady = onlineCanAct();

  sideSelect.disabled = onlineNow;
  levelSelect.disabled = onlineNow;
  newGameEl.disabled = onlineNow;

  undoEl.hidden = simulating;
  undoEl.disabled = onlineNow ? busy || !onlineReady : busy || game.history.length === 0;
  simPrevEl.hidden = !simulating;
  simNextEl.hidden = !simulating;
  simPrevEl.disabled = busy || !simulating || game.history.length <= simBasePlies;
  simNextEl.disabled = busy || !simulating || simRedo.length === 0;
  hintEl.disabled =
    onlineNow ||
    busy ||
    !!game.result ||
    (!simulating && game.position.sideToMove !== humanSide);
  resignEl.disabled = onlineNow
    ? busy || !onlineReady
    : busy || !!game.result || simulating;
  reviewEl.disabled = onlineNow || busy || game.history.length === 0 || simulating;
  retryEl.hidden =
    onlineNow ||
    simulating ||
    !(!game.result && !busy && game.position.sideToMove !== humanSide);
  simulateEl.disabled = onlineNow || thinking || reviewing || (!!game.result && !simulating);
  simulateEl.textContent = simulating ? '返回对局' : '推演';
  simulateEl.classList.toggle('active', simulating);
  simulateEl.title = simulating ? '返回当前对局' : '进入推演：可替红黑双方走子';

  const canArchive = !busy && !simulating;
  saveEl.disabled = !canArchive;
  loadEl.disabled = onlineNow || !canArchive;
  importFenEl.disabled = onlineNow || !canArchive;
  exportEl.disabled = !canArchive;
  importFileEl.disabled = onlineNow || !canArchive;
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
  if (onlineActive()) {
    setMessage('联机对局中不可载入存档');
    return;
  }
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
  if (onlineActive()) {
    setMessage('联机对局中不可从文件载入');
    return;
  }
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
  if (onlineActive()) {
    setMessage('联机对局中不可导入局面');
    return;
  }
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
  if (onlinePanel?.isOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onlinePanel.close();
    }
    return;
  }

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
  if (onlineActive()) return;
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
  if (onlineActive()) {
    handleOnlineCell(sq);
    return;
  }
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
  if (onlineActive()) {
    setMessage('联机对局中不可使用提示');
    return;
  }
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
  if (onlineActive()) {
    requestOnlineUndo();
    return;
  }
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
  if (onlineActive()) {
    resignOnline();
    return;
  }
  if (thinking || reviewing || simulating || game.result) return;
  game.resign(humanSide);
  finishGame();
}

async function runReview(): Promise<void> {
  if (onlineActive()) {
    setMessage('联机对局中不可复盘');
    return;
  }
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
  if (onlineActive()) {
    setMessage('请先结束联机对局');
    return;
  }
  generation += 1;
  clearSimulationState();
  humanSide = sideSelect.value === 'black' ? 'black' : 'red';
  level = (Number(levelSelect.value) as Level) || 2;
  game = new Game();
  startedAt = new Date();
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
  if (onlineActive()) {
    setMessage('联机对局中不可推演');
    return;
  }
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

onlinePanel = new OnlinePanel({
  hostStart: startHosting,
  hostStop: stopHosting,
  hostDecision: decideGuest,
  guestJoin: joinRoom,
  guestLeave: leaveRoom,
  undoRequest: requestOnlineUndo,
  undoCancel: cancelOnlineUndo,
  undoResponse: respondOnlineUndo,
  drawOffer: offerOnlineDraw,
  drawResponse: respondOnlineDraw,
  resign: resignOnline,
});

onlineEl.addEventListener('click', () => {
  closePanel();
  onlinePanel?.open();
});
api().onOnlineEvent(handleOnlineEvent);

renderShortcuts();
void loadShortcutSettings();
startNewGame();