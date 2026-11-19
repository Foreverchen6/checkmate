import type { SearchResult } from '../engine/pikafish.ts';
import type {
  ArchiveSummary,
  GameRecord,
  SavedGame,
} from '../storage/recordData.ts';
import type { AppSettings } from '../storage/settings.ts';

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

export interface ImportedArchive {
  path: string;
  archive: SavedGame;
}

export interface XiangqiApi {
  getStatus(): Promise<EngineStatus>;
  restartEngine(): Promise<EngineStatus>;
  search(payload: SearchPayload): Promise<SearchResult[]>;
  saveRecord(record: GameRecord): Promise<string>;
  getRecordDir(): Promise<string>;
  saveArchive(archive: SavedGame): Promise<string>;
  listArchives(): Promise<ArchiveSummary[]>;
  loadArchive(file: string): Promise<SavedGame>;
  exportArchive(archive: SavedGame): Promise<string | null>;
  importArchive(): Promise<ImportedArchive | null>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  onEngineStatus(callback: (status: EngineStatus) => void): () => void;
}

declare global {
  interface Window {
    xiangqi: XiangqiApi;
  }
}

export const api = (): XiangqiApi => window.xiangqi;