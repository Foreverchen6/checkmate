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

  it('对已运行的棋钟重复 resume 不退还已流逝的时间', () => {
    const running = tick(createClock('red', 0), 10_000);
    expect(running.running).toBe(true);
    expect(running.redMs).toBe(TOTAL_MS - 10_000);

    const now = running.updatedAt + 5_000;
    const resumed = resume(running, now);
    expect(resumed.running).toBe(true);
    expect(resumed.redMs).toBe(TOTAL_MS - 15_000);
    expect(resumed.stepMs).toBe(STEP_MS - 15_000);
    expect(resumed.blackMs).toBe(TOTAL_MS);
    expect(resumed.updatedAt).toBe(now);

    // 同一时刻重复 resume（模拟重复的重连事件）不应再次退时。
    const again = resume(resumed, now);
    expect(again.running).toBe(true);
    expect(again.redMs).toBe(TOTAL_MS - 15_000);
    expect(again.stepMs).toBe(STEP_MS - 15_000);
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