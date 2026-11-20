import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getStatus: () => ipcRenderer.invoke('engine:status'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  search: (payload: unknown) => ipcRenderer.invoke('engine:search', payload),
  saveRecord: (record: unknown) => ipcRenderer.invoke('record:save', record),
  getRecordDir: () => ipcRenderer.invoke('record:dir'),
  saveArchive: (archive: unknown) => ipcRenderer.invoke('archive:save', archive),
  listArchives: () => ipcRenderer.invoke('archive:list'),
  loadArchive: (file: unknown) => ipcRenderer.invoke('archive:load', file),
  exportArchive: (archive: unknown) => ipcRenderer.invoke('archive:export', archive),
  importArchive: () => ipcRenderer.invoke('archive:import'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  onEngineStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('engine:status', handler);
    return () => ipcRenderer.off('engine:status', handler);
  },
  hostStart: (side: unknown) => ipcRenderer.invoke('online:host-start', side),
  hostStop: () => ipcRenderer.invoke('online:host-stop'),
  hostDecision: (accept: unknown) => ipcRenderer.invoke('online:host-decision', accept),
  hostSnapshot: (snapshot: unknown) => ipcRenderer.invoke('online:host-snapshot', snapshot),
  hostReply: (
    actionId: unknown,
    accepted: unknown,
    message: unknown,
    snapshot: unknown,
  ) => ipcRenderer.invoke('online:host-reply', actionId, accepted, message, snapshot),
  guestJoin: (url: unknown) => ipcRenderer.invoke('online:guest-join', url),
  guestAction: (action: unknown) => ipcRenderer.invoke('online:guest-action', action),
  guestLeave: () => ipcRenderer.invoke('online:guest-leave'),
  getOnlineStatus: () => ipcRenderer.invoke('online:status'),
  onOnlineEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, event: unknown) => callback(event);
    ipcRenderer.on('online:event', handler);
    return () => ipcRenderer.off('online:event', handler);
  },
};

contextBridge.exposeInMainWorld('xiangqi', api);