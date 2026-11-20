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
  if (
    value.result !== null &&
    (typeof value.result !== 'string' || !RESULTS.has(value.result as GameResult))
  ) {
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