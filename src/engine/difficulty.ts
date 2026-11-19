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