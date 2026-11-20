import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { EndReason, GameResult } from '../types.ts';
import type { ArchiveSummary, RecordedMove, SavedGame } from './recordData.ts';

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
const UCI_PATTERN = /^[a-i][0-9][a-i][0-9]$/;
const MAX_MOVES = 1000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ARCHIVES = 50;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : null;
}

function readTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function readMoves(value: unknown): RecordedMove[] {
  if (!Array.isArray(value) || value.length > MAX_MOVES) {
    throw new Error('无效的着法列表');
  }

  return value.map((item, index) => {
    const move = asObject(item);
    if (!move) throw new Error(`第 ${index + 1} 手格式无效`);
    if (move.ply !== index + 1) throw new Error(`第 ${index + 1} 手序号不连续`);
    if (move.side !== 'red' && move.side !== 'black') {
      throw new Error(`第 ${index + 1} 手行棋方无效`);
    }
    if (typeof move.uci !== 'string' || !UCI_PATTERN.test(move.uci)) {
      throw new Error(`第 ${index + 1} 手坐标无效`);
    }
    const chinese = readText(move.chinese, 40);
    if (!chinese) throw new Error(`第 ${index + 1} 手记谱无效`);
    return { ply: index + 1, side: move.side, uci: move.uci, chinese };
  });
}

export function sanitizeSavedGame(raw: unknown): SavedGame {
  const data = asObject(raw);
  if (!data) throw new Error('无效的存档数据');
  if (data.version !== 1) throw new Error('不支持的存档版本');
  if (data.kind !== undefined && data.kind !== 'xiangqi-save') {
    throw new Error('无效的存档类型');
  }

  const startedAt = readTime(data.startedAt);
  if (!startedAt) throw new Error('存档缺少开始时间');
  const savedAt = readTime(data.savedAt) ?? startedAt;

  if (data.humanSide !== 'red' && data.humanSide !== 'black') {
    throw new Error('无效的执子方');
  }
  const difficulty = readText(data.difficulty, 40);
  if (!difficulty) throw new Error('无效的难度');

  const initialFen = readText(data.initialFen, 200);
  if (!initialFen) throw new Error('无效的初始局面');
  const finalFen = readText(data.finalFen, 200);
  if (!finalFen) throw new Error('无效的终局局面');

  const rawResult = data.result ?? null;
  if (
    rawResult !== null &&
    (typeof rawResult !== 'string' || !RESULTS.has(rawResult as GameResult))
  ) {
    throw new Error('无效的对局结果');
  }
  const rawReason = data.endReason ?? null;
  if (
    rawReason !== null &&
    (typeof rawReason !== 'string' || !REASONS.has(rawReason as EndReason))
  ) {
    throw new Error('无效的结束原因');
  }
  if ((rawResult === null) !== (rawReason === null)) {
    throw new Error('对局结果与结束原因不匹配');
  }

  return {
    version: 1,
    kind: 'xiangqi-save',
    startedAt,
    savedAt,
    humanSide: data.humanSide,
    difficulty,
    result: rawResult as GameResult | null,
    endReason: rawReason as EndReason | null,
    initialFen,
    finalFen,
    moves: readMoves(data.moves),
  };
}

export function archiveFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${clock}.json`;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`无法读取存档：${path}`);
  }
}

export function saveArchive(raw: SavedGame, dir: string): string {
  const archive = sanitizeSavedGame(raw);
  mkdirSync(dir, { recursive: true });

  const base = join(dir, archiveFileName(new Date(archive.savedAt)));
  const stem = base.slice(0, -'.json'.length);
  let file = base;
  let suffix = 1;
  while (existsSync(file)) {
    file = `${stem}-${suffix}.json`;
    suffix += 1;
  }

  writeFileSync(file, JSON.stringify(archive, null, 2), 'utf8');
  return file;
}

export function listArchives(dir: string): ArchiveSummary[] {
  if (!existsSync(dir)) return [];

  const summaries: ArchiveSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_FILE_SIZE) continue;
      const archive = sanitizeSavedGame(readJson(path));
      summaries.push({
        file: name,
        savedAt: archive.savedAt,
        humanSide: archive.humanSide,
        difficulty: archive.difficulty,
        moveCount: archive.moves.length,
        result: archive.result,
      });
    } catch {
      continue;
    }
  }

  summaries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return summaries.slice(0, MAX_ARCHIVES);
}

export function loadArchive(file: string, dir: string): SavedGame {
  if (
    typeof file !== 'string' ||
    file !== basename(file) ||
    !file.toLowerCase().endsWith('.json')
  ) {
    throw new Error('无效的存档文件名');
  }

  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`存档不存在：${file}`);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_FILE_SIZE) throw new Error('存档文件无效');
  return sanitizeSavedGame(readJson(path));
}

export function writeArchiveFile(path: string, raw: SavedGame): void {
  const archive = sanitizeSavedGame(raw);
  writeFileSync(path, JSON.stringify(archive, null, 2), 'utf8');
}

export function readArchiveFile(path: string): SavedGame {
  if (!existsSync(path)) throw new Error(`找不到文件：${path}`);
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_FILE_SIZE) throw new Error('存档文件无效');
  return sanitizeSavedGame(readJson(path));
}
