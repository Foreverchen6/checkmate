# 文字版中国象棋（Pikafish 陪练）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Node/TS 实现一个终端中国象棋对局程序，真实 Pikafish 提供陪练与赛后逐手复盘，棋谱落盘为 JSON。

**Architecture:** 规则引擎、记谱、渲染、引擎适配、复盘、存储各自独立；`main.ts` 串起交互循环。规则层为纯函数，引擎通过 UCI 子进程通信，复盘复用引擎适配器。

**Tech Stack:** Node.js 24（原生执行 TS）、TypeScript（仅类型检查）、Vitest、Pikafish 2026-09-25（项目根目录）、`pikafish.nnue`。

---

## 前置约束（必须遵守）

1. **当前目录不是 git 仓库**，本计划所有任务都以测试通过作为完成标准，不执行 `git init` / `git commit`。若之后初始化仓库，再按任务粒度补提交。
2. **真实引擎是硬依赖**：`D:\VSCodeProject\chess\Pikafish-Windows-x86-64-universal.exe` 与 `D:\VSCodeProject\chess\pikafish.nnue` 已存在。禁止编写桩引擎、假引擎或跳过引擎测试。
3. **引擎 FEN 字母**：Pikafish 2026-09-25 只接受 `K/A/B/N/R/C/P`（`B` 象、`N` 马）。写成 `H/E` 会得到 `Invalid FEN`。初始 FEN：
   `rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1`
4. **UCI 坐标**：列 `a`–`i`，行 `0`–`9`，红方底线为 0；移动写作 `h2e2`。
5. 所有 import 必须带 `.ts` 扩展名，禁止使用 `enum`、参数属性等 Node 类型擦除不支持的语法。

## 文件结构

```
package.json
tsconfig.json
config.json
src/
  types.ts                 共享类型与工具
  config.ts                CLI 参数与配置解析
  main.ts                  交互入口
  rules/
    board.ts               FEN 解析/序列化、初始局面、局面键
    moves.ts               走法生成、合法性、将军、照面
    status.ts              将死/困毙/60 回合
  notation/
    coords.ts              UCI 坐标互转
    chinese.ts             中文记谱生成与匹配
  render/
    board.ts               中文棋子棋盘渲染
  game/
    game.ts                对局状态机、历史、悔棋、结果
  engine/
    uci.ts                 UCI 输出解析
    pikafish.ts            子进程封装
    difficulty.ts          难度档位与选着
  review/
    review.ts              逐手复盘与分级
  storage/
    records.ts             棋谱构建与落盘
tests/
  rules/board.test.ts
  rules/moves.test.ts
  rules/status.test.ts
  notation/coords.test.ts
  notation/chinese.test.ts
  render/board.test.ts
  game/game.test.ts
  engine/uci.test.ts
  engine/pikafish.test.ts
  engine/difficulty.test.ts
  review/review.test.ts
  storage/records.test.ts
  config.test.ts
```

---

### Task 1: 项目骨架与共享类型

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "xiangqi-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "start": "node src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: 创建 `src/types.ts`**

```ts
export type Side = 'red' | 'black';
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';

export interface Piece {
  readonly type: PieceType;
  readonly side: Side;
}

export interface Square {
  readonly file: number;
  readonly rank: number;
}

export interface Move {
  readonly from: Square;
  readonly to: Square;
}

export type Board = ReadonlyArray<ReadonlyArray<Piece | null>>;

export interface Position {
  readonly board: Board;
  readonly sideToMove: Side;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
}

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'move_limit'
  | 'repetition'
  | 'resign'
  | 'aborted';

export type GameResult = 'red_win' | 'black_win' | 'draw' | 'aborted';

export const opposite = (side: Side): Side => (side === 'red' ? 'black' : 'red');

export const square = (file: number, rank: number): Square => ({ file, rank });

export const sameSquare = (a: Square, b: Square): boolean =>
  a.file === b.file && a.rank === b.rank;

export const sameMove = (a: Move, b: Move): boolean =>
  sameSquare(a.from, b.from) && sameSquare(a.to, b.to);
```

- [ ] **Step 4: 安装依赖并做类型检查**

Run:

```bash
npm install
npx tsc --noEmit
```

Expected: 安装成功，`tsc` 无输出（退出码 0）。

---

### Task 2: 棋盘与 FEN

**Files:**
- Create: `src/rules/board.ts`
- Test: `tests/rules/board.test.ts`

- [ ] **Step 1: 写失败测试 `tests/rules/board.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  INITIAL_FEN,
  initialPosition,
  parseFen,
  positionKey,
  toFen,
} from '../../src/rules/board.ts';

describe('FEN', () => {
  it('初始局面可以原样往返', () => {
    const pos = parseFen(INITIAL_FEN);
    expect(toFen(pos)).toBe(INITIAL_FEN);
  });

  it('黑将位于 e9，红帅位于 e0', () => {
    const pos = initialPosition();
    expect(pos.board[9][4]).toEqual({ type: 'K', side: 'black' });
    expect(pos.board[0][4]).toEqual({ type: 'K', side: 'red' });
  });

  it('马和象使用 N/B 字母', () => {
    const pos = initialPosition();
    expect(pos.board[0][1]).toEqual({ type: 'N', side: 'red' });
    expect(pos.board[0][2]).toEqual({ type: 'B', side: 'red' });
  });

  it('行数不足时抛出明确错误', () => {
    expect(() => parseFen('9/9 w - - 0 1')).toThrow(/10 行/);
  });

  it('局面键不包含回合计数', () => {
    expect(positionKey(initialPosition())).toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/rules/board.test.ts`

Expected: FAIL，提示找不到 `src/rules/board.ts`。

- [ ] **Step 3: 实现 `src/rules/board.ts`**

```ts
import type { Piece, Position, Side } from '../types.ts';

export const INITIAL_FEN =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

const PIECE_FROM_CHAR: Record<string, Piece> = {
  K: { type: 'K', side: 'red' },
  A: { type: 'A', side: 'red' },
  B: { type: 'B', side: 'red' },
  N: { type: 'N', side: 'red' },
  R: { type: 'R', side: 'red' },
  C: { type: 'C', side: 'red' },
  P: { type: 'P', side: 'red' },
  k: { type: 'K', side: 'black' },
  a: { type: 'A', side: 'black' },
  b: { type: 'B', side: 'black' },
  n: { type: 'N', side: 'black' },
  r: { type: 'R', side: 'black' },
  c: { type: 'C', side: 'black' },
  p: { type: 'P', side: 'black' },
};

const CHAR_FROM_PIECE: Record<string, string> = {
  'red:K': 'K',
  'red:A': 'A',
  'red:B': 'B',
  'red:N': 'N',
  'red:R': 'R',
  'red:C': 'C',
  'red:P': 'P',
  'black:K': 'k',
  'black:A': 'a',
  'black:B': 'b',
  'black:N': 'n',
  'black:R': 'r',
  'black:C': 'c',
  'black:P': 'p',
};

function parseSide(value: string): Side {
  if (value === 'w') return 'red';
  if (value === 'b') return 'black';
  throw new Error(`无效行棋方：${value}`);
}

export function parseFen(fen: string): Position {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`无效 FEN：${fen}`);

  const rows = parts[0].split('/');
  if (rows.length !== 10) {
    throw new Error(`FEN 必须有 10 行，实际 ${rows.length} 行`);
  }

  const board: (Piece | null)[][] = Array.from({ length: 10 }, () =>
    Array<Piece | null>(9).fill(null),
  );

  rows.forEach((row, index) => {
    const rank = 9 - index;
    let file = 0;
    for (const ch of row) {
      if (/[1-9]/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const piece = PIECE_FROM_CHAR[ch];
      if (!piece) throw new Error(`FEN 含未知棋子字符：${ch}`);
      if (file > 8) throw new Error(`FEN 第 ${index + 1} 行超出 9 列`);
      board[rank][file] = { ...piece };
      file += 1;
    }
    if (file !== 9) {
      throw new Error(`FEN 第 ${index + 1} 行必须有 9 列，实际 ${file}`);
    }
  });

  return {
    board,
    sideToMove: parseSide(parts[1]),
    halfmoveClock: parts[4] ? Number(parts[4]) : 0,
    fullmoveNumber: parts[5] ? Number(parts[5]) : 1,
  };
}

export function toFen(pos: Position): string {
  const rows: string[] = [];
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += CHAR_FROM_PIECE[`${piece.side}:${piece.type}`];
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  const side = pos.sideToMove === 'red' ? 'w' : 'b';
  return `${rows.join('/')} ${side} - - ${pos.halfmoveClock} ${pos.fullmoveNumber}`;
}

export function initialPosition(): Position {
  return parseFen(INITIAL_FEN);
}

export function pieceAt(pos: Position, sq: { file: number; rank: number }): Piece | null {
  if (sq.file < 0 || sq.file > 8 || sq.rank < 0 || sq.rank > 9) return null;
  return pos.board[sq.rank][sq.file];
}

export function positionKey(pos: Position): string {
  return toFen({ ...pos, halfmoveClock: 0, fullmoveNumber: 1 })
    .split(' ')
    .slice(0, 2)
    .join(' ');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/rules/board.test.ts`

Expected: 5 passed。

---

### Task 3: 走法生成、合法性与将军

**Files:**
- Create: `src/rules/moves.ts`
- Test: `tests/rules/moves.test.ts`

- [ ] **Step 1: 写失败测试 `tests/rules/moves.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { PieceType, Position, Side } from '../../src/types.ts';
import { initialPosition, parseFen } from '../../src/rules/board.ts';
import {
  applyMove,
  generateLegalMoves,
  generatePseudoMoves,
  generalsFace,
  isInCheck,
} from '../../src/rules/moves.ts';

interface Placement {
  type: PieceType;
  side: Side;
  file: number;
  rank: number;
}

function positionWith(pieces: Placement[], sideToMove: Side = 'red'): Position {
  const board: ({ type: PieceType; side: Side } | null)[][] = Array.from(
    { length: 10 },
    () => Array(9).fill(null),
  );
  board[0][3] = { type: 'K', side: 'red' };
  board[9][5] = { type: 'K', side: 'black' };
  for (const p of pieces) board[p.rank][p.file] = { type: p.type, side: p.side };
  return { board, sideToMove, halfmoveClock: 0, fullmoveNumber: 1 };
}

describe('初始局面', () => {
  it('红方有 44 个合法着法', () => {
    expect(generateLegalMoves(initialPosition())).toHaveLength(44);
  });
});

describe('棋子走法', () => {
  it('车在空棋盘中心有 17 个走法', () => {
    const pos = positionWith([{ type: 'R', side: 'red', file: 4, rank: 4 }]);
    expect(generatePseudoMoves(pos, { file: 4, rank: 4 })).toHaveLength(17);
  });

  it('炮必须有炮架才能吃子，且不能越过炮架落空点', () => {
    const pos = positionWith([
      { type: 'C', side: 'red', file: 4, rank: 4 },
      { type: 'P', side: 'red', file: 4, rank: 5 },
      { type: 'P', side: 'black', file: 4, rank: 7 },
    ]);
    const moves = generatePseudoMoves(pos, { file: 4, rank: 4 });
    expect(moves.some((m) => m.to.file === 4 && m.to.rank === 7)).toBe(true);
    expect(moves.some((m) => m.to.file === 4 && m.to.rank === 6)).toBe(false);
  });

  it('马腿被堵时不能走对应方向', () => {
    const pos = positionWith([
      { type: 'N', side: 'red', file: 4, rank: 4 },
      { type: 'P', side: 'red', file: 4, rank: 5 },
    ]);
    const moves = generatePseudoMoves(pos, { file: 4, rank: 4 });
    expect(moves.some((m) => m.to.file === 5 && m.to.rank === 6)).toBe(false);
    expect(moves.some((m) => m.to.file === 6 && m.to.rank === 5)).toBe(true);
  });

  it('象眼被堵时不能走，且红象不能过河', () => {
    const blocked = positionWith([
      { type: 'B', side: 'red', file: 4, rank: 2 },
      { type: 'P', side: 'red', file: 3, rank: 3 },
    ]);
    const blockedMoves = generatePseudoMoves(blocked, { file: 4, rank: 2 });
    expect(blockedMoves.some((m) => m.to.file === 2 && m.to.rank === 4)).toBe(false);

    const river = positionWith([{ type: 'B', side: 'red', file: 4, rank: 4 }]);
    const riverMoves = generatePseudoMoves(river, { file: 4, rank: 4 });
    expect(riverMoves.some((m) => m.to.rank === 6)).toBe(false);
    expect(riverMoves.some((m) => m.to.rank === 2)).toBe(true);
  });

  it('士和将不能走出九宫', () => {
    const advisor = positionWith([{ type: 'A', side: 'red', file: 3, rank: 0 }]);
    const advisorMoves = generatePseudoMoves(advisor, { file: 3, rank: 0 });
    expect(advisorMoves).toHaveLength(1);
    expect(advisorMoves[0].to).toEqual({ file: 4, rank: 1 });

    const king = positionWith([{ type: 'K', side: 'red', file: 3, rank: 0 }]);
    const kingMoves = generatePseudoMoves(king, { file: 3, rank: 0 });
    expect(kingMoves.some((m) => m.to.file === 2)).toBe(false);
  });

  it('兵未过河只能前进，过河后可以横走', () => {
    const before = positionWith([{ type: 'P', side: 'red', file: 4, rank: 3 }]);
    expect(generatePseudoMoves(before, { file: 4, rank: 3 })).toHaveLength(1);

    const after = positionWith([{ type: 'P', side: 'red', file: 4, rank: 6 }]);
    const moves = generatePseudoMoves(after, { file: 4, rank: 6 });
    expect(moves).toHaveLength(3);
    expect(moves.some((m) => m.to.rank === 5)).toBe(false);
  });
});

describe('将帅与将军', () => {
  it('将帅照面被识别', () => {
    const pos = parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    expect(generalsFace(pos)).toBe(true);
  });

  it('移开挡住将帅的棋子属于非法着法', () => {
    const pos = parseFen('3k5/9/9/9/9/3R5/9/9/9/3K5 w - - 0 1');
    const moves = generateLegalMoves(pos);
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 5 && m.to.file === 2)).toBe(
      false,
    );
  });

  it('车沿直线攻击将帅时判定为将军', () => {
    const pos = parseFen('3k5/9/9/9/9/3r5/9/9/9/3K5 w - - 0 1');
    expect(isInCheck(pos, 'red')).toBe(true);
  });

  it('被牵制的棋子不能走出导致己方被将军的着法', () => {
    const pos = parseFen('5k3/3r5/9/9/9/3R5/9/9/9/3K5 w - - 0 1');
    const moves = generateLegalMoves(pos);
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 5 && m.to.file === 4)).toBe(
      false,
    );
    expect(moves.some((m) => m.from.file === 3 && m.from.rank === 5 && m.to.rank === 6)).toBe(
      true,
    );
  });

  it('applyMove 会切换行棋方并处理吃子计数', () => {
    const pos = initialPosition();
    const next = applyMove(pos, {
      from: { file: 1, rank: 0 },
      to: { file: 2, rank: 2 },
    });
    expect(next.sideToMove).toBe('black');
    expect(next.halfmoveClock).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/rules/moves.test.ts`

Expected: FAIL，找不到 `src/rules/moves.ts`。

- [ ] **Step 3: 实现 `src/rules/moves.ts`**

```ts
import type { Move, Piece, Position, Side, Square } from '../types.ts';
import { opposite, sameSquare, square } from '../types.ts';
import { pieceAt } from './board.ts';

const ORTHO = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;

const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const HORSE = [
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0],
] as const;

function inBounds(sq: Square): boolean {
  return sq.file >= 0 && sq.file <= 8 && sq.rank >= 0 && sq.rank <= 9;
}

function inPalace(sq: Square, side: Side): boolean {
  if (sq.file < 3 || sq.file > 5) return false;
  return side === 'red' ? sq.rank >= 0 && sq.rank <= 2 : sq.rank >= 7 && sq.rank <= 9;
}

function addIfAvailable(
  pos: Position,
  moves: Move[],
  from: Square,
  file: number,
  rank: number,
  side: Side,
): void {
  const to = square(file, rank);
  if (!inBounds(to)) return;
  const target = pos.board[rank][file];
  if (target && target.side === side) return;
  moves.push({ from, to });
}

export function generatePseudoMoves(pos: Position, from: Square): Move[] {
  const piece = pieceAt(pos, from);
  if (!piece) return [];
  const moves: Move[] = [];

  switch (piece.type) {
    case 'R': {
      for (const [df, dr] of ORTHO) {
        let file = from.file + df;
        let rank = from.rank + dr;
        while (true) {
          const to = square(file, rank);
          if (!inBounds(to)) break;
          const target = pos.board[rank][file];
          if (!target) {
            moves.push({ from, to });
          } else {
            if (target.side !== piece.side) moves.push({ from, to });
            break;
          }
          file += df;
          rank += dr;
        }
      }
      break;
    }
    case 'C': {
      for (const [df, dr] of ORTHO) {
        let file = from.file + df;
        let rank = from.rank + dr;
        let hasScreen = false;
        while (true) {
          const to = square(file, rank);
          if (!inBounds(to)) break;
          const target = pos.board[rank][file];
          if (!hasScreen) {
            if (!target) moves.push({ from, to });
            else hasScreen = true;
          } else if (target) {
            if (target.side !== piece.side) moves.push({ from, to });
            break;
          }
          file += df;
          rank += dr;
        }
      }
      break;
    }
    case 'N': {
      for (const [df, dr, lf, lr] of HORSE) {
        const leg = square(from.file + lf, from.rank + lr);
        if (!inBounds(leg) || pieceAt(pos, leg)) continue;
        addIfAvailable(pos, moves, from, from.file + df, from.rank + dr, piece.side);
      }
      break;
    }
    case 'B': {
      for (const [df, dr] of DIAG) {
        const to = square(from.file + df * 2, from.rank + dr * 2);
        if (!inBounds(to)) continue;
        if (pieceAt(pos, square(from.file + df, from.rank + dr))) continue;
        if (piece.side === 'red' ? to.rank > 4 : to.rank < 5) continue;
        const target = pos.board[to.rank][to.file];
        if (target && target.side === piece.side) continue;
        moves.push({ from, to });
      }
      break;
    }
    case 'A': {
      for (const [df, dr] of DIAG) {
        const to = square(from.file + df, from.rank + dr);
        if (!inPalace(to, piece.side)) continue;
        addIfAvailable(pos, moves, from, to.file, to.rank, piece.side);
      }
      break;
    }
    case 'K': {
      for (const [df, dr] of ORTHO) {
        const to = square(from.file + df, from.rank + dr);
        if (!inPalace(to, piece.side)) continue;
        addIfAvailable(pos, moves, from, to.file, to.rank, piece.side);
      }
      break;
    }
    case 'P': {
      const forward = piece.side === 'red' ? 1 : -1;
      addIfAvailable(pos, moves, from, from.file, from.rank + forward, piece.side);
      const crossed = piece.side === 'red' ? from.rank >= 5 : from.rank <= 4;
      if (crossed) {
        addIfAvailable(pos, moves, from, from.file - 1, from.rank, piece.side);
        addIfAvailable(pos, moves, from, from.file + 1, from.rank, piece.side);
      }
      break;
    }
  }

  return moves;
}

export function applyMove(pos: Position, move: Move): Position {
  const piece = pieceAt(pos, move.from);
  if (!piece) throw new Error('起点没有棋子');

  const board = pos.board.map((row) => row.slice());
  const captured = board[move.to.rank][move.to.file];
  board[move.from.rank][move.from.file] = null;
  board[move.to.rank][move.to.file] = piece;

  return {
    board,
    sideToMove: opposite(pos.sideToMove),
    halfmoveClock: captured ? 0 : pos.halfmoveClock + 1,
    fullmoveNumber:
      pos.sideToMove === 'black' ? pos.fullmoveNumber + 1 : pos.fullmoveNumber,
  };
}

export function findKing(pos: Position, side: Side): Square {
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (piece && piece.type === 'K' && piece.side === side) {
        return square(file, rank);
      }
    }
  }
  throw new Error(`找不到${side === 'red' ? '红帅' : '黑将'}`);
}

export function generalsFace(pos: Position): boolean {
  const red = findKing(pos, 'red');
  const black = findKing(pos, 'black');
  if (red.file !== black.file) return false;

  const start = Math.min(red.rank, black.rank) + 1;
  const end = Math.max(red.rank, black.rank) - 1;
  for (let rank = start; rank <= end; rank += 1) {
    if (pos.board[rank][red.file]) return false;
  }
  return true;
}

export function isInCheck(pos: Position, side: Side): boolean {
  const king = findKing(pos, side);
  const enemy = opposite(side);
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      if (!piece || piece.side !== enemy) continue;
      const attacks = generatePseudoMoves(pos, square(file, rank));
      if (attacks.some((move) => sameSquare(move.to, king))) return true;
    }
  }
  return false;
}

export function generateLegalMoves(pos: Position): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const piece: Piece | null = pos.board[rank][file];
      if (!piece || piece.side !== pos.sideToMove) continue;
      for (const move of generatePseudoMoves(pos, square(file, rank))) {
        const next = applyMove(pos, move);
        if (!isInCheck(next, piece.side) && !generalsFace(next)) {
          moves.push(move);
        }
      }
    }
  }
  return moves;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/rules/moves.test.ts`

Expected: 全部 passed。若“44 个合法着法”失败，先打印实际数量并逐项核对兵、炮、马、象的初始走法。

---

### Task 4: 终局判定

**Files:**
- Create: `src/rules/status.ts`
- Test: `tests/rules/status.test.ts`

- [ ] **Step 1: 写失败测试 `tests/rules/status.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseFen } from '../../src/rules/board.ts';
import {
  hasAnyLegalMove,
  isCheckmate,
  isMoveLimitDraw,
  isStalemate,
} from '../../src/rules/status.ts';

describe('终局判定', () => {
  it('识别将死', () => {
    const pos = parseFen('4k4/4R4/9/9/9/9/9/9/9/K2RRR3 b - - 0 1');
    expect(isCheckmate(pos)).toBe(true);
    expect(isStalemate(pos)).toBe(false);
  });

  it('识别困毙', () => {
    const pos = parseFen('4k4/1N5N1/9/3N5/9/9/9/9/9/K8 b - - 0 1');
    expect(isStalemate(pos)).toBe(true);
    expect(isCheckmate(pos)).toBe(false);
  });

  it('普通局面既非将死也非困毙', () => {
    const pos = parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
    expect(hasAnyLegalMove(pos)).toBe(true);
    expect(isCheckmate(pos)).toBe(false);
    expect(isStalemate(pos)).toBe(false);
  });

  it('无吃子达到 120 个半回合判和', () => {
    const pos = parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 120 61');
    expect(isMoveLimitDraw(pos)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/rules/status.test.ts`

Expected: FAIL，找不到 `src/rules/status.ts`。

- [ ] **Step 3: 实现 `src/rules/status.ts`**

```ts
import type { Position } from '../types.ts';
import { generateLegalMoves, isInCheck } from './moves.ts';

export function hasAnyLegalMove(pos: Position): boolean {
  return generateLegalMoves(pos).length > 0;
}

export function isCheckmate(pos: Position): boolean {
  return isInCheck(pos, pos.sideToMove) && !hasAnyLegalMove(pos);
}

export function isStalemate(pos: Position): boolean {
  return !isInCheck(pos, pos.sideToMove) && !hasAnyLegalMove(pos);
}

export function isMoveLimitDraw(pos: Position): boolean {
  return pos.halfmoveClock >= 120;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/rules/status.test.ts`

Expected: 4 passed。

---

### Task 5: UCI 坐标与中文记谱

**Files:**
- Create: `src/notation/coords.ts`
- Create: `src/notation/chinese.ts`
- Test: `tests/notation/coords.test.ts`
- Test: `tests/notation/chinese.test.ts`

- [ ] **Step 1: 写失败测试 `tests/notation/coords.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseUciMove, toUciMove } from '../../src/notation/coords.ts';

describe('UCI 坐标', () => {
  it('解析 h2e2', () => {
    expect(parseUciMove('h2e2')).toEqual({
      from: { file: 7, rank: 2 },
      to: { file: 4, rank: 2 },
    });
  });

  it('接受 h2-e2 写法', () => {
    expect(parseUciMove('h2-e2')).not.toBeNull();
  });

  it('拒绝非法输入', () => {
    expect(parseUciMove('z9z9')).toBeNull();
    expect(parseUciMove('h10e2')).toBeNull();
  });

  it('可以往返转换', () => {
    const move = { from: { file: 1, rank: 0 }, to: { file: 2, rank: 2 } };
    expect(toUciMove(move)).toBe('b0c2');
    expect(parseUciMove('b0c2')).toEqual(move);
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/notation/chinese.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { initialPosition } from '../../src/rules/board.ts';
import { generateLegalMoves } from '../../src/rules/moves.ts';
import {
  chineseNotation,
  generateChineseMoves,
  parseChineseMove,
} from '../../src/notation/chinese.ts';
import { parseUciMove } from '../../src/notation/coords.ts';

describe('中文记谱', () => {
  const pos = initialPosition();

  it('生成红方开局着法', () => {
    expect(chineseNotation(pos, parseUciMove('h2e2')!)).toBe('炮二平五');
    expect(chineseNotation(pos, parseUciMove('b0c2')!)).toBe('马八进七');
  });

  it('生成黑方开局着法', () => {
    expect(chineseNotation(pos, parseUciMove('h7e7')!)).toBe('炮8平5');
    expect(chineseNotation(pos, parseUciMove('h9g7')!)).toBe('马8进7');
  });

  it('所有初始合法着法都能生成并匹配回原着法', () => {
    for (const move of generateLegalMoves(pos)) {
      const text = chineseNotation(pos, move);
      expect(parseChineseMove(pos, text)).toEqual(move);
    }
  });

  it('同列同子使用前后区分', () => {
    const twoRooks = {
      board: Array.from({ length: 10 }, () => Array(9).fill(null)),
      sideToMove: 'red' as const,
      halfmoveClock: 0,
      fullmoveNumber: 1,
    };
    twoRooks.board[9][4] = { type: 'K', side: 'black' };
    twoRooks.board[5][0] = { type: 'R', side: 'red' };
    twoRooks.board[0][0] = { type: 'R', side: 'red' };
    twoRooks.board[0][4] = { type: 'K', side: 'red' };

    expect(chineseNotation(twoRooks, parseUciMove('a5a6')!)).toBe('前车进一');
    expect(chineseNotation(twoRooks, parseUciMove('a0a1')!)).toBe('后车进一');
  });

  it('红方输入可以用阿拉伯数字', () => {
    expect(parseChineseMove(pos, '炮2平5')).toEqual(parseUciMove('h2e2'));
  });

  it('生成着法列表与合法着法数量一致', () => {
    expect(generateChineseMoves(pos)).toHaveLength(44);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/notation`

Expected: FAIL，两个源文件不存在。

- [ ] **Step 4: 实现 `src/notation/coords.ts`**

```ts
import type { Move, Square } from '../types.ts';

const FILE_CHARS = 'abcdefghi';

export function parseUciMove(text: string): Move | null {
  const normalized = text.trim().toLowerCase().replace(/-/g, '');
  const matched = /^([a-i])([0-9])([a-i])([0-9])$/.exec(normalized);
  if (!matched) return null;

  const from: Square = {
    file: FILE_CHARS.indexOf(matched[1]),
    rank: Number(matched[2]),
  };
  const to: Square = {
    file: FILE_CHARS.indexOf(matched[3]),
    rank: Number(matched[4]),
  };
  return { from, to };
}

export function toUciMove(move: Move): string {
  return `${FILE_CHARS[move.from.file]}${move.from.rank}${FILE_CHARS[move.to.file]}${move.to.rank}`;
}
```

- [ ] **Step 5: 实现 `src/notation/chinese.ts`**

```ts
import type { Move, PieceType, Position, Side } from '../types.ts';
import { generateLegalMoves } from '../rules/moves.ts';
import { pieceAt } from '../rules/board.ts';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

const PIECE_NAMES: Record<Side, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};

export function fileNumber(side: Side, file: number): number {
  return side === 'red' ? 9 - file : file + 1;
}

function formatNumber(side: Side, value: number): string {
  return side === 'red' ? CN_DIGITS[value] : String(value);
}

function prefixLabel(index: number, count: number): string {
  if (count === 2) return index === 0 ? '前' : '后';
  if (count === 3) return ['前', '中', '后'][index];
  if (index === 0) return '前';
  if (index === count - 1) return '后';
  return CN_DIGITS[index + 1];
}

export function chineseNotation(pos: Position, move: Move): string {
  const piece = pieceAt(pos, move.from);
  if (!piece) throw new Error('起点没有棋子');

  const sameFile: number[] = [];
  for (let rank = 0; rank < 10; rank += 1) {
    const other = pos.board[rank][move.from.file];
    if (other && other.side === piece.side && other.type === piece.type) {
      sameFile.push(rank);
    }
  }

  let prefix = '';
  if (sameFile.length > 1) {
    sameFile.sort((a, b) =>
      piece.side === 'red' ? b - a : a - b,
    );
    const index = sameFile.indexOf(move.from.rank);
    prefix = prefixLabel(index, sameFile.length);
  }

  const names = PIECE_NAMES[piece.side];
  const head = prefix
    ? `${prefix}${names[piece.type]}`
    : `${names[piece.type]}${formatNumber(piece.side, fileNumber(piece.side, move.from.file))}`;

  if (move.from.rank === move.to.rank) {
    return `${head}平${formatNumber(piece.side, fileNumber(piece.side, move.to.file))}`;
  }

  const isForward =
    piece.side === 'red' ? move.to.rank > move.from.rank : move.to.rank < move.from.rank;
  const action = isForward ? '进' : '退';
  const isDiagonalMover =
    piece.type === 'N' || piece.type === 'B' || piece.type === 'A';
  const amount = isDiagonalMover
    ? fileNumber(piece.side, move.to.file)
    : Math.abs(move.to.rank - move.from.rank);

  return `${head}${action}${formatNumber(piece.side, amount)}`;
}

export function generateChineseMoves(
  pos: Position,
): Array<{ move: Move; text: string }> {
  return generateLegalMoves(pos).map((move) => ({
    move,
    text: chineseNotation(pos, move),
  }));
}

const DIGIT_MAP: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

function normalizeChinese(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[一二三四五六七八九]/g, (ch) => DIGIT_MAP[ch]);
}

export function parseChineseMove(pos: Position, input: string): Move | null {
  const normalized = normalizeChinese(input);
  for (const candidate of generateChineseMoves(pos)) {
    if (normalizeChinese(candidate.text) === normalized) return candidate.move;
  }
  return null;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/notation`

Expected: 全部 passed。

---

### Task 6: 棋盘渲染

**Files:**
- Create: `src/render/board.ts`
- Test: `tests/render/board.test.ts`

- [ ] **Step 1: 写失败测试 `tests/render/board.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { initialPosition } from '../../src/rules/board.ts';
import { renderBoard } from '../../src/render/board.ts';

describe('棋盘渲染', () => {
  const text = renderBoard(initialPosition());

  it('包含双方棋子汉字', () => {
    for (const glyph of ['帅', '将', '车', '马', '炮', '兵', '卒', '相', '象', '仕', '士']) {
      expect(text).toContain(glyph);
    }
  });

  it('包含列标和行号', () => {
    expect(text).toContain('a  b  c  d  e  f  g  h  i');
    expect(text).toContain('9  ');
    expect(text).toContain('0  ');
  });

  it('渲染为 12 行', () => {
    expect(text.split('\n')).toHaveLength(12);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/render/board.test.ts`

Expected: FAIL，找不到渲染模块。

- [ ] **Step 3: 实现 `src/render/board.ts`**

```ts
import type { PieceType, Position, Side } from '../types.ts';

const GLYPHS: Record<Side, Record<PieceType, string>> = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '砲', P: '卒' },
};

export function renderBoard(pos: Position): string {
  const lines: string[] = ['   a  b  c  d  e  f  g  h  i'];

  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = `${rank}  `;
    for (let file = 0; file < 9; file += 1) {
      const piece = pos.board[rank][file];
      row += piece ? `${GLYPHS[piece.side][piece.type]} ` : '   ';
    }
    lines.push(row.trimEnd());

    if (rank === 5) {
      lines.push('   ~~~~ 楚河 · 汉界 ~~~~');
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/render/board.test.ts`

Expected: 3 passed。

---

### Task 7: 对局状态机

**Files:**
- Create: `src/game/game.ts`
- Test: `tests/game/game.test.ts`

- [ ] **Step 1: 写失败测试 `tests/game/game.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { Game, IllegalMoveError } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { INITIAL_FEN } from '../../src/rules/board.ts';

function play(game: Game, uci: string): void {
  const move = parseUciMove(uci);
  if (!move) throw new Error(`bad uci: ${uci}`);
  game.move(move);
}

describe('对局状态机', () => {
  it('新对局由红方先行，记录中文着法', () => {
    const game = new Game();
    expect(game.position.sideToMove).toBe('red');
    expect(game.legalMoves()).toHaveLength(44);

    const entry = game.move(parseUciMove('h2e2')!);
    expect(entry.chinese).toBe('炮二平五');
    expect(game.position.sideToMove).toBe('black');
  });

  it('非法着法被拒绝且不改变局面', () => {
    const game = new Game();
    expect(() => play(game, 'a0a5')).toThrow(IllegalMoveError);
    expect(game.history).toHaveLength(0);
  });

  it('悔棋退回指定步数', () => {
    const game = new Game();
    play(game, 'h2e2');
    play(game, 'h9g7');
    expect(game.undo(2)).toBe(2);
    expect(game.position.sideToMove).toBe('red');
    expect(game.history).toHaveLength(0);
  });

  it('同一局面第三次出现判和', () => {
    const game = new Game();
    const cycle = ['b0c2', 'b9c7', 'c2b0', 'c7b9'];
    for (let i = 0; i < 2; i += 1) {
      for (const uci of cycle) play(game, uci);
    }
    expect(game.result).toBe('draw');
    expect(game.endReason).toBe('repetition');
  });

  it('无吃子达到 120 半回合判和', () => {
    const fen = INITIAL_FEN.replace(' 0 1', ' 119 1');
    const game = new Game(fen);
    play(game, 'b0c2');
    expect(game.result).toBe('draw');
    expect(game.endReason).toBe('move_limit');
  });

  it('认输记录胜方', () => {
    const game = new Game();
    game.resign('red');
    expect(game.result).toBe('black_win');
    expect(game.endReason).toBe('resign');
  });

  it('中止对局', () => {
    const game = new Game();
    game.abort();
    expect(game.result).toBe('aborted');
    expect(game.endReason).toBe('aborted');
  });

  it('构造局面后可以直接生成 FEN', () => {
    const game = new Game(INITIAL_FEN);
    expect(game.fen()).toBe(INITIAL_FEN);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/game/game.test.ts`

Expected: FAIL，找不到 `src/game/game.ts`。

- [ ] **Step 3: 实现 `src/game/game.ts`**

```ts
import type { EndReason, GameResult, Move, Position, Side } from '../types.ts';
import { opposite, sameMove } from '../types.ts';
import { INITIAL_FEN, parseFen, positionKey, toFen } from '../rules/board.ts';
import { applyMove, generateLegalMoves } from '../rules/moves.ts';
import {
  isCheckmate,
  isMoveLimitDraw,
  isStalemate,
} from '../rules/status.ts';
import { chineseNotation } from '../notation/chinese.ts';

export class IllegalMoveError extends Error {}

export interface HistoryEntry {
  readonly positionBefore: Position;
  readonly move: Move;
  readonly side: Side;
  readonly ply: number;
  readonly chinese: string;
}

export class Game {
  readonly initialFen: string;
  private readonly states: Position[];
  private readonly entries: HistoryEntry[] = [];
  result: GameResult | null = null;
  endReason: EndReason | null = null;

  constructor(fen: string = INITIAL_FEN) {
    this.initialFen = fen;
    this.states = [parseFen(fen)];
  }

  get position(): Position {
    return this.states[this.states.length - 1];
  }

  get history(): readonly HistoryEntry[] {
    return this.entries;
  }

  legalMoves(): Move[] {
    return generateLegalMoves(this.position);
  }

  isLegal(move: Move): boolean {
    return this.legalMoves().some((candidate) => sameMove(candidate, move));
  }

  move(move: Move): HistoryEntry {
    if (this.result) throw new IllegalMoveError('对局已结束');
    if (!this.isLegal(move)) throw new IllegalMoveError('非法着法');

    const before = this.position;
    const chinese = chineseNotation(before, move);
    const after = applyMove(before, move);
    const entry: HistoryEntry = {
      positionBefore: before,
      move,
      side: before.sideToMove,
      ply: this.entries.length + 1,
      chinese,
    };

    this.states.push(after);
    this.entries.push(entry);
    this.updateOutcome(after);
    return entry;
  }

  undo(plies = 2): number {
    if (this.entries.length === 0) return 0;
    const count = Math.min(plies, this.entries.length);
    this.entries.splice(this.entries.length - count, count);
    this.states.splice(this.states.length - count, count);
    this.result = null;
    this.endReason = null;
    return count;
  }

  resign(loser: Side): void {
    if (this.result) return;
    this.result = loser === 'red' ? 'black_win' : 'red_win';
    this.endReason = 'resign';
  }

  abort(): void {
    if (this.result) return;
    this.result = 'aborted';
    this.endReason = 'aborted';
  }

  fen(): string {
    return toFen(this.position);
  }

  private updateOutcome(after: Position): void {
    const winner = opposite(after.sideToMove);

    if (isCheckmate(after)) {
      this.result = winner === 'red' ? 'red_win' : 'black_win';
      this.endReason = 'checkmate';
      return;
    }

    if (isStalemate(after)) {
      this.result = winner === 'red' ? 'red_win' : 'black_win';
      this.endReason = 'stalemate';
      return;
    }

    if (isMoveLimitDraw(after)) {
      this.result = 'draw';
      this.endReason = 'move_limit';
      return;
    }

    const key = positionKey(after);
    const occurrences = this.states.filter((state) => positionKey(state) === key).length;
    if (occurrences >= 3) {
      this.result = 'draw';
      this.endReason = 'repetition';
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/game/game.test.ts`

Expected: 8 passed。

---

### Task 8: UCI 解析与真实引擎适配

**Files:**
- Create: `src/engine/uci.ts`
- Create: `src/engine/pikafish.ts`
- Test: `tests/engine/uci.test.ts`
- Test: `tests/engine/pikafish.test.ts`

- [ ] **Step 1: 写失败测试 `tests/engine/uci.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  infoToCp,
  parseBestMove,
  parseInfoLine,
} from '../../src/engine/uci.ts';

describe('UCI 输出解析', () => {
  it('解析真实引擎的 multipv info 行', () => {
    const line =
      'info depth 3 seldepth 5 multipv 2 score cp 21 wdl 61 939 0 nodes 1003 nps 501500 hashfull 0 tbhits 0 time 2 pv h0g2 b7e7 b2e2';
    expect(parseInfoLine(line)).toEqual({
      multipv: 2,
      scoreCp: 21,
      mateIn: null,
      pv: ['h0g2', 'b7e7', 'b2e2'],
    });
  });

  it('解析将杀分', () => {
    const line =
      'info depth 4 multipv 1 score mate 3 nodes 1234 pv e0e1 e9d9';
    expect(parseInfoLine(line)).toEqual({
      multipv: 1,
      scoreCp: null,
      mateIn: 3,
      pv: ['e0e1', 'e9d9'],
    });
  });

  it('忽略不含评分的 info 行', () => {
    expect(parseInfoLine('info string NNUE evaluation using pikafish.nnue')).toBeNull();
  });

  it('解析 bestmove 与 (none)', () => {
    expect(parseBestMove('bestmove h2e2 ponder h9g7')).toBe('h2e2');
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 1')).toBeNull();
  });

  it('将杀分换算成可比较的 cp', () => {
    expect(infoToCp({ multipv: 1, scoreCp: null, mateIn: 3, pv: [] })).toBe(99700);
    expect(infoToCp({ multipv: 1, scoreCp: null, mateIn: -2, pv: [] })).toBe(-99800);
    expect(infoToCp({ multipv: 1, scoreCp: 35, mateIn: null, pv: [] })).toBe(35);
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/engine/pikafish.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../../src/config.ts';
import { PikafishEngine } from '../../src/engine/pikafish.ts';
import { INITIAL_FEN, parseFen } from '../../src/rules/board.ts';
import { generateLegalMoves } from '../../src/rules/moves.ts';
import { sameMove } from '../../src/types.ts';

describe('真实 Pikafish 引擎', () => {
  it(
    '完成握手、加载 NNUE 并返回合法着法',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const results = await engine.search(INITIAL_FEN, 2000, 1);
        expect(results.length).toBeGreaterThan(0);

        const legal = generateLegalMoves(parseFen(INITIAL_FEN));
        const best = results[0];
        expect(legal.some((move) => sameMove(move, best.move))).toBe(true);
        expect(best.pv.length).toBeGreaterThan(0);
      } finally {
        await engine.quit();
      }
    },
    30000,
  );

  it(
    'MultiPV 返回多条候选',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const results = await engine.search(INITIAL_FEN, 2000, 3);
        expect(results.length).toBeGreaterThan(1);
      } finally {
        await engine.quit();
      }
    },
    30000,
  );
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/engine`

Expected: FAIL，找不到 `src/engine/uci.ts` 和 `src/engine/pikafish.ts`。

- [ ] **Step 4: 实现 `src/engine/uci.ts`**

```ts
export interface SearchInfo {
  multipv: number;
  scoreCp: number | null;
  mateIn: number | null;
  pv: string[];
}

export function parseInfoLine(line: string): SearchInfo | null {
  if (!line.startsWith('info ')) return null;

  const tokens = line.split(/\s+/);
  let multipv = 1;
  let scoreCp: number | null = null;
  let mateIn: number | null = null;
  let pv: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'multipv') {
      multipv = Number(tokens[index + 1]);
      index += 1;
    } else if (token === 'score') {
      const kind = tokens[index + 1];
      const value = Number(tokens[index + 2]);
      if (kind === 'cp') scoreCp = value;
      if (kind === 'mate') mateIn = value;
      index += 2;
    } else if (token === 'pv') {
      pv = tokens.slice(index + 1);
      break;
    }
  }

  if (scoreCp === null && mateIn === null) return null;
  return { multipv, scoreCp, mateIn, pv };
}

export function parseBestMove(line: string): string | null {
  if (!line.startsWith('bestmove')) return null;
  const move = line.split(/\s+/)[1];
  return !move || move === '(none)' ? null : move;
}

export function infoToCp(info: SearchInfo): number {
  if (info.mateIn !== null) {
    return info.mateIn > 0
      ? 100000 - info.mateIn * 100
      : -100000 - info.mateIn * 100;
  }
  return info.scoreCp ?? 0;
}
```

- [ ] **Step 5: 实现 `src/engine/pikafish.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Writable } from 'node:stream';
import type { Move } from '../types.ts';
import { parseUciMove } from '../notation/coords.ts';
import {
  infoToCp,
  parseBestMove,
  parseInfoLine,
  type SearchInfo,
} from './uci.ts';

export interface EngineConfig {
  path: string;
  evalFile: string;
  threads: number;
  hashMb: number;
}

export interface SearchResult {
  move: Move;
  scoreCp: number | null;
  mateIn: number | null;
  pv: Move[];
  cp: number;
}

export class EngineTimeoutError extends Error {}

export class PikafishEngine {
  private readonly config: EngineConfig;
  private readonly proc: ChildProcess;
  private readonly stdin: Writable;
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  private exited = false;

  private constructor(
    config: EngineConfig,
    proc: ChildProcess,
    stdin: Writable,
    rl: Interface,
  ) {
    this.config = config;
    this.proc = proc;
    this.stdin = stdin;
    this.rl = rl;

    this.rl.on('line', (line) => this.onLine(line));
    this.proc.on('exit', () => {
      this.exited = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()!('__EXIT__');
      }
    });
  }

  static async start(config: EngineConfig): Promise<PikafishEngine> {
    const exe = resolve(config.path);
    const proc = spawn(exe, [], {
      cwd: dirname(exe),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdin = proc.stdin;
    const stdout = proc.stdout;
    if (!stdin || !stdout) {
      proc.kill();
      throw new Error('无法建立引擎管道');
    }

    const rl = createInterface({ input: stdout });
    const engine = new PikafishEngine(config, proc, stdin, rl);

    try {
      engine.send('uci');
      const handshake: string[] = [];
      await engine.readUntil(
        (line) => line === 'uciok',
        5000,
        (line) => handshake.push(line),
      );
      if (!handshake.some((line) => line.startsWith('option name EvalFile'))) {
        throw new Error('当前引擎不支持 EvalFile 选项');
      }

      engine.send(`setoption name EvalFile value ${resolve(config.evalFile)}`);
      engine.send(`setoption name Threads value ${config.threads}`);
      engine.send(`setoption name Hash value ${config.hashMb}`);
      engine.send('isready');
      await engine.readUntil((line) => line === 'readyok', 20000);
      return engine;
    } catch (error) {
      engine.kill();
      rl.close();
      throw error;
    }
  }

  async search(
    fen: string,
    nodes: number,
    multiPv = 1,
    timeoutMs = 15000,
  ): Promise<SearchResult[]> {
    this.send(`setoption name MultiPV value ${multiPv}`);
    this.send(`position fen ${fen}`);
    this.send(`go nodes ${nodes}`);

    const infos = new Map<number, SearchInfo>();
    const bestLine = await this.readUntil(
      (line) => line.startsWith('bestmove'),
      timeoutMs,
      (line) => {
        const info = parseInfoLine(line);
        if (info) infos.set(info.multipv, info);
      },
    );

    const bestUci = parseBestMove(bestLine);
    if (!bestUci) throw new Error('引擎未返回合法着法');

    const results: SearchResult[] = [];
    const ordered = [...infos.entries()].sort((a, b) => a[0] - b[0]);
    for (const [multipv, info] of ordered) {
      const pv = info.pv
        .map((token) => parseUciMove(token))
        .filter((move): move is Move => move !== null);
      const move = pv[0] ?? (multipv === 1 ? parseUciMove(bestUci) : null);
      if (!move) continue;
      results.push({
        move,
        scoreCp: info.scoreCp,
        mateIn: info.mateIn,
        pv,
        cp: infoToCp(info),
      });
    }

    if (results.length === 0) {
      const fallback = parseUciMove(bestUci);
      if (!fallback) throw new Error('无法解析引擎着法');
      results.push({
        move: fallback,
        scoreCp: null,
        mateIn: null,
        pv: [fallback],
        cp: 0,
      });
    }

    return results;
  }

  async quit(): Promise<void> {
    if (this.exited) {
      this.rl.close();
      return;
    }
    this.send('quit');
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.kill();
        resolvePromise();
      }, 2000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    this.rl.close();
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }

  private send(command: string): void {
    if (this.exited) throw new Error('引擎进程已退出');
    this.stdin.write(`${command}\n`);
  }

  private onLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  private async nextLine(deadline: number): Promise<string> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.exited) throw new Error('引擎进程已退出');

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.kill();
      throw new EngineTimeoutError('引擎计算超时');
    }

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.kill();
        rejectPromise(new EngineTimeoutError('引擎计算超时'));
      }, remaining);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolvePromise(line);
      });
    });
  }

  private async readUntil(
    isEnd: (line: string) => boolean,
    timeoutMs: number,
    onLine?: (line: string) => void,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const line = await this.nextLine(deadline);
      if (line === '__EXIT__') throw new Error('引擎进程已退出');
      if (isEnd(line)) return line;
      onLine?.(line);
    }
  }
}
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run tests/engine`

Expected: `uci.test.ts` 5 passed；`pikafish.test.ts` 2 passed（真实引擎启动，耗时数秒）。若报 `Invalid FEN`，确认 FEN 使用 `N/B`。

---

### Task 9: 难度与引擎选着

**Files:**
- Create: `src/engine/difficulty.ts`
- Test: `tests/engine/difficulty.test.ts`

- [ ] **Step 1: 写失败测试 `tests/engine/difficulty.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  DIFFICULTIES,
  selectEngineMove,
} from '../../src/engine/difficulty.ts';
import type { SearchResult } from '../../src/engine/pikafish.ts';

function result(cp: number, file: number): SearchResult {
  return {
    move: { from: { file, rank: 0 }, to: { file, rank: 1 } },
    scoreCp: cp,
    mateIn: null,
    pv: [],
    cp,
  };
}

describe('难度与选着', () => {
  it('三档难度参数固定', () => {
    expect(DIFFICULTIES[1]).toMatchObject({ name: 'beginner', nodes: 2000, multiPv: 3 });
    expect(DIFFICULTIES[2]).toMatchObject({ name: 'entry', nodes: 20000, multiPv: 1 });
    expect(DIFFICULTIES[3]).toMatchObject({ name: 'intermediate', nodes: 200000, multiPv: 1 });
  });

  it('非新手档直接选最佳着法', () => {
    const results = [result(100, 0), result(50, 1), result(0, 2)];
    expect(selectEngineMove(results, false)).toBe(results[0]);
  });

  it('新手档按评分加权仍可能选到非最佳着法', () => {
    const results = [result(100, 0), result(90, 1), result(80, 2)];
    const picked = selectEngineMove(results, true, () => 0.999);
    expect(results).toContain(picked);
  });

  it('空候选抛出错误', () => {
    expect(() => selectEngineMove([], true)).toThrow(/没有可选/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/engine/difficulty.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `src/engine/difficulty.ts`**

```ts
import type { SearchResult } from './pikafish.ts';

export type Level = 1 | 2 | 3;

export interface Difficulty {
  name: 'beginner' | 'entry' | 'intermediate';
  nodes: number;
  multiPv: number;
  weighted: boolean;
}

export const DIFFICULTIES: Record<Level, Difficulty> = {
  1: { name: 'beginner', nodes: 2000, multiPv: 3, weighted: true },
  2: { name: 'entry', nodes: 20000, multiPv: 1, weighted: false },
  3: { name: 'intermediate', nodes: 200000, multiPv: 1, weighted: false },
};

export function selectEngineMove(
  results: SearchResult[],
  weighted: boolean,
  random: () => number = Math.random,
): SearchResult {
  if (results.length === 0) throw new Error('没有可选的引擎着法');
  if (!weighted || results.length === 1) return results[0];

  const scores = results.map((result) =>
    Math.max(-2000, Math.min(2000, result.cp)),
  );
  const maxScore = Math.max(...scores);
  const weights = scores.map((score) => Math.exp((score - maxScore) / 80));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let roll = random() * total;
  for (let index = 0; index < results.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return results[index];
  }
  return results[results.length - 1];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/engine/difficulty.test.ts`

Expected: 4 passed。

---

### Task 10: 赛后复盘

**Files:**
- Create: `src/review/review.ts`
- Test: `tests/review/review.test.ts`

- [ ] **Step 1: 写失败测试 `tests/review/review.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { Game } from '../../src/game/game.ts';
import { PikafishEngine } from '../../src/engine/pikafish.ts';
import { loadConfig, parseArgs } from '../../src/config.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { labelForLoss, reviewGame } from '../../src/review/review.ts';

describe('复盘分级', () => {
  it('按 cp 损失分级', () => {
    expect(labelForLoss(0)).toBe('good');
    expect(labelForLoss(19)).toBe('good');
    expect(labelForLoss(20)).toBe('ok');
    expect(labelForLoss(49)).toBe('ok');
    expect(labelForLoss(50)).toBe('mistake');
    expect(labelForLoss(149)).toBe('mistake');
    expect(labelForLoss(150)).toBe('blunder');
  });
});

describe('真实引擎复盘', () => {
  it(
    '对人类的每一手生成分析',
    async () => {
      const engine = await PikafishEngine.start(loadConfig(parseArgs([])));
      try {
        const game = new Game();
        for (const uci of ['b0c2', 'b9c7', 'h0g2', 'h9g7']) {
          const move = parseUciMove(uci);
          if (!move) throw new Error(`bad uci: ${uci}`);
          game.move(move);
        }

        const report = await reviewGame(engine, game, 'red', 2000);
        expect(report.moves).toHaveLength(2);
        expect(report.acpl).toBeGreaterThanOrEqual(0);
        expect(report.worst.length).toBeLessThanOrEqual(3);

        for (const move of report.moves) {
          expect(move.chinese.length).toBeGreaterThan(0);
          expect(move.bestChinese.length).toBeGreaterThan(0);
          expect(['good', 'ok', 'mistake', 'blunder']).toContain(move.label);
        }
      } finally {
        await engine.quit();
      }
    },
    30000,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/review/review.test.ts`

Expected: FAIL，找不到 `src/review/review.ts`。

- [ ] **Step 3: 实现 `src/review/review.ts`**

```ts
import type { PikafishEngine } from '../engine/pikafish.ts';
import type { Game } from '../game/game.ts';
import type { Move, Position, Side } from '../types.ts';
import { toFen } from '../rules/board.ts';
import { applyMove } from '../rules/moves.ts';
import { chineseNotation } from '../notation/chinese.ts';
import { toUciMove } from '../notation/coords.ts';

export type MoveLabel = 'good' | 'ok' | 'mistake' | 'blunder';

export interface AnalyzedMove {
  ply: number;
  side: Side;
  uci: string;
  chinese: string;
  bestUci: string;
  bestChinese: string;
  loss: number;
  label: MoveLabel;
  pvChinese: string;
}

export interface ReviewReport {
  moves: AnalyzedMove[];
  mistakes: number;
  blunders: number;
  acpl: number;
  worst: AnalyzedMove[];
}

export function labelForLoss(loss: number): MoveLabel {
  if (loss < 20) return 'good';
  if (loss < 50) return 'ok';
  if (loss < 150) return 'mistake';
  return 'blunder';
}

function pvToChinese(start: Position, pv: Move[]): string {
  let position = start;
  const parts: string[] = [];
  for (const move of pv.slice(0, 6)) {
    try {
      parts.push(chineseNotation(position, move));
      position = applyMove(position, move);
    } catch {
      break;
    }
  }
  return parts.join(' ');
}

export async function reviewGame(
  engine: PikafishEngine,
  game: Game,
  humanSide: Side,
  nodes = 300000,
): Promise<ReviewReport> {
  const analyzed: AnalyzedMove[] = [];

  for (const entry of game.history) {
    if (entry.side !== humanSide) continue;

    const [best] = await engine.search(toFen(entry.positionBefore), nodes, 1);
    const after = applyMove(entry.positionBefore, entry.move);
    const [afterResult] = await engine.search(toFen(after), nodes, 1);

    const bestCp = best.cp;
    const actualCp = -afterResult.cp;
    let loss = Math.max(0, bestCp - actualCp);
    let label = labelForLoss(loss);

    const bestIsMate = best.mateIn !== null && best.mateIn > 0;
    const actualAllowsMate = afterResult.mateIn !== null && afterResult.mateIn > 0;
    if ((bestIsMate && actualCp < 90000) || actualAllowsMate) {
      loss = Math.max(loss, 150);
      label = 'blunder';
    }

    analyzed.push({
      ply: entry.ply,
      side: entry.side,
      uci: toUciMove(entry.move),
      chinese: entry.chinese,
      bestUci: toUciMove(best.move),
      bestChinese: chineseNotation(entry.positionBefore, best.move),
      loss,
      label,
      pvChinese: pvToChinese(entry.positionBefore, best.pv),
    });
  }

  const mistakes = analyzed.filter((move) => move.label === 'mistake').length;
  const blunders = analyzed.filter((move) => move.label === 'blunder').length;
  const acpl = analyzed.length
    ? Math.round(
        analyzed.reduce((sum, move) => sum + move.loss, 0) / analyzed.length,
      )
    : 0;
  const worst = [...analyzed].sort((a, b) => b.loss - a.loss).slice(0, 3);

  return { moves: analyzed, mistakes, blunders, acpl, worst };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/review/review.test.ts`

Expected: 2 passed（第二项会真实调用引擎 4 次，每次 2000 节点）。

---

### Task 11: 棋谱存储

**Files:**
- Create: `src/storage/records.ts`
- Test: `tests/storage/records.test.ts`

- [ ] **Step 1: 写失败测试 `tests/storage/records.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../../src/game/game.ts';
import { parseUciMove } from '../../src/notation/coords.ts';
import { buildRecord, saveRecord } from '../../src/storage/records.ts';

const tmpDir = join(process.cwd(), 'tests', '.tmp-records');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('棋谱存储', () => {
  it('未结束的对局不能生成棋谱', () => {
    const game = new Game();
    expect(() => buildRecord(game, 'red', 'entry', new Date())).toThrow(/尚未结束/);
  });

  it('认输后生成并写入棋谱', () => {
    const game = new Game();
    game.move(parseUciMove('b0c2')!);
    game.resign('red');

    const record = buildRecord(game, 'red', 'entry', new Date('2026-11-19T10:30:45+08:00'));
    expect(record.result).toBe('black_win');
    expect(record.endReason).toBe('resign');
    expect(record.moves).toHaveLength(1);
    expect(record.moves[0]).toMatchObject({
      ply: 1,
      side: 'red',
      uci: 'b0c2',
      chinese: '马八进七',
    });

    const path = saveRecord(record, tmpDir);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.initialFen).toBe(record.initialFen);
    expect(saved.finalFen).toBe(record.finalFen);
    expect(saved.moves).toEqual(record.moves);
  });

  it('同一秒内连续保存不会覆盖', () => {
    const game = new Game();
    game.resign('red');
    const record = buildRecord(game, 'red', 'entry', new Date('2026-11-19T10:30:45+08:00'));
    const first = saveRecord(record, tmpDir);
    const second = saveRecord(record, tmpDir);
    expect(second).not.toBe(first);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage/records.test.ts`

Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `src/storage/records.ts`**

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game } from '../game/game.ts';
import type { EndReason, GameResult, Side } from '../types.ts';
import { toUciMove } from '../notation/coords.ts';

export interface RecordedMove {
  ply: number;
  side: Side;
  uci: string;
  chinese: string;
}

export interface GameRecord {
  version: 1;
  startedAt: string;
  humanSide: Side;
  difficulty: string;
  result: GameResult;
  endReason: EndReason;
  initialFen: string;
  finalFen: string;
  moves: RecordedMove[];
}

export function buildRecord(
  game: Game,
  humanSide: Side,
  difficulty: string,
  startedAt: Date,
): GameRecord {
  if (!game.result || !game.endReason) {
    throw new Error('对局尚未结束，无法生成棋谱');
  }

  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    humanSide,
    difficulty,
    result: game.result,
    endReason: game.endReason,
    initialFen: game.initialFen,
    finalFen: game.fen(),
    moves: game.history.map((entry) => ({
      ply: entry.ply,
      side: entry.side,
      uci: toUciMove(entry.move),
      chinese: entry.chinese,
    })),
  };
}

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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/storage/records.test.ts`

Expected: 3 passed。

---

### Task 12: 配置解析与 CLI 入口

**Files:**
- Create: `src/config.ts`
- Create: `config.json`
- Create: `src/main.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 写失败测试 `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../src/config.ts';

describe('CLI 参数', () => {
  it('解析默认值', () => {
    const args = parseArgs([]);
    expect(args.side).toBe('red');
    expect(args.level).toBe(2);
    expect(args.review).toBe(true);
  });

  it('解析显式参数', () => {
    const args = parseArgs(['--side', 'black', '--level', '3', '--no-review']);
    expect(args.side).toBe('black');
    expect(args.level).toBe(3);
    expect(args.review).toBe(false);
  });

  it('拒绝非法参数', () => {
    expect(() => parseArgs(['--level', '9'])).toThrow(/1、2、3/);
    expect(() => parseArgs(['--side', 'blue'])).toThrow(/red 或 black/);
    expect(() => parseArgs(['--unknown'])).toThrow(/未知参数/);
  });
});

describe('配置加载', () => {
  it('默认指向项目根目录的引擎与 NNUE', () => {
    const config = loadConfig(parseArgs([]), process.cwd(), {});
    expect(config.pikafishPath.endsWith('Pikafish-Windows-x86-64-universal.exe')).toBe(true);
    expect(config.evalFile.endsWith('pikafish.nnue')).toBe(true);
  });

  it('环境变量覆盖路径', () => {
    const config = loadConfig(parseArgs([]), process.cwd(), {
      PIKAFISH_PATH: 'D:/engines/test-engine.exe',
      PIKAFISH_EVAL_FILE: 'D:/engines/test.nnue',
    });
    expect(config.pikafishPath.endsWith('test-engine.exe')).toBe(true);
    expect(config.evalFile.endsWith('test.nnue')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`

Expected: FAIL，找不到 `src/config.ts`。

- [ ] **Step 3: 实现 `src/config.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Side } from './types.ts';
import type { Level } from './engine/difficulty.ts';

export interface AppConfig {
  pikafishPath: string;
  evalFile: string;
  threads: number;
  hashMb: number;
}

export interface CliArgs {
  side: Side;
  level: Level;
  configPath: string | null;
  review: boolean;
}

const DEFAULTS: AppConfig = {
  pikafishPath: './Pikafish-Windows-x86-64-universal.exe',
  evalFile: './pikafish.nnue',
  threads: 1,
  hashMb: 64,
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    side: 'red',
    level: 2,
    configPath: null,
    review: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--side') {
      const value = argv[index + 1];
      if (value !== 'red' && value !== 'black') {
        throw new Error('--side 只能是 red 或 black');
      }
      args.side = value;
      index += 1;
    } else if (token === '--level') {
      const value = Number(argv[index + 1]);
      if (value !== 1 && value !== 2 && value !== 3) {
        throw new Error('--level 只能是 1、2、3');
      }
      args.level = value as Level;
      index += 1;
    } else if (token === '--config') {
      args.configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--no-review') {
      args.review = false;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }

  return args;
}

export function loadConfig(
  args: CliArgs,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const file = args.configPath
    ? resolve(cwd, args.configPath)
    : resolve(cwd, 'config.json');

  let fromFile: Partial<AppConfig> = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
  }

  const merged: AppConfig = { ...DEFAULTS, ...fromFile };
  if (env.PIKAFISH_PATH) merged.pikafishPath = env.PIKAFISH_PATH;
  if (env.PIKAFISH_EVAL_FILE) merged.evalFile = env.PIKAFISH_EVAL_FILE;

  return {
    pikafishPath: resolve(cwd, merged.pikafishPath),
    evalFile: resolve(cwd, merged.evalFile),
    threads: Number(merged.threads),
    hashMb: Number(merged.hashMb),
  };
}
```

- [ ] **Step 4: 创建 `config.json`**

```json
{
  "pikafishPath": "./Pikafish-Windows-x86-64-universal.exe",
  "evalFile": "./pikafish.nnue",
  "threads": 1,
  "hashMb": 64
}
```

- [ ] **Step 5: 实现 `src/main.ts`**

```ts
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Move, Side } from './types.ts';
import { loadConfig, parseArgs } from './config.ts';
import { Game, IllegalMoveError } from './game/game.ts';
import {
  EngineTimeoutError,
  PikafishEngine,
  type EngineConfig,
  type SearchResult,
} from './engine/pikafish.ts';
import { DIFFICULTIES, selectEngineMove } from './engine/difficulty.ts';
import { renderBoard } from './render/board.ts';
import { parseUciMove, toUciMove } from './notation/coords.ts';
import { chineseNotation, parseChineseMove } from './notation/chinese.ts';
import { reviewGame, type ReviewReport } from './review/review.ts';
import { buildRecord, saveRecord } from './storage/records.ts';

const LABEL_NAMES = {
  good: '好棋',
  ok: '可接受',
  mistake: '失误',
  blunder: '漏着',
} as const;

function resultText(game: Game, humanSide: Side): string {
  if (game.result === 'draw') return '和棋';
  if (game.result === 'aborted') return '对局中止';
  const humanWon = game.result === (humanSide === 'red' ? 'red_win' : 'black_win');
  return humanWon ? '你赢了' : '你输了';
}

function printReview(report: ReviewReport): void {
  console.log('\n===== 复盘报告 =====');
  for (const move of report.moves) {
    console.log(
      `第 ${move.ply} 手 ${move.side === 'red' ? '红' : '黑'} ${move.chinese}：` +
        `损失 ${move.loss}cp（${LABEL_NAMES[move.label]}），推荐 ${move.bestChinese}`,
    );
    if (move.pvChinese) console.log(`    变化：${move.pvChinese}`);
  }
  console.log(
    `汇总：失误 ${report.mistakes}，漏着 ${report.blunders}，平均损失 ${report.acpl}cp`,
  );
  if (report.worst.length > 0) {
    console.log('重点改进：');
    for (const move of report.worst) {
      console.log(
        `  第 ${move.ply} 手 ${move.chinese} → ${move.bestChinese}（损失 ${move.loss}cp）`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);
  const rl = createInterface({ input, output });
  const ask = (question: string) => rl.question(question);

  const humanSide = args.side;
  const difficulty = DIFFICULTIES[args.level];
  const startedAt = new Date();
  const game = new Game();

  let engine: PikafishEngine;
  try {
    engine = await PikafishEngine.start(config);
  } catch (error) {
    console.error(
      '无法启动 Pikafish：',
      error instanceof Error ? error.message : error,
    );
    console.error(`引擎路径：${config.pikafishPath}`);
    console.error(`权重路径：${config.evalFile}`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  const restart = async (engineConfig: EngineConfig) => {
    await engine.quit().catch(() => undefined);
    engine = await PikafishEngine.start(engineConfig);
  };

  const persist = () => {
    if (!game.result) return;
    const record = buildRecord(game, humanSide, difficulty.name, startedAt);
    try {
      const path = saveRecord(record);
      console.log(`棋谱已保存：${path}`);
    } catch (error) {
      console.error(
        '棋谱写入失败，以下为完整 JSON：',
        error instanceof Error ? error.message : error,
      );
      console.log(JSON.stringify(record, null, 2));
    }
  };

  try {
    console.log(
      `Pikafish 已就绪。你执${humanSide === 'red' ? '红' : '黑'}，难度：${difficulty.name}`,
    );
    console.log('命令：着法（如 h2e2 或 炮二平五）、hint、undo、resign、quit');

    while (!game.result) {
      console.log('');
      console.log(renderBoard(game.position));

      if (game.position.sideToMove === humanSide) {
        const answer = (
          await ask(
            `${humanSide === 'red' ? '红方' : '黑方'}走棋（着法 / hint / undo / resign / quit）> `,
          )
        ).trim();

        if (!answer) continue;
        if (answer === 'quit') {
          game.abort();
          break;
        }
        if (answer === 'resign') {
          game.resign(humanSide);
          break;
        }
        if (answer === 'undo') {
          const undone = game.undo(2);
          console.log(undone > 0 ? `已回退 ${undone} 步` : '没有可回退的着法');
          continue;
        }
        if (answer === 'hint') {
          const [best] = await engine.search(game.fen(), 200000, 1);
          console.log(
            `建议：${chineseNotation(game.position, best.move)}（${toUciMove(best.move)}）`,
          );
          continue;
        }

        let move: Move | null = parseUciMove(answer);
        if (!move) move = parseChineseMove(game.position, answer);
        if (!move) {
          console.log('无法识别的着法，请重试');
          continue;
        }

        try {
          const entry = game.move(move);
          console.log(`你走了：${entry.chinese}`);
        } catch (error) {
          if (error instanceof IllegalMoveError) {
            console.log(`非法着法：${error.message}`);
            continue;
          }
          throw error;
        }
      } else {
        let results: SearchResult[];
        try {
          results = await engine.search(
            game.fen(),
            difficulty.nodes,
            difficulty.multiPv,
          );
        } catch (error) {
          if (!(error instanceof EngineTimeoutError)) throw error;
          const retry = (
            await ask('引擎超时，是否重试？(y/N) ')
          )
            .trim()
            .toLowerCase();
          if (retry !== 'y') {
            game.abort();
            break;
          }
          await restart(config);
          results = await engine.search(
            game.fen(),
            difficulty.nodes,
            difficulty.multiPv,
          );
        }

        const chosen = selectEngineMove(results, difficulty.weighted);
        const entry = game.move(chosen.move);
        console.log(`AI 走了：${entry.chinese}`);
      }
    }

    console.log('');
    console.log(renderBoard(game.position));
    console.log(`结果：${resultText(game, humanSide)}（${game.endReason ?? '未结束'}）`);

    if (
      args.review &&
      game.result &&
      game.result !== 'aborted' &&
      game.history.some((entry) => entry.side === humanSide)
    ) {
      const answer = (await ask('是否复盘？(Y/n) ')).trim().toLowerCase();
      if (answer !== 'n') {
        console.log('正在复盘，每手需要两次引擎搜索，请稍候……');
        const report = await reviewGame(engine, game, humanSide);
        printReview(report);
      }
    }

    persist();
  } catch (error) {
    if (error instanceof EngineTimeoutError) {
      console.error('引擎计算超时，对局中止');
    } else {
      console.error('运行出错：', error instanceof Error ? error.message : error);
    }
    if (!game.result) game.abort();
    persist();
    process.exitCode = 1;
  } finally {
    await engine.quit().catch(() => undefined);
    rl.close();
  }
}

void main();
```

- [ ] **Step 6: 运行配置测试与类型检查**

Run:

```bash
npx vitest run tests/config.test.ts
npx tsc --noEmit
```

Expected: 5 passed；`tsc` 无输出。

---

### Task 13: 全量测试与真实对局冒烟

**Files:**
- 无新增文件

- [ ] **Step 1: 运行完整测试套件**

Run: `npm test`

Expected: 所有测试 passed。真实引擎测试会启动 Pikafish 数次，总耗时应在一分钟内。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`

Expected: 无输出。

- [ ] **Step 3: 用真实引擎跑一次脚本化对局**

Run:

```bash
printf 'h2e2\nquit\n' | node src/main.ts --level 1
```

Expected:

- 打印棋盘（含 `楚河 · 汉界`）
- 打印 `你走了：炮二平五`
- 打印 `结果：对局中止（aborted）`
- 打印 `棋谱已保存：records/....json`
- `records/` 下生成的 JSON 中 `moves[0]` 为 `{ "ply": 1, "side": "red", "uci": "h2e2", "chinese": "炮二平五" }`

- [ ] **Step 4: 清理冒烟产生的棋谱**

Run:

```bash
rm -rf records
```

Expected: `records/` 被删除（这是本次冒烟产生的临时产物）。

- [ ] **Step 5: 人工完成一局短对局（必须执行）**

Run:

```bash
node src/main.ts --level 1
```

操作：

1. 输入 `hint`，确认输出中文建议着法。
2. 走几步，输入 `undo`，确认回退两步。
3. 输入 `resign`，确认进入复盘询问。
4. 回车确认复盘，观察逐手损失、推荐着法、汇总输出。
5. 确认 `records/` 下生成棋谱 JSON。

Expected: 全程无异常，复盘报告包含至少 1 手人类着法分析。

---

## 自查记录

- [x] 规格覆盖：规则（Task 2–4）、记谱（Task 5）、渲染（Task 6）、对局（Task 7）、真实引擎（Task 8）、难度（Task 9）、复盘（Task 10）、存储（Task 11）、CLI 与配置（Task 12）、验收（Task 13）。
- [x] 无桩引擎：所有引擎测试直接启动项目根目录的真实 Pikafish。
- [x] FEN 字母已按 Pikafish 实际输出修正为 `N/B`。
- [x] 当前目录非 git 仓库，计划不含提交步骤。
- [x] 类型与命名一致：`PikafishEngine.search` 返回 `SearchResult[]`，`reviewGame` 与 `main` 均按此使用。