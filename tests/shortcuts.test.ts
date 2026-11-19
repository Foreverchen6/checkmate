import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  eventMatches,
  normalizeCombo,
  sanitizeShortcuts,
  shortcutConflict,
  shortcutLabel,
  type ShortcutMap,
} from '../src/shortcuts.ts';

const defaults = (): ShortcutMap => sanitizeShortcuts({});

describe('快捷键', () => {
  it('默认快捷键覆盖全部动作且互不冲突', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual(
      SHORTCUT_ACTIONS.map((action) => action.id).sort(),
    );
    const combos = Object.values(DEFAULT_SHORTCUTS).filter(Boolean);
    expect(new Set(combos).size).toBe(combos.length);
    expect(defaults()).toEqual(DEFAULT_SHORTCUTS);
  });

  it('规范化组合键输入', () => {
    expect(normalizeCombo('ctrl+n')).toBe('Ctrl+N');
    expect(normalizeCombo('  Ctrl+Shift+Z  ')).toBe('Ctrl+Shift+Z');
    expect(normalizeCombo('')).toBe('');
    expect(normalizeCombo('Ctrl+Alt+N')).toBeNull();
    expect(normalizeCombo('n')).toBeNull();
    expect(normalizeCombo(42)).toBeNull();
  });

  it('保留显式清空的动作', () => {
    const result = sanitizeShortcuts({ undo: '' });
    expect(result.undo).toBe('');
    expect(result.newGame).toBe('Ctrl+N');
  });

  it('无效值回退到默认', () => {
    const result = sanitizeShortcuts({ hint: 'F5' });
    expect(result.hint).toBe('Ctrl+H');
  });

  it('重复组合键只保留先出现的动作', () => {
    const result = sanitizeShortcuts({ newGame: 'Ctrl+X', undo: 'Ctrl+X' });
    expect(result.newGame).toBe('Ctrl+X');
    expect(result.undo).toBe('');
  });

  it('从键盘事件提取组合键', () => {
    const base = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 's' };
    expect(comboFromEvent(base)).toBe('Ctrl+S');
    expect(comboFromEvent({ ...base, shiftKey: true, key: 'Z' })).toBe('Ctrl+Shift+Z');
    expect(comboFromEvent({ ...base, ctrlKey: false })).toBeNull();
    expect(comboFromEvent({ ...base, altKey: true })).toBeNull();
    expect(comboFromEvent({ ...base, metaKey: true })).toBeNull();
    expect(comboFromEvent({ ...base, key: 'Enter' })).toBeNull();
  });

  it('匹配已保存的组合键', () => {
    const base = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 's' };
    expect(eventMatches(base, 'Ctrl+S')).toBe(true);
    expect(eventMatches({ ...base, shiftKey: true }, 'Ctrl+S')).toBe(false);
    expect(eventMatches({ ...base, altKey: true }, 'Ctrl+S')).toBe(false);
    expect(eventMatches(base, '')).toBe(false);
    expect(eventMatches(base, 'Ctrl+Shift+S')).toBe(false);
  });

  it('检测组合键冲突并忽略自身', () => {
    const map = defaults();
    expect(shortcutConflict(map, 'Ctrl+N', 'undo')).toBe('newGame');
    expect(shortcutConflict(map, 'Ctrl+N', 'newGame')).toBeNull();
    expect(shortcutConflict(map, '', 'undo')).toBeNull();
  });

  it('提供动作中文名', () => {
    expect(shortcutLabel('undo')).toBe('悔棋');
    expect(shortcutLabel('importFen')).toBe('导入局面');
  });
});
