import { describe, expect, it } from 'vitest';
import { OnlineGame } from '../../src/net/onlineGame.ts';
import {
  DISCONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  STEP_MS,
  TOTAL_MS,
} from '../../src/net/protocol.ts';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import { parseUciMove } from '../../src/notation/coords.ts';

// ActionReply.snapshot 在协议层可为 null（会话层才保证填充），控制器总是返回快照，
// 因此测试里统一用非空断言读取。
function move(uci: string) {
  const parsed = parseUciMove(uci);
  if (!parsed) throw new Error(`bad uci ${uci}`);
  return parsed;
}

function game(hostSide: 'red' | 'black' = 'red') {
  const online = new OnlineGame(hostSide, 0);
  online.begin(0);
  return online;
}

describe('联机对局控制器', () => {
  it('开始时红方行棋，双方各 20 分钟', () => {
    const online = game();
    const snapshot = online.snapshot(0);
    expect(snapshot.rev).toBe(1);
    expect(snapshot.phase).toBe('playing');
    expect(snapshot.clock.redMs).toBe(TOTAL_MS);
    expect(snapshot.clock.blackMs).toBe(TOTAL_MS);
    expect(snapshot.clock.stepMs).toBe(STEP_MS);
    expect(snapshot.clock.turn).toBe('red');
    expect(snapshot.moves).toEqual([]);
  });

  it('房主与客人各走一手，棋钟与棋谱同步', () => {
    const online = game('red');
    const first = online.applyHostMove(move('h2e2'), 1000);
    expect(first.accepted).toBe(true);
    expect(first.snapshot!.moves).toEqual(['h2e2']);
    expect(first.snapshot!.clock.turn).toBe('black');
    expect(first.snapshot!.clock.redMs).toBe(TOTAL_MS - 1000);
    expect(first.snapshot!.clock.stepMs).toBe(STEP_MS);

    const second = online.applyGuestAction('a'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    expect(second.accepted).toBe(true);
    expect(second.snapshot!.moves).toEqual(['h2e2', 'h7e7']);
    expect(second.snapshot!.clock.turn).toBe('red');
    expect(second.snapshot!.clock.blackMs).toBe(TOTAL_MS - 1000);
  });

  it('客人不能替房主走子，非法着法不落子', () => {
    const online = game('red');
    const red = online.applyGuestAction('b'.repeat(16), { type: 'move', uci: 'h2e2' }, 1000);
    expect(red.accepted).toBe(false);
    expect(online.game.history).toHaveLength(0);

    const illegal = online.applyHostMove(move('h2e5'), 1000);
    expect(illegal.accepted).toBe(false);
    expect(online.game.history).toHaveLength(0);
  });

  it('重复 actionId 只落子一次', () => {
    const online = game('red');
    const id = 'd'.repeat(16);
    online.applyHostMove(move('h2e2'), 1000);
    const first = online.applyGuestAction(id, { type: 'move', uci: 'h7e7' }, 2000);
    const again = online.applyGuestAction(id, { type: 'move', uci: 'b7e7' }, 3000);
    expect(first.accepted).toBe(true);
    expect(again.accepted).toBe(true);
    expect(again.snapshot!.moves).toEqual(['h2e2', 'h7e7']);
    expect(online.game.history).toHaveLength(2);
  });

  it('单步超时判行棋方负', () => {
    const online = game('red');
    const ended = online.checkTimeout(STEP_MS + 1);
    expect(ended?.phase).toBe('ended');
    expect(ended?.result).toBe('black_win');
    expect(ended?.endReason).toBe('timeout_step');
  });

  it('悔棋恢复到请求方上一手之前，并恢复当时棋钟', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('e'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);

    const request = online.applyGuestAction('f'.repeat(16), { type: 'undo-request' }, 3000);
    expect(request.snapshot!.pending).toEqual({ kind: 'undo', by: 'black' });

    const blocked = online.applyHostMove(move('b0c2'), 4000);
    expect(blocked.accepted).toBe(false);

    const response = online.hostUndoResponse(true, 5000);
    expect(response.accepted).toBe(true);
    expect(response.snapshot!.moves).toEqual(['h2e2']);
    expect(response.snapshot!.clock.turn).toBe('black');
    expect(response.snapshot!.clock.redMs).toBe(TOTAL_MS - 1000);
    expect(response.snapshot!.clock.blackMs).toBe(TOTAL_MS);
    expect(response.snapshot!.pending).toBeNull();
  });

  it('撤销悔棋后可正常走子', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('h'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('i'.repeat(16), { type: 'undo-request' }, 3000);
    const cancelled = online.applyGuestAction('j'.repeat(16), { type: 'undo-cancel' }, 4000);
    expect(cancelled.snapshot!.pending).toBeNull();
    expect(online.applyHostMove(move('b0c2'), 5000).accepted).toBe(true);
  });

  it('求和被走子隐式拒绝，明确同意则和棋', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('k'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('l'.repeat(16), { type: 'draw-offer' }, 3000);
    const cleared = online.applyHostMove(move('b0c2'), 4000);
    expect(cleared.accepted).toBe(true);
    expect(cleared.snapshot!.pending).toBeNull();

    const second = game('red');
    second.applyHostMove(move('h2e2'), 1000);
    second.applyGuestAction('m'.repeat(16), { type: 'draw-offer' }, 2000);
    const draw = second.hostDrawResponse(true, 3000);
    expect(draw.snapshot!.phase).toBe('ended');
    expect(draw.snapshot!.result).toBe('draw');
    expect(draw.snapshot!.endReason).toBe('agreement');
  });

  it('房主发起的求和被客人同意后结束', () => {
    const online = game('red');
    const offer = online.hostDrawOffer(1000);
    expect(offer.snapshot!.pending).toEqual({ kind: 'draw', by: 'red' });
    const reply = online.applyGuestAction(
      'n'.repeat(16),
      { type: 'draw-response', accept: true },
      2000,
    );
    expect(reply.snapshot!.phase).toBe('ended');
    expect(reply.snapshot!.result).toBe('draw');
    expect(reply.snapshot!.endReason).toBe('agreement');
  });

  it('认输、断线暂停与断线判负', () => {
    const resigning = game('red');
    const resigned = resigning.applyGuestAction('o'.repeat(16), { type: 'resign' }, 1000);
    expect(resigned.snapshot!.result).toBe('red_win');
    expect(resigned.snapshot!.endReason).toBe('resign');

    const online = game('red');
    const paused = online.onGuestDisconnected(1000);
    expect(paused.paused).toBe(true);
    expect(online.checkTimeout(300_000)).toBeNull();
    const resumed = online.onGuestReconnected(300_000);
    expect(resumed.paused).toBe(false);
    const lost = online.onGuestTimeout(300_000);
    expect(lost.result).toBe('red_win');
    expect(lost.endReason).toBe('disconnect');
  });

  it('房主中止对局', () => {
    const online = game('red');
    const before = online.snapshot(0).rev;
    const after = online.endByHostAbort(1000);
    expect(after.rev).toBe(before + 1);
    expect(after.result).toBe('aborted');
    expect(after.endReason).toBe('aborted');
  });
});

describe('联机对局控制器（分支补充）', () => {
  it('快照携带初始 FEN、完整棋谱与单调递增的 rev', () => {
    const online = new OnlineGame('red', 0);
    expect(online.hostSide).toBe('red');
    expect(online.guestSide).toBe('black');

    const started = online.begin(0);
    expect(started.version).toBe(PROTOCOL_VERSION);
    expect(started.initialFen).toBe(INITIAL_FEN);
    expect(started.result).toBeNull();
    expect(started.endReason).toBeNull();
    expect(started.paused).toBe(false);
    expect(started.message).toBeNull();

    const first = online.applyHostMove(move('h2e2'), 1000);
    expect(first.snapshot!.rev).toBe(started.rev + 1);

    const idle = online.snapshot(2000);
    expect(idle.rev).toBe(first.snapshot!.rev);
    expect(idle.initialFen).toBe(INITIAL_FEN);
    expect(idle.moves).toEqual(['h2e2']);

    const rejected = online.applyGuestAction('p'.repeat(16), { type: 'move', uci: 'a9b9' }, 2000);
    expect(rejected.accepted).toBe(false);
    expect(rejected.snapshot!.rev).toBe(first.snapshot!.rev);

    const guest = online.applyGuestAction('q'.repeat(16), { type: 'move', uci: 'h7e7' }, 3000);
    expect(guest.snapshot!.rev).toBe(first.snapshot!.rev + 1);
    expect(guest.snapshot!.moves).toEqual(['h2e2', 'h7e7']);
    expect(guest.snapshot!.initialFen).toBe(INITIAL_FEN);
  });

  it('房主执黑时客人执红，红方仍先行', () => {
    const online = new OnlineGame('black', 0);
    expect(online.guestSide).toBe('red');
    const started = online.begin(0);
    expect(started.hostSide).toBe('black');
    expect(started.clock.turn).toBe('red');
    const guest = online.applyGuestAction('r'.repeat(16), { type: 'move', uci: 'h2e2' }, 1000);
    expect(guest.accepted).toBe(true);
    expect(guest.snapshot!.clock.turn).toBe('black');
  });

  it('拒绝悔棋后棋局与棋钟继续推进，时间不退还', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('s'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('t'.repeat(16), { type: 'undo-request' }, 3000);

    const rejected = online.hostUndoResponse(false, 4000);
    expect(rejected.accepted).toBe(true);
    expect(rejected.message).not.toBeNull();
    expect(rejected.snapshot!.pending).toBeNull();
    expect(rejected.snapshot!.phase).toBe('playing');
    expect(rejected.snapshot!.moves).toEqual(['h2e2', 'h7e7']);
    expect(rejected.snapshot!.clock.turn).toBe('red');
    expect(rejected.snapshot!.clock.redMs).toBe(TOTAL_MS - 3000);
    expect(online.applyHostMove(move('b0c2'), 5000).accepted).toBe(true);
  });

  it('请求方不能回应自己的请求，房主可撤回自己的悔棋请求', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('u'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    const request = online.hostUndoRequest(3000);
    expect(request.accepted).toBe(true);
    expect(request.snapshot!.pending).toEqual({ kind: 'undo', by: 'red' });

    const own = online.hostUndoResponse(true, 4000);
    expect(own.accepted).toBe(false);
    expect(own.snapshot!.moves).toEqual(['h2e2', 'h7e7']);
    expect(own.snapshot!.pending).toEqual({ kind: 'undo', by: 'red' });

    const cancel = online.hostUndoCancel(5000);
    expect(cancel.accepted).toBe(true);
    expect(cancel.snapshot!.pending).toBeNull();
    expect(online.applyHostMove(move('b0c2'), 6000).accepted).toBe(true);
  });

  it('明确拒绝求和后对局继续', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('v'.repeat(16), { type: 'draw-offer' }, 2000);

    const rejected = online.hostDrawResponse(false, 3000);
    expect(rejected.accepted).toBe(true);
    expect(rejected.snapshot!.phase).toBe('playing');
    expect(rejected.snapshot!.result).toBeNull();
    expect(rejected.snapshot!.pending).toBeNull();
    expect(online.applyGuestAction('w'.repeat(16), { type: 'move', uci: 'h7e7' }, 4000).accepted).toBe(
      true,
    );
  });

  it('总时耗尽判负', () => {
    const online = game('red');
    const redMoves = ['b2b3', 'b3b4', 'b4b5', 'b5b6', 'h2h3', 'h3h4', 'h4h5', 'h5h6'];
    const blackMoves = ['a6a5', 'a5a4', 'c6c5', 'c5c4', 'e6e5', 'e5e4', 'g6g5', 'g5g4'];
    let now = 0;
    for (let index = 0; index < redMoves.length; index += 1) {
      now += STEP_MS - 1;
      const host = online.applyHostMove(move(redMoves[index]), now);
      expect(host.accepted).toBe(true);
      now += STEP_MS - 1;
      const guest = online.applyGuestAction(
        `x${index}`.padEnd(16, 'x'),
        { type: 'move', uci: blackMoves[index] },
        now,
      );
      expect(guest.accepted).toBe(true);
    }
    expect(online.clockNow(now).redMs).toBe(TOTAL_MS - 8 * (STEP_MS - 1));

    const ended = online.checkTimeout(now + 9);
    expect(ended?.phase).toBe('ended');
    expect(ended?.result).toBe('black_win');
    expect(ended?.endReason).toBe('timeout_total');
  });

  it('断线暂停期间不扣时，重连后从冻结值继续', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);

    const paused = online.onGuestDisconnected(10_000);
    expect(paused.paused).toBe(true);
    expect(paused.clock.running).toBe(false);
    expect(paused.clock.blackMs).toBe(TOTAL_MS - 9000);
    expect(paused.message).toBe('对方断线，等待重连');
    expect(online.checkTimeout(10_000 + DISCONNECT_GRACE_MS)).toBeNull();

    const resumed = online.onGuestReconnected(300_000);
    expect(resumed.paused).toBe(false);
    expect(resumed.clock.running).toBe(true);
    expect(resumed.message).toBeNull();
    expect(resumed.clock.blackMs).toBe(TOTAL_MS - 9000);
    expect(online.clockNow(305_000).blackMs).toBe(TOTAL_MS - 14_000);
  });

  it('断线暂停期间同意悔棋，棋钟保持冻结', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('y'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('z'.repeat(16), { type: 'undo-request' }, 3000);
    online.onGuestDisconnected(4000);

    const response = online.hostUndoResponse(true, 5000);
    expect(response.snapshot!.moves).toEqual(['h2e2']);
    expect(response.snapshot!.paused).toBe(true);
    expect(response.snapshot!.clock.running).toBe(false);

    const resumed = online.onGuestReconnected(300_000);
    expect(resumed.clock.running).toBe(true);
    expect(resumed.clock.turn).toBe('black');
    expect(resumed.clock.redMs).toBe(TOTAL_MS - 1000);
    expect(resumed.clock.blackMs).toBe(TOTAL_MS);
    expect(online.clockNow(305_000).blackMs).toBe(TOTAL_MS - 5000);
  });

  it('结束后拒绝新的动作', () => {
    const online = game('red');
    online.applyGuestAction('A'.repeat(16), { type: 'resign' }, 1000);
    const late = online.applyHostMove(move('h2e2'), 2000);
    expect(late.accepted).toBe(false);
    expect(late.snapshot!.moves).toEqual([]);
    expect(late.snapshot!.phase).toBe('ended');
    expect(online.applyGuestAction('B'.repeat(16), { type: 'resign' }, 2000).accepted).toBe(false);
  });
});