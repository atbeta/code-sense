// Electron preload script — contextBridge
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  saveFile: (path: string, content: string) => ipcRenderer.invoke('save-file', path, content),
  notifyReady: (windowId: number) => ipcRenderer.send('notify-ready', { windowId }),
  onUpdateAvailable: (callback: () => void) => ipcRenderer.on('update-available', callback),
});
