import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitizeShortcuts, type ShortcutMap } from '../shortcuts.ts';

export interface AppSettings {
  shortcuts: ShortcutMap;
}

export function defaultSettings(): AppSettings {
  return { shortcuts: sanitizeShortcuts({}) };
}

export function loadSettings(file: string): AppSettings {
  try {
    if (!existsSync(file)) return defaultSettings();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { shortcuts?: unknown };
    return { shortcuts: sanitizeShortcuts(raw?.shortcuts) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(file: string, raw: unknown): AppSettings {
  const source = raw && typeof raw === 'object' ? (raw as { shortcuts?: unknown }) : {};
  const shortcuts = sanitizeShortcuts(
    'shortcuts' in source ? source.shortcuts : raw,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ shortcuts }, null, 2), 'utf8');
  return { shortcuts };
}
