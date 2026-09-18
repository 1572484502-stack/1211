const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { startServer, DEFAULT_PORT } = require('./server.cjs');

let mainWindow;
let localServer;

function createWindow(appUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    backgroundColor: '#090b10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(appUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(async () => {
  let appUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
  try {
    const started = await startServer(DEFAULT_PORT);
    localServer = started.server;
    appUrl = started.url;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
  createWindow(appUrl);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(appUrl);
  });
});

app.on('window-all-closed', () => {
  localServer?.close();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('file:save-wav', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出重编排音乐',
    defaultPath: payload.defaultName,
    filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, Buffer.from(payload.bytes));
  return { canceled: false, filePath: result.filePath };
});
