import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../../src/storage/settings.ts';
import { DEFAULT_SHORTCUTS } from '../../src/shortcuts.ts';

const tmpDir = join(process.cwd(), 'tests', '.tmp-settings');
const file = join(tmpDir, 'settings.json');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('应用设置', () => {
  it('缺少文件时返回默认快捷键', () => {
    expect(loadSettings(file)).toEqual(defaultSettings());
    expect(loadSettings(file).shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it('保存后可读回并规范化组合键', () => {
    const saved = saveSettings(file, {
      shortcuts: { ...DEFAULT_SHORTCUTS, undo: 'ctrl+shift+z' },
    });
    expect(saved.shortcuts.undo).toBe('Ctrl+Shift+Z');
    expect(loadSettings(file)).toEqual(saved);
  });

  it('损坏文件回退默认', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(file, '{ broken', 'utf8');
    expect(loadSettings(file).shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it('保存时消除冲突', () => {
    const saved = saveSettings(file, {
      shortcuts: { ...DEFAULT_SHORTCUTS, undo: 'Ctrl+N' },
    });
    expect(saved.shortcuts.newGame).toBe('Ctrl+N');
    expect(saved.shortcuts.undo).toBe('');
  });
});
