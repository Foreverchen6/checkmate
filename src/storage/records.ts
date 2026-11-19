import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameRecord } from './recordData.ts';

export type { GameRecord, RecordedMove } from './recordData.ts';
export { buildRecord } from './recordData.ts';

export function saveRecord(record: GameRecord, dir = 'records'): string {
  mkdirSync(dir, { recursive: true });

  const date = new Date(record.startedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const base = [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');

  let file = join(dir, `${base}.json`);
  let suffix = 1;
  while (existsSync(file)) {
    file = join(dir, `${base}-${suffix}.json`);
    suffix += 1;
  }

  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}