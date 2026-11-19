import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type CliArgs } from '../src/config.ts';
import { PikafishEngine, type SearchResult } from '../src/engine/pikafish.ts';
import { INITIAL_FEN } from '../src/rules/board.ts';
import { saveRecord } from '../src/storage/records.ts';
import type { GameRecord, SavedGame } from '../src/storage/recordData.ts';
import {
  archiveFileName,
  listArchives,
  loadArchive,
  readArchiveFile,
  saveArchive,
  writeArchiveFile,
} from '../src/storage/archive.ts';
import { loadSettings, saveSettings } from '../src/storage/settings.ts';

const userDataOverride = process.env.XIANGQI_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

interface EngineStatus {
  ready: boolean;
  error: string | null;
  enginePath: string;
  evalPath: string;
}

const cliArgs: CliArgs = {
  side: 'red',
  level: 2,
  configPath: null,
  review: true,
};

const selfTest = process.argv.includes('--self-test');
const smokeMode = process.env.XIANGQI_SMOKE === '1';

let engine: PikafishEngine | null = null;
let engineStatus: EngineStatus = {
  ready: false,
  error: '引擎启动中',
  enginePath: '',
  evalPath: '',
};
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function resourceBase(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function broadcastStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('engine:status', engineStatus);
  }
}

async function startEngine(): Promise<EngineStatus> {
  const config = loadConfig(cliArgs, resourceBase());
  engineStatus = {
    ready: false,
    error: '引擎启动中',
    enginePath: config.pikafishPath,
    evalPath: config.evalFile,
  };
  broadcastStatus();

  try {
    if (!existsSync(config.pikafishPath)) {
      throw new Error(`找不到引擎：${config.pikafishPath}`);
    }
    if (!existsSync(config.evalFile)) {
      throw new Error(`找不到 NNUE 权重：${config.evalFile}`);
    }
    engine = await PikafishEngine.start(config);
    engineStatus = {
      ready: true,
      error: null,
      enginePath: config.pikafishPath,
      evalPath: config.evalFile,
    };
  } catch (error) {
    engine = null;
    engineStatus = {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
      enginePath: config.pikafishPath,
      evalPath: config.evalFile,
    };
  }

  broadcastStatus();
  return engineStatus;
}

async function ensureEngine(): Promise<PikafishEngine> {
  if (engine) return engine;
  const status = await startEngine();
  if (!engine) throw new Error(status.error ?? '引擎不可用');
  return engine;
}

interface SearchPayload {
  fen: string;
  nodes: number;
  multiPv: number;
  timeoutMs: number;
}

function parseSearchPayload(raw: unknown): SearchPayload {
  if (!raw || typeof raw !== 'object') throw new Error('无效的搜索参数');
  const payload = raw as Record<string, unknown>;

  const fen = payload.fen;
  if (typeof fen !== 'string' || fen.length === 0 || fen.length > 200) {
    throw new Error('无效的 FEN');
  }

  const nodes = Number(payload.nodes);
  if (!Number.isInteger(nodes) || nodes < 100 || nodes > 5_000_000) {
    throw new Error('无效的节点数');
  }

  const multiPv = payload.multiPv === undefined ? 1 : Number(payload.multiPv);
  if (!Number.isInteger(multiPv) || multiPv < 1 || multiPv > 10) {
    throw new Error('无效的 MultiPV');
  }

  const timeoutMs = payload.timeoutMs === undefined ? 20000 : Number(payload.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 120000) {
    throw new Error('无效的超时时间');
  }

  return { fen, nodes, multiPv, timeoutMs };
}

function registerIpc(): void {
  ipcMain.handle('engine:status', () => engineStatus);

  ipcMain.handle('engine:restart', () =>
    serialize(async () => {
      if (engine) {
        await engine.quit();
        engine = null;
      }
      return startEngine();
    }),
  );

  ipcMain.handle('engine:search', (_event, raw: unknown) =>
    serialize(async (): Promise<SearchResult[]> => {
      const payload = parseSearchPayload(raw);
      const instance = await ensureEngine();
      return instance.search(payload.fen, payload.nodes, payload.multiPv, payload.timeoutMs);
    }),
  );

  ipcMain.handle('record:save', (_event, raw: unknown) => {
    const record = raw as GameRecord;
    if (!record || record.version !== 1 || !Array.isArray(record.moves)) {
      throw new Error('无效的棋谱数据');
    }
    const dir = join(app.getPath('userData'), 'records');
    return saveRecord(record, dir);
  });

  ipcMain.handle('record:dir', () => {
    const dir = join(app.getPath('userData'), 'records');
    mkdirSync(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle('archive:save', (_event, raw: unknown) =>
    saveArchive(raw as SavedGame, archiveDir()),
  );

  ipcMain.handle('archive:list', () => listArchives(archiveDir()));

  ipcMain.handle('archive:load', (_event, file: unknown) => {
    if (typeof file !== 'string') throw new Error('无效的存档文件名');
    return loadArchive(file, archiveDir());
  });

  ipcMain.handle('archive:export', async (event, raw: unknown) => {
    const archive = raw as SavedGame;
    if (smokeMode) {
      const file = join(app.getPath('userData'), 'smoke-export.json');
      writeArchiveFile(file, archive);
      return file;
    }

    const options: SaveDialogOptions = {
      title: '导出对局',
      defaultPath: join(app.getPath('documents'), `xiangqi-${archiveFileName()}`),
      filters: [{ name: '棋谱 JSON', extensions: ['json'] }],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    writeArchiveFile(result.filePath, archive);
    return result.filePath;
  });

  ipcMain.handle('archive:import', async (event) => {
    if (smokeMode) {
      const file = join(app.getPath('userData'), 'smoke-export.json');
      return { path: file, archive: readArchiveFile(file) };
    }

    const options: OpenDialogOptions = {
      title: '从文件载入对局',
      filters: [{ name: '棋谱 JSON', extensions: ['json'] }],
      properties: ['openFile'],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const file = result.filePaths[0];
    return { path: file, archive: readArchiveFile(file) };
  });

  ipcMain.handle('settings:get', () => loadSettings(settingsPath()));

  ipcMain.handle('settings:save', (_event, raw: unknown) =>
    saveSettings(settingsPath(), raw),
  );
}

function archiveDir(): string {
  return join(app.getPath('userData'), 'saved');
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function createWindow(): void {
  const width = 300;
  const height = 360;
  const gap = 12;
  const workArea = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - gap,
    y: workArea.y + workArea.height - height - gap,
    minWidth: 250,
    minHeight: 300,
    backgroundColor: '#0b0b0c',
    title: 'Xiangqi',
    autoHideMenuBar: true,
    show: false,
    focusable: !smokeMode,
    skipTaskbar: smokeMode,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.removeMenu();
  if (smokeMode) win.once('ready-to-show', () => win.showInactive());
  else win.once('ready-to-show', () => win.show());
  void win.loadFile(join(app.getAppPath(), 'dist-ui', 'index.html'));
}

async function runSelfTest(): Promise<void> {
  const file = join(app.getPath('userData'), 'self-test.json');
  const base = { config: loadConfig(cliArgs, resourceBase()), at: new Date().toISOString() };
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const instance = await PikafishEngine.start(base.config);
    const results = await instance.search(INITIAL_FEN, 2000, 1);
    await instance.quit();
    writeFileSync(
      file,
      JSON.stringify(
        {
          ok: results.length > 0,
          ...base,
          bestMove: results[0]?.move ?? null,
          cp: results[0]?.cp ?? null,
          pvLength: results[0]?.pv.length ?? 0,
        },
        null,
        2,
      ),
      'utf8',
    );
    app.exit(results.length > 0 ? 0 : 1);
  } catch (error) {
    writeFileSync(
      file,
      JSON.stringify(
        {
          ok: false,
          ...base,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      'utf8',
    );
    app.exit(1);
  }
}

registerIpc();

void app.whenReady().then(() => {
  if (selfTest) {
    void runSelfTest();
    return;
  }

  createWindow();
  void serialize(() => startEngine());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  engine?.kill();
  engine = null;
});