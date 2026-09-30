/**
 * Preload bridge — exposes a small typed API on window.sk.
 * contextIsolation: true, nodeIntegration: false, sandbox: true.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AgentSnapshot, type SkBridge } from './src/shared/ipc';

const api: SkBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  onSnapshot: (cb) => {
    const listener = (_e: IpcRendererEvent, s: AgentSnapshot): void => cb(s);
    ipcRenderer.on(IPC.snapshot, listener);
    return () => { ipcRenderer.removeListener(IPC.snapshot, listener); };
  },
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (u) => ipcRenderer.invoke(IPC.saveSettings, u),
  validateKey: () => ipcRenderer.invoke(IPC.validateKey),
  testConnection: () => ipcRenderer.invoke(IPC.testConnection),
  pause: () => ipcRenderer.invoke(IPC.pause),
  resume: () => ipcRenderer.invoke(IPC.resume),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  getStats: () => ipcRenderer.invoke(IPC.getStats),
  getBrainProfiles: () => ipcRenderer.invoke(IPC.getBrainProfiles),
  getAdsPowerProfiles: () => ipcRenderer.invoke(IPC.getAdsPowerProfiles),
  testProfile: (adsId, profileId) => ipcRenderer.invoke(IPC.testProfile, adsId, profileId),
  saveProfile: (req) => ipcRenderer.invoke(IPC.saveProfile, req),
  openProfile: (adsId, profileId) => ipcRenderer.invoke(IPC.openProfile, adsId, profileId),
  getSessionBackups: (ids) => ipcRenderer.invoke(IPC.getSessionBackups, ids),
  restoreSession: (adsId, platform, profileId) => ipcRenderer.invoke(IPC.restoreSession, adsId, platform, profileId),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  openDashboard: () => ipcRenderer.invoke(IPC.openDashboard),
};

contextBridge.exposeInMainWorld('sk', api);
