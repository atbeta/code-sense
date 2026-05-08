// Electron main process — IPC handlers
import { app, BrowserWindow, ipcMain } from 'electron';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    webPreferences: { preload: require('path').join(__dirname, 'preload.js') },
  });
  mainWindow.loadURL('http://localhost:5173');
}

app.whenReady().then(createWindow);

// IPC handlers
ipcMain.handle('get-app-version', async () => {
  return { version: app.getVersion(), electron: process.versions.electron };
});

ipcMain.handle('save-file', async (_event, filePath: string, content: string) => {
  const fs = require('fs');
  fs.writeFileSync(filePath, content);
  return { success: true };
});

ipcMain.on('notify-ready', (_event, data: { windowId: number }) => {
  console.log('Window ready:', data.windowId);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
