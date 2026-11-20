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
  // 先结算再置为运行中：对已运行的棋钟重复调用不会退还已流逝的时间。
  const settled = tick(state, now);
  return { ...settled, running: true, updatedAt: now };
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