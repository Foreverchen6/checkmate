import { Game } from '../game/game.ts';
import { parseUciMove, toUciMove } from '../notation/coords.ts';
import { INITIAL_FEN } from '../rules/board.ts';
import { opposite, type EndReason, type Move, type Side } from '../types.ts';
import {
  checkTimeout as clockTimeout,
  clockSnapshot,
  commitMove,
  createClock,
  pause,
  restoreClock,
  resume,
  tick,
  type ClockState,
} from './clock.ts';
import {
  PROTOCOL_VERSION,
  type ActionReply,
  type ClockSnapshot,
  type GuestAction,
  type OnlinePhase,
  type OnlineSnapshot,
  type PendingRequest,
} from './protocol.ts';

export class OnlineGame {
  readonly hostSide: Side;
  readonly game = new Game(INITIAL_FEN);

  private clock: ClockState;
  private phase: OnlinePhase = 'lobby';
  private rev = 0;
  private paused = false;
  private pending: PendingRequest | null = null;
  private message: string | null = null;
  private clockAfter: ClockSnapshot[] = [];
  private readonly seenActions = new Map<string, { accepted: boolean; message: string | null }>();

  constructor(hostSide: Side, now: number) {
    this.hostSide = hostSide;
    this.clock = createClock('red', now);
  }

  get guestSide(): Side {
    return opposite(this.hostSide);
  }

  begin(now: number): OnlineSnapshot {
    this.phase = 'playing';
    this.clock = createClock('red', now);
    this.clockAfter = [clockSnapshot(this.clock)];
    this.pending = null;
    this.paused = false;
    this.message = null;
    this.rev += 1;
    return this.snapshot(now);
  }

  snapshot(now: number): OnlineSnapshot {
    this.advance(now);
    return {
      version: PROTOCOL_VERSION,
      rev: this.rev,
      phase: this.phase,
      hostSide: this.hostSide,
      initialFen: this.game.initialFen,
      moves: this.game.history.map((entry) => toUciMove(entry.move)),
      result: this.game.result,
      endReason: this.game.endReason,
      clock: clockSnapshot(this.clock),
      paused: this.paused,
      pending: this.pending ? { ...this.pending } : null,
      message: this.message,
    };
  }

  clockNow(now: number): ClockSnapshot {
    this.advance(now);
    return clockSnapshot(this.clock);
  }

  applyHostMove(move: Move, now: number): ActionReply {
    return this.applyMove(this.hostSide, move, now);
  }

  applyGuestAction(actionId: string, action: GuestAction, now: number): ActionReply {
    const cached = this.seenActions.get(actionId);
    if (cached) {
      return { accepted: cached.accepted, message: cached.message, snapshot: this.snapshot(now) };
    }
    const result = this.runGuestAction(action, now);
    this.seenActions.set(actionId, { accepted: result.accepted, message: result.message });
    while (this.seenActions.size > 20) {
      const first = this.seenActions.keys().next().value;
      if (first === undefined) break;
      this.seenActions.delete(first);
    }
    return result;
  }

  hostUndoRequest(now: number): ActionReply {
    return this.requestUndo(this.hostSide, now);
  }

  hostUndoResponse(accept: boolean, now: number): ActionReply {
    return this.respondUndo(this.hostSide, accept, now);
  }

  hostUndoCancel(now: number): ActionReply {
    return this.cancelUndo(this.hostSide, now);
  }

  hostDrawOffer(now: number): ActionReply {
    return this.requestDraw(this.hostSide, now);
  }

  hostDrawResponse(accept: boolean, now: number): ActionReply {
    return this.respondDraw(this.hostSide, accept, now);
  }

  hostResign(now: number): ActionReply {
    return this.resign(this.hostSide, now);
  }

  checkTimeout(now: number): OnlineSnapshot | null {
    if (this.phase !== 'playing' || this.paused) return null;
    const timeout = clockTimeout(this.clock, now);
    if (!timeout) return null;
    const loser = this.clock.turn;
    this.clock = tick(this.clock, now);
    this.finish(opposite(loser), timeout === 'step' ? 'timeout_step' : 'timeout_total', now);
    return this.snapshot(now);
  }

  onGuestDisconnected(now: number): OnlineSnapshot {
    if (this.phase === 'playing' && !this.paused) {
      this.clock = pause(this.clock, now);
      this.paused = true;
      this.message = '对方断线，等待重连';
      this.rev += 1;
    }
    return this.snapshot(now);
  }

  onGuestReconnected(now: number): OnlineSnapshot {
    if (this.phase === 'playing' && this.paused) {
      this.clock = resume(this.clock, now);
      this.paused = false;
      this.message = null;
      this.rev += 1;
    }
    return this.snapshot(now);
  }

  onGuestTimeout(now: number): OnlineSnapshot {
    if (this.phase === 'playing') {
      this.finish(this.hostSide, 'disconnect', now);
    }
    return this.snapshot(now);
  }

  endByHostAbort(now: number): OnlineSnapshot {
    if (this.phase !== 'ended') {
      this.phase = 'ended';
      this.clock = pause(this.clock, now);
      this.pending = null;
      this.paused = false;
      this.message = null;
      if (!this.game.result) {
        this.game.result = 'aborted';
        this.game.endReason = 'aborted';
      }
      this.rev += 1;
    }
    return this.snapshot(now);
  }

  private advance(now: number): void {
    if (this.phase === 'playing' && !this.paused) {
      this.clock = tick(this.clock, now);
    }
  }

  private runGuestAction(action: GuestAction, now: number): ActionReply {
    const side = this.guestSide;
    switch (action.type) {
      case 'move': {
        if (this.phase !== 'playing') return this.reject('对局尚未开始', now);
        if (this.paused) return this.reject('对方断线，暂不能走子', now);
        if (this.pending?.kind === 'undo') return this.reject('请先处理悔棋请求', now);
        const move = parseUciMove(action.uci);
        if (!move) return this.reject('着法格式无效', now);
        return this.applyMove(side, move, now);
      }
      case 'undo-request':
        return this.requestUndo(side, now);
      case 'undo-response':
        return this.respondUndo(side, action.accept, now);
      case 'undo-cancel':
        return this.cancelUndo(side, now);
      case 'draw-offer':
        return this.requestDraw(side, now);
      case 'draw-response':
        return this.respondDraw(side, action.accept, now);
      case 'resign':
        return this.resign(side, now);
    }
  }

  private applyMove(side: Side, move: Move, now: number): ActionReply {
    if (this.phase !== 'playing') return this.reject('对局已结束', now);
    if (this.paused) return this.reject('对局已暂停', now);
    if (this.clock.turn !== side) return this.reject('还没轮到你走子', now);
    if (this.pending?.kind === 'undo') return this.reject('请先处理悔棋请求', now);
    if (!this.game.isLegal(move)) return this.reject('非法着法', now);

    let committed: ReturnType<typeof commitMove>;
    try {
      committed = commitMove(this.clock, now, side);
    } catch {
      return this.reject('还没轮到你走子', now);
    }
    this.clock = committed.state;
    if (committed.timeout) {
      this.finish(
        opposite(side),
        committed.timeout === 'step' ? 'timeout_step' : 'timeout_total',
        now,
      );
      return this.reply(false, '走子超时', now);
    }

    this.game.move(move);
    this.clockAfter[this.game.history.length] = clockSnapshot(this.clock);
    if (this.pending?.kind === 'draw') this.pending = null;
    this.rev += 1;

    if (this.game.result) {
      this.clock = pause(this.clock, now);
      this.phase = 'ended';
      this.pending = null;
      this.paused = false;
    }
    return this.reply(true, null, now);
  }

  private requestUndo(side: Side, now: number): ActionReply {
    if (this.phase !== 'playing') return this.reject('对局尚未开始', now);
    if (this.paused) return this.reject('对局已暂停', now);
    if (this.pending) return this.reject('已有未处理的请求', now);
    const hasMove = this.game.history.some((entry) => entry.side === side);
    if (!hasMove) return this.reject('你还没有可悔的棋', now);
    this.pending = { kind: 'undo', by: side };
    this.rev += 1;
    return this.reply(true, null, now);
  }

  private respondUndo(side: Side, accept: boolean, now: number): ActionReply {
    if (this.pending?.kind !== 'undo') return this.reject('没有待处理的悔棋请求', now);
    if (this.pending.by === side) return this.reject('不能回应自己的请求', now);
    if (!accept) {
      this.pending = null;
      this.rev += 1;
      return this.reply(true, '对方拒绝悔棋', now);
    }

    const requestBy = this.pending.by;
    const last = [...this.game.history].reverse().find((entry) => entry.side === requestBy);
    if (!last) return this.reject('没有可回退的着法', now);
    const target = last.ply - 1;
    this.game.undo(this.game.history.length - target);
    this.clockAfter.length = target + 1;
    this.clock = restoreClock(this.clockAfter[target], now);
    // 断线暂停期间同意悔棋：快照来自之前的运行态，恢复后仍须保持冻结，
    // 否则暂停时长会在重连 resume 时被计入。
    if (this.paused) this.clock = pause(this.clock, now);
    this.pending = null;
    this.message = '悔棋已同意';
    this.rev += 1;
    return this.reply(true, '悔棋已同意', now);
  }

  private cancelUndo(side: Side, now: number): ActionReply {
    if (this.pending?.kind !== 'undo' || this.pending.by !== side) {
      return this.reject('没有可撤回的悔棋请求', now);
    }
    this.pending = null;
    this.rev += 1;
    return this.reply(true, '已撤回悔棋请求', now);
  }

  private requestDraw(side: Side, now: number): ActionReply {
    if (this.phase !== 'playing') return this.reject('对局尚未开始', now);
    if (this.paused) return this.reject('对局已暂停', now);
    if (this.pending) return this.reject('已有未处理的请求', now);
    this.pending = { kind: 'draw', by: side };
    this.rev += 1;
    return this.reply(true, null, now);
  }

  private respondDraw(side: Side, accept: boolean, now: number): ActionReply {
    if (this.pending?.kind !== 'draw') return this.reject('没有待处理的求和请求', now);
    if (this.pending.by === side) return this.reject('不能回应自己的请求', now);
    if (accept) {
      this.finish('draw', 'agreement', now);
      return this.reply(true, '双方同意和棋', now);
    }
    this.pending = null;
    this.rev += 1;
    return this.reply(true, '对方拒绝求和', now);
  }

  private resign(side: Side, now: number): ActionReply {
    if (this.phase !== 'playing') return this.reject('对局已结束', now);
    this.finish(opposite(side), 'resign', now);
    return this.reply(true, '已认输', now);
  }

  private finish(winner: Side | 'draw', reason: EndReason, now: number): void {
    this.clock = pause(this.clock, now);
    this.phase = 'ended';
    this.paused = false;
    this.pending = null;
    this.message = null;
    if (winner === 'draw') {
      this.game.result = 'draw';
      this.game.endReason = reason;
    } else {
      this.game.result = winner === 'red' ? 'red_win' : 'black_win';
      this.game.endReason = reason;
    }
    this.rev += 1;
  }

  private reject(message: string, now: number): ActionReply {
    return this.reply(false, message, now);
  }

  private reply(accepted: boolean, message: string | null, now: number): ActionReply {
    return { accepted, message, snapshot: this.snapshot(now) };
  }
}