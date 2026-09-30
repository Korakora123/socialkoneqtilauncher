/**
 * SocialKoneqti Agent — Electron main process.
 * Tray + window + IPC + agent runtime. Zero intelligence lives here.
 */
import { app, BrowserWindow, ipcMain, Menu, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from './src/agent/runtime';
import { errorMessage, AgentError } from './src/agent/util';
import { BrainError } from './src/agent/brainClient';
import { configStore, DASHBOARD_URL, maskKey, seedFromEnv } from './src/main/config';
import { logger } from './src/main/logger';
import { SessionVault } from './src/agent/sessionVault';
import { safeStorageKey } from './src/main/sessionKey';
import { trayIcon } from './src/main/trayIcon';
import type { AgentUpsertProfileRequest } from './src/shared/contract';
import { IPC, type AgentSnapshot, type IpcResult, type SettingsUpdate, type SettingsView, type UpdateCheckResult } from './src/shared/ipc';

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: AgentRuntime | null = null;
let quitting = false;
let lastSnapshot: AgentSnapshot | null = null;

// ───────────── single instance (CLAUDE.md: never two launchers at once) ─────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(boot);
}

function startHidden(): boolean {
  return process.argv.includes('--hidden');
}

async function boot(): Promise<void> {
  app.setAppUserModelId('com.koneqti.socialkoneqti');
  const seeded = seedFromEnv();
  if (seeded) logger.info('settings seeded from .env');
  applyAutoStart(configStore.autoStart());

  runtime = new AgentRuntime({
    config: configStore,
    version: VERSION,
    machineName: hostname(),
    logger,
    sessions: new SessionVault(join(app.getPath('userData'), 'session-backups'), safeStorageKey(join(app.getPath('userData'), 'session-backups', 'key.bin'))),
    emit: (s) => {
      lastSnapshot = s;
      win?.webContents.send(IPC.snapshot, s);
      updateTray(s);
    },
    onLatestVersion: () => { void checkForUpdates(false); },
  });

  registerIpc();
  createTray();
  if (!startHidden()) createWindow();
  setInterval(() => { if (runtime) { lastSnapshot = runtime.snapshot(); win?.webContents.send(IPC.snapshot, lastSnapshot); } }, 5000);
  void runtime.start();
  if (app.isPackaged) setTimeout(() => void checkForUpdates(false), 30_000);
}

// ───────────────────────────── window ─────────────────────────────

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: 'SocialKoneqti Agent',
    backgroundColor: '#050C1A',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => { win = null; });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function showWindow(): void {
  if (!win) createWindow();
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
}

// ───────────────────────────── tray (§48 Screen 5) ─────────────────────────────

function createTray(): void {
  tray = new Tray(trayIcon('warn'));
  tray.setToolTip('SocialKoneqti Agent');
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  updateTray(runtime?.snapshot() ?? null);
}

const STATUS_TEXT: Record<AgentSnapshot['status'], string> = {
  active: '🟢 Connected',
  starting: '🟡 Starting',
  reconnecting: '🟡 Reconnecting',
  action_needed: '🔴 Action needed',
  paused: '⚪ Paused',
};

function updateTray(s: AgentSnapshot | null): void {
  if (!tray) return;
  const status = s?.status ?? 'starting';
  const paused = s?.paused_local ?? configStore.get().paused;
  const statusLine = status === 'active' ? `${STATUS_TEXT[status]} — ${s?.jobs_today_local ?? 0} jobs today` : STATUS_TEXT[status];
  const template: MenuItemConstructorOptions[] = [
    { label: statusLine, enabled: false },
    { type: 'separator' },
    { label: '📊 Open Dashboard', click: () => void shell.openExternal(DASHBOARD_URL) },
    { label: '🖥 Show Agent Window', click: showWindow },
    paused
      ? { label: '▶  Resume All Agents', click: () => runtime?.resume() }
      : { label: '⏸  Pause All Agents', click: () => runtime?.pause() },
    { type: 'separator' },
    { label: '🔄 Check for Updates', click: () => void checkForUpdates(true) },
    { label: '❌ Quit', click: quit },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`SocialKoneqti Agent — ${s?.message ?? 'Starting'}`);
  const icon = status === 'active' ? 'active' : status === 'paused' ? 'paused' : status === 'action_needed' ? 'error' : 'warn';
  tray.setImage(trayIcon(icon));
}

function quit(): void {
  quitting = true;
  runtime?.stop(true);
  app.quit();
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in tray */ });

// ───────────────────────────── auto start / updates ─────────────────────────────

function applyAutoStart(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

async function checkForUpdates(interactive: boolean): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { available: false, version: null, message: 'Updates are checked in the installed app only' };
  try {
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const res = await autoUpdater.checkForUpdates();
    const v = res?.updateInfo?.version ?? null;
    const available = Boolean(v && v !== VERSION);
    if (interactive) showWindow();
    return { available, version: v, message: available ? `Version ${v} is downloading — it installs when you quit` : 'You are on the latest version' };
  } catch (e) {
    logger.warn('update check failed', { reason: errorMessage(e).slice(0, 120) });
    return { available: false, version: null, message: 'Could not check for updates right now' };
  }
}

// ───────────────────────────── IPC ─────────────────────────────

function settingsView(): SettingsView {
  const c = configStore.get();
  return {
    brain_url: c.brain_url,
    api_key_masked: maskKey(c.api_key),
    has_api_key: Boolean(c.api_key),
    adspower_url: c.adspower_url,
    has_adspower_api_key: Boolean(c.adspower_api_key),
    auto_start: configStore.autoStart(),
    paused: c.paused,
    version: VERSION,
  };
}

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const code = e instanceof AgentError ? e.code : e instanceof BrainError ? (e.code ?? undefined) : undefined;
    return { ok: false, error: { message: errorMessage(e), ...(code ? { code } : {}) } };
  }
}

function validUrl(u: string): boolean {
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:'; } catch { return false; }
}

function registerIpc(): void {
  const rt = (): AgentRuntime => {
    if (!runtime) throw new Error('Agent not ready');
    return runtime;
  };
  ipcMain.handle(IPC.getSnapshot, () => lastSnapshot ?? rt().snapshot());
  ipcMain.handle(IPC.getSettings, () => settingsView());
  ipcMain.handle(IPC.saveSettings, (_e, u: SettingsUpdate) => wrap(async () => {
    let reconnect = false;
    if (u.brain_url !== undefined) {
      const v = u.brain_url.trim().replace(/\/+$/, '');
      if (!validUrl(v)) throw new Error('Brain URL must start with https://');
      configStore.set({ brain_url: v }); reconnect = true;
    }
    if (u.adspower_url !== undefined) {
      const v = u.adspower_url.trim().replace(/\/+$/, '');
      if (!validUrl(v)) throw new Error('AdsPower URL must look like http://localhost:50325');
      configStore.set({ adspower_url: v }); reconnect = true;
    }
    if (u.api_key !== undefined) { configStore.setSecrets({ api_key: u.api_key.trim() }); configStore.set({ agent_id: null }); reconnect = true; }
    if (u.adspower_api_key !== undefined) { configStore.setSecrets({ adspower_api_key: u.adspower_api_key.trim() }); reconnect = true; }
    if (u.auto_start !== undefined) { configStore.setAutoStart(u.auto_start); applyAutoStart(u.auto_start); }
    if (reconnect) void rt().reconfigure();
    return settingsView();
  }));
  ipcMain.handle(IPC.validateKey, () => wrap(() => rt().validateKey()));
  ipcMain.handle(IPC.testConnection, () => wrap(() => rt().testConnection()));
  ipcMain.handle(IPC.pause, () => rt().pause());
  ipcMain.handle(IPC.resume, () => rt().resume());
  ipcMain.handle(IPC.refresh, () => rt().refresh());
  ipcMain.handle(IPC.getStats, () => wrap(() => rt().stats()));
  ipcMain.handle(IPC.getBrainProfiles, () => wrap(() => rt().brainProfiles()));
  ipcMain.handle(IPC.getAdsPowerProfiles, () => wrap(() => rt().adsProfiles()));
  ipcMain.handle(IPC.testProfile, (_e, adsId: string, profileId?: number) =>
    wrap(() => rt().testProfile(String(adsId), typeof profileId === 'number' ? profileId : undefined)));
  ipcMain.handle(IPC.saveProfile, (_e, req: AgentUpsertProfileRequest) => wrap(async () => {
    await rt().saveProfile(req);
    return { saved: true as const };
  }));
  ipcMain.handle(IPC.openProfile, (_e, adsId: string, profileId?: number) => wrap(async () => {
    await rt().openProfile(String(adsId), typeof profileId === 'number' ? profileId : undefined);
    return { opened: true as const };
  }));
  ipcMain.handle(IPC.getSessionBackups, (_e, ids: unknown) =>
    wrap(() => rt().sessionBackups(Array.isArray(ids) ? ids.map((x) => String(x)).slice(0, 500) : [])));
  ipcMain.handle(IPC.restoreSession, (_e, adsId: string, platform: string, profileId?: number) =>
    wrap(() => rt().restoreProfileSession(String(adsId), String(platform), typeof profileId === 'number' ? profileId : undefined)));
  ipcMain.handle(IPC.checkForUpdates, () => wrap(() => checkForUpdates(false)));
  ipcMain.handle(IPC.openDashboard, () => shell.openExternal(DASHBOARD_URL));
}
