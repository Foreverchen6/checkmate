# 联机对战（内网穿透）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Electron 象棋软件中加入房主权威的联机对战：生成内网穿透邀请 URL、单客加入审批、20:00+2:30 棋钟、断线重连、悔棋/求和，并保证任何退出路径都不遗留穿透进程。

**Architecture:** 房主渲染进程持有唯一权威的 `Game`、棋钟与请求裁决；Electron 主进程只运行 `127.0.0.1` HTTP 服务、HTTP 长轮询和进程内 `localtunnel` 客户端；客人通过全量快照重建棋局。穿透没有子进程，所有资源由幂等 `OnlineSession.stop()` 统一关闭。

**Tech Stack:** Node 24、TypeScript、Electron 45、esbuild、Vitest 3、Playwright-core、`localtunnel`（纯 JS，主进程内运行）。

**Spec:** `docs/superpowers/specs/2026-11-20-online-play-design.md`

## Global Constraints

- 项目根目录：`D:\VSCodeProject\checkmate`。Bash 每次会重置工作目录，所有命令必须前缀 `cd /d/VSCodeProject/checkmate && ...`。
- 系统 `node.exe` 启动即段错误。所有 Node 命令必须使用 Electron 运行时：
  `ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe"`。
- **禁止**在联机代码中使用 `child_process`、`spawn`、`exec`、`fork`、`worker_threads`。穿透只能使用主进程内的 `localtunnel` 库。
- 真实 Pikafish 2026-09-25 与 `pikafish.nnue` 是硬依赖，测试不得改用桩引擎。
- 未经用户明确授权，不执行 `git commit` 或 `git push`；每个任务末尾的提交步骤只在获得授权后执行。
- 联机期间主进程与渲染进程都要禁用 `engine:search`；会话结束后恢复。
- 计时常量固定为总时 `1_200_000ms`、单步 `150_000ms`；断线宽限 `12_000ms`；重连窗口 `120_000ms`。
- 协议最多 1000 个半回合；请求体上限 16 KB；令牌为 43 字符 base64url。

---

### Task 1: 协议类型、邀请 URL 与结束原因

**Files:**
- Create: `src/net/protocol.ts`
- Test: `tests/net/protocol.test.ts`
- Modify: `src/types.ts:28-35`
- Modify: `src/storage/archive.ts:14-21`
- Modify: `src/ui/app.ts:60-67`
- Test: `tests/storage/archive.test.ts`

**Interfaces:**
- Consumes: `EndReason`、`GameResult`、`Side` from `src/types.ts`；`INITIAL_FEN` 仅用于测试。
- Produces:
  - `PROTOCOL_VERSION = 1`、`TOTAL_MS = 1_200_000`、`STEP_MS = 150_000`、`MAX_MOVES = 1000`
  - `LOBBY_IDLE_MS = 1_800_000`、`ENDED_IDLE_MS = 600_000`、`DISCONNECT_GRACE_MS = 12_000`、`RECONNECT_WINDOW_MS = 120_000`、`POLL_HOLD_MS = 25_000`、`ACTION_TIMEOUT_MS = 5_000`
  - `OnlinePhase = 'lobby' | 'playing' | 'ended'`、`OnlineRole = 'host' | 'guest'`
  - `ClockSnapshot`、`PendingRequest`、`OnlineSnapshot`、`GuestAction`、`ActionReply`、`OnlineStatus`、`OnlineEvent`、`InviteInfo`
  - `parseInvite(input: string): InviteInfo`
  - `validateSnapshot(raw: unknown): OnlineSnapshot`
  - `validateGuestAction(raw: unknown): GuestAction`
  - `isActionId(value: string): boolean`

- [ ] **Step 1: 写协议失败测试**

Create `tests/net/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import {
  MAX_MOVES,
  PROTOCOL_VERSION,
  STEP_MS,
  TOTAL_MS,
  parseInvite,
  validateGuestAction,
  validateSnapshot,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: PROTOCOL_VERSION,
    rev: 1,
    phase: 'playing',
    hostSide: 'red',
    initialFen: INITIAL_FEN,
    moves: [],
    result: null,
    endReason: null,
    clock: {
      redMs: TOTAL_MS,
      blackMs: TOTAL_MS,
      stepMs: STEP_MS,
      turn: 'red',
      running: true,
    },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

describe('邀请 URL', () => {
  it('解析 https 隧道地址与 fragment 令牌', () => {
    expect(parseInvite(`https://abc.loca.lt/#${TOKEN}`)).toEqual({
      origin: 'https://abc.loca.lt',
      token: TOKEN,
    });
  });

  it('允许本机 http，供集成测试与冒烟使用', () => {
    expect(parseInvite(`http://127.0.0.1:4321/#${TOKEN}`)).toEqual({
      origin: 'http://127.0.0.1:4321',
      token: TOKEN,
    });
  });

  it('拒绝公网 http、错误协议、路径、查询串与错误令牌', () => {
    expect(() => parseInvite(`http://abc.loca.lt/#${TOKEN}`)).toThrow();
    expect(() => parseInvite(`javascript:alert(1)`)).toThrow();
    expect(() => parseInvite(`https://abc.loca.lt/path#${TOKEN}`)).toThrow();
    expect(() => parseInvite(`https://abc.loca.lt/?x=1#${TOKEN}`)).toThrow();
    expect(() => parseInvite('https://abc.loca.lt/#short')).toThrow();
    expect(() => parseInvite('https://abc.loca.lt/')).toThrow();
  });
});

describe('快照校验', () => {
  it('返回字段完整的快照副本', () => {
    const raw = snapshot();
    expect(validateSnapshot(raw)).toEqual(raw);
    expect(validateSnapshot(raw)).not.toBe(raw);
  });

  it('拒绝非法 revision、阶段与结束原因', () => {
    expect(() => validateSnapshot({ ...snapshot(), rev: 0 })).toThrow();
    expect(() => validateSnapshot({ ...snapshot(), phase: 'waiting' })).toThrow();
    expect(() => validateSnapshot({ ...snapshot(), endReason: 'timeout' })).toThrow();
  });

  it('拒绝非法着法与超长棋谱', () => {
    expect(() => validateSnapshot(snapshot({ moves: ['h2e2', 'bad'] }))).toThrow();
    expect(() =>
      validateSnapshot(snapshot({ moves: Array.from({ length: MAX_MOVES + 1 }, () => 'h2e2') })),
    ).toThrow();
  });

  it('校验棋钟与 pending 请求', () => {
    expect(() =>
      validateSnapshot(snapshot({ clock: { ...snapshot().clock, redMs: -1 } })),
    ).toThrow();
    expect(() =>
      validateSnapshot(snapshot({ pending: { kind: 'draw', by: 'green' as never } })),
    ).toThrow();
    expect(validateSnapshot(snapshot({ pending: { kind: 'undo', by: 'black' } })).pending).toEqual({
      kind: 'undo',
      by: 'black',
    });
  });
});

describe('客人动作校验', () => {
  it('接受白名单动作', () => {
    expect(validateGuestAction({ type: 'move', uci: 'h2e2' })).toEqual({
      type: 'move',
      uci: 'h2e2',
    });
    expect(validateGuestAction({ type: 'undo-response', accept: true })).toEqual({
      type: 'undo-response',
      accept: true,
    });
    expect(validateGuestAction({ type: 'resign' })).toEqual({ type: 'resign' });
  });

  it('拒绝未知类型、多余字段与错误类型', () => {
    expect(() => validateGuestAction({ type: 'chat', text: 'hi' })).toThrow();
    expect(() => validateGuestAction({ type: 'move', uci: 'h2e2', extra: 1 })).toThrow();
    expect(() => validateGuestAction({ type: 'draw-response', accept: 'yes' })).toThrow();
    expect(() => validateGuestAction(null)).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/protocol.test.ts
```
Expected: FAIL，提示无法解析 `../../src/net/protocol.ts`。

- [ ] **Step 3: 扩展结束原因**

Modify `src/types.ts`:

```ts
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'move_limit'
  | 'repetition'
  | 'resign'
  | 'aborted'
  | 'timeout_step'
  | 'timeout_total'
  | 'disconnect'
  | 'agreement';
```

Modify `src/storage/archive.ts`:

```ts
const REASONS = new Set<EndReason>([
  'checkmate',
  'stalemate',
  'move_limit',
  'repetition',
  'resign',
  'aborted',
  'timeout_step',
  'timeout_total',
  'disconnect',
  'agreement',
]);
```

Modify `src/ui/app.ts` 的 `REASON_TEXT`:

```ts
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
```

- [ ] **Step 4: 实现协议模块**

Create `src/net/protocol.ts`:

```ts
import type { EndReason, GameResult, Side } from '../types.ts';

export const PROTOCOL_VERSION = 1;
export const TOTAL_MS = 20 * 60_000;
export const STEP_MS = 2 * 60_000 + 30_000;
export const MAX_MOVES = 1000;
export const LOBBY_IDLE_MS = 30 * 60_000;
export const ENDED_IDLE_MS = 10 * 60_000;
export const DISCONNECT_GRACE_MS = 12_000;
export const RECONNECT_WINDOW_MS = 120_000;
export const POLL_HOLD_MS = 25_000;
export const ACTION_TIMEOUT_MS = 5_000;

export type OnlinePhase = 'lobby' | 'playing' | 'ended';
export type OnlineRole = 'host' | 'guest';

export interface ClockSnapshot {
  redMs: number;
  blackMs: number;
  stepMs: number;
  turn: Side;
  running: boolean;
}

export interface PendingRequest {
  kind: 'undo' | 'draw';
  by: Side;
}

export interface OnlineSnapshot {
  version: 1;
  rev: number;
  phase: OnlinePhase;
  hostSide: Side;
  initialFen: string;
  moves: string[];
  result: GameResult | null;
  endReason: EndReason | null;
  clock: ClockSnapshot;
  paused: boolean;
  pending: PendingRequest | null;
  message: string | null;
}

export type GuestAction =
  | { type: 'move'; uci: string }
  | { type: 'undo-request' }
  | { type: 'undo-response'; accept: boolean }
  | { type: 'undo-cancel' }
  | { type: 'draw-offer' }
  | { type: 'draw-response'; accept: boolean }
  | { type: 'resign' };

export interface ActionReply {
  accepted: boolean;
  message: string | null;
  snapshot: OnlineSnapshot | null;
}

export interface InviteInfo {
  origin: string;
  token: string;
}

export interface OnlineStatus {
  role: OnlineRole | null;
  phase: OnlinePhase | null;
  inviteUrl: string | null;
  guestConnected: boolean;
  approved: boolean;
  error: string | null;
}

export type OnlineEvent =
  | { type: 'status'; status: OnlineStatus }
  | { type: 'host-guest-joined' }
  | { type: 'host-guest-closed'; reason: string }
  | { type: 'host-action'; actionId: string; action: GuestAction }
  | { type: 'host-guest-disconnected' }
  | { type: 'host-guest-reconnected' }
  | { type: 'host-guest-timeout' }
  | { type: 'snapshot'; snapshot: OnlineSnapshot }
  | { type: 'closed'; reason: string };

const UCI_PATTERN = /^[a-i][0-9][a-i][0-9]$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIDES = new Set<Side>(['red', 'black']);
const PHASES = new Set<OnlinePhase>(['lobby', 'playing', 'ended']);
const RESULTS = new Set<GameResult>(['red_win', 'black_win', 'draw', 'aborted']);
const REASONS = new Set<EndReason>([
  'checkmate',
  'stalemate',
  'move_limit',
  'repetition',
  'resign',
  'aborted',
  'timeout_step',
  'timeout_total',
  'disconnect',
  'agreement',
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('数据格式不正确');
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error('数值超出范围');
  }
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error('文本长度不正确');
  }
  return value;
}

function side(value: unknown): Side {
  if (typeof value !== 'string' || !SIDES.has(value as Side)) {
    throw new Error('阵营无效');
  }
  return value as Side;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error('包含未知字段');
  }
}

function clock(value: unknown): ClockSnapshot {
  const raw = record(value);
  keys(raw, ['redMs', 'blackMs', 'stepMs', 'turn', 'running']);
  if (typeof raw.running !== 'boolean') throw new Error('棋钟状态无效');
  return {
    redMs: integer(raw.redMs, 0, TOTAL_MS),
    blackMs: integer(raw.blackMs, 0, TOTAL_MS),
    stepMs: integer(raw.stepMs, 0, STEP_MS),
    turn: side(raw.turn),
    running: raw.running,
  };
}

function pending(value: unknown): PendingRequest | null {
  if (value === null) return null;
  const raw = record(value);
  keys(raw, ['kind', 'by']);
  if (raw.kind !== 'undo' && raw.kind !== 'draw') throw new Error('请求类型无效');
  return { kind: raw.kind, by: side(raw.by) };
}

export function isActionId(value: string): boolean {
  return ACTION_ID_PATTERN.test(value);
}

export function parseInvite(input: string): InviteInfo {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('邀请链接格式不正确');
  }
  if (url.username || url.password) throw new Error('邀请链接格式不正确');
  if (url.protocol !== 'https:') {
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (!loopback) throw new Error('邀请链接必须使用 https');
  }
  if (url.pathname !== '/' || url.search) throw new Error('邀请链接格式不正确');
  const token = url.hash.replace(/^#/, '');
  if (!TOKEN_PATTERN.test(token)) throw new Error('邀请令牌无效');
  return { origin: url.origin, token };
}

export function validateSnapshot(raw: unknown): OnlineSnapshot {
  const value = record(raw);
  keys(value, [
    'version',
    'rev',
    'phase',
    'hostSide',
    'initialFen',
    'moves',
    'result',
    'endReason',
    'clock',
    'paused',
    'pending',
    'message',
  ]);
  if (value.version !== PROTOCOL_VERSION) throw new Error('协议版本不匹配');
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as OnlinePhase)) {
    throw new Error('对局阶段无效');
  }
  if (!Array.isArray(value.moves) || value.moves.length > MAX_MOVES) {
    throw new Error('棋谱长度无效');
  }
  const moves = value.moves.map((move) => {
    if (typeof move !== 'string' || !UCI_PATTERN.test(move)) throw new Error('着法格式无效');
    return move;
  });
  if (value.result !== null && (typeof value.result !== 'string' || !RESULTS.has(value.result as GameResult))) {
    throw new Error('结果无效');
  }
  if (
    value.endReason !== null &&
    (typeof value.endReason !== 'string' || !REASONS.has(value.endReason as EndReason))
  ) {
    throw new Error('结束原因无效');
  }
  if (typeof value.paused !== 'boolean') throw new Error('暂停状态无效');
  if (value.message !== null && (typeof value.message !== 'string' || value.message.length > 200)) {
    throw new Error('提示信息无效');
  }
  return {
    version: PROTOCOL_VERSION,
    rev: integer(value.rev, 1, 1_000_000_000),
    phase: value.phase as OnlinePhase,
    hostSide: side(value.hostSide),
    initialFen: text(value.initialFen, 200),
    moves,
    result: value.result as GameResult | null,
    endReason: value.endReason as EndReason | null,
    clock: clock(value.clock),
    paused: value.paused,
    pending: pending(value.pending),
    message: value.message as string | null,
  };
}

export function validateGuestAction(raw: unknown): GuestAction {
  const value = record(raw);
  switch (value.type) {
    case 'move':
      keys(value, ['type', 'uci']);
      if (typeof value.uci !== 'string' || !UCI_PATTERN.test(value.uci)) {
        throw new Error('着法格式无效');
      }
      return { type: 'move', uci: value.uci };
    case 'undo-response':
    case 'draw-response':
      keys(value, ['type', 'accept']);
      if (typeof value.accept !== 'boolean') throw new Error('回应格式无效');
      return { type: value.type, accept: value.accept };
    case 'undo-request':
    case 'undo-cancel':
    case 'draw-offer':
    case 'resign':
      keys(value, ['type']);
      return { type: value.type };
    default:
      throw new Error('动作类型无效');
  }
}
```

- [ ] **Step 5: 补充存档新结束原因测试**

Append to `tests/storage/archive.test.ts` inside the top-level `describe` that already exists:

```ts
it('接受联机新增的结束原因', () => {
  for (const reason of ['timeout_step', 'timeout_total', 'disconnect', 'agreement'] as const) {
    const saved = sanitizeSavedGame({ ...sample(), endReason: reason });
    expect(saved.endReason).toBe(reason);
  }
});
```

- [ ] **Step 6: 运行测试与类型检查**

Run:
```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/protocol.test.ts tests/storage/archive.test.ts
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/typescript/bin/tsc --noEmit
```
Expected: 两个测试文件全 PASS，类型检查无错误。

- [ ] **Step 7: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/net/protocol.ts tests/net/protocol.test.ts src/types.ts src/storage/archive.ts src/ui/app.ts tests/storage/archive.test.ts
git commit -m "feat: add online protocol types and end reasons"
```

---

### Task 2: 棋钟模型

**Files:**
- Create: `src/net/clock.ts`
- Test: `tests/net/clock.test.ts`

**Interfaces:**
- Consumes: `TOTAL_MS`、`STEP_MS`、`ClockSnapshot` from `src/net/protocol.ts`；`Side` from `src/types.ts`。
- Produces:
  - `ClockState { redMs; blackMs; stepMs; turn; running; updatedAt }`
  - `createClock(turn: Side, now: number): ClockState`
  - `tick(state: ClockState, now: number): ClockState`
  - `pause(state: ClockState, now: number): ClockState`
  - `resume(state: ClockState, now: number): ClockState`
  - `commitMove(state, now, mover): { state: ClockState; timeout: 'step' | 'total' | null }`
  - `checkTimeout(state: ClockState, now: number): 'step' | 'total' | null`
  - `clockSnapshot(state: ClockState): ClockSnapshot`
  - `restoreClock(clock: ClockSnapshot, now: number): ClockState`

- [ ] **Step 1: 写棋钟失败测试**

Create `tests/net/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkTimeout,
  clockSnapshot,
  commitMove,
  createClock,
  pause,
  restoreClock,
  resume,
  tick,
} from '../../src/net/clock.ts';
import { STEP_MS, TOTAL_MS } from '../../src/net/protocol.ts';

describe('棋钟', () => {
  it('双方从 20 分钟起步，红方单步 2 分半', () => {
    const clock = createClock('red', 0);
    expect(clock.redMs).toBe(TOTAL_MS);
    expect(clock.blackMs).toBe(TOTAL_MS);
    expect(clock.stepMs).toBe(STEP_MS);
    expect(clock.turn).toBe('red');
    expect(clock.running).toBe(true);
  });

  it('只扣当前行棋方的总时与单步', () => {
    const clock = tick(createClock('red', 0), 61_000);
    expect(clock.redMs).toBe(TOTAL_MS - 61_000);
    expect(clock.blackMs).toBe(TOTAL_MS);
    expect(clock.stepMs).toBe(STEP_MS - 61_000);
  });

  it('走子后切换行棋方并把新单步重置为 2 分半', () => {
    const result = commitMove(createClock('red', 0), 10_000, 'red');
    expect(result.timeout).toBeNull();
    expect(result.state.turn).toBe('black');
    expect(result.state.stepMs).toBe(STEP_MS);
    expect(result.state.redMs).toBe(TOTAL_MS - 10_000);
  });

  it('拒绝非行棋方走子', () => {
    expect(() => commitMove(createClock('red', 0), 1000, 'black')).toThrow();
  });

  it('单步耗尽判 step，总时耗尽判 total', () => {
    expect(checkTimeout(createClock('red', 0), STEP_MS + 1)).toBe('step');
    const low = { ...createClock('red', 0), redMs: 100, stepMs: 1000 };
    expect(checkTimeout(low, 150)).toBe('total');
  });

  it('走子时超时返回原因，不切换行棋方', () => {
    const result = commitMove(createClock('red', 0), STEP_MS + 1, 'red');
    expect(result.timeout).toBe('step');
    expect(result.state.turn).toBe('red');
    expect(result.state.stepMs).toBe(0);
  });

  it('暂停期间不扣时，恢复后继续', () => {
    const paused = pause(createClock('red', 0), 10_000);
    const still = tick(paused, 200_000);
    expect(still.redMs).toBe(TOTAL_MS - 10_000);
    expect(still.stepMs).toBe(STEP_MS - 10_000);
    const resumed = resume(still, 200_000);
    expect(tick(resumed, 205_000).redMs).toBe(TOTAL_MS - 15_000);
  });

  it('快照与恢复往返一致', () => {
    const state = tick(createClock('black', 1000), 5000);
    const restored = restoreClock(clockSnapshot(state), 9000);
    expect(restored.redMs).toBe(state.redMs);
    expect(restored.blackMs).toBe(state.blackMs);
    expect(restored.stepMs).toBe(state.stepMs);
    expect(restored.turn).toBe(state.turn);
    expect(restored.running).toBe(state.running);
    expect(restored.updatedAt).toBe(9000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/clock.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现棋钟**

Create `src/net/clock.ts`:

```ts
import type { Side } from '../types.ts';
import { STEP_MS, TOTAL_MS, type ClockSnapshot } from './protocol.ts';

export interface ClockState {
  redMs: number;
  blackMs: number;
  stepMs: number;
  turn: Side;
  running: boolean;
  updatedAt: number;
}

export function createClock(turn: Side, now: number): ClockState {
  return {
    redMs: TOTAL_MS,
    blackMs: TOTAL_MS,
    stepMs: STEP_MS,
    turn,
    running: true,
    updatedAt: now,
  };
}

export function tick(state: ClockState, now: number): ClockState {
  if (!state.running) return { ...state, updatedAt: now };
  const elapsed = Math.max(0, now - state.updatedAt);
  if (state.turn === 'red') {
    return {
      ...state,
      redMs: Math.max(0, state.redMs - elapsed),
      stepMs: Math.max(0, state.stepMs - elapsed),
      updatedAt: now,
    };
  }
  return {
    ...state,
    blackMs: Math.max(0, state.blackMs - elapsed),
    stepMs: Math.max(0, state.stepMs - elapsed),
    updatedAt: now,
  };
}

export function pause(state: ClockState, now: number): ClockState {
  return { ...tick(state, now), running: false, updatedAt: now };
}

export function resume(state: ClockState, now: number): ClockState {
  return { ...state, running: true, updatedAt: now };
}

export function remainingTotal(state: ClockState): number {
  return state.turn === 'red' ? state.redMs : state.blackMs;
}

export function checkTimeout(state: ClockState, now: number): 'step' | 'total' | null {
  const next = tick(state, now);
  if (next.stepMs <= 0) return 'step';
  if (remainingTotal(next) <= 0) return 'total';
  return null;
}

export function commitMove(
  state: ClockState,
  now: number,
  mover: Side,
): { state: ClockState; timeout: 'step' | 'total' | null } {
  if (!state.running) throw new Error('棋钟已暂停');
  if (state.turn !== mover) throw new Error('未轮到该方走子');
  const next = tick(state, now);
  if (next.stepMs <= 0) return { state: next, timeout: 'step' };
  if (remainingTotal(next) <= 0) return { state: next, timeout: 'total' };
  return {
    state: {
      ...next,
      turn: mover === 'red' ? 'black' : 'red',
      stepMs: STEP_MS,
      updatedAt: now,
    },
    timeout: null,
  };
}

export function clockSnapshot(state: ClockState): ClockSnapshot {
  return {
    redMs: state.redMs,
    blackMs: state.blackMs,
    stepMs: state.stepMs,
    turn: state.turn,
    running: state.running,
  };
}

export function restoreClock(clock: ClockSnapshot, now: number): ClockState {
  return {
    redMs: clock.redMs,
    blackMs: clock.blackMs,
    stepMs: clock.stepMs,
    turn: clock.turn,
    running: clock.running,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/clock.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/net/clock.ts tests/net/clock.test.ts
git commit -m "feat: add online match clock"
```

---

### Task 3: 快照重建客人棋局

**Files:**
- Create: `src/net/snapshotGame.ts`
- Test: `tests/net/snapshotGame.test.ts`

**Interfaces:**
- Consumes: `Game` from `src/game/game.ts`；`parseUciMove` from `src/notation/coords.ts`；`OnlineSnapshot` from `src/net/protocol.ts`。
- Produces: `gameFromSnapshot(snapshot: OnlineSnapshot): Game`。
- 规则：按 `initialFen` + `moves` 逐手调用 `Game.move`；非法着法抛错；快照带结果时覆盖 `game.result` 与 `game.endReason`。

- [ ] **Step 1: 写快照重建失败测试**

Create `tests/net/snapshotGame.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/rules/board.ts';
import { STEP_MS, TOTAL_MS, type OnlineSnapshot } from '../../src/net/protocol.ts';
import { gameFromSnapshot } from '../../src/net/snapshotGame.ts';

function snapshot(overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev: 1,
    phase: 'playing',
    hostSide: 'red',
    initialFen: INITIAL_FEN,
    moves: ['h2e2', 'h7e7'],
    result: null,
    endReason: null,
    clock: { redMs: TOTAL_MS, blackMs: TOTAL_MS, stepMs: STEP_MS, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

describe('快照重建', () => {
  it('按着法重建棋局并生成中文记谱', () => {
    const game = gameFromSnapshot(snapshot());
    expect(game.history).toHaveLength(2);
    expect(game.history[0].chinese).toBe('炮二平五');
    expect(game.history[1].chinese).toBe('炮8平5');
    expect(game.fen()).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 0 2');
  });

  it('快照结果覆盖回放无法推导的超时结果', () => {
    const game = gameFromSnapshot(
      snapshot({ result: 'black_win', endReason: 'timeout_step', phase: 'ended' }),
    );
    expect(game.result).toBe('black_win');
    expect(game.endReason).toBe('timeout_step');
  });

  it('拒绝非法着法', () => {
    expect(() => gameFromSnapshot(snapshot({ moves: ['h2e2', 'h2e2'] }))).toThrow(
      /第 2 手/,
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/snapshotGame.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现重建**

Create `src/net/snapshotGame.ts`:

```ts
import { Game } from '../game/game.ts';
import { parseUciMove } from '../notation/coords.ts';
import type { OnlineSnapshot } from './protocol.ts';

export function gameFromSnapshot(snapshot: OnlineSnapshot): Game {
  const game = new Game(snapshot.initialFen);

  snapshot.moves.forEach((uci, index) => {
    const move = parseUciMove(uci);
    if (!move) throw new Error(`第 ${index + 1} 手坐标无效：${uci}`);
    try {
      game.move(move);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`第 ${index + 1} 手无法重放（${uci}）：${detail}`);
    }
  });

  if (snapshot.result !== null) {
    game.result = snapshot.result;
    game.endReason = snapshot.endReason;
  }

  return game;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/snapshotGame.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/net/snapshotGame.ts tests/net/snapshotGame.test.ts
git commit -m "feat: rebuild guest game from online snapshot"
```

---

### Task 4: 房主权威对局控制器

**Files:**
- Create: `src/net/onlineGame.ts`
- Test: `tests/net/onlineGame.test.ts`

**Interfaces:**
- Consumes: `Game`、`INITIAL_FEN`、`parseUciMove`、`toUciMove`、`opposite`、`OnlineSnapshot`、`GuestAction`、`ActionReply`、棋钟函数。
- Produces:
  - `class OnlineGame`
  - `constructor(hostSide: Side, now: number)`
  - `readonly game: Game`、`readonly hostSide: Side`、`get guestSide(): Side`
  - `begin(now): OnlineSnapshot`
  - `applyHostMove(move: Move, now): ActionReply`
  - `applyGuestAction(actionId: string, action: GuestAction, now): ActionReply`
  - `hostUndoRequest(now)`、`hostUndoResponse(accept, now)`、`hostUndoCancel(now)`
  - `hostDrawOffer(now)`、`hostDrawResponse(accept, now)`、`hostResign(now)`
  - `checkTimeout(now): OnlineSnapshot | null`
  - `onGuestDisconnected(now)`、`onGuestReconnected(now)`、`onGuestTimeout(now)`
  - `endByHostAbort(now)`
  - `snapshot(now): OnlineSnapshot`、`clockNow(now): ClockSnapshot`

- [ ] **Step 1: 写控制器失败测试**

Create `tests/net/onlineGame.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OnlineGame } from '../../src/net/onlineGame.ts';
import { STEP_MS, TOTAL_MS } from '../../src/net/protocol.ts';
import { parseUciMove } from '../../src/notation/coords.ts';

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
    expect(first.snapshot.moves).toEqual(['h2e2']);
    expect(first.snapshot.clock.turn).toBe('black');
    expect(first.snapshot.clock.redMs).toBe(TOTAL_MS - 1000);
    expect(first.snapshot.clock.stepMs).toBe(STEP_MS);

    const second = online.applyGuestAction('a'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    expect(second.accepted).toBe(true);
    expect(second.snapshot.moves).toEqual(['h2e2', 'h7e7']);
    expect(second.snapshot.clock.turn).toBe('red');
    expect(second.snapshot.clock.blackMs).toBe(TOTAL_MS - 1000);
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
    expect(again.snapshot.moves).toEqual(['h2e2', 'h7e7']);
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
    expect(request.snapshot.pending).toEqual({ kind: 'undo', by: 'black' });

    const blocked = online.applyHostMove(move('b0c2'), 4000);
    expect(blocked.accepted).toBe(false);

    const response = online.hostUndoResponse(true, 5000);
    expect(response.accepted).toBe(true);
    expect(response.snapshot.moves).toEqual(['h2e2']);
    expect(response.snapshot.clock.turn).toBe('black');
    expect(response.snapshot.clock.redMs).toBe(TOTAL_MS - 1000);
    expect(response.snapshot.clock.blackMs).toBe(TOTAL_MS);
    expect(response.snapshot.pending).toBeNull();
  });

  it('撤销悔棋后可正常走子', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('h'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('i'.repeat(16), { type: 'undo-request' }, 3000);
    const cancelled = online.applyGuestAction('j'.repeat(16), { type: 'undo-cancel' }, 4000);
    expect(cancelled.snapshot.pending).toBeNull();
    expect(online.applyHostMove(move('b0c2'), 5000).accepted).toBe(true);
  });

  it('求和被走子隐式拒绝，明确同意则和棋', () => {
    const online = game('red');
    online.applyHostMove(move('h2e2'), 1000);
    online.applyGuestAction('k'.repeat(16), { type: 'move', uci: 'h7e7' }, 2000);
    online.applyGuestAction('l'.repeat(16), { type: 'draw-offer' }, 3000);
    const cleared = online.applyHostMove(move('b0c2'), 4000);
    expect(cleared.accepted).toBe(true);
    expect(cleared.snapshot.pending).toBeNull();

    const second = game('red');
    second.applyHostMove(move('h2e2'), 1000);
    second.applyGuestAction('m'.repeat(16), { type: 'draw-offer' }, 2000);
    const draw = second.hostDrawResponse(true, 3000);
    expect(draw.snapshot.phase).toBe('ended');
    expect(draw.snapshot.result).toBe('draw');
    expect(draw.snapshot.endReason).toBe('agreement');
  });

  it('房主发起的求和被客人同意后结束', () => {
    const online = game('red');
    const offer = online.hostDrawOffer(1000);
    expect(offer.snapshot.pending).toEqual({ kind: 'draw', by: 'red' });
    const reply = online.applyGuestAction(
      'n'.repeat(16),
      { type: 'draw-response', accept: true },
      2000,
    );
    expect(reply.snapshot.phase).toBe('ended');
    expect(reply.snapshot.result).toBe('draw');
    expect(reply.snapshot.endReason).toBe('agreement');
  });

  it('认输、断线暂停与断线判负', () => {
    const resigning = game('red');
    const resigned = resigning.applyGuestAction('o'.repeat(16), { type: 'resign' }, 1000);
    expect(resigned.snapshot.result).toBe('red_win');
    expect(resigned.snapshot.endReason).toBe('resign');

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
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net/onlineGame.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现控制器**

Create `src/net/onlineGame.ts`:

```ts
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
```

- [ ] **Step 4: 全量运行测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/net
```
Expected: 4 个测试文件全 PASS。

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/net/onlineGame.ts tests/net/onlineGame.test.ts
git commit -m "feat: add host-authoritative online game controller"
```

### Task 5: 本地房主 HTTP 服务

**Files:**
- Create: `electron/online/hostServer.ts`
- Test: `tests/electron/hostServer.test.ts`

**Interfaces:**
- Consumes: `validateGuestAction`、`validateSnapshot`、协议常量、`ActionReply`、`GuestAction`、`OnlineSnapshot`。
- Produces:
  - `class HostServer`
  - `constructor(options: HostServerOptions)`，其中 `onAction(actionId, action): Promise<ActionReply>` 是必需回调
  - `listen(port?): Promise<number>`、`close(): Promise<void>`（幂等）
  - `approve(): boolean`、`reject(): boolean`
  - `publish(snapshot: OnlineSnapshot): void`
  - `checkLiveness(now?): void`
  - `get port()`、`get address()`、`get status(): HostServerStatus`

- [ ] **Step 1: 写回环集成测试**

Create `tests/electron/hostServer.test.ts`:

```ts
import { createServer, request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HostServer, type HostServerOptions } from '../../electron/online/hostServer.ts';
import type { ActionReply, OnlineSnapshot } from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(rev: number, overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev,
    phase: 'playing',
    hostSide: 'red',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [],
    result: null,
    endReason: null,
    clock: { redMs: 1_200_000, blackMs: 1_200_000, stepMs: 150_000, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

function reply(accepted: boolean, message: string | null, snap: OnlineSnapshot): ActionReply {
  return { accepted, message, snapshot: snap };
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function call(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function post(
  port: number,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  return call(port, 'POST', path, body, headers);
}

function get(port: number, path: string, headers?: Record<string, string>): Promise<JsonResponse> {
  return call(port, 'GET', path, undefined, headers);
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待状态超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function approvedServer(
  onAction: HostServerOptions['onAction'],
  extra: Partial<HostServerOptions> = {},
): Promise<{ server: HostServer; port: number }> {
  const server = new HostServer({ token: TOKEN, onAction, ...extra });
  const port = await server.listen();
  const joinPromise = post(port, '/xq/v1/join', {});
  await waitFor(() => server.status.guestPresent);
  server.approve();
  const join = await joinPromise;
  expect(join.status).toBe(200);
  server.publish(snapshot(1));
  return { server, port };
}

describe('房主本地 HTTP 服务', () => {
  it('只绑定回环地址并校验令牌', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      expect(server.address).toBe('127.0.0.1');
      const anonymous = await post(port, '/xq/v1/join', {}, { authorization: '' });
      expect(anonymous.status).toBe(401);
      const wrong = await post(
        port,
        '/xq/v1/join',
        {},
        { authorization: `Bearer ${'b'.repeat(43)}` },
      );
      expect(wrong.status).toBe(401);
      const missing = await get(port, '/xq/v1/poll?rev=0', { authorization: '' });
      expect(missing.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('加入需要房主同意，拒绝后可再次加入', async () => {
    const server = new HostServer({
      token: TOKEN,
      onAction: async () => reply(true, null, snapshot(1)),
    });
    const port = await server.listen();
    try {
      const pending = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.status.approved).toBe(false);

      const notYet = await get(port, '/xq/v1/poll?rev=0');
      expect(notYet.status).toBe(403);
      const earlyAction = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(earlyAction.status).toBe(403);

      expect(server.reject()).toBe(true);
      const rejected = await pending;
      expect(rejected.status).toBe(403);
      expect(rejected.body).toMatchObject({ error: { code: 'rejected' } });

      const retry = post(port, '/xq/v1/join', {});
      await waitFor(() => server.status.guestPresent);
      expect(server.approve()).toBe(true);
      expect((await retry).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('已有客人时再次加入返回 409', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const busy = await post(port, '/xq/v1/join', {});
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ error: { code: 'busy' } });
    } finally {
      await server.close();
    }
  });

  it('长轮询在 rev 落后时立即返回，并在发布后唤醒', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    try {
      const immediate = await get(port, '/xq/v1/poll?rev=0');
      expect(immediate.status).toBe(200);
      expect((immediate.body as OnlineSnapshot).rev).toBe(1);

      const hanging = get(port, '/xq/v1/poll?rev=1');
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.publish(snapshot(2, { moves: ['h2e2'] }));
      const woken = await hanging;
      expect(woken.status).toBe(200);
      expect(woken.body).toMatchObject({ rev: 2, moves: ['h2e2'] });
    } finally {
      await server.close();
    }
  });

  it('无新快照时长轮询在挂起上限后返回 204', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      pollHoldMs: 30,
    });
    try {
      const timedOut = await get(port, '/xq/v1/poll?rev=1');
      expect(timedOut.status).toBe(204);
      expect(timedOut.body).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('客人动作经 onAction 处理后返回最新快照', async () => {
    const seen: string[] = [];
    const { server, port } = await approvedServer(async (actionId, action) => {
      seen.push(actionId);
      expect(action).toEqual({ type: 'move', uci: 'h7e7' });
      return reply(true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] }));
    });
    try {
      const response = await post(port, '/xq/v1/action', { type: 'move', uci: 'h7e7' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ accepted: true, snapshot: { rev: 2 } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(server.status.rev).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('非法动作返回 400，房主超时返回 504', async () => {
    const { server, port } = await approvedServer(() => new Promise<ActionReply>(() => {}), {
      actionTimeoutMs: 30,
    });
    try {
      const bad = await post(port, '/xq/v1/action', { type: 'move', uci: 'zz' });
      expect(bad.status).toBe(400);
      const slow = await post(port, '/xq/v1/action', { type: 'undo-request' });
      expect(slow.status).toBe(504);
      expect(slow.body).toMatchObject({ error: { code: 'timeout' } });
    } finally {
      await server.close();
    }
  });

  it('心跳刷新在线状态，离线 12 秒后暂停、2 分钟判超时', async () => {
    let clock = 1000;
    const events: string[] = [];
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      now: () => clock,
      onGuestDisconnected: () => events.push('disconnected'),
      onGuestReconnected: () => events.push('reconnected'),
      onGuestTimeout: () => events.push('timeout'),
    });
    try {
      clock = 14_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected']);

      clock = 14_000;
      const pong = await post(port, '/xq/v1/ping', {});
      expect(pong.status).toBe(204);
      expect(events).toEqual(['disconnected', 'reconnected']);

      clock = 27_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected', 'reconnected', 'disconnected']);

      clock = 147_000;
      server.checkLiveness();
      expect(events).toEqual(['disconnected', 'reconnected', 'disconnected', 'timeout']);

      clock = 200_000;
      server.checkLiveness();
      expect(events).toHaveLength(4);
    } finally {
      await server.close();
    }
  });

  it('每令牌每秒超过 20 次请求返回 429', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)), {
      now: () => 1000,
    });
    try {
      for (let index = 0; index < 19; index += 1) {
        expect((await post(port, '/xq/v1/ping', {})).status).toBe(204);
      }
      expect((await post(port, '/xq/v1/ping', {})).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('close 幂等、结束挂起轮询并释放端口', async () => {
    const { server, port } = await approvedServer(async () => reply(true, null, snapshot(1)));
    const hanging = get(port, '/xq/v1/poll?rev=1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await server.close();
    const closed = await hanging;
    expect(closed.status).toBe(410);
    expect(closed.body).toMatchObject({ error: { code: 'closed' } });
    await server.close();
    expect(server.status.listening).toBe(false);

    const rebound = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    expect(rebound).toBe(port);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/hostServer.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现本地服务**

Create `electron/online/hostServer.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACTION_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  ENDED_IDLE_MS,
  LOBBY_IDLE_MS,
  POLL_HOLD_MS,
  RECONNECT_WINDOW_MS,
  validateGuestAction,
  validateSnapshot,
  type ActionReply,
  type GuestAction,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const BODY_LIMIT = 16 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1_000;
const JOIN_RATE_LIMIT = 30;
const JOIN_RATE_WINDOW_MS = 60_000;
const MAX_WAITERS = 2;

export type HostServerErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'busy'
  | 'rejected'
  | 'timeout'
  | 'host_unavailable'
  | 'closed';

export interface HostServerOptions {
  token: string;
  onAction: (actionId: string, action: GuestAction) => Promise<ActionReply>;
  onGuestJoined?: () => void;
  onGuestDisconnected?: () => void;
  onGuestReconnected?: () => void;
  onGuestTimeout?: () => void;
  onIdle?: (reason: 'lobby-idle' | 'ended-idle') => void;
  onError?: (error: Error) => void;
  now?: () => number;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
}

export interface HostServerStatus {
  listening: boolean;
  guestPresent: boolean;
  approved: boolean;
  disconnected: boolean;
  timedOut: boolean;
  rev: number;
}

interface GuestState {
  sessionId: string;
  lastSeen: number;
  approved: boolean;
  disconnected: boolean;
  disconnectedAt: number;
  timedOut: boolean;
}

interface JoinWaiter {
  res: ServerResponse;
  sessionId: string;
}

interface PollWaiter {
  rev: number;
  res: ServerResponse;
  timer: NodeJS.Timeout | null;
}

class TimeoutError extends Error {}

function errorBody(code: HostServerErrorCode, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.writableEnded) return;
  res.writeHead(status);
  res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('响应超时')), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class HostServer {
  private readonly options: HostServerOptions;
  private readonly server;
  private readonly tokenBuffer: Buffer;
  private readonly pollHoldMs: number;
  private readonly actionTimeoutMs: number;
  private readonly createdAt: number;
  private portNumber = 0;
  private listening = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private latest: OnlineSnapshot | null = null;
  private guest: GuestState | null = null;
  private joinWaiter: JoinWaiter | null = null;
  private waiters: PollWaiter[] = [];
  private livenessTimer: NodeJS.Timeout | null = null;
  private rateWindowStart = 0;
  private rateCount = 0;
  private joinWindowStart = 0;
  private joinCount = 0;
  private endedAt: number | null = null;
  private idleReported = false;

  constructor(options: HostServerOptions) {
    this.options = options;
    this.tokenBuffer = Buffer.from(options.token);
    this.pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    this.createdAt = this.now();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        sendJson(res, 500, errorBody('host_unavailable', '服务内部错误'));
      });
    });
  }

  get port(): number {
    return this.portNumber;
  }

  get address(): string | null {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.address : null;
  }

  get status(): HostServerStatus {
    return {
      listening: this.listening,
      guestPresent: this.guest !== null,
      approved: this.guest?.approved ?? false,
      disconnected: this.guest?.disconnected ?? false,
      timedOut: this.guest?.timedOut ?? false,
      rev: this.latest?.rev ?? 0,
    };
  }

  async listen(port = 0): Promise<number> {
    if (this.closed) throw new Error('房间已关闭');
    if (this.listening) return this.portNumber;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    this.portNumber = typeof address === 'object' && address ? address.port : 0;
    this.listening = true;
    this.server.on('error', (error) => this.options.onError?.(error));
    this.livenessTimer = setInterval(() => this.checkLiveness(), 1_000);
    this.livenessTimer.unref?.();
    return this.portNumber;
  }

  approve(): boolean {
    const guest = this.guest;
    const waiter = this.joinWaiter;
    if (!guest || guest.approved || !waiter) return false;
    guest.approved = true;
    guest.lastSeen = this.now();
    this.joinWaiter = null;
    sendJson(waiter.res, 200, { phase: this.latest?.phase ?? 'lobby' });
    return true;
  }

  reject(): boolean {
    const guest = this.guest;
    const waiter = this.joinWaiter;
    if (!guest || guest.approved || !waiter) return false;
    this.guest = null;
    this.joinWaiter = null;
    sendJson(waiter.res, 403, errorBody('rejected', '房主拒绝加入'));
    return true;
  }

  publish(raw: OnlineSnapshot): void {
    if (this.closed) return;
    const snapshot = validateSnapshot(raw);
    if (this.latest && snapshot.rev <= this.latest.rev) return;
    this.latest = snapshot;
    if (snapshot.phase === 'ended' && this.endedAt === null) {
      this.endedAt = this.now();
    }
    for (const waiter of [...this.waiters]) {
      if (snapshot.rev > waiter.rev) this.finishWaiter(waiter, snapshot);
    }
  }

  checkLiveness(now = this.now()): void {
    if (this.closed) return;
    const guest = this.guest;
    if (guest && guest.approved && !guest.timedOut) {
      if (!guest.disconnected && now - guest.lastSeen > DISCONNECT_GRACE_MS) {
        guest.disconnected = true;
        guest.disconnectedAt = now;
        this.options.onGuestDisconnected?.();
      } else if (guest.disconnected && now - guest.disconnectedAt >= RECONNECT_WINDOW_MS) {
        guest.timedOut = true;
        this.options.onGuestTimeout?.();
      }
    }
    if (this.idleReported) return;
    if (!guest && now - this.createdAt >= LOBBY_IDLE_MS) {
      this.idleReported = true;
      this.options.onIdle?.('lobby-idle');
      return;
    }
    if (this.endedAt !== null && now - this.endedAt >= ENDED_IDLE_MS) {
      this.idleReported = true;
      this.options.onIdle?.('ended-idle');
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.listening = false;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      sendJson(waiter.res, 410, errorBody('closed', '房间已关闭'));
    }
    this.waiters = [];
    const joinWaiter = this.joinWaiter;
    this.joinWaiter = null;
    this.guest = null;
    if (joinWaiter) sendJson(joinWaiter.res, 410, errorBody('closed', '房间已关闭'));
    try {
      this.server.closeAllConnections();
    } catch {
      // 老版本 Node 没有该方法时直接 close，仍会等待现有连接结束。
    }
    await new Promise<void>((resolve) => {
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    this.portNumber = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) {
      sendJson(res, 410, errorBody('closed', '房间已关闭'));
      return;
    }
    const now = this.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method ?? ''} ${url.pathname}`;

    if (route === 'POST /xq/v1/join' && !this.allowJoin(now)) {
      sendJson(res, 429, errorBody('busy', '请求过于频繁'));
      return;
    }
    if (!this.authorized(req)) {
      sendJson(res, 401, errorBody('unauthorized', '邀请无效或房间已关闭'));
      return;
    }
    if (!this.allowRequest(now)) {
      sendJson(res, 429, errorBody('busy', '请求过于频繁'));
      return;
    }

    switch (route) {
      case 'POST /xq/v1/join':
        this.handleJoin(res, now);
        return;
      case 'GET /xq/v1/poll':
        this.handlePoll(res, url, now);
        return;
      case 'POST /xq/v1/ping':
        this.handlePing(res, now);
        return;
      case 'POST /xq/v1/action':
        await this.handleAction(req, res, now);
        return;
      default:
        sendJson(res, 404, errorBody('bad_request', '接口不存在'));
    }
  }

  private handleJoin(res: ServerResponse, now: number): void {
    if (this.guest) {
      sendJson(res, 409, errorBody('busy', '房间已有玩家'));
      return;
    }
    const guest: GuestState = {
      sessionId: randomBytes(16).toString('base64url'),
      lastSeen: now,
      approved: false,
      disconnected: false,
      disconnectedAt: 0,
      timedOut: false,
    };
    this.guest = guest;
    const waiter: JoinWaiter = { res, sessionId: guest.sessionId };
    this.joinWaiter = waiter;
    res.on('close', () => {
      if (this.joinWaiter === waiter && !res.writableEnded) {
        this.joinWaiter = null;
        this.guest = null;
      }
    });
    this.options.onGuestJoined?.();
  }

  private handlePoll(res: ServerResponse, url: URL, now: number): void {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    const rev = Number(url.searchParams.get('rev') ?? '');
    if (!Number.isInteger(rev) || rev < 0) {
      sendJson(res, 400, errorBody('bad_request', 'rev 无效'));
      return;
    }
    this.touch(guest, now);
    if (this.latest && this.latest.rev > rev) {
      sendJson(res, 200, this.latest);
      return;
    }
    if (this.waiters.length >= MAX_WAITERS) {
      sendJson(res, 429, errorBody('busy', '轮询过多'));
      return;
    }
    const waiter: PollWaiter = { rev, res, timer: null };
    waiter.timer = setTimeout(() => this.finishWaiter(waiter, null), this.pollHoldMs);
    waiter.timer.unref?.();
    this.waiters.push(waiter);
    res.on('close', () => this.removeWaiter(waiter));
  }

  private handlePing(res: ServerResponse, now: number): void {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    this.touch(guest, now);
    sendEmpty(res, 204);
  }

  private async handleAction(
    req: IncomingMessage,
    res: ServerResponse,
    now: number,
  ): Promise<void> {
    const guest = this.guest;
    if (!guest || !guest.approved) {
      sendJson(res, 403, errorBody('busy', '尚未获准加入'));
      return;
    }
    if (guest.timedOut) {
      sendJson(res, 410, errorBody('host_unavailable', '对局已结束'));
      return;
    }
    this.touch(guest, now);

    let action: GuestAction;
    try {
      action = validateGuestAction(await readJson(req));
    } catch {
      sendJson(res, 400, errorBody('bad_request', '动作格式无效'));
      return;
    }

    const actionId = randomBytes(16).toString('base64url');
    try {
      const reply = await withTimeout(this.options.onAction(actionId, action), this.actionTimeoutMs);
      if (reply.snapshot) this.publish(reply.snapshot);
      sendJson(res, 200, {
        accepted: reply.accepted,
        message: reply.message,
        snapshot: reply.snapshot ?? this.latest,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        sendJson(res, 504, errorBody('timeout', '房主响应超时'));
        return;
      }
      sendJson(res, 410, errorBody('host_unavailable', '房主不可用'));
    }
  }

  private finishWaiter(waiter: PollWaiter, snapshot: OnlineSnapshot | null): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (snapshot) sendJson(waiter.res, 200, snapshot);
    else sendEmpty(waiter.res, 204);
  }

  private removeWaiter(waiter: PollWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
  }

  private touch(guest: GuestState, now: number): void {
    guest.lastSeen = now;
    if (guest.disconnected && !guest.timedOut) {
      guest.disconnected = false;
      guest.disconnectedAt = 0;
      this.options.onGuestReconnected?.();
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    return (
      provided.length === this.tokenBuffer.length && timingSafeEqual(provided, this.tokenBuffer)
    );
  }

  private allowRequest(now: number): boolean {
    if (now - this.rateWindowStart >= RATE_WINDOW_MS) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    return this.rateCount <= RATE_LIMIT;
  }

  private allowJoin(now: number): boolean {
    if (now - this.joinWindowStart >= JOIN_RATE_WINDOW_MS) {
      this.joinWindowStart = now;
      this.joinCount = 0;
    }
    this.joinCount += 1;
    return this.joinCount <= JOIN_RATE_LIMIT;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/hostServer.test.ts
```
Expected: 10 个用例全 PASS。

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add electron/online/hostServer.ts tests/electron/hostServer.test.ts
git commit -m "feat: add loopback host server with long polling and liveness"
```

### Task 6: 客人 HTTP 客户端

**Files:**
- Create: `electron/online/client.ts`
- Test: `tests/electron/client.test.ts`

**Interfaces:**
- Consumes: `HostServer`（测试中作为真实对端）、`validateSnapshot`、协议常量。
- Produces:
  - `class GuestClient`
  - `constructor(origin: string, token: string, handlers: GuestClientHandlers, options?: GuestClientOptions)`
  - `join(): Promise<OnlinePhase>`
  - `start(): void`、`stop(): void`
  - `poll(rev: number, signal?: AbortSignal): Promise<OnlineSnapshot | null>`
  - `ping(): Promise<void>`
  - `action(action: GuestAction): Promise<ActionReply>`
  - `class GuestHttpError extends Error`，带 `status` 与 `code`

- [ ] **Step 1: 写回环集成测试（真实 HostServer，无假客户端）**

Create `tests/electron/client.test.ts`:

```ts
import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { GuestClient, type GuestLinkStatus } from '../../electron/online/client.ts';
import { HostServer } from '../../electron/online/hostServer.ts';
import type { ActionReply, OnlineSnapshot } from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(rev: number, overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev,
    phase: 'playing',
    hostSide: 'red',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [],
    result: null,
    endReason: null,
    clock: { redMs: 1_200_000, blackMs: 1_200_000, stepMs: 150_000, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

function reply(accepted: boolean, message: string | null, snap: OnlineSnapshot): ActionReply {
  return { accepted, message, snapshot: snap };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待状态超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

interface Proxy {
  port: number;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

function startProxy(targetPort: number): Promise<Proxy> {
  let paused = false;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (paused) {
      req.socket.destroy();
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(502);
        res.end();
      }
    });
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        pause: () => {
          paused = true;
          for (const socket of sockets) socket.destroy();
        },
        resume: () => {
          paused = false;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function startHost(onAction: (actionId: string, action: unknown) => Promise<ActionReply>) {
  const server = new HostServer({
    token: TOKEN,
    onAction: async (actionId, action) => onAction(actionId, action),
    pollHoldMs: 50,
  });
  const port = await server.listen();
  return { server, port };
}

async function joinApproved(client: GuestClient, server: HostServer): Promise<void> {
  const joining = client.join();
  await waitFor(() => server.status.guestPresent);
  server.approve();
  await joining;
}

describe('客人 HTTP 客户端', () => {
  it('加入、轮询快照并提交动作', async () => {
    const { server, port } = await startHost(async () =>
      reply(true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] })),
    );
    const snapshots: OnlineSnapshot[] = [];
    const statuses: GuestLinkStatus[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: (value) => statuses.push(value),
        onClosed: (reason) => statuses.push(`closed:${reason}` as GuestLinkStatus),
      },
      { pollHoldMs: 50, pingIntervalMs: 20, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);
      expect(snapshots[0].rev).toBe(1);

      const result = await client.action({ type: 'move', uci: 'h7e7' });
      expect(result.accepted).toBe(true);
      expect(result.snapshot?.rev).toBe(2);
      await waitFor(() => snapshots.length === 2);
      expect(snapshots[1].moves).toEqual(['h2e2', 'h7e7']);
      expect(statuses).toContain('connected');
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('忽略不比本地新的快照', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const snapshots: OnlineSnapshot[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: () => undefined,
        onClosed: () => undefined,
      },
      { pollHoldMs: 50, pingIntervalMs: 50, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);
      await client.poll(1);
      server.publish(snapshot(2, { moves: ['h2e2'] }));
      await waitFor(() => snapshots.length === 2);
      expect(snapshots.map((item) => item.rev)).toEqual([1, 2]);
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('动作被拒绝时原样返回原因', async () => {
    const { server, port } = await startHost(async () =>
      reply(false, '还没轮到你走子', snapshot(1)),
    );
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: () => undefined },
      { pollHoldMs: 50, pingIntervalMs: 50, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      const result = await client.action({ type: 'move', uci: 'h7e7' });
      expect(result.accepted).toBe(false);
      expect(result.message).toBe('还没轮到你走子');
    } finally {
      client.stop();
      await server.close();
    }
  });

  it('网络中断后持续重试并在恢复时回到 connected', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const proxy = await startProxy(port);
    const snapshots: OnlineSnapshot[] = [];
    const statuses: GuestLinkStatus[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${proxy.port}`,
      TOKEN,
      {
        onSnapshot: (value) => snapshots.push(value),
        onStatus: (value) => statuses.push(value),
        onClosed: () => undefined,
      },
      { pollHoldMs: 50, pingIntervalMs: 20, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => snapshots.length === 1);

      proxy.pause();
      await waitFor(() => statuses.includes('reconnecting'));
      proxy.resume();
      await waitFor(() => {
        const index = statuses.indexOf('reconnecting');
        return index !== -1 && statuses.slice(index + 1).includes('connected');
      });
    } finally {
      client.stop();
      await proxy.close();
      await server.close();
    }
  });

  it('房主关闭房间后通知客人并停止重试', async () => {
    const { server, port } = await startHost(async () => reply(true, null, snapshot(1)));
    const closed: string[] = [];
    const client = new GuestClient(
      `http://127.0.0.1:${port}`,
      TOKEN,
      { onSnapshot: () => undefined, onStatus: () => undefined, onClosed: (reason) => closed.push(reason) },
      { pollHoldMs: 50, pingIntervalMs: 20, retryDelayMs: 20 },
    );
    try {
      await joinApproved(client, server);
      server.publish(snapshot(1));
      client.start();
      await waitFor(() => server.status.rev === 1);
      await server.close();
      await waitFor(() => closed.length === 1);
      expect(closed[0]).toBe('房间已关闭');
    } finally {
      client.stop();
      await server.close();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/client.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现客人客户端**

Create `electron/online/client.ts`:

```ts
import {
  POLL_HOLD_MS,
  validateSnapshot,
  type ActionReply,
  type GuestAction,
  type OnlinePhase,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const POLL_GRACE_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type GuestLinkStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface GuestClientHandlers {
  onSnapshot: (snapshot: OnlineSnapshot) => void;
  onStatus: (status: GuestLinkStatus) => void;
  onClosed: (reason: string) => void;
}

export interface GuestClientOptions {
  pollHoldMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

export class GuestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuestHttpError';
  }
}

interface RawResponse {
  status: number;
  body: unknown;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class GuestClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly handlers: GuestClientHandlers;
  private readonly pollHoldMs: number;
  private readonly pingIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private revision = 0;
  private stopped = false;
  private closedNotified = false;
  private controller: AbortController | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    origin: string,
    token: string,
    handlers: GuestClientHandlers,
    options: GuestClientOptions = {},
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.token = token;
    this.handlers = handlers;
    this.pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async join(): Promise<OnlinePhase> {
    const response = await this.request('POST', '/xq/v1/join', {});
    const body = response.body as Record<string, unknown> | null;
    const phase = body?.phase;
    if (phase !== 'lobby' && phase !== 'playing' && phase !== 'ended') {
      throw new GuestHttpError(0, 'bad_request', '加入响应格式不正确');
    }
    return phase;
  }

  start(): void {
    if (this.stopped || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.pollLoop(controller.signal);
    this.heartbeat = setInterval(() => {
      void this.ping().catch((error: unknown) => {
        if (this.stopped) return;
        if (this.terminal(error)) return;
        this.handlers.onStatus('reconnecting');
      });
    }, this.pingIntervalMs);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  async poll(rev: number, signal?: AbortSignal): Promise<OnlineSnapshot | null> {
    const response = await this.request(
      'GET',
      `/xq/v1/poll?rev=${rev}`,
      undefined,
      signal,
      this.pollHoldMs + POLL_GRACE_MS,
    );
    if (response.status === 204) return null;
    return validateSnapshot(response.body);
  }

  async ping(): Promise<void> {
    await this.request('POST', '/xq/v1/ping', {});
  }

  async action(action: GuestAction): Promise<ActionReply> {
    const response = await this.request('POST', '/xq/v1/action', action);
    const body = response.body as Record<string, unknown> | null;
    if (!body || typeof body.accepted !== 'boolean') {
      throw new GuestHttpError(0, 'bad_request', '动作响应格式不正确');
    }
    const message = typeof body.message === 'string' ? body.message : null;
    const snapshot =
      body.snapshot === null || body.snapshot === undefined
        ? null
        : validateSnapshot(body.snapshot);
    return { accepted: body.accepted, message, snapshot };
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let first = true;
    let failures = 0;
    while (!this.stopped && !signal.aborted) {
      try {
        const snapshot = await this.poll(this.revision, signal);
        if (this.stopped || signal.aborted) return;
        if (snapshot && snapshot.rev > this.revision) {
          this.revision = snapshot.rev;
          this.handlers.onSnapshot(snapshot);
        }
        if (first || failures > 0) {
          first = false;
          failures = 0;
          this.handlers.onStatus('connected');
        }
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        if (this.terminal(error)) return;
        failures += 1;
        this.handlers.onStatus('reconnecting');
        await delay(this.retryDelayMs, signal);
      }
    }
  }

  private terminal(error: unknown): boolean {
    if (!(error instanceof GuestHttpError)) return false;
    let reason: string;
    if (error.code === 'host_unavailable') {
      reason = '与房主失去连接';
    } else if (error.code === 'closed') {
      reason = '房间已关闭';
    } else if (error.code === 'unauthorized') {
      reason = '邀请无效或房间已关闭';
    } else if (error.code === 'rejected') {
      reason = '房主拒绝加入';
    } else {
      return false;
    }
    this.notifyClosed(reason);
    return true;
  }

  private notifyClosed(reason: string): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.handlers.onClosed(reason);
    this.stop();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RawResponse> {
    if (this.stopped) throw new GuestHttpError(0, 'closed', '连接已关闭');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = signal ? [signal, timeout] : [timeout];
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'user-agent': 'Xiangqi/0.1',
          'bypass-tunnel-reminder': 'true',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GuestHttpError(0, 'network', '无法连接房主');
    }

    if (response.status === 204) return { status: 204, body: null };
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GuestHttpError(response.status, 'bad_request', '响应不是合法 JSON');
      }
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof error?.code === 'string' ? error.code : 'bad_request';
      const message =
        typeof error?.message === 'string' ? error.message : `请求失败（${response.status}）`;
      throw new GuestHttpError(response.status, code, message);
    }
    return { status: response.status, body: parsed };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/client.test.ts
```
Expected: 5 个用例全 PASS。

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add electron/online/client.ts tests/electron/client.test.ts
git commit -m "feat: add guest long-polling client with reconnect"
```

### Task 7: 穿透封装、会话生命周期与防子进程检查

**Files:**
- Modify: `package.json`（新增 `localtunnel@^2.0.2`）
- Create: `src/net/localtunnel.d.ts`
- Create: `electron/online/tunnel.ts`
- Create: `electron/online/session.ts`
- Test: `tests/electron/session.test.ts`
- Test: `tests/electron/staticGuard.test.ts`

**Interfaces:**
- Consumes: `localtunnel`（纯 Node 库）、`HostServer`、`GuestClient`、`parseInvite`。
- Produces:
  - `interface TunnelHandle { url; close(); onClosed(cb) }`、`interface TunnelFactory { open(port) }`
  - `localTunnelFactory: TunnelFactory`（15 秒启动超时，关闭时释放全部套接字）
  - `interface OnlineSession { role; inviteUrl; localUrl; status(); stop(reason) }`
  - `class HostOnlineSession`：`static create(options)`、`approve()`、`reject()`、`publish(snapshot)`、`reply(actionId, accepted, message, snapshot)`
  - `class GuestOnlineSession`：`static create(options)`、`start(): Promise<OnlinePhase>`、`send(action)`
  - `HostSessionOptions`、`GuestSessionOptions`

- [ ] **Step 1: 安装纯 Node 穿透依赖并补类型声明**

```bash
cd /d/VSCodeProject/checkmate && npm install localtunnel@^2.0.2
```
Expected: `package.json` 的 `dependencies` 出现 `"localtunnel": "^2.0.2"`，`package-lock.json` 更新。

Create `src/net/localtunnel.d.ts`:

```ts
declare module 'localtunnel' {
  import type { EventEmitter } from 'node:events';

  export interface TunnelOptions {
    port: number;
    local_host?: string;
    subdomain?: string;
  }

  export interface Tunnel extends EventEmitter {
    url: string;
    close(): void;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export default function localtunnel(options: TunnelOptions): Promise<Tunnel>;
}
```

- [ ] **Step 2: 写会话测试**

Create `tests/electron/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GuestOnlineSession,
  HostOnlineSession,
} from '../../electron/online/session.ts';
import type { TunnelFactory, TunnelHandle } from '../../electron/online/tunnel.ts';
import {
  parseInvite,
  type OnlineEvent,
  type OnlineSnapshot,
} from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(rev: number, overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev,
    phase: 'playing',
    hostSide: 'red',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [],
    result: null,
    endReason: null,
    clock: { redMs: 1_200_000, blackMs: 1_200_000, stepMs: 150_000, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待状态超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function fakeTunnel(url = 'https://demo.loca.lt'): TunnelHandle & {
  closeCount: number;
  notifyClosed: (reason: string) => void;
  notifyError: (reason: string) => void;
} {
  const listeners: Array<(reason: string) => void> = [];
  const handle = {
    url,
    closeCount: 0,
    close(): void {
      handle.closeCount += 1;
    },
    onClosed(callback: (reason: string) => void): void {
      listeners.push(callback);
    },
    notifyClosed(reason: string): void {
      for (const listener of listeners) listener(reason);
    },
    notifyError(reason: string): void {
      for (const listener of listeners) listener(reason);
    },
  };
  return handle;
}

describe('联机会话生命周期', () => {
  it('本地冒烟模式跳过穿透，stop 幂等且只通知一次', async () => {
    let opened = 0;
    const factory: TunnelFactory = {
      open: async () => {
        opened += 1;
        throw new Error('本地模式不应启动穿透');
      },
    };
    const events: OnlineEvent[] = [];
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      tunnelFactory: factory,
      events: (event) => events.push(event),
    });
    expect(opened).toBe(0);
    expect(session.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.inviteUrl).toBe(`${session.localUrl}/#${TOKEN}`);

    await Promise.all([session.stop('test'), session.stop('test')]);
    await session.stop('test');
    expect(events.filter((event) => event.type === 'closed')).toEqual([
      { type: 'closed', reason: 'test' },
    ]);
  });

  it('穿透句柄在停止时恰好关闭一次', async () => {
    const tunnel = fakeTunnel();
    const factory: TunnelFactory = { open: async () => tunnel };
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      tunnelFactory: factory,
      events: () => undefined,
    });
    expect(session.inviteUrl).toBe(`https://demo.loca.lt/#${TOKEN}`);

    await session.stop('first');
    await session.stop('second');
    expect(tunnel.closeCount).toBe(1);
  });

  it('穿透错误立即结束会话', async () => {
    const tunnel = fakeTunnel();
    const factory: TunnelFactory = { open: async () => tunnel };
    const events: OnlineEvent[] = [];
    const session = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      tunnelFactory: factory,
      events: (event) => events.push(event),
    });

    tunnel.notifyError('穿透连接中断');
    await waitFor(() => events.some((event) => event.type === 'closed'));
    expect(events.filter((event) => event.type === 'closed')).toEqual([
      { type: 'closed', reason: '穿透连接中断' },
    ]);
    expect(tunnel.closeCount).toBe(1);
  });

  it('房主同意后客人收到快照并可提交动作', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      events: (event) => hostEvents.push(event),
    });
    const guest = GuestOnlineSession.create({
      invite: parseInvite(host.inviteUrl ?? ''),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
      events: (event) => guestEvents.push(event),
    });

    try {
      const joining = guest.start();
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      host.approve();
      await joining;
      expect(host.status().approved).toBe(true);
      expect(host.status().guestConnected).toBe(true);

      host.publish(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      const sending = guest.send({ type: 'move', uci: 'h7e7' });
      await waitFor(() => hostEvents.some((event) => event.type === 'host-action'));
      const action = hostEvents.find(
        (event): event is Extract<OnlineEvent, { type: 'host-action' }> =>
          event.type === 'host-action',
      );
      expect(action?.action).toEqual({ type: 'move', uci: 'h7e7' });
      host.reply(action?.actionId ?? '', true, null, snapshot(2, { moves: ['h2e2', 'h7e7'] }));

      const result = await sending;
      expect(result.snapshot?.rev).toBe(2);
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 2),
      );
    } finally {
      await guest.stop('leave');
      await host.stop('test');
    }
  });

  it('房主结束联机后客人收到关闭事件', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = await HostOnlineSession.create({
      hostSide: 'red',
      token: TOKEN,
      localOnly: true,
      events: (event) => hostEvents.push(event),
    });
    const guest = GuestOnlineSession.create({
      invite: parseInvite(host.inviteUrl ?? ''),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
      events: (event) => guestEvents.push(event),
    });

    try {
      const joining = guest.start();
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      host.approve();
      await joining;
      host.publish(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      await host.stop('host-stop');
      await waitFor(() => guestEvents.some((event) => event.type === 'closed'));
      expect(guestEvents.filter((event) => event.type === 'closed')).toEqual([
        { type: 'closed', reason: '房间已关闭' },
      ]);
    } finally {
      await guest.stop('test');
    }
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/session.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现穿透与两个会话类**

Create `electron/online/tunnel.ts`:

```ts
import localtunnel from 'localtunnel';

const TUNNEL_TIMEOUT_MS = 15_000;

export interface TunnelHandle {
  readonly url: string;
  close(): void;
  onClosed(callback: (reason: string) => void): void;
}

export interface TunnelFactory {
  open(port: number): Promise<TunnelHandle>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('内网穿透不可用（启动超时）'));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          try {
            (value as { close(): void }).close();
          } catch {
            // 超时后迟到的隧道直接关闭，避免遗留连接。
          }
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const localTunnelFactory: TunnelFactory = {
  async open(port: number): Promise<TunnelHandle> {
    const tunnel = await withTimeout(
      localtunnel({ port, local_host: '127.0.0.1' }),
      TUNNEL_TIMEOUT_MS,
    );
    const listeners: Array<(reason: string) => void> = [];
    const notify = (reason: string): void => {
      for (const listener of listeners) listener(reason);
    };
    tunnel.on('close', () => notify('穿透连接已关闭'));
    tunnel.on('error', (error) => notify(`穿透连接中断：${error.message}`));
    return {
      url: tunnel.url,
      close: () => {
        try {
          tunnel.close();
        } catch {
          // 已关闭时重复 close 直接忽略。
        }
      },
      onClosed: (callback) => listeners.push(callback),
    };
  },
};
```

Create `electron/online/session.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Side } from '../../src/types.ts';
import {
  ACTION_TIMEOUT_MS,
  parseInvite,
  type ActionReply,
  type GuestAction,
  type InviteInfo,
  type OnlineEvent,
  type OnlinePhase,
  type OnlineRole,
  type OnlineSnapshot,
  type OnlineStatus,
} from '../../src/net/protocol.ts';
import { GuestClient, GuestHttpError, type GuestLinkStatus } from './client.ts';
import { HostServer } from './hostServer.ts';
import { localTunnelFactory, type TunnelFactory, type TunnelHandle } from './tunnel.ts';

type EventSink = (event: OnlineEvent) => void;

export interface OnlineSession {
  readonly role: OnlineRole;
  readonly inviteUrl: string | null;
  readonly localUrl: string | null;
  status(): OnlineStatus;
  stop(reason: string): Promise<void>;
}

export interface HostSessionOptions {
  hostSide: Side;
  events: EventSink;
  tunnelFactory?: TunnelFactory;
  token?: string;
  localOnly?: boolean;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
  now?: () => number;
}

export interface GuestSessionOptions {
  invite: InviteInfo;
  events: EventSink;
  pollHoldMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
}

interface PendingAction {
  resolve: (reply: ActionReply) => void;
  timer: NodeJS.Timeout;
}

export class HostOnlineSession implements OnlineSession {
  readonly role = 'host' as const;
  readonly hostSide: Side;
  readonly inviteUrl: string | null;
  readonly localUrl: string | null;

  private readonly emit: EventSink;
  private readonly server: HostServer;
  private readonly tunnel: TunnelHandle | null;
  private readonly pendingActions = new Map<string, PendingAction>();
  private phase: OnlinePhase = 'lobby';
  private stopPromise: Promise<void> | null = null;
  private closedEmitted = false;

  private constructor(
    hostSide: Side,
    inviteUrl: string | null,
    localUrl: string | null,
    server: HostServer,
    tunnel: TunnelHandle | null,
    emit: EventSink,
  ) {
    this.hostSide = hostSide;
    this.inviteUrl = inviteUrl;
    this.localUrl = localUrl;
    this.server = server;
    this.tunnel = tunnel;
    this.emit = emit;
  }

  static async create(options: HostSessionOptions): Promise<HostOnlineSession> {
    const token = options.token ?? randomBytes(32).toString('base64url');
    const actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    const holder: { session: HostOnlineSession | null } = { session: null };
    const stopFromServer = (reason: string): void => {
      void holder.session?.stop(reason);
    };
    const server = new HostServer({
      token,
      pollHoldMs: options.pollHoldMs,
      actionTimeoutMs,
      now: options.now,
      onAction: (actionId, action) => holder.session?.forwardAction(actionId, action) ?? Promise.resolve({
        accepted: false,
        message: '房间已关闭',
        snapshot: null,
      }),
      onGuestJoined: () => options.events({ type: 'host-guest-joined' }),
      onGuestDisconnected: () => options.events({ type: 'host-guest-disconnected' }),
      onGuestReconnected: () => options.events({ type: 'host-guest-reconnected' }),
      onGuestTimeout: () => options.events({ type: 'host-guest-timeout' }),
      onIdle: () => stopFromServer('房间空闲已关闭'),
      onError: () => stopFromServer('本地服务异常'),
    });

    let port: number;
    try {
      port = await server.listen();
    } catch (error) {
      await server.close();
      throw error;
    }

    let tunnel: TunnelHandle | null = null;
    let inviteUrl: string;
    let localUrl: string | null = null;
    try {
      if (options.localOnly) {
        localUrl = `http://127.0.0.1:${port}`;
        inviteUrl = `${localUrl}/#${token}`;
      } else {
        tunnel = await (options.tunnelFactory ?? localTunnelFactory).open(port);
        inviteUrl = `${tunnel.url.replace(/\/+$/, '')}/#${token}`;
      }
    } catch (error) {
      await server.close();
      throw error;
    }

    const session = new HostOnlineSession(
      options.hostSide,
      inviteUrl,
      localUrl,
      server,
      tunnel,
      options.events,
    );
    holder.session = session;
    if (tunnel) tunnel.onClosed((reason) => stopFromServer(reason));
    session.emitStatus();
    return session;
  }

  approve(): void {
    if (this.stopPromise) return;
    if (!this.server.approve()) return;
    this.emitStatus();
  }

  reject(): void {
    if (this.stopPromise) return;
    if (!this.server.reject()) return;
    this.emitStatus();
  }

  publish(snapshot: OnlineSnapshot): void {
    if (this.stopPromise) return;
    this.server.publish(snapshot);
    this.phase = snapshot.phase;
    this.emitStatus();
  }

  reply(
    actionId: string,
    accepted: boolean,
    message: string | null,
    snapshot: OnlineSnapshot,
  ): void {
    const pending = this.pendingActions.get(actionId);
    if (!pending) return;
    this.pendingActions.delete(actionId);
    clearTimeout(pending.timer);
    pending.resolve({ accepted, message, snapshot });
  }

  status(): OnlineStatus {
    const state = this.server.status;
    return {
      role: 'host',
      phase: this.phase,
      inviteUrl: this.inviteUrl,
      guestConnected: state.approved && !state.disconnected,
      approved: state.approved,
      error: null,
    };
  }

  stop(reason: string): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private forwardAction(actionId: string, action: GuestAction): Promise<ActionReply> {
    if (this.stopPromise) {
      return Promise.resolve({ accepted: false, message: '房间已关闭', snapshot: null });
    }
    return new Promise<ActionReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(actionId);
      }, ACTION_TIMEOUT_MS + 1_000);
      timer.unref?.();
      this.pendingActions.set(actionId, { resolve, timer });
      this.emit({ type: 'host-action', actionId, action });
    });
  }

  private async doStop(reason: string): Promise<void> {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, message: '房间已关闭', snapshot: null });
    }
    this.pendingActions.clear();
    try {
      await this.server.close();
    } catch {
      // 服务已关闭时继续清理穿透。
    }
    if (this.tunnel) {
      try {
        this.tunnel.close();
      } catch {
        // 穿透已关闭时继续通知渲染进程。
      }
    }
    this.emitClosed(reason);
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }

  private emitClosed(reason: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: 'closed', reason });
  }
}

export class GuestOnlineSession implements OnlineSession {
  readonly role = 'guest' as const;
  readonly inviteUrl = null;
  readonly localUrl = null;

  private readonly client: GuestClient;
  private readonly emit: EventSink;
  private phase: OnlinePhase = 'lobby';
  private link: GuestLinkStatus = 'connecting';
  private joined = false;
  private stopPromise: Promise<void> | null = null;
  private closedEmitted = false;

  private constructor(options: GuestSessionOptions) {
    this.emit = options.events;
    this.client = new GuestClient(
      options.invite.origin,
      options.invite.token,
      {
        onSnapshot: (snapshot) => {
          this.phase = snapshot.phase;
          this.emit({ type: 'snapshot', snapshot });
          this.emitStatus();
        },
        onStatus: (status) => {
          this.link = status;
          this.emitStatus();
        },
        onClosed: (reason) => this.emitClosed(reason),
      },
      {
        pollHoldMs: options.pollHoldMs,
        pingIntervalMs: options.pingIntervalMs,
        retryDelayMs: options.retryDelayMs,
      },
    );
  }

  static create(options: GuestSessionOptions): GuestOnlineSession {
    return new GuestOnlineSession(options);
  }

  async start(): Promise<OnlinePhase> {
    if (this.stopPromise) throw new GuestHttpError(0, 'closed', '会话已关闭');
    const phase = await this.client.join();
    this.joined = true;
    this.phase = phase;
    this.client.start();
    this.emitStatus();
    return phase;
  }

  async send(action: GuestAction): Promise<ActionReply> {
    if (this.stopPromise) throw new GuestHttpError(0, 'closed', '会话已关闭');
    const reply = await this.client.action(action);
    if (reply.snapshot) {
      this.phase = reply.snapshot.phase;
      this.emit({ type: 'snapshot', snapshot: reply.snapshot });
      this.emitStatus();
    }
    return reply;
  }

  status(): OnlineStatus {
    return {
      role: 'guest',
      phase: this.phase,
      inviteUrl: null,
      guestConnected: this.joined && this.link !== 'closed',
      approved: this.joined,
      error: null,
    };
  }

  stop(reason: string): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        this.client.stop();
        this.emitClosed(reason);
      })();
    }
    return this.stopPromise;
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }

  private emitClosed(reason: string): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: 'closed', reason });
  }
}

export function inviteFor(url: string): InviteInfo {
  return parseInvite(url);
}
```

- [ ] **Step 5: 运行会话测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/session.test.ts
```
Expected: 5 个用例全 PASS。

- [ ] **Step 6: 写并运行防子进程静态检查**

Create `tests/electron/staticGuard.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['electron/online', 'src/net'];
const FORBIDDEN = [
  /\bfrom\s+['"](?:node:)?child_process['"]/,
  /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/,
  /\bfrom\s+['"](?:node:)?worker_threads['"]/,
  /\brequire\(\s*['"](?:node:)?worker_threads['"]\s*\)/,
  /\b(?:spawn|execFile|exec|fork)\s*\(/,
];

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('联机模块不使用子进程', () => {
  it('electron/online 与 src/net 不含 child_process、worker_threads 或进程启动调用', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of listFiles(root)) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN) {
          if (pattern.test(text)) offenders.push(`${file} 命中 ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/staticGuard.test.ts
```
Expected: PASS。

- [ ] **Step 7: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add package.json package-lock.json src/net/localtunnel.d.ts electron/online/tunnel.ts electron/online/session.ts tests/electron/session.test.ts tests/electron/staticGuard.test.ts
git commit -m "feat: add in-process tunnel session with idempotent shutdown"
```

### Task 8: IPC 控制器与主进程生命周期钩子

**Files:**
- Create: `electron/online/ipc.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/ui/api.ts`
- Test: `tests/electron/ipc.test.ts`

**Interfaces:**
- Consumes: `HostOnlineSession`、`GuestOnlineSession`、`validateSnapshot`、`validateGuestAction`、`parseInvite`、`isActionId`。
- Produces:
  - `class OnlineController`：`hostStart(side)`、`hostStop()`、`hostDecision(accept)`、`hostSnapshot(raw)`、`hostReply(actionId, accepted, message, raw)`、`guestJoin(url)`、`guestAction(raw)`、`guestLeave()`、`status()`、`isActive()`、`stop(reason)`
  - IPC 通道：`online:host-start`、`online:host-stop`、`online:host-decision`、`online:host-snapshot`、`online:host-reply`、`online:guest-join`、`online:guest-action`、`online:guest-leave`、`online:status`
  - 主进程 → 渲染进程事件通道：`online:event`

- [ ] **Step 1: 写控制器测试**

Create `tests/electron/ipc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OnlineController } from '../../electron/online/ipc.ts';
import type { OnlineEvent, OnlineSnapshot } from '../../src/net/protocol.ts';

const TOKEN = 'a'.repeat(43);

function snapshot(rev: number, overrides: Partial<OnlineSnapshot> = {}): OnlineSnapshot {
  return {
    version: 1,
    rev,
    phase: 'playing',
    hostSide: 'red',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [],
    result: null,
    endReason: null,
    clock: { redMs: 1_200_000, blackMs: 1_200_000, stepMs: 150_000, turn: 'red', running: true },
    paused: false,
    pending: null,
    message: null,
    ...overrides,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待状态超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const IDLE = {
  role: null,
  phase: null,
  inviteUrl: null,
  guestConnected: false,
  approved: false,
  error: null,
};

describe('联机 IPC 控制器', () => {
  it('房主创建后进入大厅，重复创建被拒绝，停止后回到空闲', async () => {
    const events: OnlineEvent[] = [];
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => events.push(event),
    });

    const { url, localUrl } = await controller.hostStart('red');
    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).toBe(`${localUrl}/#${TOKEN}`);
    expect(controller.isActive()).toBe(true);
    expect(controller.status()).toEqual({
      role: 'host',
      phase: 'lobby',
      inviteUrl: url,
      guestConnected: false,
      approved: false,
      error: null,
    });

    await expect(controller.hostStart('red')).rejects.toThrow('已有联机会话');
    await controller.hostStop();
    expect(controller.isActive()).toBe(false);
    expect(controller.status()).toEqual(IDLE);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });

  it('房主快照与动作回复在主进程重新校验', async () => {
    const controller = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: () => undefined,
    });
    await controller.hostStart('red');
    try {
      await expect(controller.hostSnapshot({ version: 1 })).rejects.toThrow();
      await expect(
        controller.hostReply('short', true, null, snapshot(1)),
      ).rejects.toThrow('无效的动作编号');
      await expect(
        controller.hostReply('a'.repeat(16), true, null, { version: 1 }),
      ).rejects.toThrow();
    } finally {
      await controller.hostStop();
    }
  });

  it('客人加入、动作往返与离开', async () => {
    const hostEvents: OnlineEvent[] = [];
    const guestEvents: OnlineEvent[] = [];
    const host = new OnlineController({
      smokeLocal: true,
      token: TOKEN,
      emit: (event) => hostEvents.push(event),
    });
    const { url } = await host.hostStart('red');
    const guest = new OnlineController({
      emit: (event) => guestEvents.push(event),
      pollHoldMs: 50,
      pingIntervalMs: 20,
      retryDelayMs: 20,
    });

    try {
      const joining = guest.guestJoin(url);
      await waitFor(() => hostEvents.some((event) => event.type === 'host-guest-joined'));
      await host.hostDecision(true);
      const { phase } = await joining;
      expect(phase).toBe('lobby');

      await host.hostSnapshot(snapshot(1));
      await waitFor(() =>
        guestEvents.some((event) => event.type === 'snapshot' && event.snapshot.rev === 1),
      );

      const sending = guest.guestAction({ type: 'move', uci: 'h7e7' });
      await waitFor(() => hostEvents.some((event) => event.type === 'host-action'));
      const action = hostEvents.find(
        (event): event is Extract<OnlineEvent, { type: 'host-action' }> =>
          event.type === 'host-action',
      );
      await host.hostReply(
        action?.actionId ?? '',
        true,
        null,
        snapshot(2, { moves: ['h2e2', 'h7e7'] }),
      );
      const result = await sending;
      expect(result.snapshot?.rev).toBe(2);

      await guest.guestLeave();
      expect(guest.isActive()).toBe(false);
      expect(guest.status()).toEqual(IDLE);
    } finally {
      await host.hostStop();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/ipc.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现控制器**

Create `electron/online/ipc.ts`:

```ts
import type { Side } from '../../src/types.ts';
import {
  isActionId,
  parseInvite,
  validateGuestAction,
  validateSnapshot,
  type ActionReply,
  type OnlineEvent,
  type OnlinePhase,
  type OnlineStatus,
} from '../../src/net/protocol.ts';
import { GuestOnlineSession, HostOnlineSession, type OnlineSession } from './session.ts';
import type { TunnelFactory } from './tunnel.ts';

export interface OnlineControllerOptions {
  emit: (event: OnlineEvent) => void;
  smokeLocal?: boolean;
  token?: string;
  tunnelFactory?: TunnelFactory;
  pollHoldMs?: number;
  actionTimeoutMs?: number;
  pingIntervalMs?: number;
  retryDelayMs?: number;
}

const IDLE_STATUS: OnlineStatus = {
  role: null,
  phase: null,
  inviteUrl: null,
  guestConnected: false,
  approved: false,
  error: null,
};

export class OnlineController {
  private session: OnlineSession | null = null;
  private starting = false;

  constructor(private readonly options: OnlineControllerOptions) {}

  isActive(): boolean {
    return this.session !== null || this.starting;
  }

  status(): OnlineStatus {
    return this.session?.status() ?? IDLE_STATUS;
  }

  async hostStart(hostSide: Side): Promise<{ url: string; localUrl?: string }> {
    this.assertIdle();
    this.starting = true;
    try {
      const session = await HostOnlineSession.create({
        hostSide,
        events: (event) => this.handleEvent(event),
        tunnelFactory: this.options.tunnelFactory,
        token: this.options.token,
        localOnly: this.options.smokeLocal,
        pollHoldMs: this.options.pollHoldMs,
        actionTimeoutMs: this.options.actionTimeoutMs,
      });
      this.session = session;
      const result: { url: string; localUrl?: string } = { url: session.inviteUrl ?? '' };
      if (session.localUrl) result.localUrl = session.localUrl;
      return result;
    } finally {
      this.starting = false;
    }
  }

  async hostStop(): Promise<void> {
    await this.stop('host-stop');
  }

  async hostDecision(accept: boolean): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    if (accept) this.session.approve();
    else this.session.reject();
  }

  async hostSnapshot(raw: unknown): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    this.session.publish(validateSnapshot(raw));
  }

  async hostReply(
    actionId: unknown,
    accepted: unknown,
    message: unknown,
    raw: unknown,
  ): Promise<void> {
    if (!(this.session instanceof HostOnlineSession)) throw new Error('当前不是房主');
    if (typeof actionId !== 'string' || !isActionId(actionId)) throw new Error('无效的动作编号');
    if (typeof accepted !== 'boolean') throw new Error('无效的受理结果');
    if (message !== null && (typeof message !== 'string' || message.length > 200)) {
      throw new Error('无效的提示信息');
    }
    this.session.reply(actionId, accepted, message, validateSnapshot(raw));
  }

  async guestJoin(url: unknown): Promise<{ phase: OnlinePhase }> {
    this.assertIdle();
    if (typeof url !== 'string' || url.length > 300) throw new Error('邀请链接格式不正确');
    const invite = parseInvite(url);
    this.starting = true;
    const session = GuestOnlineSession.create({
      invite,
      events: (event) => this.handleEvent(event),
      pollHoldMs: this.options.pollHoldMs,
      pingIntervalMs: this.options.pingIntervalMs,
      retryDelayMs: this.options.retryDelayMs,
    });
    this.session = session;
    try {
      const phase = await session.start();
      return { phase };
    } catch (error) {
      this.session = null;
      await session.stop('join-failed');
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async guestAction(raw: unknown): Promise<ActionReply> {
    if (!(this.session instanceof GuestOnlineSession)) throw new Error('当前不是客人');
    return this.session.send(validateGuestAction(raw));
  }

  async guestLeave(): Promise<void> {
    await this.stop('guest-leave');
  }

  async stop(reason: string): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    await session.stop(reason);
  }

  private assertIdle(): void {
    if (this.session || this.starting) throw new Error('已有联机会话');
  }

  private handleEvent(event: OnlineEvent): void {
    if (event.type === 'closed') this.session = null;
    this.options.emit(event);
  }
}
```

- [ ] **Step 4: 运行控制器测试确认通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/ipc.test.ts
```
Expected: 3 个用例全 PASS。

- [ ] **Step 5: 接入 preload 与渲染进程类型**

Modify `electron/preload.ts`，在 `api` 对象末尾（`onEngineStatus` 之后）加入：

```ts
  hostStart: (side: unknown) => ipcRenderer.invoke('online:host-start', side),
  hostStop: () => ipcRenderer.invoke('online:host-stop'),
  hostDecision: (accept: unknown) => ipcRenderer.invoke('online:host-decision', accept),
  hostSnapshot: (snapshot: unknown) => ipcRenderer.invoke('online:host-snapshot', snapshot),
  hostReply: (
    actionId: unknown,
    accepted: unknown,
    message: unknown,
    snapshot: unknown,
  ) => ipcRenderer.invoke('online:host-reply', actionId, accepted, message, snapshot),
  guestJoin: (url: unknown) => ipcRenderer.invoke('online:guest-join', url),
  guestAction: (action: unknown) => ipcRenderer.invoke('online:guest-action', action),
  guestLeave: () => ipcRenderer.invoke('online:guest-leave'),
  getOnlineStatus: () => ipcRenderer.invoke('online:status'),
  onOnlineEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, event: unknown) => callback(event);
    ipcRenderer.on('online:event', handler);
    return () => ipcRenderer.off('online:event', handler);
  },
```

Modify `src/ui/api.ts`，新增导入与接口方法：

```ts
import type { Side } from '../types.ts';
import type {
  ActionReply,
  GuestAction,
  OnlineEvent,
  OnlinePhase,
  OnlineSnapshot,
  OnlineStatus,
} from '../net/protocol.ts';
```

```ts
export interface OnlineStartResult {
  url: string;
  localUrl?: string;
}
```

在 `XiangqiApi` 内追加：

```ts
  hostStart(side: Side): Promise<OnlineStartResult>;
  hostStop(): Promise<void>;
  hostDecision(accept: boolean): Promise<void>;
  hostSnapshot(snapshot: OnlineSnapshot): Promise<void>;
  hostReply(
    actionId: string,
    accepted: boolean,
    message: string | null,
    snapshot: OnlineSnapshot,
  ): Promise<void>;
  guestJoin(url: string): Promise<{ phase: OnlinePhase }>;
  guestAction(action: GuestAction): Promise<ActionReply>;
  guestLeave(): Promise<void>;
  getOnlineStatus(): Promise<OnlineStatus>;
  onOnlineEvent(callback: (event: OnlineEvent) => void): () => void;
```

- [ ] **Step 6: 接入主进程并加生命周期钩子**

Modify `electron/main.ts`：

1. 顶部导入：

```ts
import { OnlineController } from './online/ipc.ts';
```

2. 在 `let queue` 之后创建控制器：

```ts
const online = new OnlineController({
  smokeLocal: process.env.XIANGQI_ONLINE_SMOKE_LOCAL === '1',
  emit: (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('online:event', event);
    }
  },
});
```

3. 在 `registerIpc()` 末尾加入：

```ts
  ipcMain.handle('online:host-start', (_event, side: unknown) => {
    if (side !== 'red' && side !== 'black') throw new Error('无效的阵营');
    return online.hostStart(side);
  });
  ipcMain.handle('online:host-stop', () => online.hostStop());
  ipcMain.handle('online:host-decision', (_event, accept: unknown) => {
    if (typeof accept !== 'boolean') throw new Error('无效的审批结果');
    return online.hostDecision(accept);
  });
  ipcMain.handle('online:host-snapshot', (_event, snapshot: unknown) =>
    online.hostSnapshot(snapshot),
  );
  ipcMain.handle(
    'online:host-reply',
    (_event, actionId: unknown, accepted: unknown, message: unknown, snapshot: unknown) =>
      online.hostReply(actionId, accepted, message, snapshot),
  );
  ipcMain.handle('online:guest-join', (_event, url: unknown) => online.guestJoin(url));
  ipcMain.handle('online:guest-action', (_event, action: unknown) => online.guestAction(action));
  ipcMain.handle('online:guest-leave', () => online.guestLeave());
  ipcMain.handle('online:status', () => online.status());
```

4. 在 `engine:search` 的 `serialize` 回调开头加引擎门禁：

```ts
    serialize(async (): Promise<SearchResult[]> => {
      if (online.isActive()) throw new Error('联机对局中不可使用引擎');
      const payload = parseSearchPayload(raw);
      const instance = await ensureEngine();
      return instance.search(payload.fen, payload.nodes, payload.multiPv, payload.timeoutMs);
    }),
```

5. `createWindow()` 中，在 `win.removeMenu();` 后加入：

```ts
  win.on('closed', () => {
    void online.stop('window-closed');
  });
  win.webContents.on('render-process-gone', () => {
    void online.stop('render-gone');
  });
```

6. 在 `window-all-closed` 监听之后加入：

```ts
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !online.isActive()) return;
  event.preventDefault();
  quitting = true;
  const fallback = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  void Promise.race([online.stop('app-quit'), fallback]).finally(() => app.quit());
});
```

7. `will-quit` 中补一行：

```ts
app.on('will-quit', () => {
  void online.stop('will-quit');
  engine?.kill();
  engine = null;
});
```

- [ ] **Step 7: 运行类型检查与相关测试**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/typescript/bin/tsc --noEmit
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron
```
Expected: 类型检查无错误；hostServer、client、session、staticGuard、ipc 全部 PASS。

- [ ] **Step 8: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add electron/online/ipc.ts electron/main.ts electron/preload.ts src/ui/api.ts tests/electron/ipc.test.ts
git commit -m "feat: wire online sessions through IPC with quit hooks and engine guard"
```

### Task 9: 联机面板 UI 组件

**Files:**
- Create: `src/ui/online.ts`
- Modify: `src/ui/index.html`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `OnlinePhase`、`OnlineRole`、`PendingRequest`、`Side`。
- Produces:
  - `interface OnlinePanelHooks`（`hostStart`、`hostStop`、`hostDecision`、`guestJoin`、`guestLeave`、`undoRequest`、`undoCancel`、`undoResponse`、`drawOffer`、`drawResponse`、`resign`）
  - `interface OnlinePanelView`（`role`、`approved`、`joinRequestPending`、`phase`、`inviteUrl`、`clockText`、`message`、`pending`、`selfSide`、`canAct`）
  - `class OnlinePanel`：`open()`、`close()`、`render(view)`、`setError(text)`、`get isOpen`

- [ ] **Step 1: 在控制栏加入口**

Modify `src/ui/index.html`，在“新局/认输/复盘”那一行之后插入：

```html
        <div class="row">
          <button id="online" title="联机对战">联机</button>
        </div>
```

- [ ] **Step 2: 加入联机模态框**

Modify `src/ui/index.html`，在 `<div id="fen-modal" class="modal" hidden>` 之前插入：

```html
    <div id="online-modal" class="modal" hidden>
      <div class="modal-box online-box">
        <h2>联机对战</h2>

        <div class="online-tabs">
          <button id="online-tab-host" type="button" class="active">创建房间</button>
          <button id="online-tab-guest" type="button">加入房间</button>
        </div>

        <section id="online-host-pane">
          <div class="row">
            <select id="online-host-side" aria-label="房主执方">
              <option value="red">房主执红</option>
              <option value="black">房主执黑</option>
            </select>
            <button id="online-create" type="button">创建房间</button>
          </div>
          <label class="online-label" for="online-url">邀请链接</label>
          <div class="row">
            <input id="online-url" readonly placeholder="创建后生成" />
            <button id="online-copy" type="button" class="ghost" disabled>复制</button>
          </div>
          <div id="online-host-state" class="online-state">未创建</div>
          <div id="online-join-request" class="online-request" hidden>
            <span>有玩家请求加入</span>
            <div class="row">
              <button id="online-accept" type="button">同意</button>
              <button id="online-reject" type="button" class="ghost">拒绝</button>
            </div>
          </div>
          <div class="row">
            <button id="online-stop" type="button" class="ghost" disabled>结束联机</button>
          </div>
        </section>

        <section id="online-guest-pane" hidden>
          <label class="online-label" for="online-join-url">邀请链接</label>
          <textarea
            id="online-join-url"
            rows="3"
            spellcheck="false"
            placeholder="粘贴房主发来的链接"
          ></textarea>
          <div class="row">
            <button id="online-join" type="button">加入</button>
            <button id="online-leave" type="button" class="ghost" disabled>离开</button>
          </div>
          <div id="online-guest-state" class="online-state">未加入</div>
        </section>

        <div id="online-game" class="online-game" hidden>
          <div id="online-clock" class="online-clock">等待开始</div>
          <div id="online-connection" class="online-state"></div>
          <div id="online-pending" class="online-pending" hidden>
            <span id="online-pending-text"></span>
            <div class="row">
              <button id="online-pending-accept" type="button">同意</button>
              <button id="online-pending-reject" type="button" class="ghost">拒绝</button>
              <button id="online-pending-cancel" type="button" class="ghost" hidden>撤回</button>
            </div>
          </div>
          <div class="row">
            <button id="online-undo" type="button">悔棋</button>
            <button id="online-draw" type="button">求和</button>
            <button id="online-resign" type="button" class="ghost">认输</button>
          </div>
        </div>

        <p id="online-error" class="modal-error"></p>
        <div class="modal-actions">
          <button id="online-close" type="button" class="ghost">关闭</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: 补充样式**

Modify `src/ui/styles.css`，在文件末尾追加：

```css
/* ---------- online ---------- */

.online-box {
  max-width: 300px;
}

.online-tabs {
  display: flex;
  gap: 3px;
  margin-bottom: 6px;
}

.online-tabs button {
  flex: 1;
}

.online-tabs button.active {
  border-color: #4a4a52;
  background: #202026;
}

.online-label {
  display: block;
  margin: 4px 0 2px;
  color: var(--dim);
  font-size: 9px;
}

#online-url,
#online-join-url {
  flex: 1;
  min-width: 0;
  padding: 3px 4px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #141416;
  color: var(--text);
  font: inherit;
  font-size: 10px;
}

#online-url:focus,
#online-join-url:focus {
  border-color: #3d3d44;
  outline: none;
}

.online-state {
  min-height: 14px;
  margin: 4px 0;
  color: #b9b9c0;
  font-size: 10px;
  line-height: 1.4;
}

.online-request {
  margin: 4px 0;
  padding: 4px;
  border: 1px solid #6b5328;
  border-radius: 4px;
  background: #241c0e;
  font-size: 10px;
}

.online-game {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.online-clock {
  margin-bottom: 2px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.online-pending {
  margin: 4px 0;
  padding: 4px;
  border: 1px solid #3c3c46;
  border-radius: 4px;
  background: #17171b;
  font-size: 10px;
}

.online-pending .row {
  margin-top: 4px;
}
```

- [ ] **Step 4: 实现面板组件**

Create `src/ui/online.ts`:

```ts
import type { OnlinePhase, OnlineRole, PendingRequest } from '../net/protocol.ts';
import type { Side } from '../types.ts';

export interface OnlinePanelHooks {
  hostStart(hostSide: Side): Promise<void>;
  hostStop(): Promise<void>;
  hostDecision(accept: boolean): void;
  guestJoin(url: string): Promise<void>;
  guestLeave(): void;
  undoRequest(): void;
  undoCancel(): void;
  undoResponse(accept: boolean): void;
  drawOffer(): void;
  drawResponse(accept: boolean): void;
  resign(): void;
}

export interface OnlinePanelView {
  role: OnlineRole | null;
  approved: boolean;
  joinRequestPending: boolean;
  phase: OnlinePhase | null;
  inviteUrl: string | null;
  clockText: string;
  message: string;
  pending: PendingRequest | null;
  selfSide: Side | null;
  canAct: boolean;
}

const IDLE_VIEW: OnlinePanelView = {
  role: null,
  approved: false,
  joinRequestPending: false,
  phase: null,
  inviteUrl: null,
  clockText: '',
  message: '创建或加入房间',
  pending: null,
  selfSide: null,
  canAct: false,
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

export class OnlinePanel {
  private readonly hooks: OnlinePanelHooks;
  private readonly modal: HTMLDivElement;
  private readonly hostTab: HTMLButtonElement;
  private readonly guestTab: HTMLButtonElement;
  private readonly hostPane: HTMLElement;
  private readonly guestPane: HTMLElement;
  private readonly hostSide: HTMLSelectElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly urlInput: HTMLInputElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly hostState: HTMLElement;
  private readonly joinRequest: HTMLElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly rejectBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly joinInput: HTMLTextAreaElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly guestState: HTMLElement;
  private readonly gameBox: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly connectionEl: HTMLElement;
  private readonly pendingBox: HTMLElement;
  private readonly pendingText: HTMLElement;
  private readonly pendingAccept: HTMLButtonElement;
  private readonly pendingReject: HTMLButtonElement;
  private readonly pendingCancel: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly drawBtn: HTMLButtonElement;
  private readonly resignBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private view: OnlinePanelView = IDLE_VIEW;
  private tab: 'host' | 'guest' = 'host';
  private busy = false;
  private stopArmed = false;
  private stopTimer: number | null = null;

  constructor(hooks: OnlinePanelHooks) {
    this.hooks = hooks;
    this.modal = byId<HTMLDivElement>('online-modal');
    this.hostTab = byId('online-tab-host');
    this.guestTab = byId('online-tab-guest');
    this.hostPane = byId('online-host-pane');
    this.guestPane = byId('online-guest-pane');
    this.hostSide = byId<HTMLSelectElement>('online-host-side');
    this.createBtn = byId('online-create');
    this.urlInput = byId<HTMLInputElement>('online-url');
    this.copyBtn = byId('online-copy');
    this.hostState = byId('online-host-state');
    this.joinRequest = byId('online-join-request');
    this.acceptBtn = byId('online-accept');
    this.rejectBtn = byId('online-reject');
    this.stopBtn = byId('online-stop');
    this.joinInput = byId<HTMLTextAreaElement>('online-join-url');
    this.joinBtn = byId('online-join');
    this.leaveBtn = byId('online-leave');
    this.guestState = byId('online-guest-state');
    this.gameBox = byId('online-game');
    this.clockEl = byId('online-clock');
    this.connectionEl = byId('online-connection');
    this.pendingBox = byId('online-pending');
    this.pendingText = byId('online-pending-text');
    this.pendingAccept = byId('online-pending-accept');
    this.pendingReject = byId('online-pending-reject');
    this.pendingCancel = byId('online-pending-cancel');
    this.undoBtn = byId('online-undo');
    this.drawBtn = byId('online-draw');
    this.resignBtn = byId('online-resign');
    this.errorEl = byId('online-error');
    this.closeBtn = byId('online-close');
    this.bind();
    this.render(IDLE_VIEW);
  }

  get isOpen(): boolean {
    return !this.modal.hidden;
  }

  open(): void {
    this.setError('');
    this.modal.hidden = false;
    this.render(this.view);
    this.createBtn.focus();
  }

  close(): void {
    this.modal.hidden = true;
    this.resetStopArm();
  }

  setError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.title = text;
  }

  render(view: OnlinePanelView): void {
    this.view = view;
    const active = view.role !== null;
    this.hostTab.classList.toggle('active', this.tab === 'host');
    this.guestTab.classList.toggle('active', this.tab === 'guest');
    this.hostTab.hidden = active;
    this.guestTab.hidden = active;
    this.hostPane.hidden = active ? view.role !== 'host' : this.tab !== 'host';
    this.guestPane.hidden = active ? view.role !== 'guest' : this.tab !== 'guest';

    this.hostSide.disabled = active || this.busy;
    this.createBtn.disabled = active || this.busy;
    this.joinInput.disabled = active || this.busy;
    this.joinBtn.disabled = active || this.busy;
    this.urlInput.value = view.inviteUrl ?? '';
    this.copyBtn.disabled = !view.inviteUrl;
    this.stopBtn.disabled = view.role !== 'host' || this.busy;
    this.leaveBtn.disabled = view.role !== 'guest' || this.busy;
    this.joinRequest.hidden = !view.joinRequestPending;
    this.hostState.textContent = this.hostStatusText(view);
    this.guestState.textContent = this.guestStatusText(view);

    this.gameBox.hidden = !active || view.phase === null;
    this.clockEl.textContent = view.clockText || '等待开始';
    this.connectionEl.textContent = view.message;
    this.pendingBox.hidden = !view.pending;
    if (view.pending) {
      const mine = view.pending.by === view.selfSide;
      const kind = view.pending.kind === 'undo' ? '悔棋' : '求和';
      this.pendingText.textContent = mine ? `已请求${kind}，等待对方回应` : `对方请求${kind}`;
      this.pendingAccept.hidden = mine;
      this.pendingReject.hidden = mine;
      this.pendingCancel.hidden = !mine || view.pending.kind !== 'undo';
    }
    this.undoBtn.disabled = !view.canAct || view.pending !== null;
    this.drawBtn.disabled = !view.canAct || view.pending !== null;
    this.resignBtn.disabled = !view.canAct;
    if (!this.stopArmed) this.stopBtn.textContent = '结束联机';
  }

  private bind(): void {
    this.modal.addEventListener('click', (event) => {
      if (event.target === this.modal) this.close();
    });
    this.closeBtn.addEventListener('click', () => this.close());
    this.hostTab.addEventListener('click', () => {
      this.tab = 'host';
      this.setError('');
      this.render(this.view);
    });
    this.guestTab.addEventListener('click', () => {
      this.tab = 'guest';
      this.setError('');
      this.render(this.view);
    });

    this.createBtn.addEventListener('click', () => {
      const side: Side = this.hostSide.value === 'black' ? 'black' : 'red';
      void this.run(() => this.hooks.hostStart(side));
    });
    this.joinBtn.addEventListener('click', () => {
      const url = this.joinInput.value.trim();
      if (!url) {
        this.setError('请粘贴邀请链接');
        return;
      }
      void this.run(() => this.hooks.guestJoin(url));
    });
    this.copyBtn.addEventListener('click', () => {
      const text = this.view.inviteUrl;
      if (!text) return;
      void copyText(text).then((copied) => {
        this.copyBtn.textContent = copied ? '已复制' : '复制失败';
        window.setTimeout(() => {
          this.copyBtn.textContent = '复制';
        }, 1200);
      });
    });
    this.acceptBtn.addEventListener('click', () => {
      try {
        this.hooks.hostDecision(true);
      } catch (error) {
        this.setError(describeError(error));
      }
    });
    this.rejectBtn.addEventListener('click', () => {
      try {
        this.hooks.hostDecision(false);
      } catch (error) {
        this.setError(describeError(error));
      }
    });
    this.stopBtn.addEventListener('click', () => {
      if (this.view.phase === 'playing' && !this.stopArmed) {
        this.stopArmed = true;
        this.stopBtn.textContent = '再点一次确认';
        if (this.stopTimer !== null) window.clearTimeout(this.stopTimer);
        this.stopTimer = window.setTimeout(() => this.resetStopArm(), 5000);
        return;
      }
      this.resetStopArm();
      void this.run(() => this.hooks.hostStop());
    });
    this.leaveBtn.addEventListener('click', () => this.hooks.guestLeave());

    this.pendingAccept.addEventListener('click', () => {
      const pending = this.view.pending;
      if (!pending || pending.by === this.view.selfSide) return;
      if (pending.kind === 'undo') this.hooks.undoResponse(true);
      else this.hooks.drawResponse(true);
    });
    this.pendingReject.addEventListener('click', () => {
      const pending = this.view.pending;
      if (!pending || pending.by === this.view.selfSide) return;
      if (pending.kind === 'undo') this.hooks.undoResponse(false);
      else this.hooks.drawResponse(false);
    });
    this.pendingCancel.addEventListener('click', () => this.hooks.undoCancel());

    this.undoBtn.addEventListener('click', () => this.hooks.undoRequest());
    this.drawBtn.addEventListener('click', () => this.hooks.drawOffer());
    this.resignBtn.addEventListener('click', () => this.hooks.resign());
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render(this.view);
    try {
      await task();
    } catch (error) {
      this.setError(describeError(error));
    } finally {
      this.busy = false;
      this.render(this.view);
    }
  }

  private resetStopArm(): void {
    this.stopArmed = false;
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.stopBtn.textContent = '结束联机';
  }

  private hostStatusText(view: OnlinePanelView): string {
    if (view.role !== 'host') return '未创建';
    if (view.joinRequestPending) return '有玩家请求加入';
    if (view.phase === 'ended') return '对局已结束';
    if (view.approved) return '对局中';
    if (!view.inviteUrl) return '正在启动联机…';
    return '等待对方加入';
  }

  private guestStatusText(view: OnlinePanelView): string {
    if (view.role !== 'guest') return '未加入';
    if (view.phase === 'ended') return '对局已结束';
    if (!view.approved) return '等待房主同意';
    if (view.phase === 'playing') return '对局中';
    return '等待房主开始';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 5: 构建确认类型与打包通过**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/build.mjs
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/typescript/bin/tsc --noEmit
```
Expected: 构建成功；类型检查无错误（此时 `online.ts` 未被 `app.ts` 引用，但仍在 `src/**/*.ts` 检查范围内）。

- [ ] **Step 6: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/ui/online.ts src/ui/index.html src/ui/styles.css
git commit -m "feat: add online play panel UI"
```

### Task 10: 渲染进程联机模式集成

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `src/ui/index.html`（常驻联机信息条）
- Modify: `src/ui/styles.css`（信息条样式）

**Interfaces:**
- Consumes: `OnlineGame`、`gameFromSnapshot`、`toUciMove`、`OnlinePanel`/`OnlinePanelView`、`OnlineEvent`/`OnlineSnapshot`/`OnlinePhase`/`OnlineRole`/`GuestAction`/`ActionReply`/`ClockSnapshot`、`api().hostStart|hostStop|hostDecision|hostSnapshot|hostReply|guestJoin|guestAction|guestLeave|onOnlineEvent`。
- Produces: 渲染进程联机模式状态与全部交互路径；不导出符号。

**集成要点（实现时必须保持）：**
- `game` 始终是当前展示的棋局。房主直接持有 `OnlineGame.game` 对象；客人在每次快照到达时用 `gameFromSnapshot` 重建。
- 联机期间 `onlineActive()` 为真：提示、实时评估、推演、赛中复盘、新局、导入 FEN、载入存档、从文件载入全部禁用；保存/导出保持可用；悔棋与认输按钮改走联机请求。
- 联机期间不调用 `aiTurn`、`evaluatePosition`、`showHint`、`runReview`、`enterSimulation`。
- 会话结束后当前棋局保留为本地棋局；若未分胜负，把 `humanSide` 设为当前行棋方，让本地对局可继续（AI 接管另一方）。

- [ ] **Step 1: 加入常驻联机信息条**

Modify `src/ui/index.html`，在 `<section class="board-pane">` 内、`<div class="board-wrap">` 之前插入：

```html
        <div id="online-bar" class="online-bar" hidden>
          <span id="online-bar-text">联机</span>
          <span id="online-bar-clock" class="online-bar-clock"></span>
        </div>
```

Modify `src/ui/styles.css`，在文件末尾追加：

```css
.online-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
  padding: 3px 6px;
  border: 1px solid #3c3c46;
  border-radius: 4px;
  background: #17171b;
  color: #b9b9c0;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.online-bar-clock {
  color: var(--text);
}
```

- [ ] **Step 2: 补导入、DOM 元素与联机状态**

Modify `src/ui/app.ts`。

1. 把 `import { sameSquare } from '../types.ts';` 替换为：

```ts
import { opposite, sameSquare } from '../types.ts';
```

2. 在 `import type { EndReason, ... } from '../types.ts';` 之后加入：

```ts
import { OnlineGame } from '../net/onlineGame.ts';
import { gameFromSnapshot } from '../net/snapshotGame.ts';
import {
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
```

3. 在 `const fenConfirmEl = ...` 之后加入：

```ts
const onlineEl = byId<HTMLButtonElement>('online');
const onlineBarEl = byId<HTMLDivElement>('online-bar');
const onlineBarTextEl = byId('online-bar-text');
const onlineBarClockEl = byId('online-bar-clock');
```

4. 在 `let simRedo: Move[] = [];` 之后加入：

```ts
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
let startingEvents: OnlineEvent[] = [];
```

- [ ] **Step 3: 联机状态、棋钟与视图辅助函数**

Modify `src/ui/app.ts`，在 `function applyEvalUi(ui: EvalUi): void { ... }` 之后、`async function evaluatePosition` 之前插入：

```ts
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
  const total = Math.max(0, Math.ceil(ms / 1000));
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
```

- [ ] **Step 4: 房主与客人流程、快照应用与棋钟同步**

Modify `src/ui/app.ts`，在 `ensureClockTimer()` 之后、`function targetsFor` 之前插入：

```ts
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
  nextPieceId = 1;
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
    if (!reply.accepted) {
      setMessage(reply.message ?? '无法走棋');
      selected = null;
      render();
      return;
    }
    if (!reply.snapshot) return;
    const entry = game.history[game.history.length - 1];
    if (entry) snapshots.push(advancePieces(piecesNow(), entry.move));
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
  nextPieceId = 1;
  snapshots = [snapshot(game.position)];
  board.setOrientation(hostSide);
  board.reset(piecesNow());
  ensureClockTimer();
  updateOnlineUi();
  render();
  setMessage('联机房间已创建，等待对方加入');
  flushStartingEvents();
}

async function joinRoom(url: string): Promise<void> {
  if (onlineActive()) throw new Error('已有联机会话');
  if (game.history.length > 0 && !window.confirm('联机对战会替换当前棋局，继续？')) return;

  startingOnline = true;
  let joined: { phase: OnlinePhase };
  try {
    joined = await api().guestJoin(url);
  } catch (error) {
    startingOnline = false;
    startingEvents.length = 0;
    throw error;
  }

  resetLocalForOnline();
  online = {
    role: 'guest',
    phase: joined.phase,
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
  flushStartingEvents();
}

function decideGuest(accept: boolean): void {
  if (online.role !== 'host' || !online.hostGame) return;
  void (async () => {
    try {
      await api().hostDecision(accept);
      online.joinRequestPending = false;
      if (accept) {
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
  await api().guestLeave().catch(() => undefined);
  finishOnlineSession('已离开房间');
}

function finishOnlineSession(note: string): void {
  if (!onlineActive()) return;
  const result = game.result;
  const self = online.selfSide;
  online = idleOnline();
  startingOnline = false;
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
      finishOnlineSession(`联机已结束：${event.reason}`);
      return;
    }
  }
}
```

- [ ] **Step 5: 公平性门禁与本地入口改写**

Modify `src/ui/app.ts`。

1. `evaluatePosition` 开头插入（在 `const token = generation;` 之前）：

```ts
  if (onlineActive()) {
    showOnlineEvalOff();
    return;
  }
```

2. `aiTurn` 开头插入：

```ts
  if (onlineActive()) return;
```

3. `handleCell` 整体替换为：

```ts
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
```

4. `showHint` 开头插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可使用提示');
    return;
  }
```

5. `undo` 开头插入：

```ts
  if (onlineActive()) {
    requestOnlineUndo();
    return;
  }
```

6. `resign` 开头插入：

```ts
  if (onlineActive()) {
    resignOnline();
    return;
  }
```

7. `runReview` 开头插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可复盘');
    return;
  }
```

8. `startNewGame` 开头插入：

```ts
  if (onlineActive()) {
    setMessage('请先结束联机对局');
    return;
  }
```

9. `enterSimulation` 开头插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可推演');
    return;
  }
```

10. `openFenModal` 开头插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可导入局面');
    return;
  }
```

11. `loadArchived` 的 `try` 之前插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可载入存档');
    return;
  }
```

12. `importFromFile` 的 `try` 之前插入：

```ts
  if (onlineActive()) {
    setMessage('联机对局中不可从文件载入');
    return;
  }
```

- [ ] **Step 6: 改写渲染与按钮门禁**

Modify `src/ui/app.ts`。

1. `render()` 的回合显示分支：把

```ts
  } else {
    const waiting = sideToMove === humanSide;
    const suffix = waiting ? '你' : thinking ? 'AI思考' : 'AI';
    turnEl.textContent = `${SIDE_TEXT[sideToMove]} · ${suffix}`;
    turnEl.className = `turn ${sideToMove}`;
    turnEl.title = '';
  }
```

替换为：

```ts
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
```

2. `render()` 末尾：把

```ts
  renderMoves();
  renderButtons();
}
```

替换为：

```ts
  renderMoves();
  renderButtons();
  updateOnlineBar();
}
```

3. `renderButtons` 整体替换为：

```ts
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
```

- [ ] **Step 7: 启动时接线**

Modify `src/ui/app.ts`，在文件底部 `renderShortcuts();` 之前插入：

```ts
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
```

- [ ] **Step 8: 构建与类型检查**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/build.mjs
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/typescript/bin/tsc --noEmit
```
Expected: 构建成功；类型检查无错误。若报 `OnlinePanelView` 字段不匹配，以 Task 9 的接口定义为准修正 `onlineView()`。

- [ ] **Step 9: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add src/ui/app.ts src/ui/index.html src/ui/styles.css
git commit -m "feat: integrate online play mode into the app"
```

### Task 11: 联机冒烟、真实穿透与打包验收

**Files:**
- Create: `scripts/online-smoke.mjs`
- Create: `tests/electron/tunnel.live.test.ts`
- Modify: `package.json`（新增 `smoke:online` 脚本）

**Interfaces:**
- Consumes: 已构建的 `dist-electron`/`dist-ui`、`XIANGQI_ONLINE_SMOKE_LOCAL=1`、`HostOnlineSession`、`parseInvite`。
- Produces: 可重复执行的双实例联机冒烟脚本；可选的真实穿透集成测试。

- [ ] **Step 1: 编写双实例联机冒烟脚本**

Create `scripts/online-smoke.mjs`：

```js
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const shots = 'docs/screenshots';
mkdirSync(shots, { recursive: true });

const hostData = mkdtempSync(join(tmpdir(), 'xiangqi-online-host-'));
const guestData = mkdtempSync(join(tmpdir(), 'xiangqi-online-guest-'));

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;
baseEnv.XIANGQI_ONLINE_SMOKE_LOCAL = '1';

const packagedExe = process.env.XIANGQI_EXE;
const launch = (userData) =>
  electron.launch({
    executablePath: packagedExe ?? 'node_modules/electron/dist/electron.exe',
    args: packagedExe ? [] : ['.'],
    env: { ...baseEnv, XIANGQI_USER_DATA: userData },
  });

const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};

const text = (page, selector) => page.locator(selector).textContent();

const openOnline = async (page) => {
  if (!(await page.locator('.controls').isVisible())) await page.locator('#toggle-panel').click();
  await page.waitForTimeout(150);
  await page.locator('#online').click();
  await page.waitForSelector('#online-modal:not([hidden])');
};

const clickSquare = async (page, orientation, file, rank) => {
  const df = orientation === 'red' ? file : 8 - file;
  const dr = orientation === 'red' ? 9 - rank : rank;
  await page.locator(`.hits rect[data-df="${df}"][data-dr="${dr}"]`).click();
};

const moveCount = (page) =>
  page.locator('#move-list .move-red, #move-list .move-black').count();

const host = await launch(hostData);
const guest = await launch(guestData);

try {
  const hostPage = await host.firstWindow();
  const guestPage = await guest.firstWindow();
  hostPage.on('console', (message) => {
    if (message.type() === 'error') console.log('[host error]', message.text());
  });
  guestPage.on('console', (message) => {
    if (message.type() === 'error') console.log('[guest error]', message.text());
  });
  await hostPage.waitForLoadState('domcontentloaded');
  await guestPage.waitForLoadState('domcontentloaded');

  await openOnline(hostPage);
  await hostPage.locator('#online-host-side').selectOption('red');
  await hostPage.locator('#online-create').click();
  await waitFor(
    async () => (await hostPage.locator('#online-url').inputValue()).includes('/#'),
    '房主生成邀请链接',
  );
  const invite = await hostPage.locator('#online-url').inputValue();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/.test(invite)) {
    throw new Error(`邀请链接格式异常：${invite}`);
  }
  console.log('邀请链接：', invite);

  await openOnline(guestPage);
  await guestPage.locator('#online-tab-guest').click();
  await guestPage.locator('#online-join-url').fill(invite);
  await guestPage.locator('#online-join').click();
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('等待房主同意'),
    '客人进入等待审批',
  );

  await waitFor(
    () => hostPage.locator('#online-join-request').isVisible(),
    '房主收到加入请求',
  );
  await hostPage.locator('#online-accept').click();
  await waitFor(
    async () => (await text(hostPage, '#online-host-state'))?.includes('对局中'),
    '房主进入对局',
  );
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('对局中'),
    '客人进入对局',
  );

  await hostPage.screenshot({ path: `${shots}/online-host-start.png` });
  await guestPage.screenshot({ path: `${shots}/online-guest-start.png` });

  const fairness = await hostPage.evaluate(() => ({
    hint: document.getElementById('hint').disabled,
    review: document.getElementById('review').disabled,
    simulate: document.getElementById('simulate').disabled,
    newGame: document.getElementById('new-game').disabled,
    load: document.getElementById('load').disabled,
    importFen: document.getElementById('import-fen').disabled,
    eval: document.getElementById('eval-score').textContent,
    bar: !document.getElementById('online-bar').hidden,
  }));
  console.log('房主公平性门禁：', JSON.stringify(fairness));
  if (
    !fairness.hint ||
    !fairness.review ||
    !fairness.simulate ||
    !fairness.newGame ||
    !fairness.load ||
    !fairness.importFen ||
    fairness.eval !== '联机模式已关闭评估' ||
    !fairness.bar
  ) {
    throw new Error('联机公平性门禁未生效');
  }

  const engineError = await hostPage.evaluate(async () => {
    try {
      await window.xiangqi.search({ fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', nodes: 10 });
      return 'allowed';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  console.log('联机时主进程引擎门禁：', engineError);
  if (!engineError.includes('联机对局中不可使用引擎')) {
    throw new Error('主进程未拒绝联机期间的引擎调用');
  }

  await clickSquare(hostPage, 'red', 7, 1);
  await clickSquare(hostPage, 'red', 4, 1);
  await waitFor(async () => (await moveCount(hostPage)) === 1, '房主走子');
  await waitFor(async () => (await moveCount(guestPage)) === 1, '客人收到房主走子');

  await clickSquare(guestPage, 'black', 7, 7);
  await clickSquare(guestPage, 'black', 4, 7);
  await waitFor(async () => (await moveCount(guestPage)) === 2, '客人走子');
  await waitFor(async () => (await moveCount(hostPage)) === 2, '房主收到客人走子');

  await hostPage.locator('#online-undo').click();
  await waitFor(
    () => guestPage.locator('#online-pending').isVisible(),
    '客人收到悔棋请求',
  );
  const pendingText = await text(guestPage, '#online-pending-text');
  if (!pendingText?.includes('对方请求悔棋')) throw new Error(`悔棋提示异常：${pendingText}`);
  await guestPage.locator('#online-pending-accept').click();
  await waitFor(async () => (await moveCount(hostPage)) === 0, '悔棋后回到起点');
  await waitFor(async () => (await moveCount(guestPage)) === 0, '客人同步悔棋');

  await clickSquare(hostPage, 'red', 7, 1);
  await clickSquare(hostPage, 'red', 4, 1);
  await waitFor(async () => (await moveCount(guestPage)) === 1, '悔棋后房主再走子');
  await clickSquare(guestPage, 'black', 7, 7);
  await clickSquare(guestPage, 'black', 4, 7);
  await waitFor(async () => (await moveCount(hostPage)) === 2, '悔棋后客人再走子');

  await guestPage.locator('#online-draw').click();
  await waitFor(
    () => hostPage.locator('#online-pending').isVisible(),
    '房主收到求和请求',
  );
  await hostPage.locator('#online-pending-accept').click();
  await waitFor(
    async () => (await text(hostPage, '#online-host-state'))?.includes('对局已结束'),
    '房主看到和棋',
  );
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('对局已结束'),
    '客人看到和棋',
  );
  const turnText = await text(hostPage, '#turn');
  if (!turnText?.includes('和棋')) throw new Error(`终局显示异常：${turnText}`);
  console.log('联机悔棋/求和：', pendingText, turnText);

  await hostPage.locator('#online-stop').click();
  await waitFor(
    () => hostPage.locator('#online-bar').isHidden(),
    '房主结束联机',
  );
  await waitFor(
    () => guestPage.locator('#online-bar').isHidden(),
    '客人收到关闭',
  );

  const restored = await hostPage.evaluate(() => ({
    newGame: document.getElementById('new-game').disabled,
    review: document.getElementById('review').disabled,
    eval: document.getElementById('eval-score').textContent,
  }));
  console.log('结束后恢复本地功能：', JSON.stringify(restored));
  if (restored.newGame) throw new Error('结束后新局按钮未恢复');
  if (restored.review) throw new Error('结束后复盘按钮未恢复');

  await hostPage.screenshot({ path: `${shots}/online-after-stop.png` });
  console.log('联机冒烟通过');
} finally {
  await guest.close();
  await host.close();
}
```

- [ ] **Step 2: 加入脚本命令**

Modify `package.json` 的 `scripts`，在 `"package"` 之后加入：

```json
    "smoke:online": "node scripts/online-smoke.mjs"
```

- [ ] **Step 3: 运行双实例冒烟**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/build.mjs
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/online-smoke.mjs
```
Expected: 输出“邀请链接：http://127.0.0.1:…/#…”、“房主公平性门禁：…”、“联机冒烟通过”，无 renderer error。

- [ ] **Step 4: 可选的真实穿透集成测试**

Create `tests/electron/tunnel.live.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { HostOnlineSession } from '../../electron/online/session.ts';
import { parseInvite } from '../../src/net/protocol.ts';

const enabled = process.env.XIANGQI_ONLINE_TUNNEL === '1';

describe.skipIf(!enabled)('真实内网穿透', () => {
  it(
    '公网邀请地址可访问，关闭后不再可用',
    async () => {
      const token = 'b'.repeat(43);
      const session = await HostOnlineSession.create({
        hostSide: 'red',
        token,
        pollHoldMs: 100,
      });
      const invite = parseInvite(session.inviteUrl ?? '');
      const headers = {
        authorization: `Bearer ${invite.token}`,
        'bypass-tunnel-reminder': 'true',
        'user-agent': 'Xiangqi/0.1',
      };
      try {
        const response = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        expect([200, 204]).toContain(response.status);
      } finally {
        await session.stop('live-test');
      }

      const status = await fetch(`${invite.origin}/xq/v1/poll?rev=0`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
        .then((response) => response.status)
        .catch(() => 0);
      expect([200, 204]).not.toContain(status);
    },
    60_000,
  );
});
```

- [ ] **Step 5: 全量测试与真实穿透（可选）**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run
cd /d/VSCodeProject/checkmate && XIANGQI_ONLINE_TUNNEL=1 ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" node_modules/vitest/vitest.mjs run tests/electron/tunnel.live.test.ts
```
Expected: 第一条全量测试 PASS（真实穿透用例默认 skip）；第二条在公网可用时 PASS，失败时明确报错，不静默降级。

- [ ] **Step 6: 打包并验证打包版**

```bash
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/build.mjs
cd /d/VSCodeProject/checkmate && ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/package.mjs
```
Expected: 输出“打包完成：release\Xiangqi-win32-x64\Xiangqi.exe”。

打包版联机冒烟（脚本已读取 `XIANGQI_EXE`）：

```bash
cd /d/VSCodeProject/checkmate && XIANGQI_EXE=release/Xiangqi-win32-x64/Xiangqi.exe ELECTRON_RUN_AS_NODE=1 "/d/Qoder/Qoder CN/Qoder CN.exe" scripts/online-smoke.mjs
```

Expected: 打包版同样输出“联机冒烟通过”。

- [ ] **Step 7: 验收清单与无僵尸进程确认**

逐项确认（记录在提交说明或验收备注中）：

1. 房主 15 秒内拿到可复制链接；客人粘贴后进入“等待房主同意”。
2. 房主拒绝后房间仍可接受下一次加入（重复 Step 3 的加入动作）。
3. 联机期间提示、评估、推演、复盘、新局、导入局面、载入、文件载入均不可用；`window.xiangqi.search` 被主进程拒绝。
4. 双方各走一手后棋钟切换并扣减；悔棋请求、撤回、同意流程正确；求和同意结束对局。
5. 房主结束后双方恢复本地功能，当前棋局可复盘、保存、导出。
6. 关闭房主窗口、`Ctrl+C` 结束、任务管理器强杀后：邀请 URL 失效，任务管理器中不存在 `localtunnel`、`node` 子进程；本版本架构本身不创建子进程，静态检查 `tests/electron/staticGuard.test.ts` 为此提供回归保护。
7. 真实穿透模式（`XIANGQI_ONLINE_TUNNEL=1`）至少手动跑通一次：启动、加入、关闭后 URL 失效。

- [ ] **Step 8: 提交（获得用户授权后）**

```bash
cd /d/VSCodeProject/checkmate && git add scripts/online-smoke.mjs tests/electron/tunnel.live.test.ts package.json
git commit -m "test: add online play smoke and live tunnel checks"
```