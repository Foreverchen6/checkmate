export interface KeyEventLike {
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly key: string;
}

export const SHORTCUT_ACTIONS = [
  { id: 'newGame', label: '新局' },
  { id: 'undo', label: '悔棋' },
  { id: 'hint', label: '提示' },
  { id: 'resign', label: '认输' },
  { id: 'review', label: '复盘' },
  { id: 'simulate', label: '推演/返回' },
  { id: 'save', label: '保存' },
  { id: 'load', label: '载入存档' },
  { id: 'export', label: '导出对局' },
  { id: 'importFile', label: '从文件载入' },
  { id: 'importFen', label: '导入局面' },
  { id: 'menu', label: '菜单' },
  { id: 'retry', label: '重试' },
  { id: 'restartEngine', label: '重启引擎' },
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]['id'];
export type ShortcutMap = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  newGame: 'Ctrl+N',
  undo: 'Ctrl+Z',
  hint: 'Ctrl+H',
  resign: '',
  review: 'Ctrl+R',
  simulate: 'Ctrl+U',
  save: 'Ctrl+S',
  load: 'Ctrl+O',
  export: 'Ctrl+E',
  importFile: '',
  importFen: 'Ctrl+I',
  menu: 'Ctrl+M',
  retry: '',
  restartEngine: '',
};

const COMBO_RE = /^Ctrl(\+Shift)?\+([A-Z0-9])$/;
const EVENT_KEY_RE = /^[a-zA-Z0-9]$/;

export function normalizeCombo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const matched = /^ctrl(\+shift)?\+([a-z0-9])$/i.exec(trimmed);
  if (!matched) return null;
  return `Ctrl${matched[1] ? '+Shift' : ''}+${matched[2].toUpperCase()}`;
}

export function comboFromEvent(event: KeyEventLike): string | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (!EVENT_KEY_RE.test(event.key)) return null;
  return `Ctrl${event.shiftKey ? '+Shift' : ''}+${event.key.toUpperCase()}`;
}

export function eventMatches(event: KeyEventLike, combo: string): boolean {
  if (!combo || !event.ctrlKey || event.altKey || event.metaKey) return false;
  const matched = COMBO_RE.exec(combo);
  if (!matched) return false;
  if (Boolean(matched[1]) !== event.shiftKey) return false;
  return event.key.toUpperCase() === matched[2];
}

export function shortcutConflict(
  shortcuts: ShortcutMap,
  combo: string,
  except: ShortcutAction,
): ShortcutAction | null {
  if (!combo) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === except) continue;
    if (shortcuts[action.id] === combo) return action.id;
  }
  return null;
}

export function shortcutLabel(action: ShortcutAction): string {
  return SHORTCUT_ACTIONS.find((item) => item.id === action)?.label ?? action;
}

export function sanitizeShortcuts(raw: unknown): ShortcutMap {
  const incoming =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = {} as ShortcutMap;
  const used = new Set<string>();
  const pendingDefaults: ShortcutAction[] = [];

  for (const action of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, action.id)) {
      pendingDefaults.push(action.id);
      continue;
    }
    const normalized = normalizeCombo(incoming[action.id]);
    if (normalized === null) {
      pendingDefaults.push(action.id);
      continue;
    }
    if (normalized === '' || used.has(normalized)) {
      result[action.id] = '';
      continue;
    }
    result[action.id] = normalized;
    used.add(normalized);
  }

  for (const action of pendingDefaults) {
    const combo = DEFAULT_SHORTCUTS[action];
    result[action] = combo && !used.has(combo) ? combo : '';
    if (result[action]) used.add(result[action]);
  }

  return result;
}
