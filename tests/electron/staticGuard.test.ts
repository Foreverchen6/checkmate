import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['electron/online', 'src/net'];

interface Forbidden {
  label: string;
  pattern: RegExp;
  /** 该模式必须能命中的样例子进程代码，用来防止正则写错导致检查空转。 */
  canary: string;
}

const FORBIDDEN: Forbidden[] = [
  {
    label: 'import child_process',
    pattern: /\bfrom\s+['"](?:node:)?child_process['"]/,
    canary: 'import { spawn } from "node:child_process";',
  },
  {
    label: 'require child_process',
    pattern: /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/,
    canary: 'const cp = require("child_process");',
  },
  {
    label: 'import worker_threads',
    pattern: /\bfrom\s+['"](?:node:)?worker_threads['"]/,
    canary: 'import { Worker } from "node:worker_threads";',
  },
  {
    label: 'require worker_threads',
    pattern: /\brequire\(\s*['"](?:node:)?worker_threads['"]\s*\)/,
    canary: 'const workers = require("worker_threads");',
  },
  {
    label: '进程启动调用',
    pattern: /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/,
    canary: 'execSync(`git status`);',
  },
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
  it('每条禁用模式都能命中自身的样例子进程代码', () => {
    for (const { label, pattern, canary } of FORBIDDEN) {
      expect(canary, `模式「${label}」未命中样例：${canary}`).toMatch(pattern);
    }
    // 反向对照：普通标识符不应被误判。
    expect('const exec = 1; const forked = 2;').not.toMatch(
      /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/,
    );
  });

  it('electron/online 与 src/net 不含 child_process、worker_threads 或进程启动调用', () => {
    const scanned = ROOTS.flatMap((root) => listFiles(root));
    // 防止目录改名或为空时“零文件通过”的空转。
    expect(scanned.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file} 命中「${label}」(${pattern})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});