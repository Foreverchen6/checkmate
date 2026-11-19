import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getStatus: () => ipcRenderer.invoke('engine:status'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  search: (payload: unknown) => ipcRenderer.invoke('engine:search', payload),
  saveRecord: (record: unknown) => ipcRenderer.invoke('record:save', record),
  getRecordDir: () => ipcRenderer.invoke('record:dir'),
  onEngineStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('engine:status', handler);
    return () => ipcRenderer.off('engine:status', handler);
  },
};

contextBridge.exposeInMainWorld('xiangqi', api);