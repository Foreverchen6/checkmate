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