import type { SearchResult } from '../engine/pikafish.ts';
import type { GameRecord } from '../storage/recordData.ts';

export interface EngineStatus {
  ready: boolean;
  error: string | null;
  enginePath: string;
  evalPath: string;
}

export interface SearchPayload {
  fen: string;
  nodes: number;
  multiPv?: number;
  timeoutMs?: number;
}

export interface XiangqiApi {
  getStatus(): Promise<EngineStatus>;
  restartEngine(): Promise<EngineStatus>;
  search(payload: SearchPayload): Promise<SearchResult[]>;
  saveRecord(record: GameRecord): Promise<string>;
  getRecordDir(): Promise<string>;
  onEngineStatus(callback: (status: EngineStatus) => void): () => void;
}

declare global {
  interface Window {
    xiangqi: XiangqiApi;
  }
}

export const api = (): XiangqiApi => window.xiangqi;